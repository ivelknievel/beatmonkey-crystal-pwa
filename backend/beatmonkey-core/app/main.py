import httpx
import requests
import asyncio
import subprocess
import json
import os
import re
import urllib.parse
import datetime
import secrets
import sqlite3
import logging
from typing import Optional, Union, Dict, Any
from fastapi import FastAPI, Depends, HTTPException, status, Request, Query, File, UploadFile, Form
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.templating import Jinja2Templates
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials, HTTPBasic, HTTPBasicCredentials

from app.models import AuthLoginRequest, UserRegisterRequest, TrackPlayWebhook, PinCreateRequest, EnrichRequest, FestivalLogoCreateRequest, MergeArtistsRequest, YoutubeDownloadRequest
from app.auth import (
    TEST_MODE,
    NAVIDROME_DB_PATH,
    verify_google_token,
    create_session_token,
    verify_token,
    check_navidrome_whitelist,
    get_all_navidrome_users,
    validate_security_configuration
)
from app.database import (
    get_db,
    init_db,
    normalize_key,
    get_navidrome_db,
    sync_users_cache,
    get_cached_tracklist,
    upsert_tracklist,
    create_download_job,
    update_download_job,
    get_download_job
)

from app.navidrome_client import create_navidrome_user
from app.metadata_service import DJMetadataService
from app.set79_scraper import scrape_set79, normalize_set79_url
from app.id_track_resolver import router as id_track_resolver_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="BeatMonkey Core API")
metadata_service = DJMetadataService()

# Register sub-routers
app.include_router(id_track_resolver_router)

# Mount static files and setup Jinja2 templates
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.getenv("STATIC_DIR", os.path.abspath(os.path.join(BASE_DIR, "..", "static")))
if not os.path.exists(STATIC_DIR):
    STATIC_DIR = os.path.join(BASE_DIR, "static")

os.makedirs(os.path.join(STATIC_DIR, "festivals"), exist_ok=True)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

security = HTTPBearer(auto_error=False)
security_basic = HTTPBasic()

DISABLED_DOCKER_ROUTES = {
    "/api/auth/register",
    "/api/admin/merge-artists",
    "/api/artists/merge",
    "/api/scan",
}

@app.middleware("http")
async def disable_docker_routes_middleware(request: Request, call_next):
    normalized_path = request.url.path.rstrip("/")
    if normalized_path in DISABLED_DOCKER_ROUTES:
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"detail": "Service Temporarily Unavailable: Docker-dependent functionality is disabled"}
        )
    return await call_next(request)

def verify_admin(credentials: HTTPBasicCredentials = Depends(security_basic)):
    admin_user = os.getenv("ADMIN_USER", "admin")
    admin_pass = os.getenv("ADMIN_PASS", "")
    if len(admin_pass.strip()) < 32:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized",
            headers={"WWW-Authenticate": "Basic"}
        )
    if not (secrets.compare_digest(credentials.username, admin_user) and secrets.compare_digest(credentials.password, admin_pass)):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized",
            headers={"WWW-Authenticate": "Basic"}
        )
    return credentials.username

@app.on_event("startup")
def on_startup():
    validate_security_configuration()
    init_db()
    sync_users_cache()

@app.on_event("shutdown")
async def on_shutdown():
    await metadata_service.close()

def get_token_from_request(
    request: Request,
    auth_header: Optional[HTTPAuthorizationCredentials] = Depends(security),
    token_query: Optional[str] = Query(None, alias="token")
) -> str:
    token = None
    if auth_header and auth_header.credentials:
        token = auth_header.credentials
    elif token_query:
        token = token_query
    elif "token" in request.cookies:
        token = request.cookies.get("token")
    
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication token missing"
        )
    return token

def get_current_user(token: str = Depends(get_token_from_request)) -> dict:
    payload = verify_token(token)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token"
        )
    return payload

def get_current_admin_user(current_user: dict = Depends(get_current_user)) -> dict:
    if not current_user.get("is_admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges required"
        )
    return current_user

# ==================== ROUTES ====================

@app.get("/api/health")
def health_check():
    return {"status": "ok", "test_mode": TEST_MODE}

# ── Spotlight Endpoint ─────────────────────────────────────────────
@app.get("/api/spotlight")
def get_active_spotlight():
    """Retourneer de actieve spotlight (indien beschikbaar)."""
    try:
        db = get_db()
        cur = db.cursor()
        cur.execute("""
            SELECT id, title, subtitle, badge_text, description,
                   cover_image_url, backdrop_image_url, accent_color_hex,
                   target_type, target_id, action_label,
                   start_date, end_date
            FROM spotlights
            WHERE is_active = 1
              AND start_date <= datetime('now')
              AND end_date >= datetime('now')
            ORDER BY start_date DESC
            LIMIT 1
        """)
        row = cur.fetchone()
        if row is None:
            return JSONResponse(status_code=204, content={"spotlight": None})
        return {
            "id": row[0],
            "title": row[1],
            "subtitle": row[2],
            "badgeText": row[3],
            "description": row[4],
            "coverImageUrl": row[5],
            "backdropImageUrl": row[6],
            "accentColorHex": row[7],
            "targetType": row[8],
            "targetId": row[9],
            "actionLabel": row[10],
            "startDate": row[11],
            "endDate": row[12]
        }
    except Exception as e:
        logger.error(f"Spotlight error: {e}")
        return {"spotlight": None}

# ── Admin endpoint om spotlight te wisselen ─────────────────────────
@app.post("/api/spotlight/set")
def set_spotlight(
    id: str = Query(...),
    title: str = Query(...),
    subtitle: str = Query(None),
    badge_text: str = Query("SPOTLIGHT"),
    description: str = Query(None),
    cover_image_url: str = Query(...),
    backdrop_image_url: str = Query(None),
    accent_color_hex: str = Query("#FF007A"),
    target_type: str = Query(...),
    target_id: str = Query(...),
    action_label: str = Query("Bekijk"),
    days_active: int = Query(7)
):
    """Zet een nieuwe spotlight (deactiveert oude). Alleen admin."""
    try:
        db = get_db()
        cur = db.cursor()
        # Deactiveer alle actieve spotlights
        cur.execute("UPDATE spotlights SET is_active = 0 WHERE is_active = 1")
        # Voeg nieuwe toe (vervang als ID al bestaat)
        cur.execute("""
            INSERT OR REPLACE INTO spotlights (id, title, subtitle, badge_text, description, cover_image_url,
                backdrop_image_url, accent_color_hex, target_type, target_id, action_label,
                is_active, start_date, end_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                1, datetime('now'), datetime('now', '+' || ? || ' days'))
        """, (id, title, subtitle, badge_text, description, cover_image_url,
              backdrop_image_url, accent_color_hex, target_type, target_id, action_label,
              days_active))
        db.commit()
        return {"status": "ok", "spotlight_id": id, "days_active": days_active}
    except Exception as e:
        logger.error(f"Set spotlight error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/auth")
def login(req: AuthLoginRequest):
    email = None
    if TEST_MODE:
        if not req.email:
            raise HTTPException(status_code=400, detail="email field required in TEST_MODE")
        email = req.email
    else:
        if not req.id_token:
            raise HTTPException(status_code=400, detail="id_token field required")
        client_id = req.client_id or os.getenv("GOOGLE_CLIENT_ID", "")
        google_user = verify_google_token(req.id_token, client_id)
        if not google_user or not google_user.get("email"):
            raise HTTPException(status_code=401, detail="Invalid Google ID token")
        email = google_user["email"]

    nav_user = check_navidrome_whitelist(email)
    if not nav_user:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access forbidden: email not found in Navidrome whitelist"
        )

    token = create_session_token(
        navidrome_user_id=nav_user["id"],
        email=nav_user["email"],
        user_name=nav_user["user_name"],
        is_admin=nav_user["is_admin"]
    )

    return {
        "token": token,
        "user": {
            "id": nav_user["id"],
            "email": nav_user["email"],
            "name": nav_user["name"] or nav_user["user_name"],
            "user_name": nav_user["user_name"],
            "is_admin": nav_user["is_admin"]
        },
        "user_name": nav_user["user_name"],
        "user_id": nav_user["id"],
        "is_admin": nav_user["is_admin"],
        "subsonic_user": nav_user["user_name"],
        "subsonic_pass": nav_user.get("subsonic_pass", "")
    }

@app.post("/api/auth/register")
def register_navidrome_user(
    req: UserRegisterRequest,
    admin_user: dict = Depends(get_current_admin_user)
):
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Service Temporarily Unavailable: Docker registration is disabled"
    )

@app.get("/api/beheer", response_class=HTMLResponse)
def admin_portal(
    request: Request,
    username: str = Depends(verify_admin)
):
    users = get_all_navidrome_users()
    logos = get_all_festival_logos_from_db()
    return templates.TemplateResponse(
        "beheer.html",
        {
            "request": request,
            "users": users,
            "logos": logos,
            "test_mode": TEST_MODE
        }
    )

@app.post("/api/stats/play")
def record_play(
    req: TrackPlayWebhook,
    current_user: dict = Depends(get_current_user)
):
    conn = get_db()
    cursor = conn.cursor()
    played_at = req.timestamp if req.timestamp else datetime.datetime.now(datetime.timezone.utc).isoformat()
    completed_val = 1 if req.completed else 0
    cursor.execute(
        """
        INSERT INTO listen_history (
            user_id, track_id, track_title, artist, duration_seconds, played_at,
            listen_duration_seconds, listen_position_seconds, completed
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            current_user["user_id"],
            req.track_id,
            req.track_title,
            req.artist,
            req.duration_seconds,
            played_at,
            req.listen_duration_seconds or 0,
            req.listen_position_seconds or 0,
            completed_val
        )
    )
    conn.commit()
    history_id = cursor.lastrowid
    conn.close()
    return {"success": True, "id": history_id}

@app.get("/api/stats/recent")
def get_recent_listens(
    current_user: dict = Depends(get_current_user)
):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT id, user_id, track_id, track_title, artist, duration_seconds, played_at,
               listen_duration_seconds, listen_position_seconds, completed
        FROM listen_history
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 20
        """,
        (current_user["user_id"],)
    )
    rows = cursor.fetchall()
    conn.close()

    listens = [
        {
            "id": r["id"],
            "user_id": r["user_id"],
            "track_id": r["track_id"],
            "track_title": r["track_title"],
            "artist": r["artist"],
            "duration_seconds": r["duration_seconds"],
            "played_at": r["played_at"],
            "listen_duration_seconds": r["listen_duration_seconds"] if "listen_duration_seconds" in r.keys() else 0,
            "listen_position_seconds": r["listen_position_seconds"] if "listen_position_seconds" in r.keys() else 0,
            "completed": bool(r["completed"]) if "completed" in r.keys() else False
        } for r in rows
    ]
    return listens

@app.get("/api/stats/insights")
def get_listening_insights(current_user: dict = Depends(get_current_user)):
    """Uitgebreide luisterstatistieken voor de ingelogde gebruiker."""
    conn = get_db()
    cursor = conn.cursor()
    
    # 1. Meest beluisterde tracks
    cursor.execute("""
        SELECT track_id,
               COALESCE(MAX(CASE WHEN track_title != '' THEN track_title END), track_id) as track_title,
               COALESCE(MAX(CASE WHEN artist != '' THEN artist END), artist) as artist,
               COUNT(*) as plays,
               SUM(listen_duration_seconds) as total_listen_time,
               ROUND(AVG(listen_duration_seconds), 1) as avg_listen_time,
               ROUND(AVG(listen_position_seconds), 1) as avg_position,
               SUM(completed) as completed_count
        FROM listen_history
        WHERE user_id = ?
        GROUP BY track_id
        ORDER BY plays DESC
        LIMIT 20
    """, (current_user["user_id"],))
    top_tracks = [dict(row) for row in cursor.fetchall()]
    
    # 2. Meest beluisterde artiesten
    cursor.execute("""
        SELECT artist, COUNT(*) as plays,
               SUM(listen_duration_seconds) as total_listen_time,
               COUNT(DISTINCT track_id) as unique_tracks
        FROM listen_history
        WHERE user_id = ?
        GROUP BY artist
        ORDER BY plays DESC
        LIMIT 20
    """, (current_user["user_id"],))
    top_artists = [dict(row) for row in cursor.fetchall()]
    
    # 3. Luistertijd per dag (laatste 30 dagen)
    cursor.execute("""
        SELECT DATE(played_at) as day,
               COUNT(*) as plays,
               ROUND(SUM(listen_duration_seconds), 0) as total_seconds
        FROM listen_history
        WHERE user_id = ? AND played_at >= datetime('now', '-30 days')
        GROUP BY DATE(played_at)
        ORDER BY day DESC
        LIMIT 30
    """, (current_user["user_id"],))
    daily = [dict(row) for row in cursor.fetchall()]
    
    # 4. Totaaloverzicht
    cursor.execute("""
        SELECT COUNT(*) as total_plays,
               COUNT(DISTINCT track_id) as unique_tracks,
               COUNT(DISTINCT artist) as unique_artists,
               ROUND(SUM(listen_duration_seconds), 0) as total_listen_seconds,
               ROUND(AVG(listen_position_seconds), 1) as avg_listen_position,
               SUM(completed) as completed_tracks
        FROM listen_history
        WHERE user_id = ?
    """, (current_user["user_id"],))
    row = cursor.fetchone()
    overview = dict(row) if row else {}
    
    conn.close()
    
    return {
        "overview": overview,
        "top_tracks": top_tracks,
        "top_artists": top_artists,
        "daily": daily
    }

