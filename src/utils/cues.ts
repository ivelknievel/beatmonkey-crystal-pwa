import type { TrackCue } from '../types';

/** Latest valid cue at/before time; -1 before first. Duplicate times prefer last.
 * Keep original indices (also works for unsorted data); ignore invalid/negative cues.
 */
export function findActiveCueIndex(cues: readonly Pick<TrackCue, 'timeSec'>[] | undefined, time: number): number {
  if (!cues || !Number.isFinite(time)) return -1;
  let index = -1;
  let latest = -Infinity;
  cues.forEach((cue, i) => {
    if (Number.isFinite(cue.timeSec) && cue.timeSec >= 0 && cue.timeSec <= time && cue.timeSec >= latest) {
      latest = cue.timeSec;
      index = i;
    }
  });
  return index;
}
