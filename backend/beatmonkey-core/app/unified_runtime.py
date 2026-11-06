"""Unified runtime factory and management for BeatMonkey Core.

Provides:
- RefreshSessions and DownloadQueue initialization
- Read-only Navidrome user lookup by id (avoiding cross-account fallback)
- Navidrome Subsonic ping password verification with in-memory bounded rate limiter
- Worker execution via httpx using DOWNLOADER_WORKER_URL and WORKER_INTERNAL_SECRET
- install_unified(app, get_current_user) and configure_unified()
"""

import asyncio
from collections import deque
import logging
import os
import sqlite3
import time
from typing import Any, Callable, Dict, Optional

from fastapi import APIRouter, FastAPI, HTTPException, Request, status
import httpx

from app.download_queue import DownloadQueue
from app.download_service import DownloadService, create_download_router
from app.session_refresh import RefreshSessions
from app.session_routes import create_session_router

logger = logging.getLogger(__name__)

NAVIDROME_DB_PATH = os.getenv("NAVIDROME_DB_PATH", "/navidrome_data/navidrome.db")
NAVIDROME_INTERNAL_PING_URL = "http://navidrome:4533/rest/ping.view"


class InMemoryRateLimiter:
    """Bounded in-memory rate limiter for password verification attempts.

    Per-IP limit: 5 attempts / 60 seconds
    Global limit: 30 attempts / 60 seconds
    Bounded memory via maxlen deque and max-entries dictionary.
    """

    def __init__(
        self,
        ip_limit: int = 5,
        global_limit: int = 30,
        window_seconds: float = 60.0,
        max_tracked_ips: int = 1000,
    ):
        self.ip_limit = ip_limit
        self.global_limit = global_limit
        self.window_seconds = window_seconds
        self.max_tracked_ips = max_tracked_ips
        self.global_timestamps: deque[float] = deque(maxlen=global_limit * 2)
        self.ip_timestamps: Dict[str, deque[float]] = {}

    def is_allowed(self, ip: Optional[str] = None) -> bool:
        now = time.monotonic()
        cutoff = now - self.window_seconds

        # Clean global
        while self.global_timestamps and self.global_timestamps[0] <= cutoff:
            self.global_timestamps.popleft()

        if len(self.global_timestamps) >= self.global_limit:
            return False

        if ip:
            q = self.ip_timestamps.get(ip)
            if q is not None:
                while q and q[0] <= cutoff:
                    q.popleft()
                if len(q) >= self.ip_limit:
                    return False

        return True

    def record_attempt(self, ip: Optional[str] = None) -> None:
        now = time.monotonic()
        self.global_timestamps.append(now)

        if ip:
            if ip not in self.ip_timestamps:
                if len(self.ip_timestamps) >= self.max_tracked_ips:
                    # Evict stale entries
                    cutoff = now - self.window_seconds
                    to_del = [k for k, dq in self.ip_timestamps.items() if not dq or dq[-1] <= cutoff]
                    for k in to_del:
                        del self.ip_timestamps[k]
                    if len(self.ip_timestamps) >= self.max_tracked_ips:
                        # Drop an arbitrary oldest entry to stay strictly bounded
                        oldest_key = next(iter(self.ip_timestamps))
                        del self.ip_timestamps[oldest_key]
                self.ip_timestamps[ip] = deque(maxlen=self.ip_limit * 2)
            self.ip_timestamps[ip].append(now)


_rate_limiter = InMemoryRateLimiter()


def lookup_navidrome_user_by_id(user_id: str) -> Optional[Dict[str, Any]]:
    """Read-only SQLite lookup on Navidrome DB by user ID.

    Queries id, email, user_name, is_admin strictly by ID.
    Avoids old admin fallback cross-account denial/switch.
    """
    if not user_id or not os.path.exists(NAVIDROME_DB_PATH):
        return None

    try:
        conn = sqlite3.connect(f"file:{NAVIDROME_DB_PATH}?mode=ro", uri=True)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, email, user_name, is_admin FROM user WHERE id = ?",
            (str(user_id),),
        )
        row = cursor.fetchone()
        conn.close()

        if not row:
            return None

        u_id, email, user_name, is_admin = row[0], row[1] or "", row[2] or "", bool(row[3])
        return {
            "id": u_id,
            "user_id": u_id,
            "email": email,
            "user_name": user_name,
            "name": user_name,
            "is_admin": is_admin,
        }
    except Exception as exc:
        logger.warning(f"Error querying Navidrome user by id: {exc}")
        return None


