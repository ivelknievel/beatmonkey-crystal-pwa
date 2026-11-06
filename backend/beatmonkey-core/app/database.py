import os
import sqlite3
import re
import logging
from typing import Optional

logger = logging.getLogger(__name__)

CORE_DB_PATH = os.getenv("CORE_DB_PATH", "/data/core.db")
NAVIDROME_DB_PATH = os.getenv("NAVIDROME_DB_PATH", "/navidrome_data/navidrome.db")
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "ivo.menzo@gmail.com")

def get_db():
    db_dir = os.path.dirname(CORE_DB_PATH)
    if db_dir and not os.path.exists(db_dir):
        os.makedirs(db_dir, exist_ok=True)
    conn = sqlite3.connect(CORE_DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def get_navidrome_db():
    if not os.path.exists(NAVIDROME_DB_PATH):
        raise RuntimeError(f"Navidrome database not found at: {NAVIDROME_DB_PATH}")
    conn = sqlite3.connect(f"file:{NAVIDROME_DB_PATH}?mode=ro", uri=True, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def normalize_key(name: str) -> str:
    cleaned = name.strip().lower()
    cleaned = re.sub(r"[\s\-]+", "_", cleaned)
    cleaned = re.sub(r"[^a-z0-9_]", "", cleaned)
    return cleaned

def seed_festival_logos(cursor):
    seed_logos = [
        ("Tomorrowland", "tomorrowland", "https://upload.wikimedia.org/wikipedia/commons/4/4b/Tomorrowland_Logo.svg"),
        ("EDC Las Vegas", "edc_las_vegas", "https://upload.wikimedia.org/wikipedia/commons/c/ca/Edc_las_vegas_2018_as_logo_general_vector_black_generic.png"),
        ("Coachella", "coachella", "https://upload.wikimedia.org/wikipedia/commons/a/a5/Coachella_Valley_Music_and_Arts_Festival_logo.svg"),
        ("Ultra Music Festival", "ultra_music_festival", "https://upload.wikimedia.org/wikipedia/commons/9/95/Logo_of_Ultra_Music_Festival.png"),
        ("Burning Man", "burning_man", "https://upload.wikimedia.org/wikipedia/commons/e/e3/Burning_Man_Project_Logo.png"),
        ("Elrow", "elrow", "https://upload.wikimedia.org/wikipedia/commons/4/42/Elrow-logo_alpha.png"),
        ("Sunburn Festival", "sunburn_festival", "https://upload.wikimedia.org/wikipedia/commons/7/73/SunburnFestiveProperty.svg"),
    ]
    for name, norm_key, logo_url in seed_logos:
        cursor.execute("""
            INSERT OR IGNORE INTO festival_logos (festival_name, normalized_key, logo_url, source)
            VALUES (?, ?, ?, \x27wikimedia\x27)
        """, (name, norm_key, logo_url))

def init_db():
    db_dir = os.path.dirname(CORE_DB_PATH)
    if db_dir and not os.path.exists(db_dir):
        os.makedirs(db_dir, exist_ok=True)
    conn = sqlite3.connect(CORE_DB_PATH, check_same_thread=False)
    cursor = conn.cursor()

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS listen_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        track_title TEXT,
        artist TEXT,
        duration_seconds INTEGER,
        played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        listen_duration_seconds REAL DEFAULT 0,
        listen_position_seconds REAL DEFAULT 0,
        completed INTEGER DEFAULT 0
    );
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS pins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        timestamp_seconds REAL NOT NULL,
        label TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS users_cache (
        navidrome_user_id TEXT PRIMARY KEY,
        user_name TEXT,
        email TEXT,
        is_admin INTEGER DEFAULT 0,
        last_synced TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS dj_metadata (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dj_name TEXT UNIQUE NOT NULL,
        real_name TEXT,
        bio TEXT,
        image_url TEXT,
        genres TEXT,
        known_events TEXT,
        festival_history TEXT,
        additional_genres TEXT,
        source TEXT DEFAULT \x27discogs\x27,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS bug_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_version TEXT,
        device_info TEXT,
        screenshot_base64 TEXT,
        screenshot2_base64 TEXT,
        screenshot3_base64 TEXT,
        screenrecord_base64 TEXT,
        coil_cache TEXT,
        recent_api_calls TEXT,
        user_description TEXT,
        diagnostics_json TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS app_version_check (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_name TEXT,
        version_code INTEGER,
        ip_address TEXT,
        checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        user_agent TEXT
    );
    """)

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_app_version_check_checked_at ON app_version_check(checked_at);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_app_version_check_ip ON app_version_check(ip_address);")

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS festival_logos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        festival_name TEXT UNIQUE NOT NULL,
        normalized_key TEXT UNIQUE NOT NULL,
        logo_url TEXT NOT NULL,
        source TEXT DEFAULT \x27wikimedia\x27,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # Safe migration for existing core.db
    try:
        cursor.execute("ALTER TABLE listen_history ADD COLUMN listen_duration_seconds REAL DEFAULT 0")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE listen_history ADD COLUMN listen_position_seconds REAL DEFAULT 0")
    except Exception:
        pass
    try:
        cursor.execute("ALTER TABLE listen_history ADD COLUMN completed INTEGER DEFAULT 0")
    except Exception:
        pass

    cursor.execute("PRAGMA table_info(dj_metadata)")
    existing_cols = [row[1] for row in cursor.fetchall()]
    if "festival_history" not in existing_cols:
        cursor.execute("ALTER TABLE dj_metadata ADD COLUMN festival_history TEXT")
    if "additional_genres" not in existing_cols:
        cursor.execute("ALTER TABLE dj_metadata ADD COLUMN additional_genres TEXT")

    cursor.execute("PRAGMA table_info(bug_reports)")
    existing_bug_cols = [row[1] for row in cursor.fetchall()]
    if "screenshot2_base64" not in existing_bug_cols:
        try:
            cursor.execute("ALTER TABLE bug_reports ADD COLUMN screenshot2_base64 TEXT")
        except Exception:
            pass
    if "screenshot3_base64" not in existing_bug_cols:
        try:
            cursor.execute("ALTER TABLE bug_reports ADD COLUMN screenshot3_base64 TEXT")
        except Exception:
            pass
    if "screenrecord_base64" not in existing_bug_cols:
        try:
            cursor.execute("ALTER TABLE bug_reports ADD COLUMN screenrecord_base64 TEXT")
        except Exception:
            pass
    if "diagnostics_json" not in existing_bug_cols:
        cursor.execute("ALTER TABLE bug_reports ADD COLUMN diagnostics_json TEXT")

    # tracklist_tracks tabel — persistent cache voor 1001Tracklists data
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS tracklist_tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tracklist_url TEXT UNIQUE NOT NULL,
        artist TEXT,
        album_name TEXT,
        title TEXT,
        total_tracks INTEGER,
        tracks_json TEXT,
        fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP
    );
    """)

    # spotlights tabel — dynamische server-gestuurde spotlight
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS spotlights (
        id VARCHAR(64) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        subtitle VARCHAR(255),
        badge_text VARCHAR(64) DEFAULT 'SPOTLIGHT',
        description TEXT,
        cover_image_url VARCHAR(512) NOT NULL,
        backdrop_image_url VARCHAR(512),
        accent_color_hex VARCHAR(9) DEFAULT '#FF007A',
        target_type VARCHAR(32) NOT NULL,
        target_id VARCHAR(128) NOT NULL,
        action_label VARCHAR(64) DEFAULT 'Bekijk',
        is_active INTEGER DEFAULT 1,
        start_date TIMESTAMP NOT NULL,
        end_date TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)
    cursor.execute("""CREATE INDEX IF NOT EXISTS idx_spotlights_active ON spotlights(is_active, start_date, end_date)""")

    # youtube_download_jobs tabel — persistente tracking van downloads
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS youtube_download_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT UNIQUE NOT NULL,
        user_id TEXT NOT NULL,
        video_id TEXT NOT NULL,
        target_url TEXT NOT NULL,
        status TEXT NOT NULL,
        ok INTEGER DEFAULT 0,
        rc INTEGER DEFAULT 0,
        message TEXT,
        stdout TEXT,
        stderr TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
    );
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_youtube_jobs_job_id ON youtube_download_jobs(job_id)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_youtube_jobs_video_id ON youtube_download_jobs(video_id)")

    # Seed eerste spotlight (LIEF Festival tot we de flow draaien)
    cursor.execute("""SELECT COUNT(*) FROM spotlights""")
    if cursor.fetchone()[0] == 0:
        cursor.execute("""
            INSERT INTO spotlights (id, title, subtitle, badge_text, description, cover_image_url,
                accent_color_hex, target_type, target_id, action_label, start_date, end_date)
            VALUES ('spotlight_default', 'LIEF Festival 2026', 'Het leukste festival van Utrecht',
                'SPOTLIGHT', 'Ontdek de beste sets van LIEF Festival 2026',
                'https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3?w=800',
                '#E85D04', 'ALBUM', 'lief_festival_2026', 'Bekijk Album',
                datetime('now'), datetime('now', '+7 days'))
        """)

    seed_festival_logos(cursor)

    conn.commit()
    conn.close()

def sync_users_cache():
    """Synchroniseer alle gebruikers uit Navidrome DB naar users_cache in Core DB."""
    if not os.path.exists(NAVIDROME_DB_PATH):
        logger.warning(f"Navidrome database niet gevonden op {NAVIDROME_DB_PATH}. Overslaan sync_users_cache.")
        return

    try:
        conn_nav = sqlite3.connect(f"file:{NAVIDROME_DB_PATH}?mode=ro", uri=True, check_same_thread=False)
        conn_nav.row_factory = sqlite3.Row
        cursor_nav = conn_nav.cursor()
        cursor_nav.execute("SELECT id, user_name, email, is_admin FROM user")
        users = cursor_nav.fetchall()
        conn_nav.close()

        if not users:
            logger.info("Geen gebruikers gevonden in Navidrome DB om te synchroniseren.")
            return

        conn_core = get_db()
        cursor_core = conn_core.cursor()

        admin_email_clean = ADMIN_EMAIL.strip().lower() if ADMIN_EMAIL else ""

        for u in users:
            user_id = u["id"]
            user_name = u["user_name"]
            email = u["email"] or ""
            raw_is_admin = bool(u["is_admin"])

            # Een gebruiker is admin als email == ADMIN_EMAIL of is_admin == 1 in navidrome.db
            is_admin = 1 if (raw_is_admin or (admin_email_clean and email.strip().lower() == admin_email_clean)) else 0
            user_email = email if email else (ADMIN_EMAIL if is_admin else "")

            cursor_core.execute("""
                INSERT OR REPLACE INTO users_cache (navidrome_user_id, user_name, email, is_admin, last_synced)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            """, (user_id, user_name, user_email, is_admin))

        conn_core.commit()
        conn_core.close()
        logger.info(f"users_cache succesvol gesynchroniseerd ({len(users)} gebruikers).")
    except Exception as e:
        logger.error(f"Fout bij synchroniseren van users_cache: {e}", exc_info=True)


def get_cached_tracklist(tracklist_url: str) -> Optional[dict]:
    """Check core.db voor een gecachte tracklist. Return None als niet gevonden of verlopen."""
    import json
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT tracklist_url, artist, album_name, title, total_tracks, "
            "tracks_json, fetched_at, expires_at "
            "FROM tracklist_tracks WHERE tracklist_url = ?",
            (tracklist_url,)
        )
        row = cursor.fetchone()
        conn.close()
        if row:
            from datetime import datetime, timezone
            expires = row["expires_at"]
            if expires:
                expires_dt = datetime.fromisoformat(expires) if isinstance(expires, str) else expires
                if expires_dt.tzinfo is None:
                    expires_dt = expires_dt.replace(tzinfo=timezone.utc)
                now = datetime.now(timezone.utc)
                if now > expires_dt:
                    logger.info(f"Tracklist cache expired for {tracklist_url[:60]}")
                    return None
            return {
                "url": row["tracklist_url"],
                "artist": row["artist"],
                "album_name": row["album_name"],
                "title": row["title"],
                "total_tracks": row["total_tracks"],
                "tracks": json.loads(row["tracks_json"]) if row["tracks_json"] else [],
                "fetched_at": row["fetched_at"],
                "cached": True,
            }
    except Exception as e:
        logger.warning(f"Error reading tracklist cache for {tracklist_url[:60]}: {e}")
    return None


