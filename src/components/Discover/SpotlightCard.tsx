import { useNavigate } from '@tanstack/react-router';
import { Play, Flame, ArrowRight } from 'lucide-react';
import type { FestivalInfo } from '../../types';
import { usePlayerStore } from '../../stores/playerStore';

interface SpotlightCardProps {
  festival: FestivalInfo;
}

export function SpotlightCard({ festival }: SpotlightCardProps) {
  const navigate = useNavigate();
  const loadSet = usePlayerStore((s) => s.loadSet);

  const topSet = festival.stages[0]?.sets[0];

  const handlePlayTopSet = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (topSet) {
      loadSet(topSet, 0);
    }
  };

  return (
    <article
      aria-label={`Spotlight festival: ${festival.name}`}
      className="group relative w-full rounded-2xl sm:rounded-3xl overflow-hidden cursor-pointer border border-[var(--color-crystal-border)] hover:border-[var(--color-crystal-cyan)]/60 shadow-2xl transition-all duration-300 transform hover:-translate-y-0.5 select-none min-h-[260px] sm:min-h-[300px] flex flex-col justify-end p-6 sm:p-8"
    >
      {/* Hero Background Image */}
      <img
        src={festival.logo}
        alt={festival.name}
        className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
        loading="lazy"
        onError={(e) => {
          (e.currentTarget as HTMLElement).style.display = 'none';
        }}
      />

      {/* Cinematic Gradients */}
      <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0f] via-[#0a0a0f]/75 to-black/30" />
      <div className="absolute inset-0 bg-gradient-to-r from-[#0a0a0f]/90 via-[#0a0a0f]/40 to-transparent" />

      {/* Full-card open target is a sibling, never a parent of the play button. */}
      <button
        type="button"
        aria-label={`Bekijk Festival: ${festival.name}`}
        onClick={() => navigate({ to: `/festivals/${festival.slug}` })}
        className="absolute inset-0 z-10 cursor-pointer rounded-[inherit] focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-[var(--color-crystal-cyan)]"
      />

      {/* Content */}
      <div className="relative z-20 space-y-3 max-w-xl pointer-events-none">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-gradient-to-r from-[var(--color-crystal-cyan)]/20 to-[var(--color-crystal-pink)]/20 text-[var(--color-crystal-cyan)] border border-[var(--color-crystal-cyan)]/40 backdrop-blur-md">
            <Flame size={14} className="text-[var(--color-crystal-pink)]" />
            SPOTLIGHT FESTIVAL
          </span>
          <span className="text-xs font-semibold text-gray-300 bg-black/40 px-2.5 py-1 rounded-full backdrop-blur-sm border border-white/10">
            {festival.date}
          </span>
        </div>

        <h2 className="text-2xl sm:text-4xl font-extrabold text-white tracking-tight leading-tight group-hover:text-[var(--color-crystal-cyan)] transition-colors">
          {festival.name}
        </h2>

        {festival.description && (
          <p className="text-sm text-gray-300 line-clamp-2 leading-relaxed hidden sm:block">
            {festival.description}
          </p>
        )}

        {/* Action Buttons */}
        <div className="flex items-center gap-3 pt-2">
          {topSet && (
            <button
              type="button"
              onClick={handlePlayTopSet}
              className="pointer-events-auto inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--color-crystal-cyan)] hover:bg-[#33ebff] text-black font-bold text-xs sm:text-sm shadow-[0_0_20px_rgba(0,229,255,0.4)] transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <Play size={16} className="fill-black" />
              Speel Top Set
            </button>
          )}

          <span
            aria-hidden="true"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white font-semibold text-xs sm:text-sm backdrop-blur-md border border-white/15 transition-colors cursor-pointer"
          >
            <span>Bekijk Festival</span>
            <ArrowRight size={14} />
          </span>
        </div>
      </div>
    </article>
  );
}

export default SpotlightCard;
