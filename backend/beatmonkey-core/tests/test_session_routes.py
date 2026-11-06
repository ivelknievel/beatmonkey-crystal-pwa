"""Isolated unit tests for session routes factory.

Planned module contract:
app.session_routes.create_session_router(
    sessions: RefreshSessions,
    current_user_dependency: Callable,
    lookup_user_by_id: Callable[[str], Optional[dict]],
    verify_password: Callable[[str, str], Optional[dict]],
) -> APIRouter

Endpoints:
- POST /api/auth/session:
    * Requires valid access via dependency (401 on expired/invalid access).
    * GET not allowed (405).
    * Default client "android": returns JSON {"refresh_token": "..."}.
    * Client "web" (X-BM-Client: web):
        - Requires Origin matching request URL origin AND X-BM-CSRF: 1 (403 otherwise).
        - Sets __Host-bm_refresh cookie with Secure, HttpOnly, SameSite=strict, Path=/.
        - Response JSON NEVER returns refresh_token.
- POST /api/auth/refresh:
    * Rotates android JSON {"refresh_token": "..."} or web cookie __Host-bm_refresh.
    * Derives identity strictly via lookup_user_by_id(rotated_user_id).
    * Ignores or rejects arbitrary client-supplied user_id mismatches (cross-account denial).
    * Deleted/missing user in lookup_user_by_id returns 401.
    * Invalid, expired, or replayed tokens return 401 (replay revokes entire family).
    * CSRF failure on web returns 403.
    * Sets Cache-Control: no-store.
- POST /api/auth/logout:
    * Revokes entire token family in RefreshSessions and deletes web cookie.
- POST /api/auth/password:
    * Accepts {"username": "...", "password": "..."}.
    * Calls verify_password(username, password) -> profile.
    * Returns profile and access token via auth.create_session_token.
    * Missing or invalid credentials return 401.
    * No arbitrary input-selected server parameters honored.
    * Operates independently without requiring Google OAuth tokens.
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from httpx import ASGITransport, AsyncClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT / "app") not in sys.path:
    sys.path.insert(0, str(ROOT / "app"))

from app.auth import create_session_token, verify_token
from app.session_refresh import RefreshSessions

# Planned isolated module factory import (fails RED until implemented)
from app.session_routes import create_session_router

TEST_JWT_SECRET = "test-jwt-secret-fixture-isolated-at-least-32-chars-long"


class TestSessionRoutes(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._orig_jwt_secret = os.environ.get("JWT_SECRET")
        os.environ["JWT_SECRET"] = TEST_JWT_SECRET

        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.temp_dir.name, "test_sessions.sqlite")
        self.sessions = RefreshSessions(self.db_path)

        # In-memory test user store for sync callbacks
        self.users: Dict[str, dict] = {
            "user_alice": {
                "id": "user_alice",
                "email": "alice@example.com",
                "user_name": "alice",
                "is_admin": False,
            },
            "user_bob": {
                "id": "user_bob",
                "email": "bob@example.com",
                "user_name": "bob",
                "is_admin": False,
            },
        }

        self.passwords: Dict[tuple[str, str], dict] = {
            ("alice", "correct-horse-battery"): self.users["user_alice"],
        }

        self.auth_fail = False
        self.current_user_payload = self.users["user_alice"]

        def current_user_dependency(request: Request) -> dict:
            if self.auth_fail:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Invalid or expired access token",
                )
            return self.current_user_payload

        def lookup_user_by_id(user_id: str) -> Optional[dict]:
            return self.users.get(user_id)

        def verify_password(username: str, password: str) -> Optional[dict]:
            return self.passwords.get((username, password))

        self.lookup_user_by_id = lookup_user_by_id
        self.verify_password = verify_password
        self.current_user_dependency = current_user_dependency

        # Create router via factory
        self.router = create_session_router(
            sessions=self.sessions,
            current_user_dependency=self.current_user_dependency,
            lookup_user_by_id=self.lookup_user_by_id,
            verify_password=self.verify_password,
        )

        self.app = FastAPI()
        self.app.include_router(self.router)
        self.transport = ASGITransport(app=self.app)
        self.client = AsyncClient(transport=self.transport, base_url="https://testserver")

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        self.temp_dir.cleanup()
        if self._orig_jwt_secret is not None:
            os.environ["JWT_SECRET"] = self._orig_jwt_secret
        else:
            os.environ.pop("JWT_SECRET", None)

    # --------------------------------------------------------------------------
    # POST /api/auth/session tests
    # --------------------------------------------------------------------------

    async def test_session_requires_valid_access_dependency(self) -> None:
        """Accessing /api/auth/session succeeds with valid dependency user."""
        res = await self.client.post("/api/auth/session")
        self.assertEqual(res.status_code, 200)

    async def test_session_expired_access_returns_401(self) -> None:
        """Expired or missing access token dependency returns 401."""
        self.auth_fail = True
        res = await self.client.post("/api/auth/session")
        self.assertEqual(res.status_code, 401)

    async def test_session_get_method_not_allowed(self) -> None:
        """GET /api/auth/session is not allowed (405)."""
        res = await self.client.get("/api/auth/session")
        self.assertEqual(res.status_code, 405)

    async def test_session_client_default_android_returns_refresh_token_json(self) -> None:
        """Default android client receives refresh_token in response JSON and no cookie."""
        res = await self.client.post("/api/auth/session")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("refresh_token", data)
        self.assertIsInstance(data["refresh_token"], str)
        self.assertGreaterEqual(len(data["refresh_token"]), 32)
        self.assertNotIn("__Host-bm_refresh", res.cookies)

        # Explicit android header behaves identically
        res_explicit = await self.client.post(
            "/api/auth/session",
            headers={"X-BM-Client": "android"},
        )
        self.assertEqual(res_explicit.status_code, 200)
        self.assertIn("refresh_token", res_explicit.json())

    async def test_session_web_requires_same_origin_and_csrf_header(self) -> None:
        """Web client requires matching Origin and X-BM-CSRF: 1; returns 403 on failure."""
        # Missing Origin
        res1 = await self.client.post(
            "/api/auth/session",
            headers={"X-BM-Client": "web", "X-BM-CSRF": "1"},
        )
        self.assertEqual(res1.status_code, 403)

        # Mismatched Origin
        res2 = await self.client.post(
            "/api/auth/session",
            headers={
                "X-BM-Client": "web",
                "Origin": "https://evil.example.com",
                "X-BM-CSRF": "1",
            },
        )
        self.assertEqual(res2.status_code, 403)

        # Missing CSRF
        res3 = await self.client.post(
            "/api/auth/session",
            headers={
                "X-BM-Client": "web",
                "Origin": "https://testserver",
            },
        )
        self.assertEqual(res3.status_code, 403)

        # Invalid CSRF value
        res4 = await self.client.post(
            "/api/auth/session",
            headers={
                "X-BM-Client": "web",
                "Origin": "https://testserver",
                "X-BM-CSRF": "0",
            },
        )
        self.assertEqual(res4.status_code, 403)

    async def test_session_web_sets_secure_cookie_and_never_returns_token_in_json(self) -> None:
        """Web client sets __Host-bm_refresh cookie and NEVER exposes token in JSON."""
        res = await self.client.post(
            "/api/auth/session",
            headers={
                "X-BM-Client": "web",
                "Origin": "https://testserver",
                "X-BM-CSRF": "1",
            },
        )
        self.assertEqual(res.status_code, 200)

        # Cookie validation
        set_cookie = res.headers.get("set-cookie", "")
        self.assertIn("__Host-bm_refresh=", set_cookie)
        self.assertIn("Secure", set_cookie)
        self.assertIn("HttpOnly", set_cookie)
        self.assertIn("samesite=strict", set_cookie.lower())
        self.assertIn("path=/", set_cookie.lower())

        # Response body validation: NEVER returns refresh token in JSON
        data = res.json()
        self.assertNotIn("refresh_token", data)
        cookie_val = res.cookies.get("__Host-bm_refresh")
        self.assertTrue(cookie_val)
        self.assertNotIn(cookie_val, res.text)

    # --------------------------------------------------------------------------
    # POST /api/auth/refresh tests
    # --------------------------------------------------------------------------

    async def test_refresh_rotates_android_json_and_sets_no_store(self) -> None:
        """Android refresh rotates JSON {refresh_token}, returns new access/refresh tokens, sets no-store."""
        token = self.sessions.issue("user_alice", client="android")
        res = await self.client.post(
            "/api/auth/refresh",
            json={"refresh_token": token},
            headers={"X-BM-Client": "android"},
        )
        self.assertEqual(res.status_code, 200)
        self.assertIn("no-store", res.headers.get("cache-control", "").lower())

        data = res.json()
        new_refresh = data.get("refresh_token")
        self.assertTrue(new_refresh)
        self.assertNotEqual(new_refresh, token)

        # Access token must be valid for user_alice
        access_tok = data.get("token") or data.get("access_token")
        self.assertTrue(access_tok)
        claims = verify_token(access_tok)
        self.assertIsNotNone(claims)
        self.assertEqual(claims.get("user_id"), "user_alice")

        # Prior token is consumed and cannot be reused
        res_reuse = await self.client.post(
            "/api/auth/refresh",
            json={"refresh_token": token},
            headers={"X-BM-Client": "android"},
        )
        self.assertEqual(res_reuse.status_code, 401)

    async def test_refresh_rotates_web_cookie_and_sets_no_store(self) -> None:
        """Web refresh rotates __Host-bm_refresh cookie, no token in JSON, sets no-store."""
        token = self.sessions.issue("user_alice", client="web")
        res = await self.client.post(
            "/api/auth/refresh",
            headers={
                "X-BM-Client": "web",
                "Origin": "https://testserver",
                "X-BM-CSRF": "1",
            },
            cookies={"__Host-bm_refresh": token},
        )
        self.assertEqual(res.status_code, 200)
        self.assertIn("no-store", res.headers.get("cache-control", "").lower())

        set_cookie = res.headers.get("set-cookie", "")
        self.assertIn("__Host-bm_refresh=", set_cookie)
        self.assertIn("Secure", set_cookie)
        self.assertIn("HttpOnly", set_cookie)
        self.assertIn("samesite=strict", set_cookie.lower())
        self.assertIn("path=/", set_cookie.lower())

        # Response body must not contain refresh token
        data = res.json()
        self.assertNotIn("refresh_token", data)
        new_cookie_val = res.cookies.get("__Host-bm_refresh")
        self.assertTrue(new_cookie_val)
        self.assertNotEqual(new_cookie_val, token)
        self.assertNotIn(new_cookie_val, res.text)

    async def test_refresh_web_csrf_and_origin_enforcement(self) -> None:
        """Web refresh rejects missing/invalid CSRF header or mismatched origin with 403."""
        token = self.sessions.issue("user_alice", client="web")
        # Missing CSRF
        res1 = await self.client.post(
            "/api/auth/refresh",
            headers={
                "X-BM-Client": "web",
                "Origin": "https://testserver",
            },
            cookies={"__Host-bm_refresh": token},
        )
        self.assertEqual(res1.status_code, 403)

        # Origin mismatch
        res2 = await self.client.post(
            "/api/auth/refresh",
            headers={
                "X-BM-Client": "web",
                "Origin": "https://attacker.com",
                "X-BM-CSRF": "1",
            },
            cookies={"__Host-bm_refresh": token},
        )
        self.assertEqual(res2.status_code, 403)

    async def test_refresh_derives_identity_only_from_lookup_user_by_id(self) -> None:
        """Identity is derived strictly from lookup_user_by_id using the session's stored user_id."""
        token = self.sessions.issue("user_bob", client="android")
        res = await self.client.post(
            "/api/auth/refresh",
            json={"refresh_token": token},
        )
        self.assertEqual(res.status_code, 200)
        claims = verify_token(res.json().get("token") or res.json().get("access_token"))
        self.assertIsNotNone(claims)
        self.assertEqual(claims.get("user_id"), "user_bob")
        self.assertEqual(claims.get("email"), "bob@example.com")

    async def test_refresh_cross_account_parameter_denial(self) -> None:
        """Injected user_id parameter cannot switch the account; identity remains token owner or rejects."""
        alice_token = self.sessions.issue("user_alice", client="android")
        res = await self.client.post(
            "/api/auth/refresh",
            json={"refresh_token": alice_token, "user_id": "user_bob"},
            headers={"X-BM-Client": "android"},
        )
        if res.status_code == 200:
            claims = verify_token(res.json().get("token") or res.json().get("access_token"))
            self.assertEqual(claims.get("user_id"), "user_alice")
            self.assertNotEqual(claims.get("user_id"), "user_bob")
        else:
            self.assertIn(res.status_code, (400, 401, 403))

    async def test_refresh_deleted_user_returns_401(self) -> None:
        """Token whose user_id is missing from lookup_user_by_id returns 401."""
        token = self.sessions.issue("user_deleted", client="android")
        res = await self.client.post(
            "/api/auth/refresh",
            json={"refresh_token": token},
        )
        self.assertEqual(res.status_code, 401)

    async def test_refresh_invalid_or_expired_returns_401(self) -> None:
        """Invalid or expired refresh token returns 401."""
        res = await self.client.post(
            "/api/auth/refresh",
            json={"refresh_token": "unknown-nonexistent-token-1234567890"},
        )
        self.assertEqual(res.status_code, 401)

    async def test_refresh_replay_detection_revokes_entire_family(self) -> None:
        """Replay of an already-consumed token returns 401 and revokes the whole family."""
        token1 = self.sessions.issue("user_alice", client="android")

        # Legitimate rotation 1 -> token2
        res1 = await self.client.post(
            "/api/auth/refresh",
            json={"refresh_token": token1},
        )
        self.assertEqual(res1.status_code, 200)
        token2 = res1.json()["refresh_token"]

        # Replay attack: present token1 again
        res_replay = await self.client.post(
            "/api/auth/refresh",
            json={"refresh_token": token1},
        )
        self.assertEqual(res_replay.status_code, 401)

        # token2 should now be revoked due to family revocation
        res_token2 = await self.client.post(
            "/api/auth/refresh",
            json={"refresh_token": token2},
        )
        self.assertEqual(res_token2.status_code, 401)

    async def test_refresh_cross_client_replay_prevention(self) -> None:
        """Android token presented on Web or Web token presented on Android is rejected with 401."""
        android_tok = self.sessions.issue("user_alice", client="android")
        web_tok = self.sessions.issue("user_alice", client="web")

        # Android token presented via Web cookie
        res_web = await self.client.post(
            "/api/auth/refresh",
            headers={
                "X-BM-Client": "web",
                "Origin": "https://testserver",
                "X-BM-CSRF": "1",
            },
            cookies={"__Host-bm_refresh": android_tok},
        )
        self.assertEqual(res_web.status_code, 401)

        # Web token presented via Android JSON
        res_android = await self.client.post(
            "/api/auth/refresh",
            json={"refresh_token": web_tok},
            headers={"X-BM-Client": "android"},
        )
        self.assertEqual(res_android.status_code, 401)

    # --------------------------------------------------------------------------
    # POST /api/auth/logout tests
    # --------------------------------------------------------------------------

    async def test_logout_web_revokes_family_and_deletes_cookie(self) -> None:
        """Web logout revokes token family and clears __Host-bm_refresh cookie."""
        token = self.sessions.issue("user_alice", client="web")
        res = await self.client.post(
            "/api/auth/logout",
            headers={
                "X-BM-Client": "web",
                "Origin": "https://testserver",
                "X-BM-CSRF": "1",
            },
            cookies={"__Host-bm_refresh": token},
        )
        self.assertEqual(res.status_code, 200)

        # Cookie cleared
        set_cookie = res.headers.get("set-cookie", "")
        self.assertTrue(
            "Max-Age=0" in set_cookie
            or '__Host-bm_refresh=""' in set_cookie
            or '__Host-bm_refresh=;' in set_cookie,
        )

        # Token family is now revoked in session store
        res_refresh = await self.client.post(
            "/api/auth/refresh",
            headers={
                "X-BM-Client": "web",
                "Origin": "https://testserver",
                "X-BM-CSRF": "1",
            },
            cookies={"__Host-bm_refresh": token},
        )
        self.assertEqual(res_refresh.status_code, 401)

    async def test_logout_android_revokes_family(self) -> None:
        """Android logout revokes token family from explicit JSON."""
        token = self.sessions.issue("user_alice", client="android")
        res = await self.client.post(
            "/api/auth/logout",
            json={"refresh_token": token},
            headers={"X-BM-Client": "android"},
        )
        self.assertEqual(res.status_code, 200)

        # Subsequent refresh fails
        res_refresh = await self.client.post(
            "/api/auth/refresh",
            json={"refresh_token": token},
        )
        self.assertEqual(res_refresh.status_code, 401)

    # --------------------------------------------------------------------------
    # POST /api/auth/password tests
    # --------------------------------------------------------------------------

    async def test_password_login_success_returns_profile_and_access_token(self) -> None:
        """Valid username/password returns profile and access token via create_session_token."""
        res = await self.client.post(
            "/api/auth/password",
            json={"username": "alice", "password": "correct-horse-battery"},
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        token = data.get("token") or data.get("access_token")
        self.assertTrue(token)

        claims = verify_token(token)
        self.assertIsNotNone(claims)
        self.assertEqual(claims.get("user_id"), "user_alice")
        self.assertEqual(claims.get("user_name"), "alice")
        self.assertEqual(claims.get("email"), "alice@example.com")

    async def test_password_login_invalid_or_missing_credentials_returns_401(self) -> None:
        """Invalid credentials, missing user, or empty fields return 401."""
        # Wrong password
        res1 = await self.client.post(
            "/api/auth/password",
            json={"username": "alice", "password": "wrong-password"},
        )
        self.assertEqual(res1.status_code, 401)

        # Nonexistent user
        res2 = await self.client.post(
            "/api/auth/password",
            json={"username": "unknown_user", "password": "some_password"},
        )
        self.assertEqual(res2.status_code, 401)

        # Missing password field
        res3 = await self.client.post(
            "/api/auth/password",
            json={"username": "alice"},
        )
        self.assertIn(res3.status_code, (400, 401, 422))

    async def test_password_login_no_arbitrary_input_selected_server(self) -> None:
        """Login ignores or rejects arbitrary server/URL injection from request body."""
        payload = {
            "username": "alice",
            "password": "correct-horse-battery",
            "server": "https://malicious.example.com",
            "server_url": "https://attacker.example.com/navidrome",
            "redirect_url": "https://evil.example.com",
        }
        res = await self.client.post("/api/auth/password", json=payload)
        self.assertEqual(res.status_code, 200)
        self.assertNotIn("malicious.example.com", res.text)
        self.assertNotIn("attacker.example.com", res.text)

    async def test_password_login_no_google_forced(self) -> None:
        """Password login functions independently without requiring Google OAuth tokens or clients."""
        res = await self.client.post(
            "/api/auth/password",
            json={"username": "alice", "password": "correct-horse-battery"},
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("token", data)

    async def test_fake_callback_3rd_verifies_ip_and_429_unchanged(self) -> None:
        """Fake callback with 3rd argument receives request, verifies IP, and 429 is preserved unchanged."""
        recorded_ip = None

        def fake_cb(username: str, password: str, request: Request = None):
            nonlocal recorded_ip
            recorded_ip = request.client.host if (request and request.client) else None
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many authentication attempts",
                headers={"Cache-Control": "no-store"},
            )

        app = FastAPI()
        router = create_session_router(
            sessions=self.sessions,
            current_user_dependency=lambda: self.users["user_alice"],
            lookup_user_by_id=lambda uid: self.users.get(uid),
            verify_password=fake_cb,
        )
        app.include_router(router)

        transport = ASGITransport(app=app, client=("192.168.1.42", 50000))
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            res = await client.post(
                "/api/auth/password",
                json={"username": "alice", "password": "correct-horse-battery"},
            )
            self.assertEqual(res.status_code, 429)
            self.assertEqual(res.headers.get("Cache-Control"), "no-store")
            self.assertEqual(recorded_ip, "192.168.1.42")

    async def test_session_routes_rejects_payload_exceeding_4096_bytes(self) -> None:
        """Session routes bounded body rejects payloads > 4096 bytes with 413 and no-store."""
        large_payload = {"username": "alice", "password": "x" * 5000}
        res = await self.client.post("/api/auth/password", json=large_payload)
        self.assertEqual(res.status_code, 413)
        self.assertEqual(res.headers.get("Cache-Control"), "no-store")
