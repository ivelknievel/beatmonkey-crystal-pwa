import { Music2 } from 'lucide-react';
import type { TrackCue } from '../../types';
import { formatTime } from '../../utils/format';

export interface TrackRowProps {
  track: TrackCue;
  isActive: boolean;
  onSeek: () => void;
}

export function TrackRow({ track, isActive, onSeek }: TrackRowProps) {
  return (
    <div
      onClick={onSeek}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSeek();
        }
      }}
      className={`flex items-center gap-3 py-2 px-3 rounded-lg cursor-pointer transition-colors select-none ${
        isActive
          ? 'bg-[var(--color-crystal-cyan)]/10 text-[var(--color-crystal-cyan)] border border-[var(--color-crystal-cyan)]/30'
          : 'text-gray-300 hover:bg-[var(--color-crystal-surface)] hover:text-white'
      }`}
    >
      <span
        className={`text-xs font-mono w-12 text-right flex-shrink-0 ${
          isActive ? 'text-[var(--color-crystal-cyan)] font-semibold' : 'text-gray-500'
        }`}
      >
        {formatTime(track.timeSec)}
      </span>

      <div className="flex-1 min-w-0">
        <p className={`text-sm truncate leading-snug ${isActive ? 'font-semibold text-[var(--color-crystal-cyan)]' : 'text-white'}`}>
          {track.title}
        </p>
        {track.artist && (
          <p className="text-xs text-gray-400 truncate leading-snug">
            {track.artist}
          </p>
        )}
      </div>

      {track.spotifyUri && (
        <a
          href={track.spotifyUri}
          target="_blank"
          rel="noopener noreferrer"
          className="text-emerald-400 hover:text-emerald-300 p-1 rounded hover:bg-white/5 transition-colors flex-shrink-0"
          onClick={(e) => e.stopPropagation()}
          aria-label={`Open ${track.title} on Spotify`}
        >
          <Music2 size={15} />
        </a>
      )}
    </div>
  );
}

export default TrackRow;
