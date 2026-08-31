import { Play, Disc3, Heart } from 'lucide-react';
import type { SetInfo } from '../../types';
import { usePlayerStore } from '../../stores/playerStore';
import { formatTime } from '../../utils/format';

interface SetCardProps {
  set: SetInfo;
  onPlay?: () => void;
}

export function SetCard({ set, onPlay }: SetCardProps) {
  const loadSet = usePlayerStore((s) => s.loadSet);
  const setFullscreen = usePlayerStore((s) => s.setFullscreen);
  const toggleLike = usePlayerStore((s) => s.toggleLike);
  const currentSetId = usePlayerStore((s) => s.currentSetId);

  const isCurrent = currentSetId === set.id;

  const handlePlay = () => {
    if (onPlay) {
      onPlay();
    } else {
      loadSet(set, 0);
      setFullscreen(true);
    }
  };

  return (
    <div
      onClick={handlePlay}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handlePlay();
        }
      }}
      className={`group relative flex items-center gap-3.5 p-3 rounded-2xl bg-[var(--color-crystal-card)]/80 hover:bg-[var(--color-crystal-card)] border transition-all duration-200 cursor-pointer select-none ${
        isCurrent
          ? 'border-[var(--color-crystal-cyan)] shadow-[0_0_20px_rgba(0,229,255,0.15)]'
          : 'border-[var(--color-crystal-border)] hover:border-white/20'
      }`}
    >
      {/* Thumbnail */}
      <div className="relative w-16 h-16 sm:w-20 sm:h-20 rounded-xl overflow-hidden flex-shrink-0 bg-[var(--color-crystal-surface)] border border-white/10">
        {set.coverArt ? (
          <img
            src={set.coverArt}
            alt={set.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            loading="lazy"
            onError={(e) => {
              (e.currentTarget as HTMLElement).style.display = 'none';
            }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-500">
            <Disc3 size={24} />
          </div>
        )}

        {/* Play Overlay */}
        <div
          className={`absolute inset-0 bg-black/40 flex items-center justify-center transition-opacity ${
            isCurrent ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          <button
            type="button"
            aria-label="Play"
            onClick={(e) => {
              e.stopPropagation();
              handlePlay();
            }}
            className="w-8 h-8 rounded-full bg-[var(--color-crystal-cyan)] text-black flex items-center justify-center shadow"
          >
            <Play size={14} className="fill-black ml-0.5 lucide-play" />
          </button>
        </div>
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {set.festival && (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-[var(--color-crystal-cyan)]/20 text-[var(--color-crystal-cyan)] border border-[var(--color-crystal-cyan)]/30">
              {set.festival}
            </span>
          )}
          {set.stage && (
            <span className="text-[10px] text-gray-400">{set.stage}</span>
          )}
        </div>

        <h3 className="text-sm font-bold text-white group-hover:text-[var(--color-crystal-cyan)] transition-colors truncate mt-1">
          {set.title}
        </h3>

        <p className="text-xs text-gray-400 truncate mt-0.5">
          {set.artist}
        </p>

        <p className="text-[11px] font-mono text-gray-500 mt-1">
          {formatTime(set.duration)}
        </p>
      </div>

      {/* Quick Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleLike(set.id);
          }}
          className="p-2 rounded-xl text-[var(--color-crystal-pink)] hover:bg-white/10 transition-colors cursor-pointer"
          aria-label="Verwijder uit favorieten"
          title="Verwijder uit favorieten"
        >
          <Heart size={20} className="fill-current" />
        </button>
      </div>
    </div>
  );
}

export default SetCard;
