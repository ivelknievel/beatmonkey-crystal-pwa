import { authenticatedFetch } from './authService';

const VALID_YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

export function isValidYouTubeUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (parsed.port !== '') return false;
    if (parsed.username || parsed.password) return false;
    if (parsed.hash) return false;

    const host = parsed.hostname.toLowerCase();
    if (!VALID_YOUTUBE_HOSTS.has(host)) return false;

    let videoId: string | null = null;
    if (host === 'youtu.be') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length === 1) videoId = parts[0];
    } else {
      const path = parsed.pathname;
      if (path === '/watch') {
        videoId = parsed.searchParams.get('v');
      } else if (path.startsWith('/shorts/') || path.startsWith('/embed/') || path.startsWith('/live/')) {
        const parts = path.split('/').filter(Boolean);
        if (parts.length === 2) videoId = parts[1];
      }
    }
    return Boolean(videoId && VIDEO_ID_REGEX.test(videoId));
  } catch {
    return false;
  }
}

export interface ShareSourceOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function fetchShareSource(
  setId: string | null | undefined,
  options?: ShareSourceOptions
): Promise<string | null> {
  if (!setId || typeof setId !== 'string' || !setId.trim()) {
    return null;
  }

  const trimmedId = setId.trim();
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 3500;
  let timeoutId: any = null;

  if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  if (options?.signal) {
    if (options.signal.aborted) {
      if (timeoutId) clearTimeout(timeoutId);
      return null;
    }
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const res = await authenticatedFetch(
      '/api/navidrome/source/' + encodeURIComponent(trimmedId),
      { signal: controller.signal }
    );
    if (!res || !res.ok) {
      return null;
    }
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') {
      return null;
    }
    const youtubeUrl = typeof data.youtube_url === 'string' ? data.youtube_url.trim() : null;
    if (!youtubeUrl || !isValidYouTubeUrl(youtubeUrl)) {
      return null;
    }
    return youtubeUrl;
  } catch {
    return null;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export const getShareSource = fetchShareSource;