@app.post("/api/pins")
def add_pin(
    req: PinCreateRequest,
    current_user: dict = Depends(get_current_user)
):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """
        INSERT INTO pins (user_id, track_id, timestamp_seconds, label)
        VALUES (?, ?, ?, ?)
        """,
        (current_user["user_id"], req.track_id, req.timestamp_seconds, req.label)
    )
    conn.commit()
    pin_id = cursor.lastrowid
    conn.close()
    return {"success": True, "id": pin_id}

@app.get("/api/pins")
def get_pins(
    track_id: str = Query(...),
    current_user: dict = Depends(get_current_user)
):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT id, user_id, track_id, timestamp_seconds, label, created_at
        FROM pins
        WHERE track_id = ?
        ORDER BY timestamp_seconds ASC
        """,
        (track_id,)
    )
    rows = cursor.fetchall()
    conn.close()

    pins = [
        {
            "id": r["id"],
            "user_id": r["user_id"],
            "track_id": r["track_id"],
            "timestamp_seconds": r["timestamp_seconds"],
            "label": r["label"],
            "created_at": r["created_at"]
        } for r in rows
    ]
    return pins

_LIVESET_TITLE_CONTEXT_RE = re.compile(
    r"(?:"
    r"\b(?:b2b|b3b|b4b|vs\.?|versus|takeover|live|set|sets|dj\s*set|full\s*set|mix|essential\s*mix|"
    r"radio|show|episode|ep\.?\s*\d+|session|sessions|broadcast|stream|boiler\s*room|cercle|hor|h[oö]r|"
    r"lot\s*radio|experts\s*only|defected|toolroom|drumcode|afterlife|anjuna\w*|insomniac|club\s*space|"
    r"printworks|fabric|whp|warehouse\s*project|edc(?:\s*20\d{2})?|tomorrowland|ultra|umf|coachella|"
    r"awakenings|time\s*warp|creamfields|sunburn|elrow|burning\s*man|festival|stage|closing|opening|"
    r"concourse|warung|amnesia|ushua[iï]a|pacha|ibiza|miami|vegas|brooklyn|mirage|red\s*rocks)\b"
    r"|#\s*\d+"
    r"|@"
    r")",
    re.IGNORECASE,
)


def _normalize_liveset_text(value: Optional[str]) -> str:
    return " ".join(str(value or "").split()).casefold()


def _build_dj_matcher(dj_name: str):
    norm_dj = _normalize_liveset_text(dj_name)
    if not norm_dj:
        return None
    parts = [re.escape(part) for part in norm_dj.split(" ") if part]
    if not parts:
        return None
    dj_body = r"\s+".join(parts).replace(r"\s+\&\s+", r"\s*&\s*")
    boundary_re = re.compile(
        rf"(?<![a-z0-9_])(?<![a-z0-9]-)(?<!&\s)(?<!&){dj_body}(?![a-z0-9_])(?!-[a-z0-9])(?!\s*&)",
        re.IGNORECASE,
    )
    false_pos_re = re.compile(
        rf"(?:"
        rf"\b(?:plays?|playing|played|spinning|spins|drops?|dropped)\b[^,;|\n]{{0,40}}{dj_body}"
        rf"|\b(?:track|tracks|song|songs|id|ids|remix|remixes|edit|bootleg|rework|mashup|tribute|inspired|produced)\s+"
        rf"(?:a\s+|an\s+|the\s+|new\s+|unreleased\s+)?(?:track\s+|song\s+|id\s+|remix\s+|music\s+)?(?:by|from|to|of)\s+{dj_body}"
        rf"|(?<![a-z0-9_])(?<![a-z0-9]-){dj_body}\s+(?:remix|edit|bootleg|rework|vip|type\s+beat)\b"
        rf")(?![a-z0-9_])(?!-[a-z0-9])",
        re.IGNORECASE,
    )
    return boundary_re, false_pos_re


def _media_row_matches_dj(row: dict, matcher) -> bool:
    if matcher is None:
        return False
    boundary_re, false_pos_re = matcher
    for artist_field in (row["norm_artist"], row["norm_linked_artist"], row["norm_album_artist"]):
        if artist_field and boundary_re.search(artist_field):
            cleaned_artist = false_pos_re.sub(" ", artist_field)
            if boundary_re.search(cleaned_artist):
                return True
    norm_title = row["norm_title"]
    if not norm_title or not row["title_has_liveset_context"] or "playlist" in norm_title:
        return False
    if not boundary_re.search(norm_title):
        return False
    cleaned_title = false_pos_re.sub(" ", norm_title)
    return bool(boundary_re.search(cleaned_title))


def _fetch_navidrome_media_rows(cursor) -> list[dict]:
    cursor.execute("PRAGMA table_info(media_file)")
    col_names = {r[1] if not isinstance(r, sqlite3.Row) else r["name"] for r in cursor.fetchall()}
    has_missing = "missing" in col_names
    has_album_artist = "album_artist" in col_names
    has_artist_id = "artist_id" in col_names

    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='artist'")
    has_artist_table = cursor.fetchone() is not None

    album_artist_expr = "m.album_artist" if has_album_artist else "''"
    if has_artist_table and has_artist_id:
        join_clause = "LEFT JOIN artist a ON m.artist_id = a.id"
        linked_artist_expr = "a.name"
    else:
        join_clause = ""
        linked_artist_expr = "''"

    where_clause = "WHERE COALESCE(m.missing, 0) = 0" if has_missing else ""

    cursor.execute(f"""
        SELECT
            m.id,
            m.title,
            m.duration,
            m.artist,
            {album_artist_expr} AS album_artist,
            {linked_artist_expr} AS linked_artist
        FROM media_file m
        {join_clause}
        {where_clause}
        ORDER BY m.title ASC, m.id ASC
    """)
    seen_ids = set()
    media_rows = []
    for r in cursor.fetchall():
        song_id = r["id"]
        if not song_id or song_id in seen_ids:
            continue
        seen_ids.add(song_id)
        norm_title = _normalize_liveset_text(r["title"])
        media_rows.append({
            "id": song_id,
            "title": r["title"],
            "duration": int(round(r["duration"])) if r["duration"] is not None else 0,
            "norm_title": norm_title,
            "norm_artist": _normalize_liveset_text(r["artist"]),
            "norm_album_artist": _normalize_liveset_text(r["album_artist"]),
            "norm_linked_artist": _normalize_liveset_text(r["linked_artist"]),
            "title_has_liveset_context": bool(_LIVESET_TITLE_CONTEXT_RE.search(norm_title)),
        })
    return media_rows


def get_navidrome_djs_with_counts() -> list[dict]:
    if not os.path.exists(NAVIDROME_DB_PATH):
        return []
    try:
        conn = sqlite3.connect(f"file:{NAVIDROME_DB_PATH}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("""
            SELECT a.id, a.name as dj_name
            FROM artist a
            WHERE a.name IS NOT NULL AND trim(a.name) != ''
            GROUP BY a.id, a.name
            ORDER BY a.name ASC
        """)
        artist_rows = cursor.fetchall()
        media_rows = _fetch_navidrome_media_rows(cursor)
        conn.close()

        count_cache: dict[str, int] = {}
        results = []
        for r in artist_rows:
            dj_name = r["dj_name"]
            norm_dj = _normalize_liveset_text(dj_name)
            if norm_dj not in count_cache:
                matcher = _build_dj_matcher(dj_name)
                count_cache[norm_dj] = sum(1 for m in media_rows if _media_row_matches_dj(m, matcher))
            results.append({
                "id": r["id"],
                "dj_name": dj_name,
                "liveset_count": count_cache[norm_dj],
            })
        return results
    except Exception as e:
        logger.error(f"Error querying Navidrome DJs: {e}")
        return []


def get_navidrome_livesets_for_dj(dj_name: str) -> list[dict]:
    if not os.path.exists(NAVIDROME_DB_PATH):
        return []
    try:
        matcher = _build_dj_matcher(dj_name)
        if matcher is None:
            return []
        conn = sqlite3.connect(f"file:{NAVIDROME_DB_PATH}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        media_rows = _fetch_navidrome_media_rows(cursor)
        conn.close()
        return [
            {
                "title": m["title"],
                "id": m["id"],
                "duration": m["duration"],
            }
            for m in media_rows
            if _media_row_matches_dj(m, matcher)
        ]
    except Exception as e:
        logger.error(f"Error fetching livesets for DJ '{dj_name}': {e}")
        return []

# ==================== FESTIVAL LOGOS ====================

def get_all_festival_logos_from_db() -> list[dict]:
    try:
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT id, festival_name, normalized_key, logo_url FROM festival_logos")
        rows = cursor.fetchall()
        conn.close()
        return [dict(r) for r in rows]
    except Exception as e:
        logger.error(f"Error fetching festival logos: {e}")
        return []

def find_logo_for_dj(dj_name: str, meta: Optional[dict], festival_logos: list[dict]) -> str:
    if not festival_logos:
        return ""

    known_events = meta.get("known_events") or "" if meta else ""
    festival_history = meta.get("festival_history") or "" if meta else ""
    bio = meta.get("bio") or "" if meta else ""

    search_text = f"{dj_name} {known_events} {festival_history} {bio}".lower()

    for logo in festival_logos:
        fest_name = logo["festival_name"].lower()
        norm_key = logo["normalized_key"].lower()

        aliases = [fest_name, norm_key, norm_key.replace("_", " ")]
        if norm_key == "edc_las_vegas":
            aliases.extend(["edc", "electric daisy carnival"])
        elif norm_key == "ultra_music_festival":
            aliases.extend(["ultra", "umf"])
        elif norm_key == "sunburn_festival":
            aliases.append("sunburn")

        for alias in aliases:
            if alias and alias in search_text:
                return logo["logo_url"]

    return ""

@app.api_route("/api/festivals/logo/{festival_name}", methods=["GET", "HEAD"])
def get_festival_logo(festival_name: str):
    norm_key = normalize_key(festival_name)

    # 1. Check if local file exists in STATIC_DIR/festivals
    festivals_dir = os.path.join(STATIC_DIR, "festivals")
    if os.path.exists(festivals_dir):
        for ext in ["png", "jpg", "jpeg", "svg"]:
            candidate = os.path.join(festivals_dir, f"{norm_key}.{ext}")
            if os.path.exists(candidate):
                media_type = "image/svg+xml" if ext == "svg" else f"image/{'jpeg' if ext in ['jpg', 'jpeg'] else ext}"
                return FileResponse(candidate, media_type=media_type)

    # 2. Query DB record
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, festival_name, normalized_key, logo_url, source, updated_at FROM festival_logos WHERE normalized_key = ?",
        (norm_key,)
    )
    row = cursor.fetchone()
    conn.close()

    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Logo for festival '{festival_name}' not found"
        )

    logo_url = row["logo_url"]
    if logo_url.startswith("http://") or logo_url.startswith("https://"):
        return RedirectResponse(url=logo_url)
    elif logo_url.startswith("/static/"):
        rel_path = logo_url.lstrip("/static/")
        file_path = os.path.join(STATIC_DIR, rel_path)
        if os.path.exists(file_path):
            return FileResponse(file_path)

    return {
        "id": row["id"],
        "festival_name": row["festival_name"],
        "normalized_key": row["normalized_key"],
        "logo_url": row["logo_url"],
        "source": row["source"],
        "updated_at": row["updated_at"]
    }

@app.post("/api/festivals/logo/upload")
async def public_upload_logo(
    festival_name: str = Form(...),
    file: UploadFile = File(...)
):
    # Validate file type
    allowed_types = {"image/png", "image/jpeg", "image/svg+xml"}
    if file.content_type not in allowed_types:
        raise HTTPException(400, "Alleen PNG, JPG en SVG bestanden toegestaan")
    
    # Validate file size (2MB max)
    contents = await file.read()
    if len(contents) > 2 * 1024 * 1024:
        raise HTTPException(400, "Bestand te groot (max 2MB)")
    
    # Normalize festival name
    normalized_key = festival_name.lower().strip().replace(" ", "_").replace("&", "and").replace("/", "_")
    
    # Determine extension
    ext = "png" if file.content_type == "image/png" else "jpg" if file.content_type == "image/jpeg" else "svg"
    
    # Save file
    file_path = f"/app/static/festivals/{normalized_key}.{ext}"
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    with open(file_path, "wb") as f:
        f.write(contents)
    
    # Update database
    conn = get_db()
    conn.execute("""
        INSERT OR REPLACE INTO festival_logos (festival_name, normalized_key, logo_url, source, updated_at)
        VALUES (?, ?, ?, 'local', datetime('now'))
    """, (festival_name, normalized_key, f"/api/festivals/logo/{normalized_key}"))
    conn.commit()
    conn.close()
    
    return {"status": "ok", "festival_name": festival_name, "logo_url": f"/api/festivals/logo/{normalized_key}"}
@app.post("/api/beheer/upload-logo")
async def upload_festival_logo(
    request: Request,
    festival_name: str = Form(...),
    file: UploadFile = File(...),
    username: str = Depends(verify_admin)
):
    if not festival_name or not festival_name.strip():
        raise HTTPException(status_code=400, detail="Festival name is required")

    filename = file.filename or ""
    ext = filename.split(".")[-1].lower() if "." in filename else ""
    allowed_exts = ["png", "jpg", "jpeg", "svg"]
    allowed_types = ["image/png", "image/jpeg", "image/jpg", "image/svg+xml"]

    if ext not in allowed_exts and file.content_type not in allowed_types:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid file type. Only PNG, JPG, JPEG, and SVG are allowed."
        )

    if ext not in allowed_exts:
        if file.content_type == "image/svg+xml":
            ext = "svg"
        elif file.content_type in ["image/jpeg", "image/jpg"]:
            ext = "jpg"
        else:
            ext = "png"

    contents = await file.read()
    if len(contents) > 2 * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="File size exceeds maximum limit of 2MB"
        )
    if len(contents) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty file uploaded"
        )

    norm_key = normalize_key(festival_name)
    save_dir = os.path.join(STATIC_DIR, "festivals")
    os.makedirs(save_dir, exist_ok=True)
    file_path = os.path.join(save_dir, f"{norm_key}.{ext}")

    with open(file_path, "wb") as f:
        f.write(contents)

    logo_url = f"/api/festivals/logo/{norm_key}"

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO festival_logos (festival_name, normalized_key, logo_url, source, updated_at)
        VALUES (?, ?, ?, 'upload', datetime('now'))
        ON CONFLICT(normalized_key) DO UPDATE SET
            festival_name = excluded.festival_name,
            logo_url = excluded.logo_url,
            source = excluded.source,
            updated_at = excluded.updated_at
    """, (festival_name, norm_key, logo_url))
    conn.commit()
    conn.close()

    accept_header = request.headers.get("accept", "")
    user_agent = request.headers.get("user-agent", "").lower()
    if "application/json" in accept_header or "curl" in user_agent:
        return {
            "success": True,
            "festival_name": festival_name,
            "normalized_key": norm_key,
            "logo_url": logo_url
        }
    return RedirectResponse(url="/api/beheer", status_code=status.HTTP_303_SEE_OTHER)