def upsert_tracklist(
    tracklist_url: str,
    artist: str = None,
    album_name: str = None,
    title: str = None,
    total_tracks: int = None,
    tracks_json: str = None,
    ttl_hours: int = 24,
):
    """Sla een tracklist op in core.db met een TTL (default 24u)."""
    import json
    from datetime import datetime, timedelta, timezone
    try:
        conn = get_db()
        cursor = conn.cursor()
        now = datetime.now(timezone.utc)
        expires = now + timedelta(hours=ttl_hours)
        cursor.execute("""
            INSERT INTO tracklist_tracks (tracklist_url, artist, album_name, title, total_tracks, tracks_json, fetched_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tracklist_url) DO UPDATE SET
                artist = excluded.artist,
                album_name = excluded.album_name,
                title = excluded.title,
                total_tracks = excluded.total_tracks,
                tracks_json = excluded.tracks_json,
                fetched_at = excluded.fetched_at,
                expires_at = excluded.expires_at
        """, (
            tracklist_url,
            artist or "",
            album_name or "",
            title or "",
            total_tracks or 0,
            tracks_json or "[]",
            now.isoformat(),
            expires.isoformat(),
        ))
        conn.commit()
        conn.close()
        logger.info(f"Tracklist cached: {tracklist_url[:60]} (TTL {ttl_hours}h)")
    except Exception as e:
        logger.error(f"Error caching tracklist {tracklist_url[:60]}: {e}")


