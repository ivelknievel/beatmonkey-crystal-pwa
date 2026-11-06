export function parseShareTime(value: unknown): number {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 0;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : 0;
}

const VALID_YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

export function extractYouTubeVideoId(input: unknown): string | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (VIDEO_ID_REGEX.test(trimmed)) return trimmed;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (parsed.port !== '') return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.hash) return null;

    const host = parsed.hostname.toLowerCase();
    if (!VALID_YOUTUBE_HOSTS.has(host)) return null;

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
    if (videoId && VIDEO_ID_REGEX.test(videoId)) return videoId;
    return null;
  } catch {
    return null;
  }
}

export function formatShareTimestamp(seconds: number): string {
  if (isNaN(seconds) || seconds < 0 || !isFinite(seconds)) return '0:00';
  const totalSecs = Math.floor(seconds);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function buildIosShareUrl(set: { id: string; songId?: string }, seconds = 0): string {
  const time = Number.isFinite(seconds) ? parseShareTime(Math.max(0, Math.floor(seconds))) : 0;
  return `https://music.cyberspeeze.online/app/set/${encodeURIComponent(set.songId || set.id)}?t=${time}`;
}

export function buildAndroidShareUrl(set: { id: string; songId?: string }, seconds = 0): string {
  const time = Number.isFinite(seconds) ? parseShareTime(Math.max(0, Math.floor(seconds))) : 0;
  return `https://music.cyberspeeze.online/go/set/${encodeURIComponent(set.songId || set.id)}?t=${time}`;
}

export function buildYouTubeShareUrl(urlOrVideoId: string, seconds = 0): string | null {
  const videoId = extractYouTubeVideoId(urlOrVideoId);
  if (!videoId) return null;
  const time = Number.isFinite(seconds) ? parseShareTime(Math.max(0, Math.floor(seconds))) : 0;
  return `https://www.youtube.com/watch?v=${videoId}&t=${time}s`;
}

export function buildShareUrl(set: { id: string; songId?: string }, seconds = 0): string {
  return buildIosShareUrl(set, seconds);
}

export interface ShareComposerOptions {
  set: {
    id: string;
    songId?: string;
    title: string;
    artist?: string;
    youtubeUrl?: string;
    videoId?: string;
  };
  seconds?: number;
  cue?: {
    artist?: string;
    title?: string;
  } | null;
  youtubeUrl?: string;
  videoId?: string;
}

export function composeShareText(
  targetOrOptions:
    | ShareComposerOptions
    | { id: string; songId?: string; title: string; artist?: string; youtubeUrl?: string; videoId?: string },
  secondsArg?: number,
  cueArg?: { artist?: string; title?: string } | null
): string {
  let set: { id: string; songId?: string; title: string; artist?: string; youtubeUrl?: string; videoId?: string };
  let seconds: number | undefined;
  let cue: { artist?: string; title?: string } | null | undefined;
  let youtubeUrl: string | undefined;
  let videoId: string | undefined;

  if (targetOrOptions && 'set' in targetOrOptions && typeof (targetOrOptions as any).set === 'object') {
    const opts = targetOrOptions as ShareComposerOptions;
    set = opts.set;
    seconds = opts.seconds;
    cue = opts.cue;
    youtubeUrl = opts.youtubeUrl;
    videoId = opts.videoId;
  } else {
    set = targetOrOptions as any;
    seconds = secondsArg;
    cue = cueArg;
  }

  const rawSeconds = typeof seconds === 'number' ? seconds : parseShareTime(seconds);
  const safeSeconds = Number.isFinite(rawSeconds) && rawSeconds >= 0 ? Math.floor(rawSeconds) : 0;
  const timeStr = formatShareTimestamp(safeSeconds);
  const title = set?.title?.trim() || 'Liveset';

  let cueLine: string | null = null;

  if (cue) {
    const cueArtist = cue.artist?.trim();
    const cueTitle = cue.title?.trim();
    if (cueArtist && cueTitle) {
      cueLine = `${cueArtist} - ${cueTitle}`;
    } else if (cueTitle) {
      cueLine = cueTitle;
    } else if (cueArtist) {
      cueLine = cueArtist;
    }
  }

  const header = cueLine
    ? `🎵 Om ${timeStr} in ${title}\n${cueLine}`
    : `🎵 Om ${timeStr} in ${title}`;

  const sections: string[] = [header];
  sections.push(buildAndroidShareUrl(set, safeSeconds).replace('https://music.cyberspeeze.online', 'Android: https://music.cyberspeeze.online'));
  sections.push(buildIosShareUrl(set, safeSeconds).replace('https://music.cyberspeeze.online', 'IOS: https://music.cyberspeeze.online'));

  const ytCandidate = videoId || youtubeUrl || set?.videoId || set?.youtubeUrl;
  const resolvedVideoId = extractYouTubeVideoId(ytCandidate);
  if (resolvedVideoId) {
    sections.push(`YouTube: https://www.youtube.com/watch?v=${resolvedVideoId}&t=${safeSeconds}s`);
  }

  sections.push('#BeatmonkeyCrystal');

  return sections.join('\n\n');
}

type ShareTarget = {
  share?: (data: ShareData) => Promise<void>;
  clipboard?: { writeText: (text: string) => Promise<void> };
};

export async function shareLink(
  data: ShareData,
  target: ShareTarget = typeof navigator !== 'undefined' ? navigator : {}
): Promise<'shared' | 'copied' | 'cancelled'> {
  try {
    if (target.share) {
      const payload: ShareData = { ...data };
      if (payload.text && payload.url && payload.text.includes(payload.url)) {
        delete payload.url;
      }
      await target.share(payload);
      return 'shared';
    }
    if (!target.clipboard) throw new Error('Delen is niet beschikbaar in deze browser.');
    const textToWrite =
      data.text && data.url && data.text.includes(data.url)
        ? data.text
        : [data.text, data.url].filter(Boolean).join('\n\n');
    await target.clipboard.writeText(textToWrite);
    return 'copied';
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') {
      return 'cancelled';
    }
    throw error;
  }
}
