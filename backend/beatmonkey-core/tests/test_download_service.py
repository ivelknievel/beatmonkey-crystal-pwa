"""Tests for planned app/download_service.py DownloadService and create_download_router.

Planned module specifications:
- Class DownloadService(queue, execute: Callable[..., Awaitable[dict]]):
    * async start(): starts runner loop independent of incoming requests.
    * stop(): cancels runner loop and active waits cleanly.
    * async run_once() -> bool:
        - Recovers expired/stale leases first (queue.recover()).
        - Claims next job via asyncio.to_thread(self.queue.claim).
        - If claimed, invokes worker callback (execute async callback).
        - Worker callback may execute via asyncio.to_thread or async callback.
        - On finish: publishes truthful status.
        - If execution encounters timeout or cancellation: marked uncertain, no completed status.
- Factory create_download_router(queue, current_user_dependency: Callable):
    * POST /api/youtube/jobs
        - JSON body: {"url": str, "fmt": Optional[str], "quality": Optional[str]}
        - Requires authentication via current_user_dependency evaluated before body validation (malformed or unauthorized => 401).
        - Response 202 Accepted: {"job_id": str, "status": str} (truthful status, NOT ok=true).
        - Duplicate concurrent or repeated submissions: returns duplicate 202 with same job_id.
        - Strict canonical YouTube URL supported:
            * youtube.com/watch?v=11id
            * m.youtube.com/watch?v=11id
            * music.youtube.com/watch?v=11id
            * youtu.be/11id
            * shorts: youtube.com/shorts/11id
            * embed: youtube.com/embed/11id
            * live: youtube.com/live/11id
        - Rejects unknown hosts, non-standard ports, user credentials, URL fragments, invalid schemes (require safe https).
        - Reconstructs canonical URL or extracts 11-char video ID.
    * GET /api/youtube/jobs
        - Returns list of download jobs belonging to the authenticated owner.
    * GET /api/youtube/jobs/{job_id}
        - Returns job detail if owned by authenticated user.
        - Returns 404 if owned by another user or nonexistent.
- Background execution & resilience:
    * Job survives client close or client restart.
    * Background run completes fixture only.
    * Transient execution exception marked uncertain, cancellation/recovery does not allow unsafe replay.
- Legacy POST route source unchanged.
"""

import asyncio
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from typing import Any, Callable, Dict, List, Optional
from unittest.mock import AsyncMock, patch

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from httpx import ASGITransport, AsyncClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT / "app") not in sys.path:
    sys.path.insert(0, str(ROOT / "app"))

from app.download_queue import DownloadQueue

# Import planned download service and router factory
# Fails RED with ModuleNotFoundError until app/download_service.py is implemented
from app.download_service import (
    DownloadService,
    create_download_router,
    canonicalize_youtube_url,
    extract_canonical_video_id,
)


LEGACY_MAIN_PATH = ROOT / "app" / "main.py"
LEGACY_MAIN_BASELINE_SHA256 = (
    "e295bf47f07d592adacf62197afde365bed02e815693797f541ce51b427c276c"
)


class FakeClock:
    def __init__(self, start_time: float = 1700000000.0):
        self._time = float(start_time)

    def time(self) -> float:
        return self._time

    def advance(self, seconds: float):
        self._time += float(seconds)


