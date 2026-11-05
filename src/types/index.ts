export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'blocked' | 'error';

export interface SetInfo {
  id: string;
  /** Explicit stream/song identity; id remains the album identity. */
  songId?: string;
  title: string;
  artist: string;
  coverArt: string;
  duration: number;
  year?: number;
  genre?: string;
  festival?: string;
  stage?: string;
  youtubeUrl?: string;
  tracklist?: TrackCue[];
}

export interface TrackCue {
  title: string;
  artist: string;
  timeSec: number;
  spotifyUri?: string;
  durationSec?: number;
  timestamp?: number;
  isActive?: boolean;
}

export interface AudioState {
  status: PlayerStatus;
  currentSetId: string | null;
  currentSongId?: string | null;
  currentSet: SetInfo | null;
  currentTime: number;
  duration: number;
  volume: number;
  isPlaying: boolean;
  error: string | null;
  queue: SetInfo[];
  queueIndex: number;
  activeCueIndex: number;
  isFullscreen: boolean;
}

export interface ArtistInfo {
  id: string;
  name: string;
  image: string;
  bio?: string;
  genres: string[];
  setCount: number;
}

export interface StageInfo {
  name: string;
  sets: SetInfo[];
  setIds?: string[];
}

export interface FestivalInfo {
  name: string;
  slug: string;
  logo: string;
  date: string;
  description?: string;
  stages: StageInfo[];
}

export interface SetCacheEntry {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  coverArt: string;
  duration: number;
  year?: number;
  genre?: string;
  festival?: string;
  stage?: string;
  tracklist?: TrackCue[];
}

// Subsonic Response Interfaces
export type AlbumListType = 'newest' | 'recent' | 'random' | 'byGenre' | 'byYear' | 'alphabeticalByName';

export interface SubsonicResponseHeader {
  status: 'ok' | 'failed';
  version: string;
  type: string;
  serverVersion: string;
  error?: {
    code: number;
    message: string;
  };
}

export interface SubsonicArtist {
  id: string;
  name: string;
  coverArt?: string;
  artistImageUrl?: string;
  albumCount?: number;
  userRating?: number;
  album?: SubsonicAlbum[];
}

export interface SubsonicAlbum {
  id: string;
  name: string;
  title?: string;
  artist?: string;
  artistId?: string;
  coverArt?: string;
  songCount?: number;
  duration?: number;
  created?: string;
  year?: number;
  genre?: string;
  song?: SubsonicSong[];
}

export interface SubsonicSong {
  id: string;
  albumId?: string;
  parent?: string;
  title: string;
  album?: string;
  artist?: string;
  track?: number;
  year?: number;
  genre?: string;
  coverArt?: string;
  size?: number;
  contentType?: string;
  suffix?: string;
  duration?: number;
  bitRate?: number;
  path?: string;
  isVideo?: boolean;
  playCount?: number;
  discNumber?: number;
  type?: string;
}

export interface ArtistResponse extends SubsonicResponseHeader {
  artist?: SubsonicArtist;
}

export interface AlbumListResponse extends SubsonicResponseHeader {
  albumList?: {
    album: SubsonicAlbum[];
  };
  albumList2?: {
    album: SubsonicAlbum[];
  };
}

export interface SearchResponse extends SubsonicResponseHeader {
  searchResult3?: {
    artist?: SubsonicArtist[];
    album?: SubsonicAlbum[];
    song?: SubsonicSong[];
  };
}

export interface SongResponse extends SubsonicResponseHeader {
  song?: SubsonicSong;
}