@app.post("/api/beheer/delete-logo/{normalized_key}")
def delete_festival_logo(
    normalized_key: str,
    request: Request,
    username: str = Depends(verify_admin)
):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT logo_url FROM festival_logos WHERE normalized_key = ?", (normalized_key,))
    row = cursor.fetchone()
    if row:
        festivals_dir = os.path.join(STATIC_DIR, "festivals")
        for ext in ["png", "jpg", "jpeg", "svg"]:
            candidate = os.path.join(festivals_dir, f"{normalized_key}.{ext}")
            if os.path.exists(candidate):
                try:
                    os.remove(candidate)
                except Exception as e:
                    logger.error(f"Failed to remove file {candidate}: {e}")
        cursor.execute("DELETE FROM festival_logos WHERE normalized_key = ?", (normalized_key,))
        conn.commit()
    conn.close()

    accept_header = request.headers.get("accept", "")
    user_agent = request.headers.get("user-agent", "").lower()
    if "application/json" in accept_header or "curl" in user_agent:
        return {"success": True, "deleted": normalized_key}
    return RedirectResponse(url="/api/beheer", status_code=status.HTTP_303_SEE_OTHER)

@app.post("/api/festivals/logo")
def add_festival_logo(
    req: FestivalLogoCreateRequest,
    admin_user: dict = Depends(get_current_admin_user)
):
    if not req.festival_name or not req.logo_url:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="festival_name and logo_url are required"
        )
    norm_key = normalize_key(req.festival_name)
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO festival_logos (festival_name, normalized_key, logo_url, source, updated_at)
        VALUES (?, ?, ?, 'custom', datetime('now'))
        ON CONFLICT(normalized_key) DO UPDATE SET
            festival_name = excluded.festival_name,
            logo_url = excluded.logo_url,
            source = excluded.source,
            updated_at = excluded.updated_at
    """, (req.festival_name, norm_key, req.logo_url))
    conn.commit()
    logo_id = cursor.lastrowid
    conn.close()

    return {
        "success": True,
        "id": logo_id,
        "festival_name": req.festival_name,
        "normalized_key": norm_key,
        "logo_url": req.logo_url
    }

@app.get("/api/discover/djs")
async def discover_djs():
    nav_djs = get_navidrome_djs_with_counts()
    festival_logos = get_all_festival_logos_from_db()
    enriched_djs = []
    for item in nav_djs:
        name = item["dj_name"]
        artist_id = item.get("id") or ""
        liveset_count = item["liveset_count"]
        meta = await metadata_service.enrich_dj(name)
        logo_url = find_logo_for_dj(name, meta, festival_logos)
        if meta:
            enriched_djs.append({
                "id": artist_id,
                "dj_name": meta.get("dj_name", name),
                "image_url": meta.get("image_url") or "",
                "logo_url": logo_url,
                "bio": meta.get("bio") or "",
                "genres": meta.get("genres") or "",
                "known_events": meta.get("known_events") or "",
                "festival_history": meta.get("festival_history") or "",
                "additional_genres": meta.get("additional_genres") or "",
                "liveset_count": liveset_count
            })
        else:
            enriched_djs.append({
                "id": artist_id,
                "dj_name": name,
                "image_url": "",
                "logo_url": logo_url,
                "bio": "",
                "genres": "",
                "known_events": "",
                "festival_history": "",
                "additional_genres": "",
                "liveset_count": liveset_count
            })
    return {"djs": enriched_djs}

@app.get("/api/discover/dj/{dj_name}")
async def discover_dj_by_name(dj_name: str):
    meta = await metadata_service.enrich_dj(dj_name)
    livesets = get_navidrome_livesets_for_dj(dj_name)
    festival_logos = get_all_festival_logos_from_db()
    logo_url = find_logo_for_dj(dj_name, meta, festival_logos)

    if meta:
        return {
            "dj_name": meta.get("dj_name", dj_name),
            "real_name": meta.get("real_name") or "",
            "bio": meta.get("bio") or "",
            "image_url": meta.get("image_url") or "",
            "logo_url": logo_url,
            "genres": meta.get("genres") or "",
            "known_events": meta.get("known_events") or "",
            "festival_history": meta.get("festival_history") or "",
            "additional_genres": meta.get("additional_genres") or "",
            "livesets": livesets
        }
    else:
        return {
            "dj_name": dj_name,
            "real_name": "",
            "bio": "",
            "image_url": "",
            "logo_url": logo_url,
            "genres": "",
            "known_events": "",
            "festival_history": "",
            "additional_genres": "",
            "livesets": livesets
        }

@app.post("/api/discover/enrich")
async def trigger_enrichment(req: Optional[EnrichRequest] = None):
    dj_name = req.dj_name if req else None
    force = req.force if req and req.force is not None else False

    if dj_name:
        meta = await metadata_service.enrich_dj(dj_name, force=force)
        return {
            "success": True,
            "message": f"Enrichment completed for '{dj_name}'",
            "enriched": [meta] if meta else []
        }
    else:
        nav_djs = get_navidrome_djs_with_counts()
        dj_names = [d["dj_name"] for d in nav_djs if d.get("dj_name")]
        results = await metadata_service.enrich_all_djs(dj_names, force=force)
        return {
            "success": True,
            "message": f"Enrichment completed for {len(results)} DJs",
            "enriched": results
        }

@app.post("/api/discover/refresh-metadata")
async def refresh_metadata():
    """Herlaadt Discogs metadata voor alle DJ's zonder genres/bio/images"""
    result = await metadata_service.update_all_djs(force=True)
    return {"status": "ok", "updated": result}




from pydantic import BaseModel

class BugReportRequest(BaseModel):
    app_version: str = ""
    device_info: str = ""
    screenshot_base64: str = ""  # max 500KB, anders None
    screenshot2_base64: str = ""
    screenshot3_base64: str = ""
    screenrecord_base64: str = ""  # NIEUW
    coil_cache: str = ""
    recent_api_calls: str = ""
    user_description: str = ""
    diagnostics_json: str = ""