class TestDownloadServiceCore(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.temp_dir.name, "test_queue.db")
        self.fake_clock = FakeClock()
        self.queue = DownloadQueue(db_path=self.db_path, clock=self.fake_clock.time)
        self.executed_jobs: List[Dict[str, Any]] = []

    async def asyncTearDown(self) -> None:
        self.temp_dir.cleanup()

    async def dummy_executor(self, job: Dict[str, Any]) -> Dict[str, Any]:
        self.executed_jobs.append(job)
        return {
            "ok": True,
            "returncode": 0,
            "rc": 0,
            "output_path": f"/downloads/{job['video_id']}.mp3",
            "file_size": 2048,
        }

    async def test_service_start_runner_independent_and_stop_cancels_cleanly(self) -> None:
        """async start() runs independently of incoming requests; stop() cancels waits cleanly."""
        service = DownloadService(queue=self.queue, execute=self.dummy_executor)
        await service.start()
        self.assertTrue(service.is_running())

        # Submit a job while background runner is active
        job = self.queue.submit("user1", "dQw4w9WgXcQ", fmt="mp3", quality="192k")
        # Let background loop cycle
        await asyncio.sleep(0.05)

        # Stop service cleanly cancels runner task
        await service.stop()
        self.assertFalse(service.is_running())

        # Job was processed by runner
        updated = self.queue.get_for_user(job["job_id"], "user1")
        self.assertEqual(updated["status"], "completed")

    async def test_run_once_recovers_then_claims_via_to_thread_and_finishes(self) -> None:
        """run_once() recovers expired leases first, claims via asyncio.to_thread, executes callback, and finishes."""
        # 1. Submit a job and claim it to simulate an in-flight abandoned lease
        job1 = self.queue.submit("user1", "dQw4w9WgXc1", fmt="mp3", quality="192k")
        claim1 = self.queue.claim()
        self.assertIsNotNone(claim1)
        self.fake_clock.advance(500.0)  # Expire lease (LEASE_DURATION_SEC = 420s)

        # 2. Submit a second pending job
        job2 = self.queue.submit("user2", "dQw4w9WgXc2", fmt="mp3", quality="192k")

        service = DownloadService(queue=self.queue, execute=self.dummy_executor)

        # Call run_once directly
        worked = await service.run_once()
        self.assertTrue(worked)

        # Expired job1 must have been recovered to uncertain
        recovered_job1 = self.queue.get_for_user(job1["job_id"], "user1")
        self.assertEqual(recovered_job1["status"], "uncertain")

        # job2 must have been claimed, executed, and completed
        completed_job2 = self.queue.get_for_user(job2["job_id"], "user2")
        self.assertEqual(completed_job2["status"], "completed")
        self.assertEqual(len(self.executed_jobs), 1)
        self.assertEqual(self.executed_jobs[0]["job_id"], job2["job_id"])

    async def test_run_once_timeout_or_cancel_marks_uncertain_no_completed(self) -> None:
        """Timeout or cancellation during execute marks job uncertain, never completed."""
        async def slow_cancelling_executor(job: Dict[str, Any]) -> Dict[str, Any]:
            await asyncio.sleep(0.5)
            raise asyncio.TimeoutError("Execution transport timed out")

        service = DownloadService(queue=self.queue, execute=slow_cancelling_executor)
        job = self.queue.submit("user1", "dQw4w9WgXcQ", fmt="mp3", quality="192k")

        worked = await service.run_once()
        self.assertTrue(worked)

        job_state = self.queue.get_for_user(job["job_id"], "user1")
        self.assertEqual(job_state["status"], "uncertain")
        self.assertNotEqual(job_state["status"], "completed")

    async def test_transient_execution_exception_uncertain_and_no_replay(self) -> None:
        """Transient execution failure leaves job uncertain, ensuring no unsafe auto-replay."""
        async def failing_executor(job: Dict[str, Any]) -> Dict[str, Any]:
            raise RuntimeError("Transient worker network disconnection")

        service = DownloadService(queue=self.queue, execute=failing_executor)
        job = self.queue.submit("user1", "dQw4w9WgXcQ", fmt="mp3", quality="192k")

        worked = await service.run_once()
        self.assertTrue(worked)

        job_state = self.queue.get_for_user(job["job_id"], "user1")
        self.assertEqual(job_state["status"], "uncertain")

        # Second run_once must find nothing eligible to claim (no automatic resubmission/replay)
        worked_again = await service.run_once()
        self.assertFalse(worked_again)


