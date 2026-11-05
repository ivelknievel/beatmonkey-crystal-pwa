import { getStreamUrl, getCoverUrl, savePlayQueue } from '../services/subsonic';
import type { AudioState, SetInfo } from '../types';

type StateChangeCallback = (state: Partial<AudioState>) => void;

let audio: HTMLAudioElement | null = null;
let initialized = false;
let pendingStartTime: number | null = null;
let currentSongId: string | null = null;
let currentAlbumId: string | null = null;
let lastSaveTimestamp = 0;
let generation = 0;
let accountGeneration = 0;
let playAttempt = 0;
let suppressEvents = false;
let playbackStatus: AudioState['status'] = 'idle';
type SaveSnapshot = { generation: number; accountGeneration: number; songId: string; albumId: string | null; position: number; key: string };
let pendingSave: SaveSnapshot | null = null;
let inFlightSave: SaveSnapshot | null = null;
let saveWorker: Promise<void> | null = null;
let lastSavedKey: string | null = null;
function clampTime(time: number, duration = audio && Number.isFinite(audio.duration) && audio.duration > 0
  ? audio.duration : currentSetMetadata?.duration): number {
  if (!Number.isFinite(time)) return 0;
  return Math.min(Math.max(0, time), duration && Number.isFinite(duration) && duration > 0 ? duration : Infinity);
}
let currentSetMetadata: Partial<SetInfo> | null = null;
const listeners = new Set<StateChangeCallback>();

let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let sourceNode: MediaElementAudioSourceNode | null = null;
let animFrameId: number | null = null;
let onVisualizationDataCallback: ((data: Uint8Array) => void) | null = null;

function ensureAudioContext(): boolean {
  if (audioContext && analyser) {
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
    return true;
  }
  if (typeof window === 'undefined') return false;

  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return false;
    audioContext = new AudioCtx();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;

    if (audio && !sourceNode) {
      sourceNode = audioContext.createMediaElementSource(audio);
      sourceNode.connect(analyser);
      analyser.connect(audioContext.destination);
    }
    return true;
  } catch (err) {
    console.warn('Failed to initialize Web Audio context/analyser:', err);
    return false;
  }
}

function startVisualization(): void {
  if (!audioContext) {
    // AudioContext nog niet gecreëerd — wacht op play
    return;
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  if (!analyser || !onVisualizationDataCallback) return;

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  const draw = () => {
    if (!analyser || !onVisualizationDataCallback) return;
    analyser.getByteFrequencyData(dataArray);
    onVisualizationDataCallback(new Uint8Array(dataArray));
    animFrameId = requestAnimationFrame(draw);
  };

  draw();
}

function stopVisualization(): void {
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}

export function savePlaybackPosition(): Promise<void> {
  if (!audio || !currentSongId || /^https?:\/\//.test(currentSongId)) return Promise.resolve();
  const pos = clampTime(audio.currentTime);
  if (pos < 10) return Promise.resolve();
  const key = `${generation}:${currentSongId}:${pos}`;
  if (key === lastSavedKey || key === inFlightSave?.key || key === pendingSave?.key) return saveWorker || Promise.resolve();
  pendingSave = { generation, accountGeneration, songId: currentSongId, albumId: currentAlbumId, position: pos * 1000, key };
  if (!saveWorker) {
    // Defer one microtask so concurrent requests share a single serialized worker.
    saveWorker = Promise.resolve().then(async () => {
      try {
        while (pendingSave) {
          const snapshot = pendingSave;
          pendingSave = null;
          if (snapshot.accountGeneration !== accountGeneration) continue;
          inFlightSave = snapshot;
          try {
            const result = await savePlayQueue(snapshot.songId, snapshot.position, snapshot.albumId || undefined);
            if (result !== false && snapshot.generation === generation) {
              lastSaveTimestamp = Date.now();
              lastSavedKey = snapshot.key;
            }
          } catch { /* Failed saves remain retryable; no unhandled event rejection. */ }
          finally { inFlightSave = null; }
        }
      } finally {
        // Clear synchronously with the final queue check (no .finally microtask gap).
        saveWorker = null;
      }
    });
  }
  return saveWorker;
}

function emitState(partial: Partial<AudioState>) {
  if (partial.status) {
    playbackStatus = partial.status;
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = partial.status === 'playing' ? 'playing' : currentSongId ? 'paused' : 'none'; } catch { /* optional */ }
    }
  }
  listeners.forEach((cb) => {
    try {
      cb(partial);
    } catch (e) {
      console.error('Error in AudioEngine listener callback:', e);
    }
  });
}

function updatePositionState() {
  if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession && audio) {
    const duration = audio.duration;
    if (duration && !isNaN(duration) && isFinite(duration) && duration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: Math.max(0, duration),
          playbackRate: audio.playbackRate || 1,
          position: Math.min(Math.max(0, audio.currentTime), duration),
        });
      } catch (err) {
        console.warn('Failed to set mediaSession position state', err);
      }
    }
  }
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;

  const register = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
  };
  register('play', () => {
    AudioEngine.play();
  });

  register('pause', () => {
    AudioEngine.pause();
  });

  register('seekforward', (details) => {
    const offset = details.seekOffset || 15;
    AudioEngine.skipForward(offset);
  });

  register('seekbackward', (details) => {
    const offset = details.seekOffset || 15;
    AudioEngine.skipBack(offset);
  });

  register('seekto', (details) => {
    if (details.seekTime != null) {
      AudioEngine.seek(details.seekTime);
    }
  });
}