def cache_tracklist(
    tracklist_url: str,
    artist: str = None,
    album_name: str = None,
    title: str = None,
    total_tracks: int = None,
    tracks_json: str = None,
    ttl_hours: int = 24,
):
    """Alias voor upsert_tracklist."""
    return upsert_tracklist(
        tracklist_url=tracklist_url,
        artist=artist,
        album_name=album_name,
        title=title,
        total_tracks=total_tracks,
        tracks_json=tracks_json,
        ttl_hours=ttl_hours,
    )


def create_download_job(job_id: str, user_id: str, video_id: str, target_url: str):
    """Persist a new YouTube download job record."""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO youtube_download_jobs (job_id, user_id, video_id, target_url, status)
            VALUES (?, ?, ?, ?, 'pending')
        """, (job_id, user_id, video_id, target_url))
        conn.commit()
        conn.close()
    except Exception as e:
        logger.error(f"Error creating download job {job_id}: {e}")


def update_download_job(job_id: str, status: str, ok: int, rc: int, message: str, stdout: str = "", stderr: str = ""):
    """Update status and outputs for an existing YouTube download job."""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE youtube_download_jobs
            SET status = ?, ok = ?, rc = ?, message = ?, stdout = ?, stderr = ?, completed_at = CURRENT_TIMESTAMP
            WHERE job_id = ?
        """, (status, ok, rc, message, stdout, stderr, job_id))
        conn.commit()
        conn.close()
    except Exception as e:
        logger.error(f"Error updating download job {job_id}: {e}")


def get_download_job(job_id: str) -> Optional[dict]:
    """Retrieve details for a download job."""
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM youtube_download_jobs WHERE job_id = ?", (job_id,))
        row = cursor.fetchone()
        conn.close()
        if row:
            return dict(row)
    except Exception as e:
        logger.error(f"Error retrieving download job {job_id}: {e}")
    return None