class TestCanonicalYouTubeURL(unittest.TestCase):
    def test_canonical_urls_valid_supported_domains(self) -> None:
        """Strict canonical YouTube URLs: youtube.com/watch, m., music., youtu.be, shorts, embed, live."""
        valid_cases = [
            ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
            ("https://youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ]
        for url, expected_id in valid_cases:
            with self.subTest(url=url):
                vid = extract_canonical_video_id(url)
                self.assertEqual(vid, expected_id)
                canon = canonicalize_youtube_url(url)
                self.assertEqual(canon, f"https://www.youtube.com/watch?v={expected_id}")

    def test_canonical_rejects_invalids(self) -> None:
        """Rejects unknown hosts, ports, credentials, fragments, non-https schemes, and invalid ids."""
        invalid_cases = [
            # Unknown hosts
            "https://attacker.com/watch?v=dQw4w9WgXcQ",
            "https://evil-youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com.attacker.org/watch?v=dQw4w9WgXcQ",
            # Explicit ports
            "https://youtube.com:8443/watch?v=dQw4w9WgXcQ",
            "https://youtu.be:443/dQw4w9WgXcQ",
            # User credentials
            "https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ",
            "https://admin@youtu.be/dQw4w9WgXcQ",
            # URL fragments
            "https://youtube.com/watch?v=dQw4w9WgXcQ#fragment",
            "https://youtu.be/dQw4w9WgXcQ#t=10",
            # Non-https / unsafe schemes
            "http://youtube.com/watch?v=dQw4w9WgXcQ",
            "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
            "javascript:alert(1)",
            # Malformed or missing video IDs
            "https://youtube.com/watch?v=short",
            "https://youtube.com/watch?v=waytoolongvideoid123",
            "https://youtube.com/watch?v=invalid!char",
            "https://youtu.be/",
            "https://youtube.com/shorts/",
        ]
        for url in invalid_cases:
            with self.subTest(url=url):
                with self.assertRaises((ValueError, HTTPException)):
                    extract_canonical_video_id(url)


class TestDownloadRouterAPI(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.temp_dir.name, "test_queue.db")
        self.queue = DownloadQueue(db_path=self.db_path)

        self.users = {
            "user_alice": {"user_id": "user_alice", "email": "alice@test.local"},
            "user_bob": {"user_id": "user_bob", "email": "bob@test.local"},
        }
        self.auth_user = self.users["user_alice"]
        self.auth_fail = False

        async def current_user_dependency(request: Request) -> dict:
            # Dependency must execute before body validation: if unauthorized, raise 401
            auth_header = request.headers.get("Authorization")
            if self.auth_fail or not auth_header:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Authentication required",
                )
            return self.auth_user

        self.current_user_dependency = current_user_dependency
        self.router = create_download_router(
            queue=self.queue,
            current_user_dependency=self.current_user_dependency,
        )

        self.app = FastAPI()
        self.app.include_router(self.router)
        self.transport = ASGITransport(app=self.app)
        self.client = AsyncClient(transport=self.transport, base_url="https://testserver")

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        self.temp_dir.cleanup()

    async def test_post_jobs_unauthorized_malformed_returns_401(self) -> None:
        """Unauthorized malformed request returns 401 because auth dependency runs before body parsing."""
        self.auth_fail = True
        # Request with broken body and missing auth
        res = await self.client.post(
            "/api/youtube/jobs",
            content=b"{bad-malformed-json",
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(res.status_code, 401)

    async def test_post_jobs_authorized_success_returns_202_not_ok_true(self) -> None:
        """POST /api/youtube/jobs returns HTTP 202 {job_id, status} and NOT ok=true."""
        res = await self.client.post(
            "/api/youtube/jobs",
            json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "fmt": "mp3", "quality": "192k"},
            headers={"Authorization": "Bearer valid-token"},
        )
        self.assertEqual(res.status_code, 202)
        data = res.json()
        self.assertIn("job_id", data)
        self.assertEqual(data.get("status"), "pending")
        # Explicit contract requirement: NOT ok=true
        self.assertNotIn("ok", data)

    async def test_duplicate_submission_returns_202_with_same_job_id(self) -> None:
        """Duplicate submission for same user/video/format returns HTTP 202 with existing job_id."""
        payload = {
            "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "fmt": "mp3",
            "quality": "192k",
        }
        res1 = await self.client.post(
            "/api/youtube/jobs",
            json=payload,
            headers={"Authorization": "Bearer valid-token"},
        )
        self.assertEqual(res1.status_code, 202)
        job_id1 = res1.json()["job_id"]

        res2 = await self.client.post(
            "/api/youtube/jobs",
            json=payload,
            headers={"Authorization": "Bearer valid-token"},
        )
        self.assertEqual(res2.status_code, 202)
        job_id2 = res2.json()["job_id"]

        self.assertEqual(job_id1, job_id2)

    async def test_get_jobs_returns_owner_list_only(self) -> None:
        """GET /api/youtube/jobs returns list of jobs belonging strictly to the authenticated user."""
        # Alice creates two jobs
        await self.client.post(
            "/api/youtube/jobs",
            json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXc1", "fmt": "mp3", "quality": "192k"},
            headers={"Authorization": "Bearer valid-token"},
        )
        await self.client.post(
            "/api/youtube/jobs",
            json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXc2", "fmt": "mp3", "quality": "192k"},
            headers={"Authorization": "Bearer valid-token"},
        )

        # Bob creates one job
        self.auth_user = self.users["user_bob"]
        await self.client.post(
            "/api/youtube/jobs",
            json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXc3", "fmt": "mp3", "quality": "192k"},
            headers={"Authorization": "Bearer valid-token"},
        )

        # Alice lists her jobs
        self.auth_user = self.users["user_alice"]
        res_alice = await self.client.get(
            "/api/youtube/jobs",
            headers={"Authorization": "Bearer valid-token"},
        )
        self.assertEqual(res_alice.status_code, 200)
        alice_jobs = res_alice.json()
        self.assertEqual(len(alice_jobs), 2)
        for job in alice_jobs:
            self.assertEqual(job["user_id"], "user_alice")

        # Bob lists his jobs
        self.auth_user = self.users["user_bob"]
        res_bob = await self.client.get(
            "/api/youtube/jobs",
            headers={"Authorization": "Bearer valid-token"},
        )
        self.assertEqual(res_bob.status_code, 200)
        bob_jobs = res_bob.json()
        self.assertEqual(len(bob_jobs), 1)
        self.assertEqual(bob_jobs[0]["user_id"], "user_bob")

    async def test_get_job_by_id_owner_vs_cross_account_404(self) -> None:
        """GET /api/youtube/jobs/{job_id} returns job to owner, but 404 to non-owner or nonexistent."""
        self.auth_user = self.users["user_alice"]
        res = await self.client.post(
            "/api/youtube/jobs",
            json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "fmt": "mp3", "quality": "192k"},
            headers={"Authorization": "Bearer valid-token"},
        )
        job_id = res.json()["job_id"]

        # Alice accesses her own job: 200 OK
        res_alice = await self.client.get(
            f"/api/youtube/jobs/{job_id}",
            headers={"Authorization": "Bearer valid-token"},
        )
        self.assertEqual(res_alice.status_code, 200)
        self.assertEqual(res_alice.json()["job_id"], job_id)

        # Bob accesses Alice's job: strictly 404 Not Found (cross-account isolation)
        self.auth_user = self.users["user_bob"]
        res_bob = await self.client.get(
            f"/api/youtube/jobs/{job_id}",
            headers={"Authorization": "Bearer valid-token"},
        )
        self.assertEqual(res_bob.status_code, 404)

        # Nonexistent job: 404 Not Found
        res_none = await self.client.get(
            "/api/youtube/jobs/nonexistent_job_id",
            headers={"Authorization": "Bearer valid-token"},
        )
        self.assertEqual(res_none.status_code, 404)

    async def test_job_survives_client_close_and_restart(self) -> None:
        """Job persists in queue and survives client disconnect or client restart."""
        # Post a job with client instance 1
        res = await self.client.post(
            "/api/youtube/jobs",
            json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "fmt": "mp3", "quality": "192k"},
            headers={"Authorization": "Bearer valid-token"},
        )
        job_id = res.json()["job_id"]

        # Close client 1
        await self.client.aclose()

        # Spin up new client instance 2 connecting to same queue
        client2 = AsyncClient(transport=self.transport, base_url="https://testserver")
        try:
            res_new = await client2.get(
                f"/api/youtube/jobs/{job_id}",
                headers={"Authorization": "Bearer valid-token"},
            )
            self.assertEqual(res_new.status_code, 200)
            self.assertEqual(res_new.json()["job_id"], job_id)
        finally:
            await client2.aclose()

    async def test_background_run_completes_fixture_only(self) -> None:
        """Background runner executes job to completion using fixture execution only."""
        executed = []

        async def fixture_execute(job: Dict[str, Any]) -> Dict[str, Any]:
            executed.append(job)
            return {"ok": True, "returncode": 0, "rc": 0, "output_path": "/media/test.mp3"}

        service = DownloadService(queue=self.queue, execute=fixture_execute)
        await service.start()
        try:
            res = await self.client.post(
                "/api/youtube/jobs",
                json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "fmt": "mp3", "quality": "192k"},
                headers={"Authorization": "Bearer valid-token"},
            )
            job_id = res.json()["job_id"]

            # Wait briefly for fixture worker runner to process
            await asyncio.sleep(0.05)

            status_res = await self.client.get(
                f"/api/youtube/jobs/{job_id}",
                headers={"Authorization": "Bearer valid-token"},
            )
            self.assertEqual(status_res.status_code, 200)
            self.assertEqual(status_res.json()["status"], "completed")
            self.assertEqual(len(executed), 1)
        finally:
            await service.stop()


