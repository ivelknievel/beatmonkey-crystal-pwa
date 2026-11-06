"""Tests for isolated session_refresh.py module.

Verifies intended API:
- RefreshSessions(db_path, [clock=...])
- issue(user_id, client="android"|"web") -> opaque token (random 32 bytes)
- rotate(token, client) -> (new_token, user_id)
- revoke(token, client)
- Tokens SHA256 hashed only in DB
- Idle 7-day and absolute 30-day bounds
- Reject unknown, expired, revoked, and replayed tokens
- Replay detection revokes entire token family
- Client mismatch fails closed without affecting rightful account
- Atomic simultaneous rotations fail closed
- Temp SQLite DB support & controlled clock support
"""

import hashlib
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
from datetime import datetime, timedelta, timezone
import unittest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT / "app") not in sys.path:
    sys.path.insert(0, str(ROOT / "app"))

# Intended isolated module import (fails RED until implemented)
from app.session_refresh import RefreshSessions


class ControlledClockTime(datetime):
    def __float__(self):
        return self.timestamp()


class ControlledClock:
    def __init__(self, initial_dt: datetime = None):
        self._dt = initial_dt or ControlledClockTime(2026, 11, 6, 12, 0, 0, tzinfo=timezone.utc)

    def __call__(self):
        return self._dt

    def advance(self, td: timedelta):
        self._dt = ControlledClockTime.fromtimestamp(self._dt.timestamp() + td.total_seconds(), tz=timezone.utc)


