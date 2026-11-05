from pydantic import BaseModel
from typing import Optional

class AuthLoginRequest(BaseModel):
    email: Optional[str] = None
    id_token: Optional[str] = None
    client_id: Optional[str] = None
    expected_nonce: Optional[str] = None

class UserRegisterRequest(BaseModel):
    username: str
    name: str
    email: str

class TrackPlayWebhook(BaseModel):
    track_id: str = ""
    track_title: Optional[str] = ""
    artist: Optional[str] = ""
    duration_seconds: Optional[float] = None
    listen_duration_seconds: Optional[float] = 0
    listen_position_seconds: Optional[float] = 0
    completed: Optional[bool] = False
    timestamp: Optional[str] = None

class PinCreateRequest(BaseModel):
    track_id: str
    timestamp_seconds: float
    label: Optional[str] = None

class EnrichRequest(BaseModel):
    dj_name: Optional[str] = None
    force: Optional[bool] = False

class FestivalLogoCreateRequest(BaseModel):
    festival_name: str
    logo_url: str

class YoutubeDownloadRequest(BaseModel):
    url: Optional[str] = None
    fmt: Optional[str] = "mp3"
    quality: Optional[str] = "192k"

class MergeArtistsRequest(BaseModel):
    source_ids: list[str] = []
    target_id: Optional[str] = None
    target_name: Optional[str] = None
    source_names: Optional[list[str]] = None

class ArtistSummary(BaseModel):
    id: str
    name: str
    albumCount: int

class ArtistsResponse(BaseModel):
    artists: list[ArtistSummary]
