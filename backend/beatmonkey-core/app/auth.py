import os
import sqlite3
import datetime
import jwt
from typing import Optional
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests

TEST_MODE = os.getenv("TEST_MODE", "false").lower() in ("true", "1", "t")
def get_jwt_secret() -> str:
    secret = os.getenv("JWT_SECRET", "")
    if not secret or len(secret.strip()) < 32:
        raise ValueError("JWT_SECRET is missing, empty, or shorter than 32 characters")
    return secret

def validate_security_configuration() -> None:
    """Validate deployment credentials before startup database initialization."""
    get_jwt_secret()
    if len(os.getenv("ADMIN_PASS", "").strip()) < 32:
        raise RuntimeError("ADMIN_PASS must be explicitly set and at least 32 characters")

JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = 72
NAVIDROME_DB_PATH = os.getenv("NAVIDROME_DB_PATH", "/navidrome_data/navidrome.db")
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "ivo.menzo@gmail.com")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
TRUSTED_CLIENT_IDS = {
    "847956533620-i97tume6hs4k6g0lja0tu4gkidaulis3.apps.googleusercontent.com",
    "847956533620-i97tume6hs4k6g0lja0tu4gkidaulis3",
    "847956533620-s39avbq2lame2osonh57i0ioausdblo2.apps.googleusercontent.com",
    "847956533620-s39avbq2lame2osonh57i0ioausdblo2",
}
if GOOGLE_CLIENT_ID:
    TRUSTED_CLIENT_IDS.add(GOOGLE_CLIENT_ID)

def verify_google_token(token: str, client_id: Optional[str] = None) -> Optional[dict]:
    """Valideer Google ID token, return {email, name, sub} of None"""
    try:
        cid = client_id or GOOGLE_CLIENT_ID or None
        id_info = None
        if cid:
            try:
                id_info = id_token.verify_oauth2_token(token, google_requests.Request(), cid)
            except Exception:
                pass

        if not id_info:
            id_info = id_token.verify_oauth2_token(token, google_requests.Request())
            aud = id_info.get("aud")
            if aud not in TRUSTED_CLIENT_IDS and aud != cid:
                return None

        return {
            "email": id_info.get("email"),
            "name": id_info.get("name"),
            "sub": id_info.get("sub")
        }
    except Exception as e:
        print(f"Google token verification failed: {e}")
        return None

def create_session_token(navidrome_user_id: str, email: str, user_name: str, is_admin: bool) -> str:
    """Genereer JWT met claims"""
    secret = get_jwt_secret()
    payload = {
        "sub": navidrome_user_id,
        "user_id": navidrome_user_id,
        "user_name": user_name,
        "email": email,
        "is_admin": is_admin,
        "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=JWT_EXPIRY_HOURS),
        "iat": datetime.datetime.now(datetime.timezone.utc)
    }
    return jwt.encode(payload, secret, algorithm=JWT_ALGORITHM)

def verify_token(jwt_token: str) -> Optional[dict]:
    """Decode en valideer ons eigen JWT, return payload of None"""
    secret = get_jwt_secret()
    try:
        payload = jwt.decode(jwt_token, secret, algorithms=[JWT_ALGORITHM])
        return payload
    except jwt.PyJWTError:
        return None

import base64
import hashlib
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def decrypt_navidrome_password(enc_pass: str, key_str: str = "just for obfuscation") -> Optional[str]:
    """Decrypt Navidrome stored password using AES-GCM and the encryption key"""
    if not enc_pass:
        return None
    try:
        raw = base64.b64decode(enc_pass)
        if len(raw) < 28:
            return None
        nonce = raw[:12]
        ciphertext = raw[12:]
        key = hashlib.sha256(key_str.encode("utf-8")).digest()
        aesgcm = AESGCM(key)
        decrypted = aesgcm.decrypt(nonce, ciphertext, None)
        return decrypted.decode("utf-8")
    except Exception as e:
        print(f"Failed to decrypt Navidrome password: {e}")
        return None

def check_navidrome_whitelist(email: str) -> Optional[dict]:
    """Read-only SQLite check op Navidrome DB — return {id, user_name, name, is_admin, subsonic_pass} of None"""
    if not os.path.exists(NAVIDROME_DB_PATH):
        print(f"Navidrome DB not found at: {NAVIDROME_DB_PATH}")
        return None
    try:
        conn = sqlite3.connect(f"file:{NAVIDROME_DB_PATH}?mode=ro", uri=True)
        cursor = conn.cursor()
        
        # Check matching email in Navidrome DB
        cursor.execute("SELECT id, user_name, name, is_admin, email, password FROM user WHERE lower(email) = lower(?)", (email,))
        row = cursor.fetchone()
        
        # Fallback for ADMIN_EMAIL if email in Navidrome DB was not filled in
        if not row and email and email.lower() == ADMIN_EMAIL.lower():
            cursor.execute("SELECT id, user_name, name, is_admin, email, password FROM user WHERE is_admin = 1 ORDER BY created_at ASC LIMIT 1")
            row = cursor.fetchone()

        conn.close()
        
        if row:
            user_id, user_name, name, is_admin, user_email, enc_pass = row[0], row[1], row[2], bool(row[3]), row[4], row[5]
            if email and email.lower() == ADMIN_EMAIL.lower():
                is_admin = True
            subsonic_pass = decrypt_navidrome_password(enc_pass) or ""
            return {
                "id": user_id,
                "user_name": user_name,
                "name": name,
                "email": email if email else user_email,
                "is_admin": is_admin,
                "subsonic_pass": subsonic_pass
            }
        return None
    except Exception as e:
        print(f"Error checking Navidrome DB: {e}")
        return None

def get_all_navidrome_users() -> list[dict]:
    """Ophalen van alle gebruikers uit Navidrome DB voor beheer portaal"""
    if not os.path.exists(NAVIDROME_DB_PATH):
        return []
    try:
        conn = sqlite3.connect(f"file:{NAVIDROME_DB_PATH}?mode=ro", uri=True)
        cursor = conn.cursor()
        cursor.execute("SELECT id, user_name, name, email, is_admin, created_at, last_login_at FROM user ORDER BY user_name ASC")
        rows = cursor.fetchall()
        conn.close()
        users = []
        for r in rows:
            is_admin = bool(r[4])
            if r[3] and r[3].lower() == ADMIN_EMAIL.lower():
                is_admin = True
            users.append({
                "id": r[0],
                "user_name": r[1],
                "name": r[2],
                "email": r[3],
                "is_admin": is_admin,
                "created_at": r[5],
                "last_login_at": r[6]
            })
        return users
    except Exception as e:
        print(f"Error reading Navidrome users: {e}")
        return []
