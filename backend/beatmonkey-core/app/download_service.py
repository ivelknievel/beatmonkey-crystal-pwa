import asyncio
import inspect
import json
import logging
import re
from typing import Any, Awaitable, Callable, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from app.download_queue import DownloadQueue
from app.session_routes import read_bounded_body

logger = logging.getLogger(__name__)

# Strict YouTube URL matching patterns
# Allowed hosts: youtube.com, www.youtube.com, m.youtube.com, music.youtube.com, youtu.be
VALID_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
}

VIDEO_ID_REGEX = re.compile(r"^[a-zA-Z0-9_-]{11}$")
MAX_REQUEST_BODY_BYTES = 4096


def extract_canonical_video_id(url: str) -> str:
    if not isinstance(url, str):
        raise ValueError("URL must be a string")

    parsed = urlparse(url.strip())

    if parsed.scheme != "https":
        raise ValueError("Scheme must be https")

    if parsed.port is not None:
        raise ValueError("Explicit ports not allowed")

    if parsed.username or parsed.password:
        raise ValueError("User credentials not allowed")

    if parsed.fragment:
        raise ValueError("URL fragments not allowed")

    host = (parsed.hostname or "").lower()
    if host not in VALID_HOSTS:
        raise ValueError(f"Invalid host: {host}")

    video_id: Optional[str] = None

    if host == "youtu.be":
        # Path should be /11id
        parts = [p for p in parsed.path.strip("/").split("/") if p]
        if len(parts) == 1:
            video_id = parts[0]
        else:
            raise ValueError("Invalid youtu.be path")
    else:
        # youtube.com, www., m., music.
        path = parsed.path
        if path == "/watch":
            qs = parse_qs(parsed.query)
            v_list = qs.get("v")
            if v_list and len(v_list) > 0:
                video_id = v_list[0]
            else:
                raise ValueError("Missing 'v' parameter in /watch")
        elif path.startswith("/shorts/"):
            parts = [p for p in path.strip("/").split("/") if p]
            if len(parts) == 2 and parts[0] == "shorts":
                video_id = parts[1]
            else:
                raise ValueError("Invalid /shorts/ path")
        elif path.startswith("/embed/"):
            parts = [p for p in path.strip("/").split("/") if p]
            if len(parts) == 2 and parts[0] == "embed":
                video_id = parts[1]
            else:
                raise ValueError("Invalid /embed/ path")
        elif path.startswith("/live/"):
            parts = [p for p in path.strip("/").split("/") if p]
            if len(parts) == 2 and parts[0] == "live":
                video_id = parts[1]
            else:
                raise ValueError("Invalid /live/ path")
        else:
            raise ValueError(f"Unsupported path: {path}")

    if not video_id or not VIDEO_ID_REGEX.fullmatch(video_id):
        raise ValueError(f"Invalid YouTube video ID: {video_id}")

    return video_id


def canonicalize_youtube_url(url: str) -> str:
    video_id = extract_canonical_video_id(url)
    return f"https://www.youtube.com/watch?v={video_id}"


class DownloadService:
    def __init__(
        self,
        queue: DownloadQueue,
        execute: Callable[[Dict[str, Any]], Awaitable[Dict[str, Any]]],
    ):
        self.queue = queue
        self.execute = execute
        self._runner_task: Optional[asyncio.Task] = None
        self._stop_event = asyncio.Event()

    def is_running(self) -> bool:
        return self._runner_task is not None and not self._runner_task.done()

    async def start(self) -> None:
        if self.is_running():
            return
        self._stop_event.clear()
        self._runner_task = asyncio.create_task(self._runner_loop())

    async def stop(self) -> None:
        self._stop_event.set()
        if self._runner_task:
            self._runner_task.cancel()
            try:
                await self._runner_task
            except asyncio.CancelledError:
                pass
            finally:
                self._runner_task = None

    async def _runner_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                worked = await self.run_once()
                if not worked:
                    try:
                        await asyncio.wait_for(self._stop_event.wait(), timeout=2.0)
                    except asyncio.TimeoutError:
                        pass
                else:
                    await asyncio.sleep(0.01)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"DownloadService runner error: {e}", exc_info=True)
                await asyncio.sleep(1.0)

    async def run_once(self) -> bool:
        # 1. Recover expired leases
        await asyncio.to_thread(self.queue.recover)

        # 2. Claim next pending job
        job = await asyncio.to_thread(self.queue.claim)
        if not job:
            return False

        job_id = job["job_id"]
        lease_token = job.get("lease_token")

        try:
            # 3. Worker callback (execute canonical videoid job)
            if inspect.iscoroutinefunction(self.execute):
                res = await self.execute(job)
            else:
                call_res = self.execute(job)
                if inspect.isawaitable(call_res):
                    res = await call_res
                else:
                    res = call_res

            # Normal outcome finish matching lease
            await asyncio.to_thread(self.queue.finish, job_id, lease_token, res)
        except asyncio.CancelledError:
            # Shield finish uncertain result, then re-raise cancellation
            uncertain_res = {
                "ok": False,
                "rc": -1,
                "returncode": -1,
                "transport_error": True,
                "error": "transport error / cancelled",
            }
            await asyncio.shield(asyncio.to_thread(self.queue.finish, job_id, lease_token, uncertain_res))
            raise
        except Exception as exc:
            uncertain_res = {
                "ok": False,
                "rc": -1,
                "returncode": -1,
                "transport_error": True,
                "error": f"transport error: {exc}",
            }
            await asyncio.to_thread(self.queue.finish, job_id, lease_token, uncertain_res)

        return True


def create_download_router(
    queue: DownloadQueue,
    current_user_dependency: Callable,
) -> APIRouter:
    router = APIRouter()

    @router.post("/api/youtube/jobs", status_code=status.HTTP_202_ACCEPTED)
    async def create_download_job(
        request: Request,
        user: dict = Depends(current_user_dependency),
    ):
        try:
            body_bytes = await read_bounded_body(request, MAX_REQUEST_BODY_BYTES)
        except HTTPException as exc:
            if exc.status_code == status.HTTP_413_REQUEST_ENTITY_TOO_LARGE:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Request body exceeds maximum size",
                )
            raise
        try:
            payload = json.loads(body_bytes.decode("utf-8"))
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid JSON payload",
            )

        if not isinstance(payload, dict):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Payload must be a JSON object",
            )

        url = payload.get("url")
        if not url:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="URL field is required",
            )

        try:
            video_id = extract_canonical_video_id(url)
        except (ValueError, HTTPException) as err:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid YouTube URL: {err}",
            )

        fmt = payload.get("fmt", "mp3")
        quality = payload.get("quality", "192k")

        user_id = user.get("user_id") or user.get("id") or str(user)
        try:
            job = queue.submit(user_id=user_id, video_id=video_id, fmt=fmt, quality=quality)
        except ValueError as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

        return {
            "job_id": job["job_id"],
            "status": job["status"],
        }

    @router.get("/api/youtube/jobs")
    async def list_download_jobs(
        user: dict = Depends(current_user_dependency),
    ):
        user_id = user.get("user_id") or user.get("id") or str(user)
        jobs = queue.list_for_user(user_id)
        return jobs

    @router.get("/api/youtube/jobs/{job_id}")
    async def get_download_job(
        job_id: str,
        user: dict = Depends(current_user_dependency),
    ):
        user_id = user.get("user_id") or user.get("id") or str(user)
        job = queue.get_for_user(job_id=job_id, user_id=user_id)
        if not job:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Job not found",
            )
        return job

    return router