class TestLegacyBaselineIntegrity(unittest.TestCase):
    def test_legacy_main_source_unchanged(self) -> None:
        """Verify AST exact bodies of legacy download endpoints and extractor match git HEAD original main."""
        import ast
        import subprocess

        self.assertTrue(LEGACY_MAIN_PATH.exists(), "Legacy main.py must exist")

        # Load original main.py from git HEAD without live /opt dependency
        repo_dir = LEGACY_MAIN_PATH.parents[2]
        cmd = ["git", "-C", str(repo_dir), "show", "HEAD:backend/beatmonkey-core/app/main.py"]
        head_content = subprocess.check_output(cmd).decode("utf-8")

        head_tree = ast.parse(head_content)
        live_tree = ast.parse(LEGACY_MAIN_PATH.read_text(encoding="utf-8"))

        target_names = {
            "extract_and_validate_youtube_id",
            "download_youtube_endpoint",
            "get_youtube_download_job_endpoint",
        }

        head_nodes = {
            n.name: n
            for n in head_tree.body
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in target_names
        }
        live_nodes = {
            n.name: n
            for n in live_tree.body
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in target_names
        }

        self.assertEqual(
            set(head_nodes.keys()),
            target_names,
            "Git HEAD main.py must contain all legacy download endpoints and extractor",
        )
        self.assertEqual(
            set(live_nodes.keys()),
            target_names,
            "Live main.py must contain all legacy download endpoints and extractor",
        )

        for name in target_names:
            head_body = ast.dump(ast.Module(body=head_nodes[name].body, type_ignores=[]))
            live_body = ast.dump(ast.Module(body=live_nodes[name].body, type_ignores=[]))
            self.assertEqual(
                live_body,
                head_body,
                f"Legacy AST body for {name} has diverged from git HEAD original main",
            )


if __name__ == "__main__":
    unittest.main()
