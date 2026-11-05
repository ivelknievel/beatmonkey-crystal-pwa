"""
Discogs + RA / 1001Tracklists DJ metadata enricher for Beatmonkey Core.
Enriches DJ metadata with biographies, photos, genre labels, and festival history.
"""
import os
import re
import httpx
import sqlite3
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional, Dict, Any, List, Set

from app.scraper import DJScraper

logger = logging.getLogger(__name__)

DISCOGS_TOKEN = os.getenv("DISCOGS_TOKEN", "jVHiBaUJNfhEJFyZeIpmShGsOrShXHLLnkBLKXDj")
DISCOGS_BASE = "https://api.discogs.com"
CACHE_DAYS = 30

CORE_DB_PATH = os.getenv("CORE_DB_PATH", "/data/core.db" if os.path.exists("/data/core.db") else "/opt/beatmonkey-core/core.db")


def split_dj_name(dj_name: str) -> List[str]:
    """
    Split b2b / collaboration DJ names into individual artist names.
    Examples:
      - 'Cassian b2b Joris Voorn WE2' -> ['Cassian', 'Joris Voorn']
      - 'ARGY pres. NEWORLD' -> ['ARGY', 'NEWORLD']
      - 'Joris Voorn x Kevin de Vries' -> ['Joris Voorn', 'Kevin de Vries']
      - 'AYYBO b2b Green Velvet' -> ['AYYBO', 'Green Velvet']
    """
    if not dj_name:
        return []
    # Strip event / edition / set suffixes like WE1, WE2, Live, DJ Set, (Live), etc.
    cleaned = re.sub(r"\s+(?:WE\d+|Live|DJ\s*Set|\(Live\)|\[Live\])$", "", dj_name.strip(), flags=re.IGNORECASE).strip()
    
    # Split on delimiters: b2b, pres., pres, x, &, /
    parts = re.split(r"\s+(?:b2b|pres\.?|x|&|/)\s+", cleaned, flags=re.IGNORECASE)
    parts = [p.strip() for p in parts if p.strip()]
    return parts if len(parts) > 1 else [cleaned]


def is_valid_image(url: str) -> bool:
    """Check if an image URL is valid and not a placeholder."""
    if not url or not isinstance(url, str):
        return False
    if "spacer.gif" in url:
        return False
    return True