async def verify_navidrome_password(
    username: str,
    password: str,
    client_ip: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Verify credentials via fixed internal Navidrome Subsonic ping.

    POST form u, p, v=1.16.1, c=beatmonkey, f=json to http://navidrome:4533/rest/ping.view.
    Timeout 8.0s, max connections 4. No arbitrary user-supplied host.
    Requires subsonic-response.status == 'ok', then exact username DB lookup.
    """
    if not username or not password:
        return None

    if not _rate_limiter.is_allowed(client_ip):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many authentication attempts. Please try again later.",
            headers={"Cache-Control": "no-store"},
        )

    _rate_limiter.record_attempt(client_ip)

    limits = httpx.Limits(max_connections=4, max_keepalive_connections=2)
    data = {
        "u": username,
        "p": password,
        "v": "1.16.1",
        "c": "beatmonkey",
        "f": "json",
    }

    try:
        async with httpx.AsyncClient(timeout=8.0, limits=limits) as client:
            resp = await client.post(NAVIDROME_INTERNAL_PING_URL, data=data)

        if resp.status_code != 200:
            return None

        body = resp.json()
        subsonic_resp = body.get("subsonic-response", {})
        if subsonic_resp.get("status") != "ok":
            return None
    except Exception as e:
        logger.warning(f"Navidrome subsonic ping verification error: {e}")
        return None

    # Subsonic ping OK: lookup exact username in Navidrome DB
    if not os.path.exists(NAVIDROME_DB_PATH):
        return None

    try:
        conn = sqlite3.connect(f"file:{NAVIDROME_DB_PATH}?mode=ro", uri=True)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, email, user_name, is_admin FROM user WHERE user_name = ?",
            (username,),
        )
        row = cursor.fetchone()
        conn.close()

        if not row:
            return None

        u_id, email, user_name, is_admin = row[0], row[1] or "", row[2] or "", bool(row[3])
        return {
            "id": u_id,
            "user_id": u_id,
            "email": email,
            "user_name": user_name,
            "name": user_name,
            "is_admin": is_admin,
        }
    except Exception as exc:
        logger.warning(f"Error querying Navidrome user by username: {exc}")
        return None


async def execute_worker_download(job: Dict[str, Any]) -> Dict[str, Any]:
    """Execute download job via unprivileged downloader worker httpx call.

    Uses DOWNLOADER_WORKER_URL and WORKER_INTERNAL_SECRET (no secret in logs).
    Canonical URL based on 11-char video_id only, fmt, quality.
    Timeout 310s. Returns actual worker JSON.
    """
    worker_url = os.getenv("DOWNLOADER_WORKER_URL", "http://beatmonkey-downloader:8001").rstrip("/")
    worker_secret = os.getenv("WORKER_INTERNAL_SECRET", "")
    if not worker_secret or len(worker_secret) < 32:
        return {
            "ok": False,
            "rc": -1,
            "returncode": -1,
            "error": "Worker secret unconfigured or shorter than 32 chars",
        }

    headers = {
        "X-Worker-Secret": worker_secret,
        "Content-Type": "application/json",
    }
    payload = {
        "video_id": job["video_id"],
        "fmt": job.get("fmt", "mp3"),
        "quality": job.get("quality", "192k"),
        "user_id": job.get("user_id", "unknown"),
        "job_id": job.get("job_id", ""),
    }

    delays = [1.0, 3.0]
    try:
        async with asyncio.timeout(310.0):
            for attempt in range(3):
                try:
                    async with httpx.AsyncClient(timeout=310.0) as client:
                        resp = await client.post(f"{worker_url}/download", json=payload, headers=headers)
                except Exception:
                    return {
                        "ok": False,
                        "rc": -1,
                        "returncode": -1,
                        "transport_error": True,
                        "error": "Worker transport error",
                    }

                if resp.status_code == 429:
                    if attempt < 2:
                        await asyncio.sleep(delays[attempt])
                        continue
                    return {
                        "ok": False,
                        "rc": -1,
                        "returncode": -1,
                        "error": "Worker busy (HTTP 429)",
                        "stderr": resp.text,
                    }

                if resp.status_code in (401, 403):
                    return {
                        "ok": False,
                        "rc": -1,
                        "returncode": -1,
                        "error": "Worker authentication failure",
                        "stderr": resp.text,
                    }

                if resp.status_code != 200:
                    return {
                        "ok": False,
                        "rc": -1,
                        "returncode": -1,
                        "error": f"Worker error HTTP {resp.status_code}",
                        "stderr": resp.text,
                    }

                data = resp.json()
                return data
    except (TimeoutError, asyncio.TimeoutError):
        return {
            "ok": False,
            "rc": -1,
            "returncode": -1,
            "transport_error": True,
            "error": "Worker timeout",
        }
    except Exception:
        return {
            "ok": False,
            "rc": -1,
            "returncode": -1,
            "transport_error": True,
            "error": "Worker transport error",
        }


class _LazyRuntimeProxy:
    def __init__(self, attrname: str):
        self._attrname = attrname

    def __getattr__(self, name: str) -> Any:
        target = getattr(runtime, self._attrname, None)
        if target is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Service unavailable: runtime.{self._attrname} is not initialized",
            )
        return getattr(target, name)


class UnifiedRuntime:
    """Manages session and download background services."""

    def __init__(
        self,
        refresh_db_path: str = "/data/refresh_sessions.db",
        queue_db_path: str = "/data/download_queue.db",
    ):
        self.refresh_db_path = refresh_db_path
        self.queue_db_path = queue_db_path
        self.sessions: Optional[RefreshSessions] = None
        self.queue: Optional[DownloadQueue] = None
        self.download_service: Optional[DownloadService] = None

    def initialize(self) -> None:
        if self.sessions is None:
            self.sessions = RefreshSessions(self.refresh_db_path)
        if self.queue is None:
            self.queue = DownloadQueue(self.queue_db_path)
        if self.download_service is None:
            self.download_service = DownloadService(
                queue=self.queue,
                execute=execute_worker_download,
            )

    async def start(self) -> None:
        self.initialize()
        if self.download_service:
            await self.download_service.start()

    async def stop(self) -> None:
        if self.download_service:
            await self.download_service.stop()


runtime = UnifiedRuntime()


def configure_unified(
    refresh_db_path: str = "/data/refresh_sessions.db",
    queue_db_path: str = "/data/download_queue.db",
) -> UnifiedRuntime:
    """Configure and initialize singleton UnifiedRuntime."""
    runtime.refresh_db_path = refresh_db_path
    runtime.queue_db_path = queue_db_path
    runtime.initialize()
    return runtime


def install_unified(app: FastAPI, current_user_dependency: Callable) -> APIRouter:
    """Install unified session and download routers into FastAPI application.

    Registered with lazy access to runtime instances to prevent database
    writes or side-effects prior to security validation.
    """
    # Callback adapter for verify_password with request/rate-limiting
    async def _verify_password_wrapper(
        username: str,
        password: str,
        request: Optional[Request] = None,
    ) -> Optional[Dict[str, Any]]:
        client_ip = None
        if request and request.client and request.client.host:
            client_ip = request.client.host
        return await verify_navidrome_password(username, password, client_ip=client_ip)

    real_session_router = create_session_router(
        sessions=_LazyRuntimeProxy("sessions"),
        current_user_dependency=current_user_dependency,
        lookup_user_by_id=lookup_navidrome_user_by_id,
        verify_password=_verify_password_wrapper,
    )

    real_download_router = create_download_router(
        queue=_LazyRuntimeProxy("queue"),
        current_user_dependency=current_user_dependency,
    )

    app.include_router(real_session_router)
    app.include_router(real_download_router)

    return app