@app.post("/api/bugreport")
async def receive_bug_report(req: BugReportRequest):
    if len(req.diagnostics_json) > 50000:
        raise HTTPException(status_code=413, detail="diagnostics_json exceeds maximum length of 50000 characters")
    conn = get_db()
    cursor = conn.cursor()
    # Truncate screenshot if too large
    screenshot = req.screenshot_base64[:500000] if len(req.screenshot_base64) > 500000 else req.screenshot_base64
    screenshot2 = req.screenshot2_base64[:500000] if len(req.screenshot2_base64) > 500000 else req.screenshot2_base64
    screenshot3 = req.screenshot3_base64[:500000] if len(req.screenshot3_base64) > 500000 else req.screenshot3_base64
    cursor.execute("""
        INSERT INTO bug_reports (app_version, device_info, screenshot_base64, screenshot2_base64, screenshot3_base64, screenrecord_base64, coil_cache, recent_api_calls, user_description, diagnostics_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (req.app_version, req.device_info, screenshot, screenshot2, screenshot3, req.screenrecord_base64, req.coil_cache, req.recent_api_calls, req.user_description, req.diagnostics_json))
    conn.commit()
    report_id = cursor.lastrowid
    conn.close()
    return {"status": "ok", "report_id": report_id}



# ── Navidrome Recent Albums & Cover API ──────────────────────────────────────

@app.get("/api/navidrome/source/{set_id}")
def get_navidrome_source(set_id: str, db: sqlite3.Connection = Depends(get_navidrome_db)):
    from app.navidrome_source import resolve_source
    return {"youtube_url": resolve_source(db, set_id, os.getenv("MUSIC_PATH", "/music"))}


@app.get("/api/navidrome/recent-albums")
async def get_recent_albums(limit: int = 10, db: sqlite3.Connection = Depends(get_navidrome_db)):
    cursor = db.execute("""
        SELECT a.id, a.name, a.album_artist, a.embed_art_path, a.min_year, a.created_at 
        FROM album a 
        WHERE a.name IS NOT NULL AND a.name != \x27\x27 
          AND a.song_count > 0
        ORDER BY a.created_at DESC 
        LIMIT ?
    """, (limit,))
    albums = []
    for row in cursor.fetchall():
        albums.append({
            "id": row["id"],
            "name": row["name"],
            "artist": row["album_artist"] or "",
            "coverArtPath": row["embed_art_path"] or "",
            "year": row["min_year"],
            "createdAt": str(row["created_at"]) if row["created_at"] else ""
        })
    return {"albums": albums}


COVER_CACHE_DIR = "/data/covers"

@app.api_route("/api/navidrome/cover/{album_id}", methods=["GET", "HEAD"])
async def get_navidrome_cover(album_id: str, db: sqlite3.Connection = Depends(get_navidrome_db)):
    os.makedirs(COVER_CACHE_DIR, exist_ok=True)
    cache_path = os.path.join(COVER_CACHE_DIR, f"{album_id}.jpg")
    if os.path.exists(cache_path):
        return FileResponse(cache_path, media_type="image/jpeg")

    # 1. Check Navidrome artwork directory if it exists
    nav_artwork_dir = os.getenv("NAVIDROME_ARTWORK_PATH", "/navidrome_data/artwork")
    for ext in [".jpg", ".jpeg", ".png"]:
        p = os.path.join(nav_artwork_dir, f"{album_id}{ext}")
        if os.path.exists(p):
            mime = "image/png" if ext == ".png" else "image/jpeg"
            return FileResponse(p, media_type=mime)

    # 2. Check album and media_file in Navidrome DB
    cursor = db.execute("""
        SELECT a.embed_art_path, mf.path 
        FROM album a 
        LEFT JOIN media_file mf ON a.id = mf.album_id 
        WHERE a.id = ? 
        LIMIT 1
    """, (album_id,))
    row = cursor.fetchone()
    if not row:
        return Response(status_code=404)

    embed_art_path = row["embed_art_path"] or ""
    mf_path = row["path"] or ""
    candidate_paths = [p for p in [embed_art_path, mf_path] if p]

    music_dir = os.getenv("MUSIC_PATH", "/music")

    # 3. Check for sidecar image file (e.g. .jpg next to .mp3)
    for rel_path in candidate_paths:
        base_without_ext = os.path.splitext(rel_path)[0]
        for ext in [".jpg", ".jpeg", ".png"]:
            sidecar = os.path.join(music_dir, f"{base_without_ext}{ext}")
            if os.path.exists(sidecar):
                mime = "image/png" if ext == ".png" else "image/jpeg"
                return FileResponse(sidecar, media_type=mime)

    # 4. Extract embedded APIC from MP3 using mutagen
    try:
        from mutagen.mp3 import MP3
        from mutagen.id3 import APIC

        for rel_path in candidate_paths:
            full_audio_path = os.path.join(music_dir, rel_path)
            if os.path.exists(full_audio_path):
                audio = MP3(full_audio_path)
                if audio.tags:
                    for tag in audio.tags.values():
                        if isinstance(tag, APIC):
                            try:
                                with open(cache_path, "wb") as f:
                                    f.write(tag.data)
                            except Exception as save_err:
                                logger.warning(f"Could not cache cover: {save_err}")
                            return Response(content=tag.data, media_type=tag.mime or "image/jpeg")
    except Exception as e:
        logger.error(f"Error extracting cover art for album {album_id}: {e}")

    return Response(status_code=404)


# ── Artist API & Merge Endpoints ─────────────────────────────────────────────

@app.get("/api/artists")
def get_artists(db: sqlite3.Connection = Depends(get_navidrome_db)):
    cursor = db.execute("""
        SELECT a.id, a.name, COUNT(al.id) as album_count
        FROM artist a
        LEFT JOIN album al ON al.album_artist_id = a.id
        WHERE a.name IS NOT NULL AND a.name != ''
        GROUP BY a.id, a.name
        ORDER BY a.name ASC
    """)
    artists = []
    for row in cursor.fetchall():
        artists.append({
            "id": row["id"],
            "name": row["name"],
            "albumCount": row["album_count"]
        })
    return {"artists": artists}


def execute_artist_merge(req: MergeArtistsRequest, db: sqlite3.Connection):
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Service Temporarily Unavailable: artist merge is disabled"
    )

@app.post("/api/admin/merge-artists")
def merge_artists_admin(req: MergeArtistsRequest, db: sqlite3.Connection = Depends(get_navidrome_db)):
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Service Temporarily Unavailable: artist merge is disabled"
    )

@app.post("/api/artists/merge")
def merge_artists_public(req: MergeArtistsRequest, db: sqlite3.Connection = Depends(get_navidrome_db)):
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Service Temporarily Unavailable: artist merge is disabled"
    )

@app.get("/api/update/check")
def check_update(
    request: Request,
    version_name: Optional[str] = Query(None, alias="version_name"),
    versionName: Optional[str] = Query(None, alias="versionName"),
    version_code: Optional[Union[int, str]] = Query(None, alias="version_code"),
    versionCode: Optional[Union[int, str]] = Query(None, alias="versionCode"),
    app_version: Optional[str] = Query(None, alias="app_version"),
    app_version_name: Optional[str] = Query(None, alias="app_version_name"),
    app_version_code: Optional[Union[int, str]] = Query(None, alias="app_version_code")
):
    """Retourneert de nieuwste Beatmonkey Crystal versie info en logt de client app versie."""
    client_ip = (
        request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        or request.headers.get("x-real-ip", "").strip()
        or (request.client.host if request.client else "unknown")
    )
    user_agent = request.headers.get("user-agent", "")

    v_name = (
        version_name
        or versionName
        or app_version_name
        or app_version
        or request.headers.get("x-app-version-name")
        or request.headers.get("x-app-version")
        or request.headers.get("x-version-name")
    )

    raw_v_code = (
        version_code
        or versionCode
        or app_version_code
        or request.headers.get("x-app-version-code")
        or request.headers.get("x-version-code")
    )
    v_code = None
    if raw_v_code is not None:
        try:
            v_code = int(raw_v_code)
        except (ValueError, TypeError):
            v_code = None

    try:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO app_version_check (version_name, version_code, ip_address, checked_at, user_agent)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
        """, (v_name, v_code, client_ip, user_agent))
        conn.commit()
        conn.close()
    except Exception as e:
        logger.warning(f"Kon app_version_check niet loggen: {e}")

    version_file = os.path.join(STATIC_DIR, "version.json")
    if not os.path.exists(version_file):
        version_file = "/opt/beatmonkey-core/static/version.json"
    if os.path.exists(version_file):
        with open(version_file) as f:
            data = json.load(f)
        return data
    return {
        "versionCode": 0,
        "versionName": "unknown",
        "apkUrl": "https://music.cyberspeeze.online/api/download/apk",
        "whatsNew": "Geen update info beschikbaar"
    }


@app.get("/api/admin/versions")
def get_client_versions(days: int = Query(7, ge=1, le=365, description="Aantal dagen terugkijken")):
    """Overzicht van unieke clients (IP/tijdstip/versionName/versionCode) van de laatste N dagen."""
    try:
        conn = get_db()
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        # Unieke clients gegroepeerd per IP met de meest recente check
        cur.execute("""
            WITH RankedChecks AS (
                SELECT 
                    id,
                    version_name,
                    version_code,
                    ip_address,
                    checked_at,
                    user_agent,
                    ROW_NUMBER() OVER (PARTITION BY ip_address ORDER BY checked_at DESC, id DESC) as rn,
                    COUNT(*) OVER (PARTITION BY ip_address) as check_count
                FROM app_version_check
                WHERE checked_at >= datetime('now', '-' || ? || ' days')
            )
            SELECT 
                id,
                ip_address,
                version_name,
                version_code,
                checked_at,
                user_agent,
                check_count
            FROM RankedChecks
            WHERE rn = 1
            ORDER BY checked_at DESC;
        """, (days,))
        rows = cur.fetchall()

        clients = [
            {
                "id": r["id"],
                "ip_address": r["ip_address"],
                "version_name": r["version_name"],
                "versionName": r["version_name"],
                "version_code": r["version_code"],
                "versionCode": r["version_code"],
                "checked_at": r["checked_at"],
                "user_agent": r["user_agent"],
                "check_count": r["check_count"]
            }
            for r in rows
        ]

        cur.execute("""
            SELECT COUNT(*) as total FROM app_version_check
            WHERE checked_at >= datetime('now', '-' || ? || ' days')
        """, (days,))
        total_count_row = cur.fetchone()
        total_checks = total_count_row["total"] if total_count_row else 0

        cur.execute("""
            SELECT id, version_name, version_code, ip_address, checked_at, user_agent
            FROM app_version_check
            ORDER BY checked_at DESC, id DESC
            LIMIT 20
        """)
        recent_rows = cur.fetchall()
        recent_checks = [
            {
                "id": r["id"],
                "ip_address": r["ip_address"],
                "version_name": r["version_name"],
                "versionName": r["version_name"],
                "version_code": r["version_code"],
                "versionCode": r["version_code"],
                "checked_at": r["checked_at"],
                "user_agent": r["user_agent"]
            }
            for r in recent_rows
        ]

        conn.close()
        return {
            "days": days,
            "total_unique_clients": len(clients),
            "total_checks": total_checks,
            "clients": clients,
            "recent_checks": recent_checks
        }
    except Exception as e:
        logger.error(f"Error retrieving client versions: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")


@app.api_route("/api/download/apk", methods=["GET", "HEAD"])
def download_apk():
    """Download de nieuwste Beatmonkey Crystal APK met correct MIME type en Content-Disposition."""
    possible_paths = [
        os.path.join(STATIC_DIR, "beatmonkey_crystal_latest.apk"),
        os.path.join(STATIC_DIR, "beatmonkey-crystal.apk"),
        "/opt/beatmonkey-core/static/beatmonkey_crystal_latest.apk",
        "/opt/beatmonkey-core/static/beatmonkey-crystal.apk",
        "/app/static/beatmonkey_crystal_latest.apk",
        "/app/static/beatmonkey-crystal.apk",
    ]
    for apk_path in possible_paths:
        if os.path.exists(apk_path):
            return FileResponse(
                apk_path,
                media_type="application/vnd.android.package-archive",
                filename="beatmonkey-crystal.apk",
                headers={
                    "Content-Disposition": "attachment; filename=\"beatmonkey-crystal.apk\"",
                    "Content-Type": "application/vnd.android.package-archive"
                }
            )
    return JSONResponse(status_code=404, content={"error": "APK not found"})


@app.get("/dl", response_class=HTMLResponse)
def download_landing_page():
    """HTML download pagina voor Beatmonkey Crystal."""
    html_content = """<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Beatmonkey Crystal Download</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background-color: #0f172a;
            color: #ffffff;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 24px;
            text-align: center;
        }
        .card {
            background: rgba(30, 41, 59, 0.85);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 24px;
            padding: 40px 28px;
            max-width: 420px;
            width: 100%;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
        }
        .icon { font-size: 54px; margin-bottom: 16px; }
        h1 {
            font-size: 24px;
            font-weight: 700;
            margin-bottom: 8px;
            color: #38bdf8;
            letter-spacing: -0.5px;
        }
        .subtitle {
            font-size: 15px;
            color: #94a3b8;
            margin-bottom: 28px;
            line-height: 1.5;
        }
        .btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            background: linear-gradient(135deg, #38bdf8, #818cf8);
            color: #0f172a;
            font-weight: 700;
            text-decoration: none;
            padding: 16px 24px;
            border-radius: 14px;
            font-size: 16px;
            box-shadow: 0 4px 20px rgba(56, 189, 248, 0.35);
        }
        .info-box {
            margin-top: 24px;
            padding: 14px 16px;
            background: rgba(15, 23, 42, 0.6);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 12px;
            font-size: 13px;
            color: #94a3b8;
            line-height: 1.6;
        }
        .info-box strong { color: #cbd5e1; }
        .meta {
            margin-top: 18px;
            font-size: 12px;
            color: #64748b;
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">🐒</div>
        <h1>Beatmonkey Crystal</h1>
        <p class="subtitle">Android App voor elektronische muziek &amp; livesets</p>
        
        <a class="btn" href="/api/download/apk" download="beatmonkey-crystal.apk">
            <span>📥</span>
            <span>Klik hier om Beatmonkey Crystal te downloaden</span>
        </a>

        <div class="info-box">
            💡 <strong>Tip:</strong> Als de download niet start, tik dan op de drie puntjes (<strong>⋮</strong>) &gt; <strong>Downloaden</strong>
        </div>

        <div class="meta">
            Versie: Latest • Android APK
        </div>
    </div>
</body>
</html>"""
    return HTMLResponse(content=html_content)


@app.get("/api/tracklist/mapping")
def get_tracklist_mapping():
    mapping_file = os.path.join(STATIC_DIR, "tracklist_mapping.json")
    if not os.path.exists(mapping_file):
        mapping_file = "/opt/beatmonkey-core/static/tracklist_mapping.json"
    if os.path.exists(mapping_file):
        with open(mapping_file) as f:
            return json.load(f)
    return {"mappings": []}