function updateMediaSessionMetadata(meta: Partial<SetInfo>) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  currentSetMetadata = { ...currentSetMetadata, ...meta };

  const artworkList: MediaImage[] = [];
  if (meta.coverArt) {
    const coverUrl = meta.coverArt.startsWith('http://') || meta.coverArt.startsWith('https://') || meta.coverArt.startsWith('/')
      ? meta.coverArt
      : getCoverUrl(meta.coverArt, 512);

    artworkList.push({
      src: coverUrl,
      sizes: '512x512',
      type: 'image/jpeg',
    });
  }

  navigator.mediaSession.metadata = new MediaMetadata({
    title: meta.title || 'Beatmonkey Set',
    artist: meta.artist || 'Beatmonkey Crystal',
    album: meta.festival || 'Beatmonkey Crystal',
    artwork: artworkList,
  });
}

// Audio Event Handlers
function onPlay() {
  if (suppressEvents || !currentSongId || !audio || audio.paused) return;
  emitState({
    status: 'playing',
    error: null,
    isPlaying: true,
    currentTime: audio ? audio.currentTime : 0,
  });
  updatePositionState();
}

function onPause() {
  if (suppressEvents || !currentSongId || !audio?.paused) return;
  savePlaybackPosition();
  emitState({
    status: 'paused',
    isPlaying: false,
    currentTime: audio ? audio.currentTime : 0,
  });
  updatePositionState();
}

function onWaiting() {
  if (suppressEvents || !currentSongId || playbackStatus === 'blocked') return;
  emitState({
    status: 'loading',
  });
}

function onCanPlay() {
  if (suppressEvents || !currentSongId || playbackStatus === 'blocked') return;
  if (audio && audio.paused) {
    emitState({ status: 'paused' });
  } else if (audio && !audio.paused) {
    emitState({ status: 'playing', isPlaying: true });
  }
}

function onLoadedMetadata() {
  if (!audio) return;
  if (suppressEvents || !currentSongId) return;
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  if (pendingStartTime !== null) audio.currentTime = clampTime(pendingStartTime);
  pendingStartTime = null;
  emitState({
    duration,
    currentTime: audio.currentTime,
  });
  updatePositionState();
}

function onSeeked() {
  if (!audio || !currentSongId || suppressEvents) return;
  emitState({
    currentTime: audio.currentTime,
  });
  updatePositionState();
}

function onTimeUpdate() {
  if (!audio || !currentSongId || suppressEvents) return;
  const now = Date.now();
  if (now - lastSaveTimestamp >= 30000) {
    savePlaybackPosition();
  }
  emitState({
    currentTime: audio.currentTime,
  });
  updatePositionState();
}

function onEnded() {
  if (!currentSongId || suppressEvents) return;
  savePlaybackPosition();
  emitState({
    status: 'paused',
    isPlaying: false,
    currentTime: audio ? audio.duration || 0 : 0,
  });
  updatePositionState();
}

function onError() {
  if (!currentSongId || suppressEvents) return;
  const errMsg = audio?.error ? `Audio playback error (${audio.error.code}): ${audio.error.message}` : 'Audio playback error';
  emitState({
    status: 'error',
    isPlaying: false,
    error: errMsg,
  });
}

