import os
from pathlib import Path
import sys
import pytest
import sqlite3
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT / "app") not in sys.path:
    sys.path.insert(0, str(ROOT / "app"))

# RED test import: app.download_queue does not exist yet
from app.download_queue import DownloadQueue


class FakeClock:
    def __init__(self, start_time: float = 1000.0):
        self._time = start_time

    def time(self) -> float:
        return self._time

    def advance(self, seconds: float):
        self._time += seconds


@pytest.fixture
def temp_db(tmp_path):
    return str(tmp_path / "queue.db")


@pytest.fixture
def fake_clock():
    return FakeClock(1700000000.0)


@pytest.fixture
def queue(temp_db, fake_clock):
    return DownloadQueue(db_path=temp_db, clock=fake_clock.time)


def test_validation_video_id(queue):
    # Strict 11-char video ID
    with pytest.raises(ValueError):
        queue.submit("user1", "short", fmt="mp3", quality="192k")
    with pytest.raises(ValueError):
        queue.submit("user1", "toolongvideoid123", fmt="mp3", quality="192k")
    with pytest.raises(ValueError):
        queue.submit("user1", "invalid!char", fmt="mp3", quality="192k")

    # Valid 11-char video id
    job = queue.submit("user1", "dQw4w9WgXcQ", fmt="mp3", quality="192k")
    assert job is not None
    assert "job_id" in job
    assert job["status"] == "pending"


def test_validation_format_and_quality(queue):
    # fmt only mp3
    with pytest.raises(ValueError):
        queue.submit("user1", "dQw4w9WgXcQ", fmt="mp4", quality="192k")
    with pytest.raises(ValueError):
        queue.submit("user1", "dQw4w9WgXcQ", fmt="m4a", quality="192k")

    # quality allowlist: 128k, 192k, 256k, 320k
    with pytest.raises(ValueError):
        queue.submit("user1", "dQw4w9WgXcQ", fmt="mp3", quality="64k")
    with pytest.raises(ValueError):
        queue.submit("user1", "dQw4w9WgXcQ", fmt="mp3", quality="500k")

    for q in ["128k", "192k", "256k", "320k"]:
        # Different video ids to avoid duplicate collision
        vid = f"vid{q:>08s}"[:11]
        job = queue.submit("user1", vid, fmt="mp3", quality=q)
        assert job["job_id"] is not None


