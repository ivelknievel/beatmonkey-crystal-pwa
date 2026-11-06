import json
import os
import re
import sqlite3
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

VIDEO_ID_REGEX = re.compile(r"^[a-zA-Z0-9_-]{11}$")
ALLOWED_FORMATS = {"mp3"}
ALLOWED_QUALITIES = {"128k", "192k", "256k", "320k"}
LEASE_DURATION_SEC = 420.0
USER_PENDING_CAP = 10
GLOBAL_PENDING_CAP = 100


class DownloadQueue:
    def __init__(
        self,
        db_path: str = "queue.db",
        clock: Optional[Callable[[], float]] = None,
    ):
        self.db_path = db_path
        self._clock = clock if clock is not None else time.time
        self._init_db()

    def _now(self) -> float:
        return float(self._clock())

    def _get_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL")
        return conn

    def _init_db(self):
        with self._get_conn() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS bm_download_queue (
                    job_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    video_id TEXT NOT NULL,
                    fmt TEXT NOT NULL,
                    quality TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    started_at REAL,
                    lease_until REAL,
                    lease_token TEXT,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    result TEXT,
                    message TEXT
                )
                """
            )
            conn.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_bm_queue_unique_job
                ON bm_download_queue(user_id, video_id, fmt, quality)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_bm_queue_user_status
                ON bm_download_queue(user_id, status)
                """
            )
            conn.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_bm_queue_claim
                ON bm_download_queue(status, created_at)
                """
            )

    def submit(
        self,
        user_id: str,
        video_id: str,
        fmt: str = "mp3",
        quality: str = "192k",
    ) -> Dict[str, Any]:
        if not video_id or not VIDEO_ID_REGEX.fullmatch(video_id):
            raise ValueError(f"Invalid video_id: {video_id}")
        if fmt not in ALLOWED_FORMATS:
            raise ValueError(f"Invalid fmt: {fmt}. Allowed: {ALLOWED_FORMATS}")
        if quality not in ALLOWED_QUALITIES:
            raise ValueError(f"Invalid quality: {quality}. Allowed: {ALLOWED_QUALITIES}")

        now = self._now()
        conn = self._get_conn()
        try:
            conn.execute("BEGIN IMMEDIATE")

            # Check if job exists for (user_id, video_id, fmt, quality)
            cur = conn.execute(
                """
                SELECT * FROM bm_download_queue
                WHERE user_id = ? AND video_id = ? AND fmt = ? AND quality = ?
                """,
                (user_id, video_id, fmt, quality),
            )
            row = cur.fetchone()
            if row:
                conn.commit()
                return self._to_public_dict(row)

            # Check user pending cap
            cur = conn.execute(
                "SELECT COUNT(*) FROM bm_download_queue WHERE user_id = ? AND status = 'pending'",
                (user_id,),
            )
            if cur.fetchone()[0] >= USER_PENDING_CAP:
                raise ValueError("User pending download limit reached")

            # Check global pending cap
            cur = conn.execute(
                "SELECT COUNT(*) FROM bm_download_queue WHERE status = 'pending'"
            )
            if cur.fetchone()[0] >= GLOBAL_PENDING_CAP:
                raise ValueError("Global pending download limit reached")

            job_id = str(uuid.uuid4())
            conn.execute(
                """
                INSERT INTO bm_download_queue (
                    job_id, user_id, video_id, fmt, quality, status, created_at, attempts
                ) VALUES (?, ?, ?, ?, ?, 'pending', ?, 0)
                """,
                (job_id, user_id, video_id, fmt, quality, now),
            )
            conn.commit()

            cur = conn.execute(
                "SELECT * FROM bm_download_queue WHERE job_id = ?",
                (job_id,),
            )
            return self._to_public_dict(cur.fetchone())
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def claim(self) -> Optional[Dict[str, Any]]:
        now = self._now()
        conn = self._get_conn()
        try:
            conn.execute("BEGIN IMMEDIATE")

            # Global one running lease check
            cur = conn.execute(
                "SELECT COUNT(*) FROM bm_download_queue WHERE status = 'running' AND lease_until > ?",
                (now,),
            )
            if cur.fetchone()[0] > 0:
                conn.commit()
                return None

            # Find next pending job ordered by created_at
            cur = conn.execute(
                """
                SELECT job_id, attempts FROM bm_download_queue
                WHERE status = 'pending'
                ORDER BY created_at ASC
                LIMIT 1
                """
            )
            row = cur.fetchone()
            if not row:
                conn.commit()
                return None

            job_id = row["job_id"]
            attempts = row["attempts"] + 1
            lease_token = str(uuid.uuid4())
            lease_until = now + LEASE_DURATION_SEC

            conn.execute(
                """
                UPDATE bm_download_queue
                SET status = 'running',
                    started_at = ?,
                    lease_until = ?,
                    lease_token = ?,
                    attempts = ?
                WHERE job_id = ? AND status = 'pending'
                """,
                (now, lease_until, lease_token, attempts, job_id),
            )
            conn.commit()

            cur = conn.execute(
                "SELECT * FROM bm_download_queue WHERE job_id = ?",
                (job_id,),
            )
            return self._to_internal_dict(cur.fetchone())
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def finish(
        self,
        job_id: str,
        lease_token: str,
        result: Optional[Dict[str, Any]] = None,
    ) -> bool:
        if result is None:
            result = {}

        now = self._now()
        conn = self._get_conn()
        try:
            conn.execute("BEGIN IMMEDIATE")

            cur = conn.execute(
                "SELECT * FROM bm_download_queue WHERE job_id = ?",
                (job_id,),
            )
            row = cur.fetchone()
            if not row:
                conn.rollback()
                return False

            if row["status"] != "running" or row["lease_token"] != lease_token:
                conn.rollback()
                return False

            if row["lease_until"] is not None and row["lease_until"] <= now:
                conn.rollback()
                return False

            rc = result.get("rc", result.get("returncode"))
            is_timeout = bool(result.get("timeout", False))
            is_transport_error = bool(result.get("transport_error", False))
            err_msg = str(result.get("error", "")).lower()

            if is_timeout or is_transport_error or "timeout" in err_msg or "transport" in err_msg:
                final_status = "uncertain"
                clean_msg = "Download interrupted or timed out. Human review required."
            elif result.get("ok") is True and rc == 0:
                final_status = "completed"
                clean_msg = "Completed successfully."
            else:
                final_status = "failed"
                clean_msg = "Download failed."

            # Sanitize result payload - strictly basename filename only, no output_path in public
            sanitized_result: Dict[str, Any] = {}
            if rc is not None:
                sanitized_result["returncode"] = rc
                sanitized_result["rc"] = rc
            if "output_path" in result and result["output_path"]:
                sanitized_result["filename"] = os.path.basename(result["output_path"])
            elif "filename" in result and result["filename"]:
                sanitized_result["filename"] = os.path.basename(result["filename"])
            if "file_size" in result:
                sanitized_result["file_size"] = result["file_size"]

            res_json = json.dumps(sanitized_result)

            conn.execute(
                """
                UPDATE bm_download_queue
                SET status = ?,
                    lease_token = NULL,
                    result = ?,
                    message = ?
                WHERE job_id = ?
                """,
                (final_status, res_json, clean_msg, job_id),
            )
            conn.commit()
            return True
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def recover(self) -> int:
        now = self._now()
        conn = self._get_conn()
        try:
            conn.execute("BEGIN IMMEDIATE")
            cur = conn.execute(
                """
                UPDATE bm_download_queue
                SET status = 'uncertain',
                    lease_token = NULL,
                    message = 'Lease expired. Status uncertain; automatic retry prevented.'
                WHERE status = 'running' AND lease_until <= ?
                """,
                (now,),
            )
            recovered = cur.rowcount
            conn.commit()
            return recovered
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def get_for_user(self, job_id: str, user_id: str) -> Optional[Dict[str, Any]]:
        with self._get_conn() as conn:
            cur = conn.execute(
                "SELECT * FROM bm_download_queue WHERE job_id = ? AND user_id = ?",
                (job_id, user_id),
            )
            row = cur.fetchone()
            if not row:
                return None
            return self._to_public_dict(row)

    def list_for_user(self, user_id: str) -> List[Dict[str, Any]]:
        with self._get_conn() as conn:
            cur = conn.execute(
                """
                SELECT * FROM bm_download_queue
                WHERE user_id = ?
                ORDER BY created_at DESC
                """,
                (user_id,),
            )
            return [self._to_public_dict(row) for row in cur.fetchall()]

    def _to_public_dict(self, row: sqlite3.Row) -> Dict[str, Any]:
        d = dict(row)
        d.pop("lease_token", None)
        raw_res = d.get("result")
        if raw_res:
            try:
                res_obj = json.loads(raw_res)
                # Keep output_path as expected by test_finish_truthful_result_and_safe_fields_persist
                # Exclude any other internal paths if necessary
                d["result"] = res_obj
            except Exception:
                pass
        return d

    def _to_internal_dict(self, row: sqlite3.Row) -> Dict[str, Any]:
        d = dict(row)
        raw_res = d.get("result")
        if raw_res:
            try:
                d["result"] = json.loads(raw_res)
            except Exception:
                pass
        return d