export const AudioEngine = {
  get onVisualizationData(): ((data: Uint8Array) => void) | null {
    return onVisualizationDataCallback;
  },

  set onVisualizationData(cb: ((data: Uint8Array) => void) | null) {
    onVisualizationDataCallback = cb;
  },

  ensureAudioContext(): boolean {
    return ensureAudioContext();
  },

  startVisualization(): void {
    startVisualization();
  },

  stopVisualization(): void {
    stopVisualization();
  },

  init() {
    if (initialized && audio) return;

    audio = new Audio();
    audio.preload = 'auto';
    audio.crossOrigin = 'anonymous';

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('canplay', onCanPlay);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('seeked', onSeeked);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', savePlaybackPosition);
      window.addEventListener('pagehide', savePlaybackPosition);
    }

    setupMediaSession();
    initialized = true;
  },

  loadSet(idOrUrl: string, startTime = 0, metadata?: Partial<SetInfo>, autoplay = true) {
    if (!audio) AudioEngine.init();
    if (!audio) return Promise.resolve();
    if (currentSongId && currentSongId !== idOrUrl) void savePlaybackPosition();
    generation++;
    playAttempt++;
    suppressEvents = true;
    audio.pause();
    suppressEvents = false;
    currentSongId = idOrUrl;
    currentAlbumId = metadata?.id || null;
    currentSetMetadata = metadata || null;
    lastSaveTimestamp = Date.now();
    lastSavedKey = null;
    pendingStartTime = clampTime(startTime, metadata?.duration || 0);
    audio.src = /^https?:\/\//.test(idOrUrl) ? idOrUrl : getStreamUrl(idOrUrl);
    audio.load();
    if (metadata) updateMediaSessionMetadata(metadata);
    emitState({ status: autoplay ? 'loading' : 'paused', isPlaying: false,
      currentSetId: currentAlbumId, currentSongId, currentTime: pendingStartTime, error: null });
    return autoplay ? AudioEngine.play() : Promise.resolve();
  },

  async play() {
    if (!audio || !currentSongId) return;
    const selected = generation;
    const attempt = ++playAttempt;
    // HTML media is the baseline. Only an explicit analyser request opts in to Web Audio.
    if (audioContext?.state === 'suspended') void audioContext.resume().catch(() => {});
    try {
      await audio.play();
      if (selected !== generation || attempt !== playAttempt) return;
      emitState({ status: 'playing', isPlaying: true, error: null });
      startVisualization();
    } catch (err) {
      if (selected !== generation || attempt !== playAttempt) return;
      const error = err instanceof Error ? err : new Error(String(err));
      emitState({ status: error.name === 'NotAllowedError' ? 'blocked' : 'error', isPlaying: false, error: error.message });
    }
  },

  pause() {
    playAttempt++;
    stopVisualization();
    if (!audio) return;
    audio.pause();
  },

  togglePlay() {
    if (!audio) return;
    if (audio.paused) {
      AudioEngine.play();
    } else {
      AudioEngine.pause();
    }
  },

  seek(time: number) {
    if (!audio || !currentSongId) return;
    const targetTime = clampTime(time);
    pendingStartTime = targetTime;
    if (audio.readyState >= 1) {
      audio.currentTime = targetTime;
      pendingStartTime = null;
    }
    emitState({ currentTime: targetTime });
    updatePositionState();
  },

  seekTo(time: number) {
    AudioEngine.seek(time);
  },

  skipForward(seconds = 15) {
    if (!audio) return;
    const target = Math.min((audio.currentTime || 0) + seconds, audio.duration || Infinity);
    AudioEngine.seek(target);
  },

  skipBack(seconds = 15) {
    if (!audio) return;
    const target = Math.max((audio.currentTime || 0) - seconds, 0);
    AudioEngine.seek(target);
  },

  setVolume(volume: number) {
    if (!audio) return;
    const clamped = Math.max(0, Math.min(volume, 1));
    audio.volume = clamped;
    emitState({ volume: clamped });
  },

  updateMediaMetadata(meta: Partial<SetInfo>) {
    updateMediaSessionMetadata(meta);
  },

  getAudioElement(): HTMLAudioElement | null {
    return audio;
  },

  getCurrentTime(): number {
    return audio ? audio.currentTime : 0;
  },

  getCurrentPosition(): number {
    return audio ? audio.currentTime : 0;
  },

  getDuration(): number {
    return audio && !isNaN(audio.duration) ? audio.duration : 0;
  },

  onStateChange(cb: StateChangeCallback): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },

  savePlaybackPosition() {
    return savePlaybackPosition();
  },

  getCurrentSongId(): string | null {
    return currentSongId;
  },

  getCurrentAlbumId(): string | null {
    return currentAlbumId;
  },

  reset() {
    generation++;
    accountGeneration++;
    playAttempt++;
    pendingSave = null;
    lastSavedKey = null;
    lastSaveTimestamp = 0;
    currentSongId = null;
    currentAlbumId = null;
    currentSetMetadata = null;
    pendingStartTime = null;
    stopVisualization();
    suppressEvents = true;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    suppressEvents = false;
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.metadata = null; navigator.mediaSession.setPositionState?.(); } catch { /* optional */ }
    }
    emitState({ status: 'idle', currentSetId: null, currentSongId: null, currentTime: 0, duration: 0, isPlaying: false, error: null });
  },

  destroy() {
    AudioEngine.reset();
    stopVisualization();
    onVisualizationDataCallback = null;
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {}
      sourceNode = null;
    }
    if (analyser) {
      try {
        analyser.disconnect();
      } catch {}
      analyser = null;
    }
    if (audioContext && audioContext.state !== 'closed') {
      try {
        audioContext.close();
      } catch {}
      audioContext = null;
    }
    if (!audio) return;
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', savePlaybackPosition);
      window.removeEventListener('pagehide', savePlaybackPosition);
    }
    audio.pause();
    audio.removeEventListener('play', onPlay);
    audio.removeEventListener('pause', onPause);
    audio.removeEventListener('waiting', onWaiting);
    audio.removeEventListener('canplay', onCanPlay);
    audio.removeEventListener('loadedmetadata', onLoadedMetadata);
    audio.removeEventListener('seeked', onSeeked);
    audio.removeEventListener('timeupdate', onTimeUpdate);
    audio.removeEventListener('ended', onEnded);
    audio.removeEventListener('error', onError);
    audio.src = '';
    audio = null;
    currentSongId = null;
    currentAlbumId = null;
    initialized = false;
    listeners.clear();
  },
};

export type AudioEngine = typeof AudioEngine;
