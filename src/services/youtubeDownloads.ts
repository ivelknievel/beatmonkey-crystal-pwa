import { authenticatedFetch } from './authService';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'uncertain';

export const KNOWN_STATUSES: Set<string> = new Set([
  'pending',
  'running',
  'completed',
  'failed',
  'uncertain',
]);

export interface YoutubeJob {
  id: string;
  status: JobStatus;
  url: string;
  owner?: string;
  created_at?: string;
  error?: string | null;
  [key: string]: any;
}

const VALID_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

export function extractCanonicalVideoId(url: string): string {
  if (!url || typeof url !== 'string') {
    throw new Error('URL must be a string');
  }
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error('URL must not be empty');
  }

  const parsed = new URL(trimmed);

  if (parsed.protocol !== 'https:') {
    throw new Error('Scheme must be https');
  }

  if (parsed.port !== '') {
    throw new Error('Explicit ports not allowed');
  }

  if (parsed.username || parsed.password) {
    throw new Error('User credentials not allowed');
  }

  if (parsed.hash) {
    throw new Error('URL fragments not allowed');
  }

  const host = parsed.hostname.toLowerCase();
  if (!VALID_HOSTS.has(host)) {
    throw new Error(`Invalid host: ${host}`);
  }

  let videoId: string | null = null;

  if (host === 'youtu.be') {
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length === 1) {
      videoId = parts[0];
    } else {
      throw new Error('Invalid youtu.be path');
    }
  } else {
    const path = parsed.pathname;
    if (path === '/watch') {
      const v = parsed.searchParams.get('v');
      if (v) {
        videoId = v;
      } else {
        throw new Error("Missing 'v' parameter in /watch");
      }
    } else if (path.startsWith('/shorts/')) {
      const parts = path.split('/').filter(Boolean);
      if (parts.length === 2 && parts[0] === 'shorts') {
        videoId = parts[1];
      } else {
        throw new Error('Invalid /shorts/ path');
      }
    } else if (path.startsWith('/embed/')) {
      const parts = path.split('/').filter(Boolean);
      if (parts.length === 2 && parts[0] === 'embed') {
        videoId = parts[1];
      } else {
        throw new Error('Invalid /embed/ path');
      }
    } else if (path.startsWith('/live/')) {
      const parts = path.split('/').filter(Boolean);
      if (parts.length === 2 && parts[0] === 'live') {
        videoId = parts[1];
      } else {
        throw new Error('Invalid /live/ path');
      }
    } else {
      throw new Error(`Unsupported path: ${path}`);
    }
  }

  if (!videoId || !VIDEO_ID_REGEX.test(videoId)) {
    throw new Error(`Invalid YouTube video ID: ${videoId}`);
  }

  return videoId;
}

export function validateYoutubeUrl(url: string): boolean {
  try {
    extractCanonicalVideoId(url);
    return true;
  } catch {
    return false;
  }
}

export function canonicalizeYoutubeUrl(url: string): string {
  const videoId = extractCanonicalVideoId(url);
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function normalizeJob(raw: any, fallbackUrl?: string): YoutubeJob {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid job payload');
  }
  const id = String(raw.id || raw.job_id || '');
  if (!id) {
    throw new Error('Missing job ID');
  }

  const rawStatus = raw.status;
  const status: JobStatus = KNOWN_STATUSES.has(rawStatus)
    ? (rawStatus as JobStatus)
    : 'uncertain';

  let rawUrl = raw.url;
  if (!rawUrl && raw.video_id) {
    rawUrl = `https://www.youtube.com/watch?v=${raw.video_id}`;
  }
  if (!rawUrl && fallbackUrl) {
    rawUrl = fallbackUrl;
  }

  let canonicalUrl = rawUrl || '';
  try {
    if (rawUrl) {
      canonicalUrl = canonicalizeYoutubeUrl(rawUrl);
    }
  } catch {
    // Keep rawUrl if canonicalize fails
  }

  const error = raw.error || raw.message || null;

  return {
    ...raw,
    id,
    url: canonicalUrl,
    status,
    error,
    owner: raw.owner || raw.user_id,
    created_at: raw.created_at,
  };
}

const BASE = '';

export async function submitYoutubeJob(
  url: string,
  options?: { fmt?: string; quality?: string; signal?: AbortSignal }
): Promise<YoutubeJob> {
  const signal = options?.signal;
  let response: Response;
  try {
    response = await authenticatedFetch(`${BASE}/api/youtube/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        ...(options?.fmt ? { fmt: options.fmt } : {}),
        ...(options?.quality ? { quality: options.quality } : {}),
      }),
      signal,
    });
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      const error: any = new Error(err.message || 'Verzoek time-out');
      error.status = 'uncertain';
      throw error;
    }
    throw err;
  }

  if (response.status === 401) {
    throw new Error('Sessie verlopen. Log opnieuw in om door te gaan.');
  }

  if (response.status === 202) {
    const data = await response.json();
    return normalizeJob(data, url);
  }

  throw new Error(`Fout bij indienen van download (${response.status})`);
}

export async function listYoutubeJobs(signal?: AbortSignal): Promise<YoutubeJob[]> {
  const response = await authenticatedFetch(`${BASE}/api/youtube/jobs`, {
    method: 'GET',
    signal,
  });

  if (response.status === 401) {
    throw new Error('Sessie verlopen. Log opnieuw in om door te gaan.');
  }

  if (!response.ok) {
    throw new Error(`Fout bij ophalen van downloads (${response.status})`);
  }

  const data = await response.json();
  const list = Array.isArray(data) ? data : (data?.jobs && Array.isArray(data.jobs) ? data.jobs : []);
  return list.map((item: any) => normalizeJob(item));
}

export async function getYoutubeJob(jobId: string, signal?: AbortSignal): Promise<YoutubeJob> {
  const response = await authenticatedFetch(`${BASE}/api/youtube/jobs/${encodeURIComponent(jobId)}`, {
    method: 'GET',
    signal,
  });

  if (response.status === 401) {
    throw new Error('Sessie verlopen. Log opnieuw in om door te gaan.');
  }

  if (!response.ok) {
    throw new Error(`Fout bij ophalen van download (${response.status})`);
  }

  const data = await response.json();
  return normalizeJob(data);
}
