import { Calendar, Sparkles } from 'lucide-react';
import type { FestivalInfo } from '../../types';

interface FestivalCardProps {
  festival: FestivalInfo;
  onClick: () => void;
}

export function FestivalCard({ festival, onClick }: FestivalCardProps) {
  const totalSets = festival.stages.reduce((acc, stage) => acc + stage.sets.length, 0);

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
      className="group relative w-[180px] h-[220px] flex-shrink-0 rounded-2xl overflow-hidden cursor-pointer bg-[var(--color-crystal-card)] border border-[var(--color-crystal-border)]/70 hover:border-[var(--color-crystal-cyan)]/60 shadow-lg hover:shadow-[0_8px_25px_rgba(0,229,255,0.2)] transition-all duration-300 transform hover:-translate-y-1 select-none flex flex-col justify-end p-4"
    >
      {/* Background Image / Logo */}
      <img
        src={festival.logo}
        alt={festival.name}
        className="absolute inset-0 w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
        loading="lazy"
        onError={(e) => {
          (e.currentTarget as HTMLElement).style.display = 'none';
        }}
      />

      {/* Dark / Gradient Overlays */}
      <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0f] via-[#0a0a0f]/60 to-transparent" />
      <div className="absolute inset-0 bg-radial from-transparent to-black/40" />

      {/* Content */}
      <div className="relative z-10 space-y-1">
        {totalSets > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-[var(--color-crystal-cyan)]/20 text-[var(--color-crystal-cyan)] border border-[var(--color-crystal-cyan)]/40 backdrop-blur-md">
            <Sparkles size={10} />
            {totalSets} {totalSets === 1 ? 'set' : 'sets'}
          </span>
        )}

        <h3 className="text-base font-bold text-white leading-tight group-hover:text-[var(--color-crystal-cyan)] transition-colors line-clamp-2">
          {festival.name}
        </h3>

        <div className="flex items-center gap-1 text-xs text-gray-300 font-medium">
          <Calendar size={12} className="text-gray-400" />
          <span>{festival.date}</span>
        </div>
      </div>
    </div>
  );
}

export default FestivalCard;
