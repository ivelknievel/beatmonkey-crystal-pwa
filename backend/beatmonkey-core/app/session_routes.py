"""Session routes factory for isolated access and refresh token management."""

import inspect
from typing import Any, Callable, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.routing import APIRoute

from app.auth import create_session_token
from app.session_refresh import ABSOLUTE_EXPIRY_SECONDS, RefreshSessions

COOKIE_NAME = "__Host-bm_refresh"
COOKIE_MAX_AGE = int(ABSOLUTE_EXPIRY_SECONDS)
MIN_TOKEN_LEN = 10
MAX_TOKEN_LEN = 512
MAX_USERNAME_LEN = 256
MAX_PASSWORD_LEN = 1024
MAX_REQUEST_BODY_BYTES = 4096


async def read_bounded_body(request: Request, max_bytes: int = MAX_REQUEST_BODY_BYTES) -> bytes:
    """Stream request body up to max_bytes. Rejects with 413 if body exceeds limit."""
    chunks = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=413,
                detail="Request entity too large",
                headers={"Cache-Control": "no-store"},
            )
        chunks.append(chunk)
    return b"".join(chunks)


class NoStoreRoute(APIRoute):
    """Route handler wrapper ensuring Cache-Control: no-store on all responses."""

    def get_route_handler(self) -> Callable:
        original_route_handler = super().get_route_handler()

        async def custom_route_handler(request: Request) -> Response:
            try:
                response = await original_route_handler(request)
            except HTTPException as exc:
                exc_headers = dict(exc.headers) if exc.headers else {}
                exc_headers["Cache-Control"] = "no-store"
                exc.headers = exc_headers
                raise exc
            response.headers["Cache-Control"] = "no-store"
            return response

        return custom_route_handler


def _resolve_and_validate_client(request: Request) -> str:
    """Resolves client type and enforces web security policies."""
    client_header = request.headers.get("x-bm-client")
    client = client_header.strip().lower() if client_header else "android"

    # Enforce cookies cannot fall back to android mode:
    # If refresh cookie is provided and no web header, reject 403.
    if COOKIE_NAME in request.cookies and client != "web":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: refresh cookie provided without web client header",
            headers={"Cache-Control": "no-store"},
        )

    if client not in ("android", "web"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported client type: {client}",
            headers={"Cache-Control": "no-store"},
        )

    return client


def _validate_web_csrf_and_origin(request: Request) -> None:
    """Enforces exact origin matching and X-BM-CSRF: 1 for web client requests."""
    origin = request.headers.get("origin")
    expected_origin = f"{request.url.scheme}://{request.url.netloc}".rstrip("/")
    if not origin or origin.rstrip("/") != expected_origin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: Origin mismatch or missing",
            headers={"Cache-Control": "no-store"},
        )

    csrf = request.headers.get("x-bm-csrf")
    if csrf != "1":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: Invalid or missing CSRF header",
            headers={"Cache-Control": "no-store"},
        )


def _validate_token_string(token: Any) -> str:
    """Validates bounded token inputs."""
    if not isinstance(token, str) or not (MIN_TOKEN_LEN <= len(token) <= MAX_TOKEN_LEN):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid session token",
            headers={"Cache-Control": "no-store"},
        )
    return token


async def _get_fresh_user_profile(
    user_id: str,
    lookup_fn: Callable[[str], Any],
) -> Dict[str, Any]:
    """Fresh lookup of user by ID strictly deriving identity and standard profile keys."""
    if not user_id or not isinstance(user_id, str):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid user session",
            headers={"Cache-Control": "no-store"},
        )
    user = lookup_fn(user_id)
    if inspect.isawaitable(user):
        user = await user
    if not user or not isinstance(user, dict) or "id" not in user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
            headers={"Cache-Control": "no-store"},
        )
    return {
        "id": str(user["id"]),
        "email": str(user.get("email", "")),
        "user_name": str(user.get("user_name", "")),
        "is_admin": bool(user.get("is_admin", False)),
    }


def _set_web_cookie(response: Response, token: str) -> None:
    """Sets the __Host-bm_refresh cookie with strict security flags."""
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=COOKIE_MAX_AGE,
        path="/",
        secure=True,
        httponly=True,
        samesite="strict",
    )


def _clear_web_cookie(response: Response) -> None:
    """Clears the __Host-bm_refresh cookie with identical security flags."""
    response.delete_cookie(
        key=COOKIE_NAME,
        path="/",
        secure=True,
        httponly=True,
        samesite="strict",
    )