class DJMetadataService:
    def __init__(self, db_path: str = CORE_DB_PATH):
        self.db_path = db_path
        self._http = httpx.AsyncClient(
            headers={
                "User-Agent": "BeatmonkeyCore/1.0 +https://music.cyberspeeze.online",
                "Authorization": f"Discogs token={DISCOGS_TOKEN}"
            },
            timeout=15.0
        )
        self.scraper = DJScraper()

    async def close(self):
        await self._http.aclose()
        await self.scraper.close()

    def _get_db(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _needs_refresh(self, dj_name: str) -> bool:
        """Check of de metadata ontbreekt (geen genres/bio/image) of ouder is dan CACHE_DAYS (30) dagen."""
        conn = self._get_db()
        row = conn.execute(
            "SELECT updated_at, genres, bio, image_url FROM dj_metadata WHERE lower(dj_name) = lower(?)", (dj_name,)
        ).fetchone()
        conn.close()
        if not row:
            return True
        # If genres are missing, always refresh
        if not row["genres"]:
            return True
        try:
            updated = datetime.fromisoformat(row["updated_at"])
        except Exception:
            return True
        return (datetime.utcnow() - updated) > timedelta(days=CACHE_DAYS)

    async def _safe_get(self, url: str, params: dict = None) -> Optional[httpx.Response]:
        """HTTP GET request met automatische retry bij Discogs 429 rate limits."""
        for attempt in range(3):
            try:
                resp = await self._http.get(url, params=params)
                if resp.status_code == 429:
                    retry_after = float(resp.headers.get("Retry-After", 2.0))
                    logger.warning(f"Discogs rate limit (429). Waiting {retry_after}s before retry {attempt + 1}/3...")
                    await asyncio.sleep(retry_after)
                    continue
                resp.raise_for_status()
                return resp
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 429:
                    await asyncio.sleep(2.0)
                    continue
                logger.error(f"Discogs HTTP error for {url}: {e}")
                return None
            except Exception as e:
                logger.error(f"Discogs error for {url}: {str(e)}")
                return None
        return None

    def _extract_events(self, groups: list) -> str:
        """Extract known events/festivals from Discogs groups."""
        if not groups or not isinstance(groups, list):
            return ""
        events = []
        keywords = ["festival", "stage", "presents", "live at", "essential mix", "resident"]
        for g in groups:
            if isinstance(g, dict):
                name = g.get("name", "")
                for kw in keywords:
                    if kw.lower() in name.lower():
                        events.append(name)
                        break
        return ", ".join(events[:10])

    async def _lookup_discogs_single(self, name: str) -> Dict[str, Any]:
        """Search Discogs for artist bio, image, and releases to extract genres."""
        res: Dict[str, Any] = {
            "real_name": "",
            "bio": "",
            "image_url": "",
            "genres": set(),
            "known_events": ""
        }
        try:
            # 1. Search for artist
            search_url = f"{DISCOGS_BASE}/database/search"
            params = {"q": name, "type": "artist", "per_page": 5}
            resp = await self._safe_get(search_url, params=params)
            if resp:
                data = resp.json()
                results = data.get("results", [])
                if results:
                    artist = results[0]
                    artist_id = artist.get("id")
                    cover_img = artist.get("cover_image", "")
                    if not is_valid_image(cover_img):
                        cover_img = ""

                    if artist_id:
                        # Fetch artist profile
                        artist_url = f"{DISCOGS_BASE}/artists/{artist_id}"
                        artist_resp = await self._safe_get(artist_url)
                        if artist_resp:
                            artist_data = artist_resp.json()
                            res["real_name"] = artist_data.get("realname", "") or ""
                            res["bio"] = artist_data.get("profile", "") or ""
                            
                            images = artist_data.get("images")
                            if not cover_img and isinstance(images, list) and len(images) > 0 and isinstance(images[0], dict):
                                img = images[0].get("resource_url", "") or images[0].get("uri", "")
                                if is_valid_image(img):
                                    cover_img = img

                            res["known_events"] = self._extract_events(artist_data.get("groups") or [])

                        # Fetch artist releases for genres/styles
                        rel_url = f"{DISCOGS_BASE}/artists/{artist_id}/releases"
                        rel_resp = await self._safe_get(rel_url, params={"sort": "year", "sort_order": "desc", "per_page": 5})
                        if rel_resp:
                            releases = rel_resp.json().get("releases", [])
                            for rel in releases:
                                g = rel.get("genre")
                                if isinstance(g, list):
                                    res["genres"].update([x for x in g if x])
                                elif isinstance(g, str) and g:
                                    res["genres"].add(g)
                                s = rel.get("style")
                                if isinstance(s, list):
                                    res["genres"].update([x for x in s if x])
                                elif isinstance(s, str) and s:
                                    res["genres"].add(s)

                    res["image_url"] = cover_img

            # 2. Database search by artist name for genre extraction (highly reliable for genre tags)
            search_rel = await self._safe_get(search_url, params={"artist": name, "per_page": 5})
            if search_rel:
                for item in search_rel.json().get("results", []):
                    for g in item.get("genre", []):
                        if g:
                            res["genres"].add(g)
                    for s in item.get("style", []):
                        if s:
                            res["genres"].add(s)
        except Exception as e:
            logger.error(f"Discogs lookup error for '{name}': {str(e)}")

        return res

    async def enrich_dj(self, dj_name: str, force: bool = False, cached_only: bool = False) -> Optional[Dict[str, Any]]:
        """Enrich a DJ's metadata using RA, 1001Tracklists, and Discogs. Returns metadata dict.

        ``cached_only`` never performs network I/O: catalog endpoints must answer from
        SQLite so a Discogs 429 cannot stall a user-facing request for minutes.
        """
        if cached_only and not force:
            return self.get_cached(dj_name)
        if not force and not self._needs_refresh(dj_name):
            return self.get_cached(dj_name)

        parts = split_dj_name(dj_name)
        is_collab = len(parts) > 1

        # 1. Discogs metadata gathering
        discogs_meta = {}
        if not is_collab:
            single_res = await self._lookup_discogs_single(dj_name)
            discogs_meta = {
                "real_name": single_res.get("real_name", ""),
                "bio": single_res.get("bio", ""),
                "image_url": single_res.get("image_url", ""),
                "genres": ", ".join(sorted(single_res.get("genres", set()))),
                "known_events": single_res.get("known_events", ""),
            }
        else:
            # First try the full collab name
            full_res = await self._lookup_discogs_single(dj_name)
            
            # Lookup each part
            part_results = []
            for part in parts:
                p_res = await self._lookup_discogs_single(part)
                part_results.append(p_res)
                await asyncio.sleep(0.2)

            # Bio: full bio if present, else first part bio
            bio = full_res.get("bio") or ""
            if not bio:
                for pr in part_results:
                    if pr.get("bio"):
                        bio = pr["bio"]
                        break

            # Image: full image if present & valid, else first part image
            image_url = full_res.get("image_url") or ""
            if not is_valid_image(image_url):
                image_url = ""
                for pr in part_results:
                    if is_valid_image(pr.get("image_url")):
                        image_url = pr["image_url"]
                        break

            # Real name: full realname if present, else first part
            real_name = full_res.get("real_name") or ""
            if not real_name:
                for pr in part_results:
                    if pr.get("real_name"):
                        real_name = pr["real_name"]
                        break

            # Genres: union of full name and all parts
            all_genres: Set[str] = set(full_res.get("genres", set()))
            for pr in part_results:
                all_genres.update(pr.get("genres", set()))
            genres_str = ", ".join(sorted(all_genres))

            # Known events: merge
            events_list = [full_res.get("known_events")] if full_res.get("known_events") else []
            for pr in part_results:
                ev = pr.get("known_events")
                if ev and ev not in events_list:
                    events_list.append(ev)
            known_events = ", ".join([e for e in events_list if e])

            discogs_meta = {
                "real_name": real_name,
                "bio": bio,
                "image_url": image_url,
                "genres": genres_str,
                "known_events": known_events,
            }

        # 2. Run RA / 1001Tracklists Scraper
        scraped_info = {}
        try:
            scraped_info = await self.scraper.enrich_dj(dj_name)
            # If collab and scraper yielded no bio or image, try parts
            if is_collab and (not scraped_info.get("bio") or not scraped_info.get("image_url")):
                for part in parts:
                    part_scraped = await self.scraper.enrich_dj(part)
                    if not scraped_info.get("bio") and part_scraped.get("bio"):
                        scraped_info["bio"] = part_scraped["bio"]
                    if not scraped_info.get("image_url") and part_scraped.get("image_url"):
                        scraped_info["image_url"] = part_scraped["image_url"]
                    if part_scraped.get("festival_history"):
                        f_list = [scraped_info.get("festival_history", ""), part_scraped.get("festival_history", "")]
                        scraped_info["festival_history"] = ", ".join([f for f in f_list if f])
        except Exception as e:
            logger.error(f"RA/1001Tracklists scraper error for '{dj_name}': {str(e)}")

        # 3. Merge metadata
        bio = scraped_info.get("bio") or discogs_meta.get("bio") or ""
        image_url = scraped_info.get("image_url") or discogs_meta.get("image_url") or ""
        real_name = discogs_meta.get("real_name") or ""
        genres = discogs_meta.get("genres") or ""
        festival_history = scraped_info.get("festival_history") or ""
        additional_genres = scraped_info.get("additional_genres") or ""
        known_events = discogs_meta.get("known_events") or festival_history

        metadata = {
            "dj_name": dj_name,
            "real_name": real_name,
            "bio": bio,
            "image_url": image_url,
            "genres": genres,
            "known_events": known_events,
            "festival_history": festival_history,
            "additional_genres": additional_genres,
            "source": "ra_1001tracklists+discogs"
        }

        # Save to core.db
        self._save_metadata(metadata)
        return metadata

    def _save_metadata(self, metadata: dict):
        conn = self._get_db()
        conn.execute("""
            INSERT INTO dj_metadata (
                dj_name, real_name, bio, image_url, genres, known_events,
                festival_history, additional_genres, source, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(dj_name) DO UPDATE SET
                real_name=excluded.real_name,
                bio=excluded.bio,
                image_url=excluded.image_url,
                genres=excluded.genres,
                known_events=excluded.known_events,
                festival_history=excluded.festival_history,
                additional_genres=excluded.additional_genres,
                source=excluded.source,
                updated_at=excluded.updated_at
        """, (
            metadata["dj_name"],
            metadata.get("real_name", ""),
            metadata.get("bio", ""),
            metadata.get("image_url", ""),
            metadata.get("genres", ""),
            metadata.get("known_events", ""),
            metadata.get("festival_history", ""),
            metadata.get("additional_genres", ""),
            metadata.get("source", "ra_1001tracklists+discogs")
        ))
        conn.commit()
        conn.close()
        logger.info(f"Metadata saved for '{metadata['dj_name']}'")

    def get_cached(self, dj_name: str) -> Optional[Dict[str, Any]]:
        conn = self._get_db()
        row = conn.execute(
            "SELECT * FROM dj_metadata WHERE lower(dj_name) = lower(?)", (dj_name,)
        ).fetchone()
        conn.close()
        if row:
            return dict(row)
        return None

    def get_all_cached(self) -> List[Dict[str, Any]]:
        conn = self._get_db()
        rows = conn.execute(
            "SELECT * FROM dj_metadata ORDER BY updated_at DESC"
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    async def enrich_all_djs(self, dj_names: List[str], force: bool = False) -> List[Dict[str, Any]]:
        """Enrich all DJs in the list, returning results."""
        results = []
        for name in dj_names:
            meta = await self.enrich_dj(name, force=force)
            if meta:
                results.append(meta)
            await asyncio.sleep(0.3)
        return results

    async def update_all_djs(self, force: bool = True) -> int:
        """Herlaadt metadata voor alle DJ's in dj_metadata of Navidrome."""
        conn = self._get_db()
        rows = conn.execute("SELECT dj_name FROM dj_metadata").fetchall()
        conn.close()
        dj_names = [r["dj_name"] for r in rows if r["dj_name"]]
        
        count = 0
        for name in dj_names:
            try:
                meta = await self.enrich_dj(name, force=force)
                if meta:
                    count += 1
                await asyncio.sleep(0.3)
            except Exception as e:
                logger.error(f"Error updating DJ {name}: {e}")
        return count


def update_all_djs() -> int:
    """Helper function to run update_all_djs synchronously."""
    service = DJMetadataService()
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(service.update_all_djs(force=True))
    finally:
        loop.run_until_complete(service.close())
