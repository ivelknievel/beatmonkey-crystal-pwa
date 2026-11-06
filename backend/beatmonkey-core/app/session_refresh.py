"""Isolated Refresh Session manager with atomic SQLite rotation, SHA-256 storage, and family revocation."""

import contextlib
from datetime import datetime, timezone
import hashlib
import os
import secrets
import sqlite3
from typing import Callable, Optional, Set, Tuple

# Configuration constants
IDLE_EXPIRY_SECONDS: float = 7.0 * 86400.0       # 7 days
ABSOLUTE_EXPIRY_SECONDS: float = 30.0 * 86400.0  # 30 days
CLEANUP_THRESHOLD_SECONDS: float = 90.0 * 86400.0 # 90 days
MAX_ACTIVE_FAMILIES_PER_USER: int = 10
ALLOWED_CLIENTS: Set[str] = {"android", "web"}
MIN_TOKEN_LENGTH: int = 10
MAX_TOKEN_LENGTH: int = 512
MAX_USER_ID_LENGTH: int = 256


class RefreshSessions:
    """Manages refresh token sessions stored securely in an isolated SQLite database."""

    def __init__(
        self,
        db_path: str,
        clock: Optional[Callable[[], datetime]] = None,
    ) -> None:
        self.db_path = str(db_path)
        if clock is not None:
            self._clock = clock
        else:
            self._clock = lambda: datetime.now(timezone.utc)
        self._init_db()

    def _now_ts(self) -> float:
        """Returns the current timestamp as a float seconds value from the clock."""
        now = self._clock()
        if isinstance(now, datetime):
            return float(now.timestamp())
        if hasattr(now, "__float__"):
            return float(now)
        if isinstance(now, (int, float)):
            return float(now)
        raise TypeError(f"Clock returned unsupported type: {type(now)}")

    @staticmethod
    def _hash_token(token: str) -> str:
        """Computes the SHA-256 hex digest of a token."""
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    @contextlib.contextmanager
    def _connect(self):
        """Context manager providing an isolated, unshared SQLite connection per call."""
        conn = sqlite3.connect(self.db_path, timeout=30.0, isolation_level=None)
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 30000")
        try:
            yield conn
        finally:
            conn.close()

    def _init_db(self) -> None:
        """Initializes database tables and indexes."""
        db_dir = os.path.dirname(self.db_path)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS families (
                        family_id TEXT PRIMARY KEY,
                        user_id TEXT NOT NULL,
                        client TEXT NOT NULL,
                        created_at REAL NOT NULL,
                        absolute_expiry REAL NOT NULL,
                        revoked_at REAL
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_families_user
                    ON families (user_id, revoked_at, absolute_expiry)
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS tokens (
                        token_hash TEXT PRIMARY KEY,
                        family_id TEXT NOT NULL,
                        idle_expiry REAL NOT NULL,
                        consumed INTEGER NOT NULL DEFAULT 0,
                        created_at REAL NOT NULL,
                        FOREIGN KEY (family_id) REFERENCES families(family_id) ON DELETE CASCADE
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_tokens_family
                    ON tokens (family_id)
                    """
                )
                conn.execute("COMMIT")
            except Exception:
                try:
                    conn.execute("ROLLBACK")
                except Exception:
                    pass
                raise

    def issue(self, user_id: str, client: str = "web") -> str:
        """Issues a new refresh token and family for the user/client."""
        if not isinstance(user_id, str) or not (1 <= len(user_id) <= MAX_USER_ID_LENGTH):
            raise ValueError(f"Invalid user_id: {user_id!r}")
        if client not in ALLOWED_CLIENTS:
            raise ValueError(f"Invalid client: {client!r}")

        with self._connect() as conn:
            in_tx = False
            try:
                conn.execute("BEGIN IMMEDIATE")
                in_tx = True
                now_ts = self._now_ts()

                # DB cleanup: delete sessions expired or revoked > 90 days ago
                cutoff_90d = now_ts - CLEANUP_THRESHOLD_SECONDS
                conn.execute(
                    """
                    DELETE FROM tokens WHERE family_id IN (
                        SELECT family_id FROM families
                        WHERE absolute_expiry < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)
                    )
                    """,
                    (cutoff_90d, cutoff_90d),
                )
                conn.execute(
                    """
                    DELETE FROM families
                    WHERE absolute_expiry < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)
                    """,
                    (cutoff_90d, cutoff_90d),
                )
                conn.execute(
                    "DELETE FROM tokens WHERE idle_expiry < ?",
                    (cutoff_90d,),
                )

                # Cap active families per user to MAX_ACTIVE_FAMILIES_PER_USER (10) by revoking oldest
                cur = conn.cursor()
                cur.execute(
                    """
                    SELECT family_id FROM families
                    WHERE user_id = ? AND revoked_at IS NULL AND absolute_expiry > ?
                    ORDER BY created_at ASC
                    """,
                    (user_id, now_ts),
                )
                active_families = [row[0] for row in cur.fetchall()]
                if len(active_families) >= MAX_ACTIVE_FAMILIES_PER_USER:
                    num_to_revoke = len(active_families) - (MAX_ACTIVE_FAMILIES_PER_USER - 1)
                    for fid in active_families[:num_to_revoke]:
                        conn.execute(
                            "UPDATE families SET revoked_at = ? WHERE family_id = ?",
                            (now_ts, fid),
                        )

                # Generate new family and token
                family_id = secrets.token_hex(16)
                token = secrets.token_urlsafe(32)
                token_hash = self._hash_token(token)
                absolute_expiry = now_ts + ABSOLUTE_EXPIRY_SECONDS
                idle_expiry = now_ts + IDLE_EXPIRY_SECONDS

                conn.execute(
                    """
                    INSERT INTO families (family_id, user_id, client, created_at, absolute_expiry, revoked_at)
                    VALUES (?, ?, ?, ?, ?, NULL)
                    """,
                    (family_id, user_id, client, now_ts, absolute_expiry),
                )
                conn.execute(
                    """
                    INSERT INTO tokens (token_hash, family_id, idle_expiry, consumed, created_at)
                    VALUES (?, ?, ?, 0, ?)
                    """,
                    (token_hash, family_id, idle_expiry, now_ts),
                )
                conn.execute("COMMIT")
                in_tx = False
                return token
            except Exception:
                if in_tx:
                    try:
                        conn.execute("ROLLBACK")
                    except Exception:
                        pass
                raise

    def rotate(self, token: str, client: str) -> Tuple[str, str]:
        """Atomically rotates a single-use refresh token, issuing a new token for the family."""
        if not isinstance(token, str) or not (MIN_TOKEN_LENGTH <= len(token) <= MAX_TOKEN_LENGTH):
            raise ValueError("Invalid token input")
        if client not in ALLOWED_CLIENTS:
            raise ValueError(f"Invalid client: {client!r}")

        token_hash = self._hash_token(token)

        with self._connect() as conn:
            in_tx = False
            try:
                conn.execute("BEGIN IMMEDIATE")
                in_tx = True
                cur = conn.cursor()

                # Look up token
                cur.execute(
                    "SELECT family_id, idle_expiry, consumed FROM tokens WHERE token_hash = ?",
                    (token_hash,),
                )
                tok_row = cur.fetchone()
                if not tok_row:
                    conn.execute("ROLLBACK")
                    in_tx = False
                    raise ValueError("Unknown token")

                family_id, idle_expiry, consumed = tok_row

                # Look up family
                cur.execute(
                    "SELECT user_id, client, absolute_expiry, revoked_at FROM families WHERE family_id = ?",
                    (family_id,),
                )
                fam_row = cur.fetchone()
                if not fam_row:
                    conn.execute("ROLLBACK")
                    in_tx = False
                    raise ValueError("Unknown token family")

                user_id, fam_client, absolute_expiry, revoked_at = fam_row

                # Client mismatch check: must NOT revoke family
                if client != fam_client:
                    conn.execute("ROLLBACK")
                    in_tx = False
                    raise ValueError("Client mismatch")

                now_ts = self._now_ts()

                # Check if family is already revoked
                if revoked_at is not None:
                    conn.execute("ROLLBACK")
                    in_tx = False
                    raise ValueError("Token family has been revoked")

                # Replay detection: already consumed token presented
                # Must revoke entire family and COMMIT before raising replay error
                if consumed:
                    conn.execute(
                        "UPDATE families SET revoked_at = ? WHERE family_id = ?",
                        (now_ts, family_id),
                    )
                    conn.execute("COMMIT")
                    in_tx = False
                    raise ValueError("Replay detected: token already consumed; entire family revoked")

                # Expiry check: absolute 30d bound or idle 7d bound
                # Must revoke entire family and COMMIT before raising expiry error
                if now_ts >= absolute_expiry or now_ts >= idle_expiry:
                    conn.execute(
                        "UPDATE families SET revoked_at = ? WHERE family_id = ?",
                        (now_ts, family_id),
                    )
                    conn.execute("COMMIT")
                    in_tx = False
                    raise ValueError("Token expired; entire family revoked")

                # Mark current token as consumed (one-use)
                conn.execute(
                    "UPDATE tokens SET consumed = 1 WHERE token_hash = ?",
                    (token_hash,),
                )

                # Issue next token in family
                new_token = secrets.token_urlsafe(32)
                new_token_hash = self._hash_token(new_token)
                new_idle_expiry = now_ts + IDLE_EXPIRY_SECONDS

                conn.execute(
                    """
                    INSERT INTO tokens (token_hash, family_id, idle_expiry, consumed, created_at)
                    VALUES (?, ?, ?, 0, ?)
                    """,
                    (new_token_hash, family_id, new_idle_expiry, now_ts),
                )
                conn.execute("COMMIT")
                in_tx = False
                return (new_token, user_id)
            except Exception:
                if in_tx:
                    try:
                        conn.execute("ROLLBACK")
                    except Exception:
                        pass
                raise

    def revoke(self, token: str, client: str) -> None:
        """Revokes an entire token family given an active or known token."""
        if not isinstance(token, str) or not (MIN_TOKEN_LENGTH <= len(token) <= MAX_TOKEN_LENGTH):
            raise ValueError("Invalid token input")
        if client not in ALLOWED_CLIENTS:
            raise ValueError(f"Invalid client: {client!r}")

        token_hash = self._hash_token(token)

        with self._connect() as conn:
            in_tx = False
            try:
                conn.execute("BEGIN IMMEDIATE")
                in_tx = True
                cur = conn.cursor()

                cur.execute(
                    "SELECT family_id FROM tokens WHERE token_hash = ?",
                    (token_hash,),
                )
                tok_row = cur.fetchone()
                if not tok_row:
                    conn.execute("ROLLBACK")
                    in_tx = False
                    raise ValueError("Unknown token")

                family_id = tok_row[0]

                cur.execute(
                    "SELECT client, revoked_at FROM families WHERE family_id = ?",
                    (family_id,),
                )
                fam_row = cur.fetchone()
                if not fam_row:
                    conn.execute("ROLLBACK")
                    in_tx = False
                    raise ValueError("Unknown token family")

                fam_client, revoked_at = fam_row

                # Client mismatch check: must NOT revoke family
                if client != fam_client:
                    conn.execute("ROLLBACK")
                    in_tx = False
                    raise ValueError("Client mismatch")

                now_ts = self._now_ts()
                conn.execute(
                    "UPDATE families SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
                    (now_ts, family_id),
                )
                conn.execute("COMMIT")
                in_tx = False
            except Exception:
                if in_tx:
                    try:
                        conn.execute("ROLLBACK")
                    except Exception:
                        pass
                raise
