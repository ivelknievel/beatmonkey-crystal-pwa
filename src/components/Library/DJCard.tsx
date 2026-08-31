import { User, Music, ChevronRight } from 'lucide-react';
import type { ArtistInfo } from '../../types';

interface DJCardProps {
  artist: ArtistInfo;
  onClick: () => void;
}

export function DJCard({ artist, onClick }: DJCardProps) {
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className="group relative flex flex-col p-3.5 sm:p-4 rounded-2xl bg-[var(--color-crystal-card,#1a1a26)]/80 hover:bg-[var(--color-crystal-card,#1a1a26)] border border-[var(--color-crystal-border,#222230)] hover:border-[var(--color-crystal-cyan,#00e5ff)]/50 shadow-lg hover:shadow-[0_4px_20px_rgba(0,229,255,0.15)] transition-all duration-200 cursor-pointer select-none"
    >
      <div className="flex items-center gap-3">
        {/* DJ Avatar */}
        <div className="relative w-12 h-12 sm:w-14 sm:h-14 rounded-full overflow-hidden flex-shrink-0 bg-[var(--color-crystal-surface,#12121a)] border-2 border-[var(--color-crystal-border,#222230)] group-hover:border-[var(--color-crystal-cyan,#00e5ff)] transition-colors shadow-inner">
          {artist.image ? (
            <img
              src={artist.image}
              alt={artist.name}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              loading="lazy"
              onError={(e) => {
                (e.currentTarget as HTMLElement).style.display = 'none';
              }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-500">
              <User size={22} />
            </div>
          )}
        </div>

        {/* DJ Info */}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm sm:text-base font-bold text-white group-hover:text-[var(--color-crystal-cyan,#00e5ff)] transition-colors truncate">
            {artist.name}
          </h3>

          <p className="text-xs text-gray-400 flex items-center gap-1 mt-0.5">
            <Music size={11} className="text-[var(--color-crystal-cyan,#00e5ff)] flex-shrink-0" />
            <span>{artist.setCount || 1} {artist.setCount === 1 ? 'liveset' : 'livesets'}</span>
          </p>
        </div>

        <ChevronRight size={16} className="text-gray-500 group-hover:text-white group-hover:translate-x-0.5 transition-all flex-shrink-0" />
      </div>

      {/* Genre tags */}
      {artist.genres && artist.genres.length > 0 && (
        <div className="flex items-center gap-1.5 mt-3 pt-2.5 border-t border-white/5 flex-wrap">
          {artist.genres.slice(0, 2).map((genre) => (
            <span
              key={genre}
              className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-[var(--color-crystal-surface,#12121a)] text-gray-300 border border-[var(--color-crystal-border,#222230)] truncate max-w-[110px]"
            >
              {genre}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default DJCard;