class TestSessionRefresh(unittest.TestCase):
    def setUp(self):
        self.clock = ControlledClock()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.temp_dir.name, "sessions.sqlite")
        self.sessions = RefreshSessions(self.db_path, clock=self.clock)

    def tearDown(self):
        self.temp_dir.cleanup()

    def _get_all_db_text_and_blobs(self):
        """Helper to dump all cell contents from SQLite DB to verify token hashing."""
        conn = sqlite3.connect(self.db_path)
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type=\"table\"")
        tables = [r[0] for r in cur.fetchall()]
        all_values = []
        for t in tables:
            cur.execute(f"SELECT * FROM {t}")
            for row in cur.fetchall():
                for col in row:
                    if isinstance(col, (str, bytes)):
                        all_values.append(col if isinstance(col, str) else col.hex())
        conn.close()
        return all_values

    def test_issue_opaque_random_32_bytes_token(self):
        """issue() returns random 32-byte opaque token string."""
        token = self.sessions.issue("user_101", client="web")
        self.assertIsInstance(token, str)
        # 32 bytes is 64 hex chars or >=43 base64url chars
        self.assertGreaterEqual(len(token), 43)

        # Issue second token: tokens must be unique/random
        token2 = self.sessions.issue("user_101", client="web")
        self.assertNotEqual(token, token2)

    def test_tokens_hashed_only_in_db_never_plaintext(self):
        """Tokens are SHA256 hashed only in SQLite DB, never stored plaintext."""
        token = self.sessions.issue("user_privacy", client="web")
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()

        db_values = self._get_all_db_text_and_blobs()
        # Plaintext token must NEVER appear anywhere in the database
        for val in db_values:
            self.assertNotIn(token, val, "Plaintext token leaked into SQLite database!")

        # SHA256 hash MUST appear in the database
        hash_found = any(token_hash in val for val in db_values)
        self.assertTrue(hash_found, "SHA-256 hash of token not found in database records")

    def test_client_validation_on_issue(self):
        """issue() accepts \"android\" and \"web\", rejecting unknown clients."""
        t_web = self.sessions.issue("user_1", client="web")
        self.assertIsInstance(t_web, str)

        t_android = self.sessions.issue("user_2", client="android")
        self.assertIsInstance(t_android, str)

        with self.assertRaises(Exception):
            self.sessions.issue("user_3", client="ios")

        with self.assertRaises(Exception):
            self.sessions.issue("user_4", client="")

    def test_rotate_success_contract(self):
        """rotate(token, client) returns (new_token, user_id)."""
        t1 = self.sessions.issue("user_42", client="web")
        res = self.sessions.rotate(t1, client="web")
        self.assertIsInstance(res, tuple)
        self.assertEqual(len(res), 2)
        t2, user_id = res
        self.assertEqual(user_id, "user_42")
        self.assertIsInstance(t2, str)
        self.assertGreaterEqual(len(t2), 43)
        self.assertNotEqual(t1, t2)

        # Ensure t2 is hashed in DB and not plaintext
        db_values = self._get_all_db_text_and_blobs()
        self.assertNotIn(t2, db_values)
        t2_hash = hashlib.sha256(t2.encode("utf-8")).hexdigest()
        self.assertTrue(any(t2_hash in val for val in db_values))

    def test_rotate_rejects_unknown_token(self):
        """Rotating an unknown/forged token fails closed."""
        fake_token = "f" * 64
        with self.assertRaises(Exception):
            self.sessions.rotate(fake_token, client="web")

    def test_rotate_rejects_client_mismatch_without_affecting_rightful_account(self):
        """Client mismatch must fail closed and NOT affect rightful account."""
        t1 = self.sessions.issue("user_mismatch", client="web")

        # Wrong client fails closed
        with self.assertRaises(Exception):
            self.sessions.rotate(t1, client="android")

        # Rightful client can still rotate normally
        t2, user_id = self.sessions.rotate(t1, client="web")
        self.assertEqual(user_id, "user_mismatch")
        self.assertNotEqual(t1, t2)

    def test_revoke_token_and_reject_subsequent_rotation(self):
        """revoke(token, client) revokes token, rejecting subsequent rotations."""
        t1 = self.sessions.issue("user_rev", client="web")
        self.sessions.revoke(t1, client="web")

        # Subsequent rotation of revoked token must be rejected
        with self.assertRaises(Exception):
            self.sessions.rotate(t1, client="web")

    def test_revoke_client_mismatch_preserves_rightful_session(self):
        """Revoke with mismatched client fails and does NOT revoke rightful session."""
        t1 = self.sessions.issue("user_rev_preserve", client="web")

        with self.assertRaises(Exception):
            self.sessions.revoke(t1, client="android")

        # Rightful account remains active and rotatable
        t2, user_id = self.sessions.rotate(t1, client="web")
        self.assertEqual(user_id, "user_rev_preserve")

    def test_idle_7_day_expiry(self):
        """Tokens expire after 7 days of inactivity (idle bound)."""
        t1 = self.sessions.issue("user_idle", client="web")

        # Active rotation within 7 days (e.g. at 6 days 23 hours) succeeds
        self.clock.advance(timedelta(days=6, hours=23))
        t2, uid = self.sessions.rotate(t1, client="web")
        self.assertEqual(uid, "user_idle")

        # Exceeding 7 days idle without rotation fails
        self.clock.advance(timedelta(days=7, seconds=1))
        with self.assertRaises(Exception):
            self.sessions.rotate(t2, client="web")

    def test_absolute_30_day_bound(self):
        """Tokens expire after 30 days absolute lifetime regardless of activity."""
        t_curr = self.sessions.issue("user_abs", client="web")

        # Rotate every 5 days for 5 cycles (25 days elapsed)
        for _ in range(5):
            self.clock.advance(timedelta(days=5))
            t_curr, uid = self.sessions.rotate(t_curr, client="web")
            self.assertEqual(uid, "user_abs")

        # At day 25, advance 5 days and 1 second (total 30 days and 1s from initial issue)
        self.clock.advance(timedelta(days=5, seconds=1))
        with self.assertRaises(Exception):
            self.sessions.rotate(t_curr, client="web")

    def test_replay_detection_revokes_entire_token_family(self):
        """Replaying a previously rotated token revokes the entire token family."""
        t1 = self.sessions.issue("user_fam", client="web")
        t2, _ = self.sessions.rotate(t1, client="web")
        t3, _ = self.sessions.rotate(t2, client="web")

        # Legitimate user holds t3. Attacker replays already consumed t1:
        with self.assertRaises(Exception):
            self.sessions.rotate(t1, client="web")

        # Replay detection MUST have revoked the entire family:
        # Legitimate active token t3 must now be rejected!
        with self.assertRaises(Exception):
            self.sessions.rotate(t3, client="web")

    def test_atomic_simultaneous_rotations_fail_closed(self):
        """Simultaneous concurrent rotations fail closed: at most one succeeds."""
        t1 = self.sessions.issue("user_concurrent", client="web")

        results = []
        errors = []
        barrier = threading.Barrier(2)

        def worker():
            barrier.wait()
            try:
                res = self.sessions.rotate(t1, client="web")
                results.append(res)
            except Exception as e:
                errors.append(e)

        th1 = threading.Thread(target=worker)
        th2 = threading.Thread(target=worker)
        th1.start()
        th2.start()
        th1.join()
        th2.join()

        # At most one can succeed, or both fail closed; never both succeed.
        self.assertLessEqual(len(results), 1, "Both concurrent rotations succeeded! Divergent tokens issued!")
        self.assertEqual(len(results) + len(errors), 2)

    def test_temp_sqlite_db_isolation(self):
        """RefreshSessions operates on isolated SQLite database file."""
        with tempfile.NamedTemporaryFile(suffix=".sqlite") as tf:
            iso_sessions = RefreshSessions(tf.name)
            token = iso_sessions.issue("user_iso", client="android")
            self.assertIsInstance(token, str)


if __name__ == "__main__":
    unittest.main()