def create_session_router(
    sessions: RefreshSessions,
    current_user_dependency: Callable,
    lookup_user_by_id: Callable[[str], Optional[dict]],
    verify_password: Callable[[str, str], Optional[dict]],
) -> APIRouter:
    """Factory creating an APIRouter for session and refresh token endpoints."""
    router = APIRouter(route_class=NoStoreRoute)

    @router.post("/api/auth/session")
    async def issue_session(
        request: Request,
        response: Response,
        current_user: Any = Depends(current_user_dependency),
    ) -> Dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        client = _resolve_and_validate_client(request)
        if client == "web":
            _validate_web_csrf_and_origin(request)

        user_id = None
        if isinstance(current_user, dict):
            user_id = current_user.get("id") or current_user.get("user_id") or current_user.get("sub")
        elif hasattr(current_user, "id"):
            user_id = getattr(current_user, "id")
        elif hasattr(current_user, "user_id"):
            user_id = getattr(current_user, "user_id")

        if not user_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid user session",
                headers={"Cache-Control": "no-store"},
            )

        profile = await _get_fresh_user_profile(str(user_id), lookup_user_by_id)

        try:
            refresh_token = sessions.issue(profile["id"], client=client)
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Unable to issue session token",
                headers={"Cache-Control": "no-store"},
            )

        if client == "web":
            _set_web_cookie(response, refresh_token)
            return {"status": "ok"}
        else:
            return {"refresh_token": refresh_token}

    @router.post("/api/auth/refresh")
    async def refresh_session(
        request: Request,
        response: Response,
    ) -> Dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        client = _resolve_and_validate_client(request)

        body: Dict[str, Any] = {}
        try:
            raw = await read_bounded_body(request)
            if raw:
                import json
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    body = parsed
        except HTTPException:
            raise
        except Exception:
            body = {}

        if client == "web":
            _validate_web_csrf_and_origin(request)
            raw_token = request.cookies.get(COOKIE_NAME)
            if not raw_token:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Missing refresh session cookie",
                    headers={"Cache-Control": "no-store"},
                )
        else:
            raw_token = body.get("refresh_token")
            if not raw_token:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Missing refresh token in request",
                    headers={"Cache-Control": "no-store"},
                )

        token = _validate_token_string(raw_token)

        try:
            new_token, rotated_user_id = sessions.rotate(token, client=client)
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired session token",
                headers={"Cache-Control": "no-store"},
            )

        profile = await _get_fresh_user_profile(rotated_user_id, lookup_user_by_id)

        access_token = create_session_token(
            navidrome_user_id=profile["id"],
            email=profile["email"],
            user_name=profile["user_name"],
            is_admin=profile["is_admin"],
        )

        if client == "web":
            _set_web_cookie(response, new_token)
            return {
                "token": access_token,
                "access_token": access_token,
                "user": profile,
                **profile,
            }
        else:
            return {
                "token": access_token,
                "access_token": access_token,
                "refresh_token": new_token,
                "user": profile,
                **profile,
            }

    @router.post("/api/auth/logout")
    async def logout_session(
        request: Request,
        response: Response,
    ) -> Dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        client = _resolve_and_validate_client(request)

        body: Dict[str, Any] = {}
        try:
            raw = await read_bounded_body(request)
            if raw:
                import json
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    body = parsed
        except HTTPException:
            raise
        except Exception:
            body = {}

        if client == "web":
            _validate_web_csrf_and_origin(request)
            _clear_web_cookie(response)
            raw_token = request.cookies.get(COOKIE_NAME)
            if raw_token:
                try:
                    token = _validate_token_string(raw_token)
                    sessions.revoke(token, client="web")
                except Exception:
                    pass
        else:
            raw_token = body.get("refresh_token")
            if raw_token:
                try:
                    token = _validate_token_string(raw_token)
                    sessions.revoke(token, client="android")
                except Exception:
                    pass

        return {"status": "ok"}

    @router.post("/api/auth/password")
    async def password_login(
        request: Request,
        response: Response,
    ) -> Dict[str, Any]:
        response.headers["Cache-Control"] = "no-store"
        client = _resolve_and_validate_client(request)
        if client == "web":
            _validate_web_csrf_and_origin(request)

        body: Dict[str, Any] = {}
        try:
            raw = await read_bounded_body(request)
            if raw:
                import json
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    body = parsed
                else:
                    raise HTTPException(
                        status_code=status.HTTP_401_UNAUTHORIZED,
                        detail="Invalid request body",
                        headers={"Cache-Control": "no-store"},
                    )
            else:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Missing credentials",
                    headers={"Cache-Control": "no-store"},
                )
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid request JSON",
                headers={"Cache-Control": "no-store"},
            )

        username = body.get("username")
        password = body.get("password")

        # Bounded credentials inputs
        if (
            not username
            or not password
            or not isinstance(username, str)
            or not isinstance(password, str)
            or not (1 <= len(username) <= MAX_USERNAME_LEN)
            or not (1 <= len(password) <= MAX_PASSWORD_LEN)
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid credentials",
                headers={"Cache-Control": "no-store"},
            )

        try:
            sig = inspect.signature(verify_password)
            if len(sig.parameters) >= 3:
                auth_result = verify_password(username, password, request)
            else:
                auth_result = verify_password(username, password)
            if inspect.isawaitable(auth_result):
                auth_result = await auth_result
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid credentials",
                headers={"Cache-Control": "no-store"},
            )

        if not auth_result or not isinstance(auth_result, dict):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid credentials",
                headers={"Cache-Control": "no-store"},
            )

        user_id = auth_result.get("id") or auth_result.get("user_id")
        if not user_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid credentials",
                headers={"Cache-Control": "no-store"},
            )

        # Fresh user lookup by ID before token creation
        profile = await _get_fresh_user_profile(str(user_id), lookup_user_by_id)

        access_token = create_session_token(
            navidrome_user_id=profile["id"],
            email=profile["email"],
            user_name=profile["user_name"],
            is_admin=profile["is_admin"],
        )

        return {
            "token": access_token,
            "access_token": access_token,
            "user": profile,
            **profile,
        }

    return router