@app.get("/api/tracklist/resolve")
def resolve_tracklist(
    album: str = Query("", description="Album / festival name"),
    artist: str = Query("", description="Artist name"),
    album_id: str = Query("", description="Album ID or Tracklist ID"),
    song_id: str = Query("", description="Song / Media ID")
):
    """Zoek een 1001Tracklists URL op basis van album naam + artiest."""
    mapping_file = os.path.join(STATIC_DIR, "tracklist_mapping.json")
    if not os.path.exists(mapping_file):
        mapping_file = "/opt/beatmonkey-core/static/tracklist_mapping.json"
    if os.path.exists(mapping_file):
        with open(mapping_file, "r", encoding="utf-8") as f:
            mapping = json.load(f)
    else:
        mapping = {"mappings": []}

    mappings = mapping.get("mappings", mapping) if isinstance(mapping, dict) else mapping
    if not isinstance(mappings, list):
        mappings = []

    def normalize_url(u: str) -> str:
        if not u:
            return ""
        clean = u.strip()
        if "set79.com" in clean or clean.startswith("https://set79.com"):
            return clean
        if "fullsets.fm" in clean or clean.startswith("/set/"):
            from app.tracklist_matching import normalize_fullsets_url
            return normalize_fullsets_url(clean)
        if clean.startswith("http"):
            return clean.replace("1001tracklists.comtracklist", "1001tracklists.com/tracklist")
        if clean.startswith("/tracklist/"):
            return clean
        if clean.startswith("/"):
            return "/tracklist" + clean
        return "/tracklist/" + clean

    def format_match(m, matched_as=None):
        raw_url = m.get("tracklistUrl", m.get("url", "")) or ""
        clean_url = normalize_url(raw_url)
        source = m.get("source")
        if not source:
            if "set79.com" in clean_url or "soundcloud.com" in clean_url:
                source = "set79"
            elif "fullsets.fm" in clean_url:
                source = "fullsets"
            else:
                source = "1001tracklists"
        elif source.startswith("auto:"):
            source = source.split("auto:", 1)[1]

        resp = {
            "found": True,
            "tracklistUrl": clean_url,
            "verified": m.get("verified", False),
            "source": source
        }
        if matched_as:
            resp["matched_as"] = matched_as
        return resp

    # Zoek op album_id of song_id als die meegegeven is
    aid_str = album_id.strip() if isinstance(album_id, str) else ""
    sid_str = song_id.strip() if isinstance(song_id, str) else ""
    target_ids = [i for i in [aid_str, sid_str] if i]
    if target_ids:
        for aid in target_ids:
            for m in reversed(mappings):
                raw_url = m.get("tracklistUrl", m.get("url", "")) or ""
                # Check main album_id
                if m.get("album_id") == aid:
                    return format_match(m)
                # Check subsonic_ids (extra IDs voor PWA/Song IDs)
                subsonic_ids = m.get("subsonic_ids", [])
                if isinstance(subsonic_ids, list) and aid in subsonic_ids:
                    return format_match(m)
                # Check in URL
                if (f"/{aid}/" in raw_url or
                    raw_url.startswith(f"/tracklist/{aid}") or
                    raw_url.startswith(f"/{aid}") or
                    aid in raw_url):
                    return format_match(m)

    album_lower = album.lower().strip() if isinstance(album, str) else ""
    artist_lower = artist.lower().strip() if isinstance(artist, str) else ""

    # Zoek eerst exacte matches
    exact_matches = []
    substring_matches = []
    for i, m in enumerate(mappings):
        m_artist = m.get("artist", m.get("dj_name", "")).lower().strip()
        m_album = m.get("albumName", m.get("album", "")).lower().strip()

        if m_artist == artist_lower:
            if m_album == album_lower or album_lower == m_album:
                exact_matches.append((i, m))
            elif m_album in album_lower or album_lower in m_album:
                substring_matches.append((i, m))

    # Exacte matches eerst (laatste = recentste)
    if exact_matches:
        best = exact_matches[-1]
        return format_match(best[1])

    # Dan substring matches (laatste = recentste)
    if substring_matches:
        best = substring_matches[-1]
        return format_match(best[1])

    # 1b. Extra substring matching — vangt gedeeltelijke namen
    extra_substring = []
    for i, m in enumerate(mappings):
        m_artist = m.get("artist", m.get("dj_name", "")).lower().strip()
        m_album = m.get("albumName", m.get("album", "")).lower().strip()
        # Check of de opgegeven artist in de mapping artist zit of andersom
        artist_match = artist_lower and (artist_lower in m_artist or m_artist in artist_lower)
        # Check of de opgegeven album in de mapping album zit of andersom
        album_match = album_lower and (album_lower in m_album or m_album in album_lower)
        if artist_match and album_match:
            extra_substring.append((i, m))
    if extra_substring:
        best = extra_substring[-1]
        return format_match(best[1])

    # 2. Extra check voor b2b combinaties
    if "b2b" in artist_lower:
        parts = [p.strip() for p in artist_lower.split("b2b") if p.strip()]
        if len(parts) >= 2:
            exact_b2b = []
            sub_b2b = []
            for part in parts:
                for i, m in enumerate(mappings):
                    m_artist = m.get("artist", m.get("dj_name", "")).lower().strip()
                    m_album = m.get("albumName", m.get("album", "")).lower().strip()
                    if part in m_artist or m_artist in part:
                        if m_album == album_lower or album_lower == m_album:
                            exact_b2b.append((i, m, part))
                        elif m_album in album_lower or album_lower in m_album:
                            sub_b2b.append((i, m, part))
            if exact_b2b:
                best = exact_b2b[-1]
                return format_match(best[1], matched_as=best[2])
            if sub_b2b:
                best = sub_b2b[-1]
                return format_match(best[1], matched_as=best[2])

    return {"found": False, "tracklistUrl": None}


@app.get("/api/tracklist/cached")
async def get_cached_tracklist_api(
    url: str = Query(..., description="1001Tracklists URL om op te zoeken in cache"),
):
    """Check of een tracklist in de persistent cache (core.db) zit.
    Geeft de gecachte tracklist terug indien aanwezig en niet verlopen (< 24u oud).
    """
    try:
        from app.database import get_cached_tracklist
        lookup_url = url.strip()
        if "fullsets.fm" in lookup_url or lookup_url.startswith("/set/"):
            from app.tracklist_matching import normalize_fullsets_url
            lookup_url = normalize_fullsets_url(lookup_url)
        cached = get_cached_tracklist(lookup_url)
        if cached:
            return {"found": True, "data": cached}
        return {"found": False, "data": None}
    except Exception as e:
        logger.error(f"Error checking tracklist cache: {e}")
        return {"found": False, "data": None, "error": str(e)}


import urllib.request
import urllib.error

class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def resolve_shortlink(url: str) -> str:
    """Volg redirect van 1001.tl naar volledige 1001tracklists URL"""
    clean = url.strip()
    if clean.startswith('1001.tl/'):
        clean = 'https://' + clean
    if '1001.tl' in clean:
        try:
            resp = requests.get(clean, allow_redirects=True, timeout=10, headers={'User-Agent': 'Mozilla/5.0'})
            if '1001tracklists.com/tracklist/' in resp.url:
                return resp.url
        except Exception:
            pass
    return clean

def resolve_1001_url(url: str) -> str:
    """Resolveert 1001.tl shortlinks, IDs, of paden naar volledige 1001tracklists URL"""
    clean = url.strip()
    if clean.startswith("1001.tl/"):
        clean = "https://" + clean
    if "1001.tl" in clean:
        try:
            opener = urllib.request.build_opener(_NoRedirectHandler)
            req = urllib.request.Request(clean, headers={"User-Agent": "curl/7.88.1"})
            try:
                opener.open(req, timeout=10)
            except urllib.error.HTTPError as e:
                if e.code in (301, 302, 303, 307, 308):
                    loc = e.headers.get("Location")
                    if loc:
                        return loc
        except Exception:
            pass

    id_candidate = clean
    for prefix in [
        "https://www.1001tracklists.com/tracklist/",
        "http://www.1001tracklists.com/tracklist/",
        "https://1001tracklists.com/tracklist/",
        "http://1001tracklists.com/tracklist/",
        "/tracklist/",
        "/"
    ]:
        if id_candidate.startswith(prefix):
            id_candidate = id_candidate[len(prefix):]
            break

    if "/" not in id_candidate and not id_candidate.endswith(".html") and 0 < len(id_candidate) < 25:
        try:
            opener = urllib.request.build_opener(_NoRedirectHandler)
            req = urllib.request.Request(f"https://1001.tl/{id_candidate}", headers={"User-Agent": "curl/7.88.1"})
            try:
                opener.open(req, timeout=10)
            except urllib.error.HTTPError as e:
                if e.code in (301, 302, 303, 307, 308):
                    loc = e.headers.get("Location")
                    if loc:
                        return loc
        except Exception:
            pass

    if not clean.startswith("http"):
        if not clean.startswith("/"):
            clean = "/" + clean
        if not clean.startswith("/tracklist"):
            clean = "/tracklist" + clean
        clean = f"https://www.1001tracklists.com{clean}"
    return clean

@app.post("/api/tracklist/manual-map")
async def manual_map_tracklist(
    albumName: str = Query("", description="Album / festival name"),
    artist: str = Query("", description="Artist name"),
    tracklistUrl: str = Query("", description="1001Tracklists URL of pad")
):
    """Handmatig een 1001Tracklists URL toevoegen aan tracklist_mapping.json en optioneel scrapen."""
    raw_url = tracklistUrl.strip()
    
    # Bij 1001.tl shortlinks: niet proberen te resolven vanaf VPS (faalt),
    # stuur direct naar Beelink scraper die FlareSolverr gebruikt
    if "1001.tl" in raw_url:
        clean_url = raw_url
    else:
        resolved = resolve_shortlink(raw_url)
        clean_url = resolved
    
    if clean_url.startswith("http"):
        clean_url = clean_url.replace("1001tracklists.comtracklist", "1001tracklists.com/tracklist")
        if "1001tracklists.com" in clean_url:
            import urllib.parse
            parsed = urllib.parse.urlparse(clean_url)
            clean_url = parsed.path
    elif clean_url.startswith("/tracklist/"):
        pass  # al goed
    elif clean_url.startswith("/"):
        clean_url = "/tracklist" + clean_url
    else:
        # Alleen een ID
        clean_url = "/tracklist/" + clean_url

    tracks_count = 0
    if clean_url:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=30.0) as client:
                scraper_urls = [
                    f"http://10.0.0.3:8192/api/scrape/tracklist?url={clean_url}",
                ]
                for s_url in scraper_urls:
                    try:
                        resp = await client.get(s_url)
                        if resp.status_code == 200:
                            data = resp.json()
                            tracks_count = len(data.get("tracks", [])) or data.get("total_tracks", 0)
                            break
                    except Exception:
                        continue
        except Exception as e:
            logger.warning(f"Manual tracklist scrape warning for {clean_url}: {e}")

    mapping_file = os.path.join(STATIC_DIR, "tracklist_mapping.json")
    if not os.path.exists(mapping_file):
        mapping_file = "/opt/beatmonkey-core/static/tracklist_mapping.json"

    if os.path.exists(mapping_file):
        try:
            with open(mapping_file, "r", encoding="utf-8") as f:
                mapping = json.load(f)
        except Exception:
            mapping = {"mappings": []}
    else:
        mapping = {"mappings": []}

    mappings = mapping.get("mappings", [])
    updated = False
    for m in mappings:
        if (m.get("artist", "").lower().strip() == artist.strip().lower() and
            m.get("albumName", "").lower().strip() == albumName.strip().lower()):
            m["tracklistUrl"] = clean_url
            m["verified"] = True
            updated = True
            break

    if not updated and (albumName.strip() or artist.strip()):
        mappings.append({
            "albumName": albumName.strip(),
            "artist": artist.strip(),
            "tracklistUrl": clean_url,
            "verified": True
        })

    mapping["mappings"] = mappings

    try:
        with open(mapping_file, "w", encoding="utf-8") as f:
            json.dump(mapping, f, indent=2, ensure_ascii=False)
        fallback_file = "/opt/beatmonkey-core/static/tracklist_mapping.json"
        if os.path.exists(os.path.dirname(fallback_file)) and mapping_file != fallback_file:
            with open(fallback_file, "w", encoding="utf-8") as f:
                json.dump(mapping, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Error saving tracklist_mapping.json: {e}")

    return {
        "success": True,
        "tracklistUrl": clean_url,
        "tracks": tracks_count
    }


@app.post("/api/scan")
async def trigger_scan():
    """Trigger Navidrome library scan."""
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Service Temporarily Unavailable: library scan is disabled"
    )


YOUTUBE_ID_REGEX = re.compile(r"^[a-zA-Z0-9_-]{11}$")
ALLOWED_YOUTUBE_DOMAINS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
}
ALLOWED_DOWNLOAD_FORMATS = {"mp3"}
ALLOWED_DOWNLOAD_QUALITIES = {"128k", "192k", "256k", "320k", "0", "best"}

