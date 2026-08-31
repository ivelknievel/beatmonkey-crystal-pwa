import { getStreamUrl, getCoverUrl, savePlayQueue } from '../services/subsonic';
import type { AudioState, SetInfo } from '../types';

type StateChangeCallback = (state: Partial<AudioState>) => void;

let audio: HTMLAudioElement | null = null;
let initialized = false;
let pendingStartTime = 0;
let currentSongId: string | null = null;
let currentAlbumId: string | null = null;
let lastSaveTimestamp = 0;
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

export async function savePlaybackPosition(): Promise<void> {
  if (!audio || !currentSongId) return;
  if (currentSongId.startsWith('http://') || currentSongId.startsWith('https://')) return;
  const pos = audio.currentTime || 0;
  if (pos < 10) return; // alleen posities > 10s
  const albumId = currentAlbumId || '';
  await savePlayQueue(currentSongId, pos * 1000, albumId || undefined);
  lastSaveTimestamp = Date.now();
}

function emitState(partial: Partial<AudioState>) {
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

  navigator.mediaSession.setActionHandler('play', () => {
    AudioEngine.play();
  });

  navigator.mediaSession.setActionHandler('pause', () => {
    AudioEngine.pause();
  });

  navigator.mediaSession.setActionHandler('seekforward', (details) => {
    const offset = details.seekOffset || 15;
    AudioEngine.skipForward(offset);
  });

  navigator.mediaSession.setActionHandler('seekbackward', (details) => {
    const offset = details.seekOffset || 15;
    AudioEngine.skipBack(offset);
  });

  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (details.seekTime != null) {
      AudioEngine.seek(details.seekTime);
    }
  });
}

function updateMediaSessionMetadata(meta: Partial<SetInfo>) {
  if (!('mediaSession' in navigator)) return;
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
  emitState({
    status: 'playing',
    isPlaying: true,
    currentTime: audio ? audio.currentTime : 0,
  });
  updatePositionState();
}

function onPause() {
  savePlaybackPosition();
  emitState({
    status: 'paused',
    isPlaying: false,
    currentTime: audio ? audio.currentTime : 0,
  });
  updatePositionState();
}

function onWaiting() {
  emitState({
    status: 'loading',
  });
}

function onCanPlay() {
  if (audio && audio.paused) {
    emitState({ status: 'paused' });
  } else if (audio && !audio.paused) {
    emitState({ status: 'playing', isPlaying: true });
  }
}

function onLoadedMetadata() {
  if (!audio) return;
  const duration = isNaN(audio.duration) ? 0 : audio.duration;
  if (pendingStartTime > 0 && (!duration || pendingStartTime < duration)) {
    audio.currentTime = pendingStartTime;
    pendingStartTime = 0;
  }
  emitState({
    duration,
    currentTime: audio.currentTime,
  });
  updatePositionState();
}

function onSeeked() {
  if (!audio) return;
  emitState({
    currentTime: audio.currentTime,
  });
  updatePositionState();
}

function onTimeUpdate() {
  if (!audio) return;
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
  savePlaybackPosition();
  emitState({
    status: 'paused',
    isPlaying: false,
    currentTime: audio ? audio.duration || 0 : 0,
  });
  updatePositionState();
}

function onError() {
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

  loadSet(idOrUrl: string, startTime = 0, metadata?: Partial<SetInfo>) {
    if (!audio) {
      AudioEngine.init();
    }
    if (!audio) return;

    if (currentSongId && currentSongId !== idOrUrl && audio.currentTime > 0) {
      savePlaybackPosition();
    }
    currentSongId = idOrUrl;
    currentAlbumId = metadata?.id || null;
    lastSaveTimestamp = Date.now();

    const streamUrl = idOrUrl.startsWith('http://') || idOrUrl.startsWith('https://')
      ? idOrUrl
      : getStreamUrl(idOrUrl);

    pendingStartTime = startTime;
    audio.src = streamUrl;
    audio.load();

    if (metadata) {
      updateMediaSessionMetadata(metadata);
    }

    emitState({
      status: 'loading',
      currentSetId: idOrUrl,
      currentTime: startTime,
      error: null,
    });

    const playPromise = audio.play();
    if (playPromise !== undefined) {
      playPromise.catch((err) => {
        // Autoplay may be blocked by browser policy until user gesture
        console.warn('Audio play was interrupted or requires user interaction:', err);
      });
    }
  },

  async play() {
    ensureAudioContext();
    startVisualization();
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
    if (!audio) return;
    try {
      await audio.play();
    } catch (err: any) {
      console.warn('AudioEngine play error:', err);
      emitState({ error: err?.message || 'Playback error' });
    }
  },

  pause() {
    stopVisualization();
    savePlaybackPosition();
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
    if (!audio) return;
    const targetTime = Math.max(0, time);
    pendingStartTime = targetTime;
    if (audio.readyState >= 1) {
      const duration = isNaN(audio.duration) ? 0 : audio.duration;
      const clamped = duration > 0 ? Math.min(targetTime, duration) : targetTime;
      audio.currentTime = clamped;
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
    savePlaybackPosition();
  },

  getCurrentSongId(): string | null {
    return currentSongId;
  },

  getCurrentAlbumId(): string | null {
    return currentAlbumId;
  },

  destroy() {
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
    savePlaybackPosition();
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
