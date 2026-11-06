import asyncio
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from fastapi import FastAPI
import httpx
from httpx import ASGITransport, AsyncClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT / "app") not in sys.path:
    sys.path.insert(0, str(ROOT / "app"))

from app.unified_runtime import (
    runtime,
    configure_unified,
    install_unified,
    execute_worker_download,
    verify_navidrome_password,
    NAVIDROME_INTERNAL_PING_URL,
)

class TestUnifiedRuntime(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        runtime.sessions = None
        runtime.queue = None
        runtime.download_service = None

    async def asyncTearDown(self):
        if runtime.download_service:
            await runtime.stop()
        runtime.sessions = None
        runtime.queue = None
        runtime.download_service = None

    async def test_install_unified_no_files_until_configure(self):
        with tempfile.TemporaryDirectory() as td:
            r_path = os.path.join(td, "refresh.db")
            q_path = os.path.join(td, "queue.db")
            runtime.refresh_db_path = r_path
            runtime.queue_db_path = q_path
            runtime.sessions = None
            runtime.queue = None
            runtime.download_service = None

            app = FastAPI()
            install_unified(app, lambda: {"user_id": "u1", "id": "u1"})

            # Before configure_unified: NO files must exist!
            self.assertFalse(os.path.exists(r_path), f"Refresh DB should not exist before configure: {os.listdir(td)}")
            self.assertFalse(os.path.exists(q_path), f"Queue DB should not exist before configure: {os.listdir(td)}")

            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                res = await client.get("/api/youtube/jobs")
                self.assertEqual(res.status_code, 503)
                self.assertFalse(os.path.exists(q_path), "Requests before configure must raise 503 and not initialize DB")

            # Now configure
            configure_unified(refresh_db_path=r_path, queue_db_path=q_path)
            self.assertTrue(os.path.exists(r_path))
            self.assertTrue(os.path.exists(q_path))

            # Both routers operate on SAME instances worker uses
            self.assertIs(runtime.download_service.queue, runtime.queue)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                res = await client.get("/api/youtube/jobs")
                self.assertEqual(res.status_code, 200)

    async def test_source_worker_payload_and_missing_secret(self):
        # Missing or short secret fails before network
        old_secret = os.environ.get("WORKER_INTERNAL_SECRET")
        try:
            os.environ["WORKER_INTERNAL_SECRET"] = "short"
            res = await execute_worker_download({"video_id": "dQw4w9WgXcQ", "user_id": "u1", "job_id": "j1"})
            self.assertFalse(res.get("ok"))
            self.assertEqual(res.get("returncode"), -1)
            self.assertIn("secret", res.get("error", "").lower())
        finally:
            if old_secret is not None:
                os.environ["WORKER_INTERNAL_SECRET"] = old_secret
            else:
                os.environ.pop("WORKER_INTERNAL_SECRET", None)

    async def test_worker_retry_429_to_200_exactly_2_calls(self):
        """Worker 429 followed by 200 succeeds with exactly 2 calls."""
        old_secret = os.environ.get("WORKER_INTERNAL_SECRET")
        call_count = 0

        def handler(request: httpx.Request):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return httpx.Response(429, text="worker busy")
            return httpx.Response(200, json={"ok": True, "rc": 0, "video_id": "dQw4w9WgXcQ"})

        transport = httpx.MockTransport(handler)
        real_async_client = httpx.AsyncClient

        def client_factory(*args, **kwargs):
            kwargs["transport"] = transport
            return real_async_client(*args, **kwargs)

        try:
            os.environ["WORKER_INTERNAL_SECRET"] = "a" * 32
            with patch("httpx.AsyncClient", side_effect=client_factory):
                with patch("asyncio.sleep", return_value=None) as mock_sleep:
                    res = await execute_worker_download({
                        "video_id": "dQw4w9WgXcQ",
                        "user_id": "u1",
                        "job_id": "j1",
                    })
                    self.assertEqual(call_count, 2)
                    self.assertTrue(res.get("ok"))
                    self.assertEqual(mock_sleep.call_count, 1)
                    self.assertEqual(mock_sleep.call_args[0][0], 1.0)
        finally:
            if old_secret is not None:
                os.environ["WORKER_INTERNAL_SECRET"] = old_secret
            else:
                os.environ.pop("WORKER_INTERNAL_SECRET", None)

    async def test_worker_retry_persistent_429_exactly_3_fails_honest_busy(self):
        """Worker persistent 429 fails after exactly 3 attempts honest busy."""
        old_secret = os.environ.get("WORKER_INTERNAL_SECRET")
        call_count = 0

        def handler(request: httpx.Request):
            nonlocal call_count
            call_count += 1
            return httpx.Response(429, text="worker busy")

        transport = httpx.MockTransport(handler)
        real_async_client = httpx.AsyncClient

        def client_factory(*args, **kwargs):
            kwargs["transport"] = transport
            return real_async_client(*args, **kwargs)

        try:
            os.environ["WORKER_INTERNAL_SECRET"] = "a" * 32
            with patch("httpx.AsyncClient", side_effect=client_factory):
                with patch("asyncio.sleep", return_value=None) as mock_sleep:
                    res = await execute_worker_download({
                        "video_id": "dQw4w9WgXcQ",
                        "user_id": "u1",
                        "job_id": "j1",
                    })
                    self.assertEqual(call_count, 3)
                    self.assertFalse(res.get("ok"))
                    self.assertIn("busy", res.get("error", "").lower())
                    self.assertIn("429", res.get("error", ""))
                    self.assertEqual(mock_sleep.call_count, 2)
                    self.assertEqual(mock_sleep.call_args_list[0][0][0], 1.0)
                    self.assertEqual(mock_sleep.call_args_list[1][0][0], 3.0)
        finally:
            if old_secret is not None:
                os.environ["WORKER_INTERNAL_SECRET"] = old_secret
            else:
                os.environ.pop("WORKER_INTERNAL_SECRET", None)

    async def test_navidrome_subsonic_ping_regression_and_fixed_url(self):
        """Assert fixed HTTPS public Subsonic URL and MockTransport POST verification."""
        # Assert fixed HTTPS public URL
        self.assertEqual(NAVIDROME_INTERNAL_PING_URL, "https://music.cyberspeeze.online/rest/ping.view")

        captured_requests = []

        def ping_mock_handler(request: httpx.Request):
            captured_requests.append(request)
            if b"badpass" in request.content:
                # Subsonic failed response: 200 OK with status="failed"
                return httpx.Response(
                    200,
                    json={
                        "subsonic-response": {
                            "status": "failed",
                            "version": "1.16.1",
                            "error": {"code": 40, "message": "Wrong username or password"},
                        }
                    },
                )
            return httpx.Response(
                200,
                json={"subsonic-response": {"status": "ok", "version": "1.16.1"}},
            )

        transport = httpx.MockTransport(ping_mock_handler)
        real_async_client = httpx.AsyncClient

        def client_factory(*args, **kwargs):
            kwargs["transport"] = transport
            return real_async_client(*args, **kwargs)

        with patch("httpx.AsyncClient", side_effect=client_factory):
            # Test failed subsonic response returns None
            result_failed = await verify_navidrome_password("testuser", "badpass", "127.0.0.1")
            self.assertIsNone(result_failed)
            self.assertEqual(len(captured_requests), 1)

            req = captured_requests[0]
            self.assertEqual(req.method, "POST")
            self.assertEqual(req.url.path, "/rest/ping.view")
            # Verify body contains credentials, no query params
            self.assertEqual(str(req.url), "https://music.cyberspeeze.online/rest/ping.view")
            self.assertEqual(req.url.query, b"")
            body_text = req.content.decode("utf-8")
            self.assertIn("u=testuser", body_text)
            self.assertIn("p=badpass", body_text)
            self.assertIn("v=1.16.1", body_text)
            self.assertIn("c=beatmonkey", body_text)
            self.assertIn("f=json", body_text)