def extract_and_validate_youtube_id(target: str) -> str:
    """Strictly validate and extract 11-character YouTube video ID."""
    clean = (target or "").strip()
    if not clean:
        raise ValueError("URL or video ID is required")

    # Direct 11-char ID
    if YOUTUBE_ID_REGEX.match(clean):
        return clean

    try:
        parsed = urllib.parse.urlparse(clean)
    except Exception:
        raise ValueError("Malformed URL")

    if parsed.scheme not in ("http", "https"):
        raise ValueError("Invalid URL scheme; must be http or https")

    hostname = (parsed.hostname or "").lower()
    if hostname not in ALLOWED_YOUTUBE_DOMAINS:
        raise ValueError(f"Invalid host '{hostname}'. Only YouTube URLs are allowed.")

    if parsed.username or parsed.password:
        raise ValueError("User credentials in URL are prohibited")

    video_id = None
    if hostname == "youtu.be":
        parts = [p for p in parsed.path.split("/") if p]
        if parts:
            video_id = parts[0]
    else:
        path = parsed.path.rstrip("/")
        if path == "/watch":
            qs = urllib.parse.parse_qs(parsed.query)
            v_vals = qs.get("v")
            if v_vals and len(v_vals) > 0:
                video_id = v_vals[0]
        elif path.startswith("/shorts/"):
            parts = [p for p in path.split("/") if p]
            if len(parts) >= 2 and parts[0] == "shorts":
                video_id = parts[1]
        elif path.startswith("/live/"):
            parts = [p for p in path.split("/") if p]
            if len(parts) >= 2 and parts[0] == "live":
                video_id = parts[1]
        elif path.startswith("/embed/"):
            parts = [p for p in path.split("/") if p]
            if len(parts) >= 2 and parts[0] == "embed":
                video_id = parts[1]

    if not video_id or not YOUTUBE_ID_REGEX.match(video_id):
        raise ValueError("Could not extract a valid 11-character YouTube video ID")

    return video_id


