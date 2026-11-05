import { create } from 'zustand';
import { findActiveCueIndex } from '../utils/cues';
import { AudioEngine } from '../engine/AudioEngine';
import type { ArtistInfo, AudioState, FestivalInfo, PlayerStatus, SetInfo, TrackCue } from '../types';
import { getAlbum, getStarred, starAlbum, unstarAlbum, getPlayQueue, getCoverUrl } from '../services/subsonic';

const LIKED_SETS_STORAGE_KEY = 'beatmonkey_liked_sets';
let accountScope: string | null = null;
let accountGeneration = 0;
let selectionGeneration = 0;
let likesGeneration = 0;
const likeRequests = new Map<string, number>();
function likedStorageKey(): string | null {
  return accountScope === null ? null : `${LIKED_SETS_STORAGE_KEY}:${encodeURIComponent(accountScope)}`;
}
function getInitialLikedSets(): string[] {
  try {
    const key = likedStorageKey();
    if (!key) return [];
    const value: unknown = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}
function persistLikes(ids: string[]) {
  try { const key = likedStorageKey(); if (key) localStorage.setItem(key, JSON.stringify(ids)); } catch { /* storage is optional */ }
}
function safePosition(time: number, duration = 0) {
  return Number.isFinite(time) ? Math.min(Math.max(time, 0), Number.isFinite(duration) && duration > 0 ? duration : Infinity) : 0;
}

export interface PlayerStoreState extends AudioState {
  likedSetIds: string[];
  festivals: FestivalInfo[];
  recentSets: SetInfo[];
  artists: ArtistInfo[];
  user?: any;
  authToken?: string | null;
}

export interface PlayerActions {
  setAccountScope: (scope: string | null) => void;
  resetPlayer: () => void;
  setStatus: (status: PlayerStatus) => void;
  /**
   * `signal` cancels only this pending selection (route navigation/unmount).
   * It never resets the engine: an already started load keeps playing unless a
   * newer selection supersedes it, and no further mutation happens after abort.
   */
  loadSet: (set: SetInfo, startTime?: number, signal?: AbortSignal) => Promise<void> | void;
  play: () => Promise<void>;
  pause: () => void;
  togglePlay: () => void;
  seek: (time: number) => void;
  skipForward: (seconds?: number) => void;
  skipBack: (seconds?: number) => void;
  addToQueue: (set: SetInfo) => void;
  removeFromQueue: (index: number) => void;
  clearQueue: () => void;
  nextTrack: () => void;
  prevTrack: () => void;
  setFullscreen: (isFullscreen: boolean) => void;
  setActiveCueIndex: (activeCueIndex: number) => void;
  updateProgress: (currentTime: number, duration?: number) => void;
  setCurrentTime: (currentTime: number) => void;
  setError: (error: string | null) => void;
  restoreLastPosition: () => Promise<void>;
  
  // Library & Favorites Actions
  syncLikedSets: () => Promise<void>;
  toggleLike: (setId: string) => Promise<void> | void;
  isLiked: (setId: string) => boolean;
  setFestivals: (festivals: FestivalInfo[]) => void;
  setRecentSets: (recentSets: SetInfo[]) => void;
  setArtists: (artists: ArtistInfo[]) => void;
  setTracklistForSet: (setId: string, tracklist: TrackCue[]) => void;
  setUser?: (user: any) => void;
  setAuthToken?: (token: string | null) => void;
}

export type PlayerStore = PlayerStoreState & PlayerActions;

const initialAudioState: AudioState = {
  status: 'idle',
  currentSetId: null,
  currentSongId: null,
  currentSet: null,
  currentTime: 0,
  duration: 0,
  volume: 1,
  isPlaying: false,
  error: null,
  queue: [],
  queueIndex: -1,
  activeCueIndex: -1,
  isFullscreen: false,
};

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  ...initialAudioState,
  likedSetIds: getInitialLikedSets(),
  festivals: [],
  recentSets: [],
  artists: [],
  user: null,
  authToken: null,
  setUser: (user) => set({ user }),
  setAuthToken: (authToken) => set({ authToken }),

  setStatus: (status) => set({ status }),

  setCurrentTime: (currentTime: number) => get().seek(currentTime),

  resetPlayer: () => {
    selectionGeneration++;
    AudioEngine.reset();
    set({ ...initialAudioState, queue: [] });
  },

  setAccountScope: (scope) => {
    if (accountScope === scope) return;
    // Credentials may already have changed: reset must never save outgoing media.
    accountGeneration++;
    likesGeneration++;
    likeRequests.clear();
    get().resetPlayer();
    accountScope = scope;
    set({ likedSetIds: getInitialLikedSets(), festivals: [], recentSets: [], artists: [], user: null, authToken: null });
  },

  loadSet: async (setInfo: SetInfo, startTime = 0, signal?: AbortSignal) => {
    // A caller that is already gone must not supersede or touch the current selection.
    if (signal?.aborted) return;
    const selected = ++selectionGeneration;
    const account = accountGeneration;
    const active = () => !signal?.aborted && selected === selectionGeneration && account === accountGeneration;
    // Stop the old source before any async lookup can let its events overwrite selection state.
    AudioEngine.pause();
    set({ currentSetId: setInfo.id, currentSongId: null, currentSet: setInfo,
      currentTime: safePosition(startTime, setInfo.duration), duration: setInfo.duration || 0,
      status: 'loading', isPlaying: false, error: null, activeCueIndex: -1 });
    try {
      let songId = setInfo.songId || setInfo.id;
      const external = /^https?:\/\//.test(setInfo.id);
      if (!external) {
        const data = await getAlbum(setInfo.id);
        if (!active()) return;
        const songs = data?.album?.song || [];
        const song = setInfo.songId ? songs.find((s: { id: string }) => s.id === setInfo.songId) : songs[0];
        if (!song) throw new Error('Geen tracks gevonden in deze set');
        songId = song.id;
      }
      if (!active()) return;
      const resolvedSet = { ...setInfo, songId };
      const queue = get().queue;
      const existing = queue.findIndex(item => item.id === setInfo.id);
      const queueIndex = existing < 0 ? queue.length : existing;
      const nextQueue = existing < 0 ? [...queue, resolvedSet] : queue.map((item, i) => i === existing ? resolvedSet : item);
      set({ currentSet: resolvedSet, currentSongId: songId, queue: nextQueue, queueIndex });
      await AudioEngine.loadSet(songId, safePosition(startTime, setInfo.duration), resolvedSet);
      // The engine start is already committed; only skip this call's continuations.
      if (!active()) return;
      if (!external && startTime === 0 && !setInfo.songId && !window.location.pathname.startsWith('/app/set/')) {
        try {
          const pq = await getPlayQueue();
          if (!active()) return;
          // Never apply another song's offset, even when it belongs to this album.
          if (pq?.songId === songId && Number.isFinite(pq.position) && pq.position > 0) AudioEngine.seek(pq.position / 1000);
        } catch { /* resume is optional */ }
      }
    } catch (err) {
      if (!active()) return;
      set({ status: 'error', isPlaying: false, error: err instanceof Error ? err.message : 'Fout bij laden' });
    }
  },

  restoreLastPosition: async () => {
    let pendingShare = false;
    try { pendingShare = !!sessionStorage.getItem('auth_return_url')?.startsWith('/set/'); } catch { /* optional storage */ }
    if (window.location.pathname.startsWith('/app/set/') || pendingShare || get().currentSetId) return;
    const selected = ++selectionGeneration;
    const account = accountGeneration;
    const active = () => selected === selectionGeneration && account === accountGeneration;
    try {
      const pq = await getPlayQueue();
      if (!active() || !pq?.songId) return;
      const data = await getAlbum(pq.albumId || pq.songId);
      if (!active() || !data?.album) return;
      const album = data.album;
      if (!album.song?.some((song: { id: string }) => song.id === pq.songId)) return;
      const setInfo: SetInfo = { id: album.id, songId: pq.songId,
        title: album.title || album.name || 'Live Set', artist: album.artist || 'Unknown',
        coverArt: getCoverUrl(album.coverArt || album.id), duration: album.duration || 0,
        year: album.year, genre: album.genre };
      // Subsonic playqueue positions are always milliseconds, including <1000ms.
      const position = safePosition(pq.position / 1000, setInfo.duration);
      set({ currentSetId: setInfo.id, currentSongId: pq.songId, currentSet: setInfo,
        currentTime: position, duration: setInfo.duration, queue: [setInfo], queueIndex: 0,
        isPlaying: false, activeCueIndex: -1, error: null });
      await AudioEngine.loadSet(pq.songId, position, setInfo, false);
      if (!active()) return;
    } catch { /* optional restore must not replace explicit selection */ }
  },

  play: async () => {
    await AudioEngine.play();
  },

  pause: () => {
    AudioEngine.pause();
  },

  togglePlay: () => {
    AudioEngine.togglePlay();
  },

  seek: (time) => {
    AudioEngine.seek(time);
  },

  skipForward: (seconds = 15) => {
    AudioEngine.skipForward(seconds);
  },

  skipBack: (seconds = 15) => {
    AudioEngine.skipBack(seconds);
  },

  addToQueue: (setInfo) => {
    const { queue } = get();
    set({ queue: [...queue, setInfo] });
  },

  removeFromQueue: (index) => {
    const { queue, queueIndex } = get();
    const newQueue = queue.filter((_, i) => i !== index);
    let newIndex = queueIndex;
    if (index < queueIndex) {
      newIndex--;
    } else if (index === queueIndex) {
      newIndex = Math.min(queueIndex, newQueue.length - 1);
    }
    set({
      queue: newQueue,
      queueIndex: newIndex,
    });
  },

  clearQueue: () => {
    set({ queue: [], queueIndex: -1 });
  },

  nextTrack: () => {
    const { queue, queueIndex, loadSet } = get();
    if (queueIndex + 1 < queue.length) {
      const nextSet = queue[queueIndex + 1];
      loadSet(nextSet, 0);
    }
  },

  prevTrack: () => {
    const { queue, queueIndex, loadSet } = get();
    if (queueIndex > 0) {
      const prevSet = queue[queueIndex - 1];
      loadSet(prevSet, 0);
    }
  },

  setFullscreen: (isFullscreen) => {
    set({ isFullscreen });
  },

  setActiveCueIndex: (activeCueIndex) => {
    set({ activeCueIndex });
  },

  updateProgress: (currentTime, duration) => {
    if (duration !== undefined) {
      set({ currentTime, duration });
    } else {
      set({ currentTime });
    }
  },

  setError: (error) => {
    set({ error, status: error ? 'error' : get().status });
  },

  syncLikedSets: async () => {
    const account = accountGeneration;
    const request = ++likesGeneration;
    try {
      const starred = await getStarred();
      if (account !== accountGeneration || request !== likesGeneration) return;
      const ids = [...new Set(starred.map(s => s.id))];
      set({ likedSetIds: ids });
      persistLikes(ids);
    } catch { /* failed fetch is not a successful empty list */ }
  },

  toggleLike: async (setId: string) => {
    const account = accountGeneration;
    const request = ++likesGeneration;
    likeRequests.set(setId, request);
    const wasLiked = get().likedSetIds.includes(setId);
    const apply = (liked: boolean) => {
      const ids = get().likedSetIds.filter(id => id !== setId);
      if (liked) ids.push(setId);
      set({ likedSetIds: ids });
      persistLikes(ids);
    };
    apply(!wasLiked);
    try {
      const result = await (wasLiked ? unstarAlbum(setId) : starAlbum(setId));
      if (result === false) throw new Error('Favoriet niet opgeslagen');
    } catch {
      if (account === accountGeneration && likeRequests.get(setId) === request) apply(wasLiked);
    }
  },

  isLiked: (setId: string) => {
    return get().likedSetIds.includes(setId);
  },

  setFestivals: (festivals) => set({ festivals }),
  setRecentSets: (recentSets) => set({ recentSets }),
  setArtists: (artists) => set({ artists }),

  setTracklistForSet: (setId, tracklist) => {
    const { currentSet, queue, currentTime } = get();
    // Late/non-current results cannot mutate any active player state.
    if (!currentSet || currentSet.id !== setId) return;
    set({ currentSet: { ...currentSet, tracklist },
      queue: queue.map(item => item.id === setId ? { ...item, tracklist } : item),
      activeCueIndex: findActiveCueIndex(tracklist, currentTime) });
  },
}));

// Permanent subscription survives reset/account changes.
AudioEngine.onStateChange((stateUpdate) => {
  // While metadata resolves, the old element may still dispatch queued events.
  const expected = usePlayerStore.getState();
  if (stateUpdate.status !== 'idle' && expected.currentSetId &&
    (expected.currentSongId === null || AudioEngine.getCurrentAlbumId() !== expected.currentSetId ||
      AudioEngine.getCurrentSongId() !== expected.currentSongId)) return;
  usePlayerStore.setState(stateUpdate);
  if (stateUpdate.currentTime !== undefined) {
    const state = usePlayerStore.getState();
    usePlayerStore.setState({ activeCueIndex: findActiveCueIndex(state.currentSet?.tracklist, state.currentTime) });
  }
});