def test_concurrent_duplicate_submit_returns_same_id(temp_db, fake_clock):
    # Dedupe unique active/success per user/video/fmt/quality concurrent atomic
    q1 = DownloadQueue(db_path=temp_db, clock=fake_clock.time)
    results = []

    def do_submit():
        q = DownloadQueue(db_path=temp_db, clock=fake_clock.time)
        res = q.submit("user1", "dQw4w9WgXcQ", fmt="mp3", quality="192k")
        results.append(res["job_id"])

    threads = [threading.Thread(target=do_submit) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(results) == 5
    assert len(set(results)) == 1, "Concurrent duplicate submit must return identical job_id"


def test_users_isolated_for_same_video(queue):
    job1 = queue.submit("user1", "dQw4w9WgXcQ", fmt="mp3", quality="192k")
    job2 = queue.submit("user2", "dQw4w9WgXcQ", fmt="mp3", quality="192k")
    assert job1["job_id"] != job2["job_id"]


def test_unauthorized_owner_get_returns_none(queue):
    job = queue.submit("user1", "dQw4w9WgXcQ", fmt="mp3", quality="192k")
    job_id = job["job_id"]

    # Owner gets job
    assert queue.get_for_user(job_id, "user1") is not None
    # Non-owner gets None
    assert queue.get_for_user(job_id, "user2") is None


def test_list_for_user(queue):
    queue.submit("user1", "dQw4w9WgXc1", fmt="mp3", quality="192k")
    queue.submit("user1", "dQw4w9WgXc2", fmt="mp3", quality="192k")
    queue.submit("user2", "dQw4w9WgXc3", fmt="mp3", quality="192k")

    u1_jobs = queue.list_for_user("user1")
    assert len(u1_jobs) == 2
    for j in u1_jobs:
        assert j["user_id"] == "user1"

    u2_jobs = queue.list_for_user("user2")
    assert len(u2_jobs) == 1
    assert u2_jobs[0]["user_id"] == "user2"


def test_cap_pending_per_user_and_global(queue):
    # Cap pending per user: 10
    for i in range(10):
        vid = f"viduser1_{i:02d}"
        queue.submit("user_limit", vid, fmt="mp3", quality="192k")

    with pytest.raises(Exception):
        queue.submit("user_limit", "viduser1_10", fmt="mp3", quality="192k")

    # Global cap: 100
    # Fill remaining up to 100 across other users
    for i in range(90):
        uid = f"user_g_{i//9}"
        vid = f"vg_{i:08d}"[:11]
        queue.submit(uid, vid, fmt="mp3", quality="192k")

    # 101st submit should fail global cap
    with pytest.raises(Exception):
        queue.submit("brand_new_u", "vnewglobal1", fmt="mp3", quality="192k")


def test_restart_queued_persists_and_claims_once(temp_db, fake_clock):
    q1 = DownloadQueue(db_path=temp_db, clock=fake_clock.time)
    job = q1.submit("user1", "dQw4w9WgXcQ", fmt="mp3", quality="192k")

    # Simulate process restart with new instance
    q2 = DownloadQueue(db_path=temp_db, clock=fake_clock.time)
    claim1 = q2.claim()
    assert claim1 is not None
    assert claim1["job_id"] == job["job_id"]
    assert claim1["attempts"] == 1
    assert "lease_token" in claim1
    assert "started_at" in claim1
    assert "lease_until" in claim1

    # Second claim should find nothing because job is currently leased/running
    claim2 = q2.claim()
    assert claim2 is None


def test_only_one_global_running_lease(queue):
    queue.submit("user1", "dQw4w9WgXc1", fmt="mp3", quality="192k")
    queue.submit("user2", "dQw4w9WgXc2", fmt="mp3", quality="192k")

    first_claim = queue.claim()
    assert first_claim is not None

    # Only one global running lease allowed at a time
    second_claim = queue.claim()
    assert second_claim is None


def test_stale_lease_finish_rejected(queue, fake_clock):
    queue.submit("user1", "dQw4w9WgXcQ", fmt="mp3", quality="192k")
    claimed = queue.claim()
    job_id = claimed["job_id"]
    token = claimed["lease_token"]

    # Wrong / stale lease token
    res = queue.finish(job_id, "wrong_token", {"returncode": 0})
    assert res is False

    # Check job is still running, not finished
    j = queue.get_for_user(job_id, "user1")
    assert j["status"] == "running"


def test_finish_truthful_result_and_safe_fields_persist(queue):
    queue.submit("user1", "dQw4w9WgXcQ", fmt="mp3", quality="192k")
    claimed = queue.claim()
    job_id = claimed["job_id"]
    token = claimed["lease_token"]

    raw_result = {
        "ok": True,
        "returncode": 0,
        "output_path": "/var/media/audio.mp3",
        "file_size": 1024,
        "stdout": "SECRET_BEARER_TOKEN_IN_OUTPUT",
        "secrets": "super_secret_auth",
    }

    ok = queue.finish(job_id, token, raw_result)
    assert ok is True

    record = queue.get_for_user(job_id, "user1")
    assert record["status"] == "completed"

    stored_result = record.get("result", {})
    if isinstance(stored_result, str):
        import json
        stored_result = json.loads(stored_result)

    assert stored_result.get("returncode") == 0
    assert "stdout" not in stored_result
    assert "secrets" not in stored_result
    assert "output_path" not in stored_result
    assert stored_result.get("filename") == "audio.mp3"


def test_finish_empty_and_worker_error_not_completed(queue):
    # Empty result {} -> not completed (failed)
    queue.submit("user1", "dQw4w9WgXcE", fmt="mp3", quality="192k")
    c_empty = queue.claim()
    assert queue.finish(c_empty["job_id"], c_empty["lease_token"], {}) is True
    j_empty = queue.get_for_user(c_empty["job_id"], "user1")
    assert j_empty["status"] != "completed"
    assert j_empty["status"] == "failed"

    # {ok: true, rc: 1} -> not completed (failed)
    queue.submit("user1", "dQw4w9WgXcF", fmt="mp3", quality="192k")
    c_rc1 = queue.claim()
    assert queue.finish(c_rc1["job_id"], c_rc1["lease_token"], {"ok": True, "rc": 1}) is True
    j_rc1 = queue.get_for_user(c_rc1["job_id"], "user1")
    assert j_rc1["status"] != "completed"
    assert j_rc1["status"] == "failed"

    # transport_error: True -> uncertain
    queue.submit("user1", "dQw4w9WgXcG", fmt="mp3", quality="192k")
    c_trans = queue.claim()
    assert queue.finish(c_trans["job_id"], c_trans["lease_token"], {"transport_error": True}) is True
    j_trans = queue.get_for_user(c_trans["job_id"], "user1")
    assert j_trans["status"] == "uncertain"


def test_finish_failed_or_transport_timeout_uncertain(queue):
    # Test failed with non-zero returncode
    queue.submit("user1", "dQw4w9WgXc1", fmt="mp3", quality="192k")
    c1 = queue.claim()
    assert queue.finish(c1["job_id"], c1["lease_token"], {"returncode": 1, "error": "Download failed"}) is True
    j1 = queue.get_for_user(c1["job_id"], "user1")
    assert j1["status"] == "failed"

    # Test transport timeout marked uncertain
    queue.submit("user2", "dQw4w9WgXc2", fmt="mp3", quality="192k")
    c2 = queue.claim()
    assert queue.finish(c2["job_id"], c2["lease_token"], {"returncode": -1, "error": "transport timeout", "timeout": True}) is True
    j2 = queue.get_for_user(c2["job_id"], "user2")
    assert j2["status"] == "uncertain"


def test_expired_running_recover_must_mark_uncertain(queue, fake_clock):
    queue.submit("user1", "dQw4w9WgXcQ", fmt="mp3", quality="192k")
    c = queue.claim()
    job_id = c["job_id"]

    # Clock advances past lease_until
    fake_clock.advance(1000.0)

    recovered_count = queue.recover()
    assert recovered_count == 1

    # Truthful: must mark uncertain (not auto-retry) as worker might still publish
    j = queue.get_for_user(job_id, "user1")
    assert j["status"] == "uncertain"

    # Claim next should NOT return this uncertain job (never auto-resubmitted)
    assert queue.claim() is None


def test_failed_and_uncertain_retry_policy_no_automatic_duplicate(queue):
    # When uncertain, submit should return existing uncertain requiring deliberate action
    queue.submit("user1", "dQw4w9WgXcQ", fmt="mp3", quality="192k")
    c = queue.claim()
    queue.finish(c["job_id"], c["lease_token"], {"returncode": -1, "timeout": True})

    j_before = queue.get_for_user(c["job_id"], "user1")
    assert j_before["status"] == "uncertain"

    # Re-submitting returns existing uncertain job
    resubmitted = queue.submit("user1", "dQw4w9WgXcQ", fmt="mp3", quality="192k")
    assert resubmitted["job_id"] == c["job_id"]
    assert resubmitted["status"] == "uncertain"
