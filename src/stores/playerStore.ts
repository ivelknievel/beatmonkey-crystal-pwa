import { create } from 'zustand';
import { AudioEngine } from '../engine/AudioEngine';
import type { ArtistInfo, AudioState, FestivalInfo, PlayerStatus, SetInfo, TrackCue } from '../types';
import { getAlbum, getStarred, starAlbum, unstarAlbum, getPlayQueue, getCoverUrl } from '../services/subsonic';

const LIKED_SETS_STORAGE_KEY = 'beatmonkey_liked_sets';

function getInitialLikedSets(): string[] {
  try {
    const raw = localStorage.getItem(LIKED_SETS_STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn('Failed to load liked sets from storage', e);
  }
  return [];
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
  setStatus: (status: PlayerStatus) => void;
  loadSet: (set: SetInfo, startTime?: number) => Promise<void> | void;
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

  setCurrentTime: (currentTime: number) => set({ currentTime }),

  loadSet: async (setInfo: SetInfo, startTime = 0) => {
    let targetStartTime = startTime;

    try {
      let songId = setInfo.id;
      let albumSongs: any[] = [];
      if (!setInfo.id.startsWith('http://') && !setInfo.id.startsWith('https://')) {
        const album = await getAlbum(setInfo.id);
        const songs = album?.album?.song;
        if (!songs || songs.length === 0) {
          throw new Error('Geen tracks gevonden in deze set');
        }
        albumSongs = songs;
        songId = songs[0].id;
      }

      const queue = get().queue;
      let queueIndex = queue.findIndex((item) => item.id === setInfo.id);

      if (queueIndex === -1) {
        set({
          queue: [...queue, setInfo],
          queueIndex: queue.length,
          currentSetId: setInfo.id,
          currentSet: setInfo,
          currentTime: targetStartTime,
          duration: setInfo.duration || 0,
          status: 'loading',
          error: null,
        });
      } else {
        set({
          queueIndex,
          currentSetId: setInfo.id,
          currentSet: setInfo,
          currentTime: targetStartTime,
          duration: setInfo.duration || 0,
          status: 'loading',
          error: null,
        });
      }

      AudioEngine.loadSet(songId, targetStartTime, setInfo);

      // Na het laden van de audio, check playqueue
      if (!window.location.pathname.startsWith('/app/set/') && targetStartTime === 0 && !setInfo.id.startsWith('http://') && !setInfo.id.startsWith('https://')) {
        try {
          const pq = await getPlayQueue();
          if (pq && pq.songId && pq.position > 0) {
            // Zoek naar de song die matcht met deze set
            // We hebben album ID van de set, check of pq.albumId matcht
            let sameAlbum = pq.albumId === setInfo.id;

            // Als de playqueue geen albumId heeft, probeer dan de song ID te matchen aan de tracks van het album via Subsonic getAlbum
            if (!sameAlbum) {
              if (pq.songId === songId || pq.songId === setInfo.id) {
                sameAlbum = true;
              } else if (albumSongs.some((s) => s.id === pq.songId)) {
                sameAlbum = true;
              } else if (!pq.albumId) {
                const alb = await getAlbum(setInfo.id);
                const tracks = alb?.album?.song || [];
                if (tracks.some((s: any) => s.id === pq.songId)) {
                  sameAlbum = true;
                }
              }
            }

            if (sameAlbum && pq.position > 0) {
              // Positie is in ms, AudioEngine.currentTime is in seconds
              const resumeTime = pq.position / 1000;
              console.log(`Hervatten vanaf ${resumeTime.toFixed(0)}s (server playqueue)`);
              AudioEngine.seekTo(resumeTime);
              get().setCurrentTime(resumeTime);
            }
          }
        } catch {
          /* ignore play queue fetch errors */
        }
      }
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : 'Fout bij laden' });
    }
  },

  restoreLastPosition: async () => {
    // Keep a mandatory-login share target intact, including after OAuth.
    if (window.location.pathname.startsWith('/app/set/') || sessionStorage.getItem('auth_return_url')?.startsWith('/set/')) return;
    try {
      const pq = await getPlayQueue();
      if (!pq || !pq.songId) return;

      const targetId = pq.albumId || pq.songId;
      if (!targetId) return;

      const albumData = await getAlbum(targetId).catch(() => null);
      if (albumData?.album) {
        const album = albumData.album;
        const setInfo: SetInfo = {
          id: album.id,
          title: album.title || album.name || 'Live Set',
          artist: album.artist || 'Unknown',
          coverArt: getCoverUrl(album.coverArt || album.id),
          duration: album.duration || 0,
          year: album.year || 0,
          genre: album.genre || '',
        };
        const posSec = pq.position > 1000 ? pq.position / 1000 : pq.position;
        set({
          currentSetId: setInfo.id,
          currentSet: setInfo,
          currentTime: posSec,
          duration: setInfo.duration || 0,
          queue: [setInfo],
          queueIndex: 0,
        });
      }
    } catch {
      /* ignore */
    }
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
    set({ currentTime: time });
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
    try {
      const starred = await getStarred();
      if (starred.length > 0) {
        const ids = starred.map((s) => s.id);
        set({ likedSetIds: ids });
        localStorage.setItem(LIKED_SETS_STORAGE_KEY, JSON.stringify(ids));
      }
    } catch {
      /* silent */
    }
  },

  toggleLike: async (setId: string) => {
    const current = get().likedSetIds;
    const isLiked = current.includes(setId);

    // Optimistic update
    const updated = isLiked
      ? current.filter((id) => id !== setId)
      : [...current, setId];
    set({ likedSetIds: updated });
    try {
      localStorage.setItem(LIKED_SETS_STORAGE_KEY, JSON.stringify(updated));
    } catch (e) {
      console.warn('Failed to save liked sets', e);
    }

    // Backend sync (async, non-blocking)
    if (isLiked) {
      await unstarAlbum(setId);
    } else {
      await starAlbum(setId);
    }
  },

  isLiked: (setId: string) => {
    return get().likedSetIds.includes(setId);
  },

  setFestivals: (festivals) => set({ festivals }),
  setRecentSets: (recentSets) => set({ recentSets }),
  setArtists: (artists) => set({ artists }),

  setTracklistForSet: (setId, tracklist) => {
    const { currentSet, queue } = get();
    if (currentSet && currentSet.id === setId) {
      set({ currentSet: { ...currentSet, tracklist } });
    }
    const updatedQueue = queue.map((s) => (s.id === setId ? { ...s, tracklist } : s));
    set({ queue: updatedQueue });
  },
}));

// Bind AudioEngine state events to PlayerStore
AudioEngine.onStateChange((stateUpdate) => {
  usePlayerStore.setState(stateUpdate);

  if (stateUpdate.currentTime !== undefined) {
    const time = stateUpdate.currentTime;
    const tracklist = usePlayerStore.getState().currentSet?.tracklist;
    if (tracklist && tracklist.length > 0) {
      // Binary search for active cue
      let lo = 0, hi = tracklist.length - 1;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (time < tracklist[mid].timeSec) hi = mid - 1;
        else lo = mid + 1;
      }
      const newActiveCue = Math.max(0, lo - 1);
      if (usePlayerStore.getState().activeCueIndex !== newActiveCue) {
        usePlayerStore.setState({ activeCueIndex: newActiveCue });
      }
    }
  }
});
