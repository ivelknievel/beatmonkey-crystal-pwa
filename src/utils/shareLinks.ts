export function parseShareTime(value: unknown): number {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 0;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : 0;
}

export function buildShareUrl(set: { id: string; songId?: string }, seconds = 0): string {
  const time = Number.isFinite(seconds) ? parseShareTime(Math.max(0, Math.floor(seconds))) : 0;
  return `https://music.cyberspeeze.online/app/set/${encodeURIComponent(set.songId || set.id)}?t=${time}`;
}

type ShareTarget = { share?: (data: ShareData) => Promise<void>; clipboard?: { writeText: (text: string) => Promise<void> } };
export async function shareLink(data: ShareData, target: ShareTarget = navigator): Promise<'shared' | 'copied' | 'cancelled'> {
  try {
    if (target.share) { await target.share(data); return 'shared'; }
    if (!target.clipboard) throw new Error('Delen is niet beschikbaar in deze browser.');
    await target.clipboard.writeText([data.text, data.url].filter(Boolean).join('\n\n'));
    return 'copied';
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') return 'cancelled';
    throw error;
  }
}