@app.post("/api/youtube/download")
async def download_youtube_endpoint(
    url: Optional[str] = Query(None),
    fmt: Optional[str] = Query("mp3"),
    quality: Optional[str] = Query("192k"),
    payload: Optional[YoutubeDownloadRequest] = None,
    current_user: dict = Depends(get_current_user)
):
    """
    Authorized YouTube download endpoint.
    Validates JWT auth, enforces strict YouTube URL & 11-char video ID,
    checks format & quality allowlists, persists job records, and delegates
    execution to the isolated unprivileged downloader worker via random internal secret.
    """
    target_url = (payload.url if payload and payload.url else url) or ""
    target_url = target_url.strip()
    if not target_url:
        raise HTTPException(status_code=400, detail="URL is required")

    target_fmt = ((payload.fmt if payload and payload.fmt else fmt) or "mp3").lower()
    target_quality = ((payload.quality if payload and payload.quality else quality) or "192k").lower()

    if target_fmt not in ALLOWED_DOWNLOAD_FORMATS:
        raise HTTPException(status_code=400, detail="Only 'mp3' format is permitted")
    if target_quality not in ALLOWED_DOWNLOAD_QUALITIES:
        raise HTTPException(status_code=400, detail=f"Invalid quality. Allowed values: {sorted(ALLOWED_DOWNLOAD_QUALITIES)}")

    try:
        video_id = extract_and_validate_youtube_id(target_url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    user_id = current_user.get("user_id") or current_user.get("sub") or "unknown"
    job_id = secrets.token_hex(16)

    # Persist job initially
    create_download_job(job_id, user_id, video_id, target_url)

    worker_url = os.getenv("DOWNLOADER_WORKER_URL", "http://beatmonkey-downloader:8001").rstrip("/")
    worker_secret = os.getenv("WORKER_INTERNAL_SECRET", "")
    if not worker_secret or len(worker_secret) < 32:
        logger.error("WORKER_INTERNAL_SECRET is unconfigured or shorter than 32 characters")
        update_download_job(job_id, status="failed", ok=0, rc=-1, message="Worker secret unconfigured", stdout="", stderr="Internal error")
        raise HTTPException(status_code=500, detail="Internal worker authentication unconfigured")

    headers = {
        "X-Worker-Secret": worker_secret,
        "Content-Type": "application/json"
    }
    worker_payload = {
        "video_id": video_id,
        "fmt": target_fmt,
        "quality": target_quality,
        "user_id": user_id,
        "job_id": job_id
    }

    try:
        async with httpx.AsyncClient(timeout=310.0) as client:
            resp = await client.post(f"{worker_url}/download", json=worker_payload, headers=headers)

        if resp.status_code in (401, 403):
            logger.error(f"Worker authentication failure: {resp.status_code}")
            update_download_job(job_id, status="failed", ok=0, rc=-1, message="Worker authentication failed", stdout="", stderr=resp.text)
            return {
                "ok": False,
                "stdout": "",
                "stderr": "Worker authentication failed",
                "rc": -1,
                "message": "Fout bij communicatie met downloader worker"
            }

        if resp.status_code != 200:
            err_text = resp.text
            update_download_job(job_id, status="failed", ok=0, rc=-1, message=f"Worker error: {resp.status_code}", stdout="", stderr=err_text)
            return {
                "ok": False,
                "stdout": "",
                "stderr": err_text,
                "rc": -1,
                "message": f"Worker error: {resp.status_code}"
            }

        data = resp.json()
        ok = bool(data.get("ok"))
        stdout = data.get("stdout", "")
        stderr = data.get("stderr", "")
        rc = data.get("rc", 0 if ok else -1)
        msg = data.get("message") or (stdout if stdout else ("Download succesvol voltooid." if ok else stderr))

        update_download_job(
            job_id,
            status="completed" if ok else "failed",
            ok=1 if ok else 0,
            rc=rc,
            message=msg,
            stdout=stdout,
            stderr=stderr
        )

        return {
            "ok": ok,
            "stdout": stdout,
            "stderr": stderr,
            "rc": rc,
            "message": msg,
            "filename": data.get("filename"),
            "job_id": job_id
        }
    except httpx.TimeoutException:
        logger.error(f"Worker timeout for video_id {video_id}")
        update_download_job(job_id, status="failed", ok=0, rc=-1, message="Download duurde te lang (timeout)", stdout="", stderr="Download timeout na 300 seconden")
        return {
            "ok": False,
            "stdout": "",
            "stderr": "Download timeout na 300 seconden",
            "rc": -1,
            "message": "Download duurde te lang (timeout)"
        }
    except Exception as e:
        logger.error(f"Error calling worker for {video_id}: {e}")
        update_download_job(job_id, status="failed", ok=0, rc=-1, message=f"Serverfout bij download: {e}", stdout="", stderr=str(e))
        return {
            "ok": False,
            "stdout": "",
            "stderr": str(e),
            "rc": -1,
            "message": f"Serverfout bij download: {e}"
        }


@app.get("/api/youtube/download/job/{job_id}")
async def get_youtube_download_job_endpoint(
    job_id: str,
    current_user: dict = Depends(get_current_user)
):
    """Retrieve the status and outputs of a YouTube download job."""
    job = get_download_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    user_id = current_user.get("user_id") or current_user.get("sub")
    if not current_user.get("is_admin") and job.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Forbidden: You do not own this download job")
    return job


@app.get("/api/scrape/tracklist")
async def proxy_scrape_tracklist(url: str = Query(...)):
    """Proxy GET /api/scrape/tracklist requests to the Beelink scraper."""
    import httpx
    clean_url = url.strip()
    # Check of dit een set79.com URL is — gebruik dan de set79 scraper
    if "set79.com" in clean_url:
        try:
            from app.set79_scraper import scrape_set79
            result = await scrape_set79(clean_url)
            if result.get("total_tracks", 0) > 0:
                return result
        except Exception as e:
            logger.warning(f"Set79 scrape via /api/scrape/tracklist failed: {e}")

    if "fullsets.fm" in clean_url or clean_url.startswith("/set/"):
        from app.tracklist_matching import normalize_fullsets_url
        canonical_url = normalize_fullsets_url(clean_url)
        cached = get_cached_tracklist(canonical_url)
        if cached and cached.get("total_tracks", 0) > 0:
            return {**cached, "url": canonical_url, "source": "fullsets"}
        try:
            from app.tracklist_discovery import fetch_fullsets_set
            res = await fetch_fullsets_set(canonical_url)
            if res.get("total_tracks", 0) > 0:
                upsert_tracklist(
                    tracklist_url=canonical_url,
                    artist=res.get("artist", ""),
                    album_name="",
                    title=res.get("title", ""),
                    total_tracks=res["total_tracks"],
                    tracks_json=json.dumps(res.get("tracks", []), default=str),
                    ttl_hours=24
                )
                return res
            if res.get("error"):
                return res
        except Exception as e:
            logger.warning(f"Fullsets live fetch failed for {canonical_url}: {e}")
        return {"error": f"Cached tracklist not found for {canonical_url}", "tracks": []}

    if not clean_url.startswith("http"):
        if not clean_url.startswith("/"):
            clean_url = "/" + clean_url
        clean_url = f"https://www.1001tracklists.com{clean_url}"
    beelink_url = f"http://10.0.0.3:8192/api/scrape/tracklist?url={clean_url}"
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.get(beelink_url)
            if resp.status_code == 200:
                return resp.json()
            return {"error": f"Beelink scraper returned {resp.status_code}", "tracks": []}
    except Exception as e:
        logger.error(f"Beelink scraper proxy error: {e}")
        return {"error": str(e), "tracks": []}

@app.get("/api/scrape/artist/{slug}")
async def proxy_scrape_artist(slug: str, q: Optional[str] = Query(None, description="Optional bounded search query")):
    """Proxy GET /api/scrape/artist/{slug} requests to the Beelink scraper."""
    import httpx
    beelink_url = f"http://10.0.0.3:8192/api/scrape/artist/{slug}"
    if q and q.strip():
        beelink_url = f"{beelink_url}?q={urllib.parse.quote(q.strip())}"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(beelink_url)
            if resp.status_code == 200:
                return resp.json()
            return {"error": f"Beelink scraper returned {resp.status_code}", "tracklists": []}
    except Exception as e:
        logger.error(f"Beelink scraper proxy error: {e}")
        return {"error": str(e), "tracklists": []}


@app.get("/api/scrape/set79")
async def api_scrape_set79(
    url: str = Query(..., description="SoundCloud URL of set79.com URL"),
    refresh: bool = Query(False, description="Forceer verse scrape (negeer cache)")
):
    """Scrape een DJ set tracklist van set79.com (accepteert set79.com URL of SoundCloud URL)."""
    clean_url = url.strip()
    if not clean_url:
        raise HTTPException(status_code=400, detail="URL is verplicht")
    
    result = await scrape_set79(clean_url, force_refresh=refresh)
    if "error" in result and result.get("total_tracks", 0) == 0:
        err_msg = result.get("error", "Tracklist niet gevonden")
        if "404" in err_msg or "niet gevonden" in err_msg.lower() or "not found" in err_msg.lower():
            raise HTTPException(status_code=404, detail=err_msg)
        raise HTTPException(status_code=500, detail=err_msg)
    
    return result


import urllib.parse


@app.get("/api/scrape/auto-resolve")
async def auto_resolve_tracklist(
    album_id: str = Query("", description="Album ID or Subsonic ID"),
    artist: str = Query("", description="Artist name"),
    albumName: str = Query("", description="Album / Set name"),
    soundcloud_url: Optional[str] = Query(None, description="Optional SoundCloud URL for set79"),
    song_id: Optional[str] = Query(None, description="Optional Song ID or Media ID"),
    full_title: str = Query("", description="Original media title including event/date")
):
    """
    Dual-source auto-resolve endpoint for tracklists (1001Tracklists & set79.com).
    """
    album_id = album_id.strip() if isinstance(album_id, str) else ""
    artist = artist.strip() if isinstance(artist, str) else ""
    albumName = albumName.strip() if isinstance(albumName, str) else ""
    sc_url = soundcloud_url.strip() if isinstance(soundcloud_url, str) else None
    song_id = song_id.strip() if isinstance(song_id, str) else ""

    logger.info(f"Auto-resolve requested: album_id='{album_id}', song_id='{song_id}', artist='{artist}', albumName='{albumName}', soundcloud_url='{sc_url}'")

    source_errors = []
    mismatch_detail = ""

    def _check_artist_response_mismatch(req_artist: str, payload: dict) -> Optional[str]:
        if not req_artist or not isinstance(payload, dict):
            return None
        import re as _re
        req_tokens = [t for t in _re.findall(r"[a-z0-9]+", req_artist.lower()) if len(t) >= 2]
        if not req_tokens:
            req_tokens = _re.findall(r"[a-z0-9]+", req_artist.lower())
        if not req_tokens:
            return None
        req_compact = "".join(req_tokens)

        for field_name in ("page_title", "artist", "artist_name"):
            raw_val = str(payload.get(field_name) or "").strip()
            if not raw_val:
                continue
            val_low = raw_val.lower()
            val_tokens = set(_re.findall(r"[a-z0-9]+", val_low))
            val_compact = _re.sub(r"[^a-z0-9]+", "", val_low)
            if not (
                all(tok in val_tokens for tok in req_tokens)
                or (req_compact and req_compact in val_compact)
            ):
                return f"Artist response {field_name} mismatch: requested '{req_artist}', got '{raw_val}'"
        return None

    async def fetch_1001tracklists(t_url: str) -> dict:
        if not t_url.startswith("http"):
            if not t_url.startswith("/"):
                t_url = "/" + t_url
            t_url = f"https://www.1001tracklists.com{t_url}"
        beelink_url = f"http://10.0.0.3:8192/api/scrape/tracklist?url={urllib.parse.quote(t_url, safe=':/')}"
        try:
            async with httpx.AsyncClient(timeout=35.0) as client:
                resp = await client.get(beelink_url)
                if resp.status_code == 200:
                    data = resp.json()
                    tracks = data.get("tracks", [])
                    total = len(tracks) or data.get("total_tracks", 0)
                    if total > 0:
                        return {
                            "url": t_url,
                            "title": data.get("title", ""),
                            "total_tracks": total,
                            "tracks": tracks,
                            "source": "1001tracklists"
                        }
                    if data.get("error"):
                        return {
                            "url": t_url,
                            "title": "",
                            "total_tracks": 0,
                            "tracks": [],
                            "source": "1001tracklists",
                            "error": "source_unavailable",
                            "detail": f"Scraper tracklist error for {t_url}: {data.get('error')}"
                        }
                    return {
                        "url": t_url,
                        "title": data.get("title", ""),
                        "total_tracks": 0,
                        "tracks": [],
                        "source": "1001tracklists",
                        "error": "source_unavailable",
                        "detail": f"Scraper returned 0 tracks for matched tracklist {t_url}"
                    }
                return {
                    "url": t_url,
                    "title": "",
                    "total_tracks": 0,
                    "tracks": [],
                    "source": "1001tracklists",
                    "error": "source_unavailable",
                    "detail": f"Scraper tracklist HTTP {resp.status_code} for {t_url}"
                }
        except Exception as e:
            logger.warning(f"Error fetching 1001tracklists via Beelink ({t_url}): {e}")
            return {
                "url": t_url,
                "title": "",
                "total_tracks": 0,
                "tracks": [],
                "source": "1001tracklists",
                "error": "source_unavailable",
                "detail": f"Scraper tracklist request failed ({type(e).__name__}): {e}"
            }

    # 1. Step a: Check tracklist_mapping.json first
    mapping_file = os.path.join(STATIC_DIR, "tracklist_mapping.json")
    if not os.path.exists(mapping_file):
        mapping_file = "/opt/beatmonkey-core/static/tracklist_mapping.json"

    mapping_data = {"mappings": []}
    if os.path.exists(mapping_file):
        try:
            with open(mapping_file, "r", encoding="utf-8") as f:
                mapping_data = json.load(f)
        except Exception as e:
            logger.warning(f"Error reading tracklist_mapping.json in auto-resolve: {e}")

    mappings = mapping_data.get("mappings", []) if isinstance(mapping_data, dict) else mapping_data
    if not isinstance(mappings, list):
        mappings = []

    mapped_match = None
    target_ids = [i for i in [album_id, song_id] if i]
    if target_ids:
        for m in reversed(mappings):
            raw_url = m.get("tracklistUrl", m.get("url", "")) or ""
            m_album_id = m.get("album_id")
            m_subs = m.get("subsonic_ids", []) if isinstance(m.get("subsonic_ids"), list) else []
            matched = False
            for tid in target_ids:
                if (m_album_id == tid or
                    tid in m_subs or
                    f"/{tid}/" in raw_url or
                    raw_url.startswith(f"/tracklist/{tid}") or
                    raw_url.startswith(f"/{tid}")):
                    matched = True
                    break
            if matched:
                mapped_match = m
                break

    if not mapped_match and artist and albumName:
        artist_lower = artist.lower()
        album_lower = albumName.lower()
        for m in reversed(mappings):
            m_artist = m.get("artist", m.get("dj_name", "")).lower().strip()
            m_album = m.get("albumName", m.get("album", "")).lower().strip()
            if m_artist == artist_lower:
                if m_album == album_lower or m_album in album_lower or album_lower in m_album:
                    mapped_match = m
                    break

    if mapped_match:
        m_url = mapped_match.get("tracklistUrl", mapped_match.get("url", ""))
        if m_url:
            source_tag = mapped_match.get("source", "")
            is_set79 = "set79.com" in m_url or source_tag in ("set79", "auto:set79")
            is_fullsets = "fullsets.fm" in m_url or m_url.startswith("/set/") or source_tag in ("fullsets", "auto:fullsets")
            if is_fullsets:
                from app.tracklist_matching import normalize_fullsets_url
                m_url = normalize_fullsets_url(m_url)

            # Check core.db cache first
            cached = get_cached_tracklist(m_url)
            if cached and cached.get("total_tracks", 0) > 0:
                logger.info(f"Auto-resolve mapping hit (cached): {m_url}")
                return {
                    "found": True,
                    "source": "set79" if is_set79 else ("fullsets" if is_fullsets else "1001tracklists"),
                    "url": m_url,
                    "total_tracks": cached["total_tracks"],
                    "tracks": cached.get("tracks", [])
                }

            # Scrape live if not in cache
            if is_set79:
                set79_res = await scrape_set79(m_url)
                if set79_res.get("total_tracks", 0) > 0:
                    logger.info(f"Auto-resolve mapping hit (set79 live): {m_url}")
                    return {
                        "found": True,
                        "source": "set79",
                        "url": m_url,
                        "total_tracks": set79_res["total_tracks"],
                        "tracks": set79_res.get("tracks", [])
                    }
            elif is_fullsets:
                try:
                    from app.tracklist_discovery import fetch_fullsets_set
                    fs_live = await fetch_fullsets_set(m_url)
                    if fs_live.get("total_tracks", 0) > 0:
                        logger.info(f"Auto-resolve mapping hit (fullsets live): {m_url}")
                        upsert_tracklist(
                            tracklist_url=m_url,
                            artist=artist or mapped_match.get("artist", ""),
                            album_name=albumName or mapped_match.get("albumName", ""),
                            title=fs_live.get("title", ""),
                            total_tracks=fs_live["total_tracks"],
                            tracks_json=json.dumps(fs_live.get("tracks", []), default=str),
                            ttl_hours=24
                        )
                        return {
                            "found": True,
                            "source": "fullsets",
                            "url": m_url,
                            "total_tracks": fs_live["total_tracks"],
                            "tracks": fs_live.get("tracks", [])
                        }
                except Exception as e:
                    logger.warning(f"Live fullsets fetch failed for {m_url}: {e}")
                source_errors.append(f"Mapped fullsets tracklist unavailable in cache: {m_url}")
            else:
                res_1001 = await fetch_1001tracklists(m_url)
                if res_1001.get("total_tracks", 0) > 0:
                    logger.info(f"Auto-resolve mapping hit (1001tracklists live): {m_url}")
                    upsert_tracklist(
                        tracklist_url=m_url,
                        artist=artist or mapped_match.get("artist", ""),
                        album_name=albumName or mapped_match.get("albumName", ""),
                        title=res_1001.get("title", ""),
                        total_tracks=res_1001["total_tracks"],
                        tracks_json=json.dumps(res_1001.get("tracks", []), default=str)
                    )
                    return {
                        "found": True,
                        "source": "1001tracklists",
                        "url": m_url,
                        "total_tracks": res_1001["total_tracks"],
                        "tracks": res_1001.get("tracks", [])
                    }
                if res_1001.get("error") == "source_unavailable":
                    source_errors.append(res_1001.get("detail") or f"Mapped 1001tracklists unavailable: {m_url}")

    # Look up recording from Navidrome DB if album_id or song_id provided
    navidrome_db_path = os.getenv("NAVIDROME_DB_PATH") or next(
        (p for p in ("/navidrome_data/navidrome.db", "/opt/navidrome.db", "/root/navidrome/data/navidrome.db") if os.path.exists(p)),
        "/navidrome_data/navidrome.db")
    rec_info: Dict[str, Any] = {
        "title": full_title or albumName,
        "artist": artist,
        "album": albumName,
        "album_id": album_id,
        "id": song_id,
        "song_id": song_id,
    }

    if os.path.exists(navidrome_db_path) and (album_id or song_id):
        try:
            db_uri = f"file:{os.path.abspath(navidrome_db_path)}?mode=ro"
            with sqlite3.connect(db_uri, uri=True) as nav_conn:
                nav_conn.row_factory = sqlite3.Row
                cur = nav_conn.cursor()
                row = None
                if song_id:
                    cur.execute("SELECT * FROM media_file WHERE id = ? LIMIT 1", (song_id,))
                    row = cur.fetchone()
                if not row and album_id:
                    cur.execute("SELECT * FROM media_file WHERE album_id = ? LIMIT 1", (album_id,))
                    row = cur.fetchone()
                if not row and album_id:
                    cur.execute("SELECT * FROM media_file WHERE id = ? LIMIT 1", (album_id,))
                    row = cur.fetchone()

                if row:
                    row_dict = dict(row)
                    real_song_id = row_dict.get("id") or song_id
                    real_album_id = row_dict.get("album_id") or album_id
                    if real_album_id:
                        album_id = real_album_id
                    if real_song_id:
                        song_id = real_song_id

                    rec_info.update({
                        "id": real_song_id,
                        "song_id": real_song_id,
                        "album_id": real_album_id,
                        "title": row_dict.get("title") or rec_info["title"],
                        "path": row_dict.get("path") or "",
                        "comment": row_dict.get("comment") or "",
                        "duration": row_dict.get("duration"),
                        "artist": row_dict.get("artist") or rec_info["artist"],
                        "album": row_dict.get("album") or rec_info["album"],
                    })
        except Exception as e:
            logger.warning(f"Navidrome DB lookup error ({navidrome_db_path}): {e}")

    try:
        from app.tracklist_discovery import discover_fullsets
        fs_res = await discover_fullsets(rec_info)
        if fs_res.get("found") and fs_res.get("total_tracks", 0) > 0:
            logger.info(f"Auto-resolve Fullsets discovery hit: {fs_res.get('url')}")
            best_url = fs_res.get("url", "")
            best_tracks = fs_res.get("tracks", [])
            total_tracks = fs_res.get("total_tracks", len(best_tracks))
            source_name = "fullsets"
            source_tag = "auto:fullsets"

            from app.tracklist_matching import persist_mapping
            subsonic_ids = list(dict.fromkeys(i for i in [album_id, song_id] if i))
            entry = {
                "albumName": rec_info.get("album") or albumName,
                "artist": rec_info.get("artist") or artist,
                "tracklistUrl": best_url,
                "verified": True,
                "source": source_tag,
                "subsonic_ids": subsonic_ids,
            }
            if album_id:
                entry["album_id"] = album_id
            try:
                persist_mapping(mapping_file, entry)
            except Exception as e:
                logger.error("Unable to persist fullsets tracklist mapping: %s", type(e).__name__)
                return {"found": False, "error": "source_unavailable", "detail": "Tracklist found but mapping persistence failed", "tracks": []}

            try:
                upsert_tracklist(
                    tracklist_url=best_url,
                    artist=rec_info.get("artist") or artist,
                    album_name=rec_info.get("album") or albumName,
                    title=fs_res.get("title", f"{artist} - {albumName}"),
                    total_tracks=total_tracks,
                    tracks_json=json.dumps(best_tracks, default=str),
                    ttl_hours=24
                )
            except Exception as e:
                logger.error(f"Error upserting fullsets tracklist in core.db: {e}")

            return {
                "found": True,
                "source": source_name,
                "url": best_url,
                "total_tracks": total_tracks,
                "tracks": best_tracks
            }
        elif fs_res.get("error"):
            source_errors.append(fs_res.get("detail") or f"Fullsets discovery unavailable: {fs_res.get('error')}")
    except Exception as e:
        logger.warning(f"Error running discover_fullsets in auto-resolve: {e}")
        source_errors.append(f"Fullsets discovery exception: {type(e).__name__} ({e})")

    # 2. Search actual performers and use the complete event title.
    from app.tracklist_matching import search_artists, choose_tracklist
    full_title = full_title.strip() if isinstance(full_title, str) else ""
    search_q = (full_title or albumName).strip()
    lookup_artists = search_artists(artist, full_title or albumName)
    cand_1001 = None
    for lookup_artist in lookup_artists:
        import re
        slug = re.sub(r'[^a-z0-9]+', '-', lookup_artist.lower()).strip('-')
        if not slug:
            continue
        artist_url = f"http://10.0.0.3:8192/api/scrape/artist/{slug}"
        if search_q:
            artist_url = f"{artist_url}?q={urllib.parse.quote(search_q)}"
        try:
            async with httpx.AsyncClient(timeout=45.0) as client:
                b_resp = await client.get(artist_url)
            if b_resp.status_code == 404:
                continue
            if b_resp.status_code != 200:
                source_errors.append(f"Artist {slug}: upstream HTTP {b_resp.status_code}")
                continue
            b_data = b_resp.json()
            mismatch = _check_artist_response_mismatch(lookup_artist, b_data)
            if mismatch or b_data.get("error"):
                source_errors.append(mismatch or f"Artist {slug}: scraper reported an error")
                continue
            if b_data.get("is_complete") is not True:
                source_errors.append(f"Artist {slug}: search coverage incomplete or unknown")
            matched_t = choose_tracklist(b_data.get("tracklists", []), lookup_artist, albumName, full_title)
            if matched_t:
                t_url = matched_t.get("url") or matched_t.get("path")
                if t_url:
                    scraped = await fetch_1001tracklists(t_url)
                    if scraped.get("total_tracks", 0) > 0:
                        cand_1001 = scraped
                        break
                    source_errors.append(scraped.get("detail") or "Matched tracklist could not be read")
        except Exception as e:
            logger.warning("Tracklist source request failed for %s: %s", lookup_artist, type(e).__name__)
            source_errors.append(f"Artist {slug}: {type(e).__name__}")

    # 3. Step c: Probeer Set79
    cand_set79 = None
    if sc_url:
        s_res = await scrape_set79(sc_url)
        if s_res.get("total_tracks", 0) > 0:
            cand_set79 = {
                "url": s_res.get("url", sc_url),
                "title": s_res.get("title", f"{artist} - {albumName}"),
                "total_tracks": s_res["total_tracks"],
                "tracks": s_res.get("tracks", []),
                "source": "set79"
            }

    if not cand_set79 and albumName:
        try:
            conn = get_db()
            cursor = conn.cursor()
            q_str = f"%{albumName.strip()}%"
            cursor.execute("""
                SELECT tracklist_url, artist, album_name, title, total_tracks, tracks_json
                FROM tracklist_tracks
                WHERE tracklist_url LIKE '%set79.com%'
                  AND (title LIKE ? OR album_name LIKE ?)
                ORDER BY total_tracks DESC LIMIT 1
            """, (q_str, q_str))
            row = cursor.fetchone()
            conn.close()
            if row:
                t_json = row["tracks_json"]
                t_list = json.loads(t_json) if t_json else []
                cand_set79 = {
                    "url": row["tracklist_url"],
                    "title": row["title"] or f"{artist} - {albumName}",
                    "total_tracks": row["total_tracks"] or len(t_list),
                    "tracks": t_list,
                    "source": "set79"
                }
        except Exception as e:
            logger.warning(f"Error querying set79 cache in core.db: {e}")

    # 4. Step d: Vergelijk beide candidates als ze allebei tracks hebben
    best = None
    t1 = cand_1001.get("total_tracks", 0) if cand_1001 else 0
    t2 = cand_set79.get("total_tracks", 0) if cand_set79 else 0

    if t1 >= 5 and t2 >= 5:
        if t1 > t2:
            best = cand_1001
        elif t2 > t1:
            best = cand_set79
        else:
            cued1 = sum(1 for tr in cand_1001.get("tracks", []) if tr.get("cue_seconds") is not None)
            cued2 = sum(1 for tr in cand_set79.get("tracks", []) if tr.get("cue_seconds") is not None)
            if cued2 > cued1:
                best = cand_set79
            else:
                best = cand_1001
    elif t1 >= 5:
        best = cand_1001
    elif t2 >= 5:
        best = cand_set79
    elif t1 > 0 or t2 > 0:
        if t1 >= t2:
            best = cand_1001
        else:
            best = cand_set79

    # 5. Step e: Sla de beste tracklist op in tracklist_mapping.json & core.db
    if best and best.get("total_tracks", 0) > 0:
        source_name = best.get("source", "1001tracklists")
        source_tag = f"auto:{source_name}"
        best_url = best.get("url", "")
        best_tracks = best.get("tracks", [])
        total_tracks = len(best_tracks) or best.get("total_tracks", 0)

        from app.tracklist_matching import persist_mapping
        entry = {
            "albumName": albumName, "artist": artist, "tracklistUrl": best_url,
            "verified": True, "source": source_tag,
            "subsonic_ids": list(dict.fromkeys(i for i in [album_id, song_id] if i)),
        }
        if album_id:
            entry["album_id"] = album_id
        try:
            persist_mapping(mapping_file, entry)
        except Exception as e:
            logger.error("Unable to persist tracklist mapping: %s", type(e).__name__)
            return {"found": False, "error": "source_unavailable", "detail": "Tracklist found but mapping persistence failed", "tracks": []}

        try:
            upsert_tracklist(
                tracklist_url=best_url,
                artist=artist,
                album_name=albumName,
                title=best.get("title", f"{artist} - {albumName}"),
                total_tracks=total_tracks,
                tracks_json=json.dumps(best_tracks, default=str),
                ttl_hours=24
            )
        except Exception as e:
            logger.error(f"Error upserting tracklist in core.db: {e}")

        return {
            "found": True,
            "source": source_name,
            "url": best_url,
            "total_tracks": total_tracks,
            "tracks": best_tracks
        }

    if source_errors:
        return {
            "found": False,
            "error": "source_unavailable",
            "detail": "; ".join(source_errors)[:1000],
            "set79_status": "not_searched_no_source_url" if not sc_url else "attempted",
            "source": None,
            "total_tracks": 0,
            "tracks": []
        }

    return {
        "found": False,
        "error": "not_found",
        "detail": "No unambiguous match in searched artist listings/cache; not proof of global absence",
        "searched_artists": lookup_artists,
        "set79_status": "not_searched_no_source_url" if not sc_url else "attempted",
        "source": None,
        "total_tracks": 0,
        "tracks": []
    }


import httpx


@app.post("/api/identify")
async def identify_track(audio: UploadFile = File(None), album_id: str = Form(None), offset_seconds: int = Form(60)):
    """Identify a track using AudD API."""
    AUDD_TOKEN = os.getenv("AUDD_API_TOKEN", "")
    if not AUDD_TOKEN:
        try:
            with open("/opt/beatmonkey-core/.env") as envf:
                for line in envf:
                    if line.startswith("AUDD_API_TOKEN="):
                        AUDD_TOKEN = line.strip().split("=", 1)[1]
        except:
            pass
    if not AUDD_TOKEN:
        return {"success": False, "error": "AudD API token not configured"}
    
    if audio:
        audio_data = await audio.read()
        if len(audio_data) < 1000:
            return {"success": False, "error": "Audio too small"}
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                resp = await client.post("https://api.audd.io/", data={"api_token": AUDD_TOKEN, "return": "spotify,apple_music"}, files={"file": ("audio.mp3", audio_data, "audio/mpeg")})
                result = resp.json()
                if result.get("status") == "success" and result.get("result"):
                    t = result["result"]
                    return {"success": True, "artist": t.get("artist", ""), "title": t.get("title", ""), "album": t.get("album", ""), "spotify_url": t.get("spotify", {}).get("external_urls", {}).get("spotify", "")}
                return {"success": False, "error": "No match"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    elif album_id:
        # Stuur de Navidrome stream URL direct naar AudD
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(f"https://music.cyberspeeze.online/rest/getAlbum?u=Ivo&p=CocaCola2026@&v=1.16.1&c=beatmonkey&f=json&id={album_id}")
            data = resp.json()
            songs = data.get("subsonic-response", {}).get("album", {}).get("song", [])
            if not songs:
                return {"success": False, "error": "No songs found"}
            song_id = songs[0].get("id")
        
        stream_url = f"https://music.cyberspeeze.online/rest/stream.view?u=Ivo&p=CocaCola2026@&v=1.16.1&c=beatmonkey&id={song_id}&format=raw&maxBitRate=128"
        
        # Download eerste 200KB van de stream
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                range_start = offset_seconds * 16000  # ~16KB/sec bij 128kbps
                range_end = range_start + 400000  # 25 seconden
                headers = {"Range": f"bytes={range_start}-{range_end}"}
                resp = await client.get(stream_url, headers=headers)
                audio_data = resp.content
                if len(audio_data) < 1000:
                    return {"success": False, "error": "Audio too small"}
                
                audd_resp = await client.post("https://api.audd.io/", data={"api_token": AUDD_TOKEN, "return": "spotify,apple_music"}, files={"file": ("audio.mp3", audio_data, "audio/mpeg")})
                result = audd_resp.json()
                if result.get("status") == "success" and result.get("result"):
                    t = result["result"]
                    return {"success": True, "artist": t.get("artist", ""), "title": t.get("title", ""), "album": t.get("album", ""), "spotify_url": t.get("spotify", {}).get("external_urls", {}).get("spotify", "")}
                return {"success": False, "error": "No match"}
        except Exception as e:
            return {"success": False, "error": str(e)}
    
    return {"success": False, "error": "Provide audio or album_id"}


@app.post("/api/identify-by-album")
async def identify_by_album(
    album_id: str = Form(...),
    offset_seconds: int = Form(60)
):
    """Identify a track by album_id + offset_seconds (no audio upload)."""
    logger.info(f"Identify by album: {album_id}, offset: {offset_seconds}")
    AUDD_TOKEN = os.getenv("AUDD_API_TOKEN", "")
    if not AUDD_TOKEN:
        try:
            with open("/opt/beatmonkey-core/.env") as envf:
                for line in envf:
                    if line.startswith("AUDD_API_TOKEN="):
                        AUDD_TOKEN = line.strip().split("=", 1)[1]
        except:
            pass
    if not AUDD_TOKEN:
        return {"success": False, "error": "AudD API token not configured"}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            # Eerst proberen als album ID
            resp = await client.get(f"https://music.cyberspeeze.online/rest/getAlbum?u=Ivo&p=CocaCola2026@&v=1.16.1&c=beatmonkey&f=json&id={album_id}")
            data = resp.json()
            songs = data.get("subsonic-response", {}).get("album", {}).get("song", [])
            
            if songs:
                song_id = songs[0].get("id")
                logger.info(f"Resolved album_id {album_id} via getAlbum -> song_id {song_id}")
            else:
                # Fallback: probeer als song ID (offline downloads gebruiken song_id als album_id)
                logger.info(f"getAlbum failed for {album_id}, trying getSong...")
                song_resp = await client.get(f"https://music.cyberspeeze.online/rest/getSong?u=Ivo&p=CocaCola2026@&v=1.16.1&c=beatmonkey&f=json&id={album_id}")
                song_data = song_resp.json()
                song = song_data.get("subsonic-response", {}).get("song")
                if song:
                    song_id = song.get("id")
                    logger.info(f"Resolved song_id {album_id} via getSong -> OK")
                else:
                    return {"success": False, "error": "No songs found"}
        
        # Stream 25s sample from Navidrome
        stream_url = f"https://music.cyberspeeze.online/rest/stream.view?u=Ivo&p=CocaCola2026@&v=1.16.1&c=beatmonkey&id={song_id}&format=raw&maxBitRate=128"
        
        async with httpx.AsyncClient(timeout=30) as client:
            range_start = offset_seconds * 16000
            range_end = range_start + 400000
            headers = {"Range": f"bytes={range_start}-{range_end}"}
            resp = await client.get(stream_url, headers=headers)
            audio_data = resp.content
            if len(audio_data) < 1000:
                return {"success": False, "error": "Audio too small"}
            
            audd_resp = await client.post(
                "https://api.audd.io/",
                data={"api_token": AUDD_TOKEN, "return": "spotify,apple_music"},
                files={"file": ("audio.mp3", audio_data, "audio/mpeg")}
            )
            result = audd_resp.json()
            print(f"[AUDD RESULT] {json.dumps(result, indent=2)}", flush=True)
            if result.get("status") == "success" and result.get("result"):
                t = result["result"]
                return {"success": True, "artist": t.get("artist", ""), "title": t.get("title", ""), "album": t.get("album", ""), "spotify_url": t.get("spotify", {}).get("external_urls", {}).get("spotify", "")}
            return {"success": False, "error": "No match"}
    except Exception as e:
        logger.error(f"Identify by album error: {e}")
        return {"success": False, "error": str(e)}
