import { useState } from 'react';
import { Music } from 'lucide-react';
import type { SetInfo } from '../../types';
import { getCoverUrl } from '../../services/subsonic';
import { usePlayerStore } from '../../stores/playerStore';

export interface SetCardProps {
  set: SetInfo;
  onClick?: () => void;
}

export function SetCard({ set, onClick }: SetCardProps) {
  const coverUrl = getCoverUrl(set.coverArt || set.id, 200);
  const [imgError, setImgError] = useState(false);
  const loadSet = usePlayerStore((s) => s.loadSet);

  const handleClick = () => {
    if (onClick) {
      onClick();
    } else {
      loadSet(set, 0);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="text-left group w-[140px] flex-shrink-0 cursor-pointer select-none"
    >
      <div className="relative aspect-square w-[140px] h-[140px] rounded-xl overflow-hidden bg-crystal-surface mb-2 border border-[var(--color-crystal-border)]/50 group-hover:border-crystal-cyan/50 transition-colors">
        {!imgError && coverUrl ? (
          <img
            src={coverUrl}
            alt={set.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            onError={() => setImgError(true)}
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-crystal-cyan/20 to-crystal-pink/20">
            <Music size={32} className="text-crystal-cyan/40" />
          </div>
        )}
      </div>
      <p className="text-sm font-medium text-white truncate group-hover:text-crystal-cyan transition-colors">
        {set.title}
      </p>
      <p className="text-xs text-gray-500 truncate">
        {set.artist || 'Onbekende DJ'}
      </p>
    </button>
  );
}

export const RecentSetCard = SetCard;
export default SetCard;
