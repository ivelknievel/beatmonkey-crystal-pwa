import { useRef, useEffect } from 'react';
import type { MouseEvent } from 'react';
import { Play, Pause, Disc3, Loader2 } from 'lucide-react';
import { usePlayerStore } from '../../stores/playerStore';
import { AudioEngine } from '../../engine/AudioEngine';
import { getCoverUrl } from '../../services/subsonic';
import { FavoriteButton } from '../Shared/FavoriteButton';
import type { SetInfo } from '../../types';

export interface MiniPlayerProps {
  set?: SetInfo | null;
  isPlaying?: boolean;
  onPlayPause?: () => void;
  onOpenFullscreen?: () => void;
}

export function MiniPlayerBar({
  set: propSet,
  isPlaying: propIsPlaying,
  onPlayPause,
  onOpenFullscreen,
}: MiniPlayerProps = {}) {
  const storeSet = usePlayerStore((state) => state.currentSet);
  const storeIsPlaying = usePlayerStore((state) => state.isPlaying);
  const status = usePlayerStore((state) => state.status);
  const isFullscreen = usePlayerStore((state) => state.isFullscreen);
  const togglePlayStore = usePlayerStore((state) => state.togglePlay);
  const setFullscreenStore = usePlayerStore((state) => state.setFullscreen);

  const set = propSet !== undefined ? propSet : storeSet;
  const isPlaying = propIsPlaying !== undefined ? propIsPlaying : storeIsPlaying;
  const isLoading = status === 'loading';

  const progressRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let rafId: number;
    const update = () => {
      if (AudioEngine && progressRef.current) {
        const ct = AudioEngine.getCurrentTime();
        const dur = AudioEngine.getDuration();
        if (dur > 0) {
          progressRef.current.style.width = `${Math.min(100, Math.max(0, (ct / dur) * 100))}%`;
        } else {
          progressRef.current.style.width = '0%';
        }
      }
      rafId = requestAnimationFrame(update);
    };
    rafId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(rafId);
  }, []);

  if (isFullscreen) {
    return null;
  }

  const handleOpenFullscreen = () => {
    if (onOpenFullscreen) {
      onOpenFullscreen();
    } else {
      setFullscreenStore(true);
    }
  };

  const handlePlayPause = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (onPlayPause) {
      onPlayPause();
    } else {
      togglePlayStore();
    }
  };

  const title = set?.title || 'Beatmonkey Crystal';
  const artist = set?.artist || (set ? 'Onbekende artiest' : 'Geen track geladen');
  const coverSrc = set?.coverArt
    ? set.coverArt.startsWith('http://') || set.coverArt.startsWith('https://') || set.coverArt.startsWith('/')
      ? set.coverArt
      : getCoverUrl(set.coverArt, 100)
    : null;

  return (
    <section
      className="relative w-full h-15 bg-[var(--color-crystal-card)]/95 backdrop-blur-md border-t border-[var(--color-crystal-border)] flex items-center px-4 gap-3 cursor-pointer select-none transition-colors hover:bg-[var(--color-crystal-card)] z-20"
      aria-label={`Mini-player: ${title} - ${artist}`}
    >
      {/* Native open action sits behind, not around, the other controls. */}
      <button
        type="button"
        onClick={handleOpenFullscreen}
        aria-label={`Open speler: ${title} - ${artist}`}
        className="absolute inset-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-[var(--color-crystal-cyan)]"
      />
      {/* Mini Progress Bar (direct DOM manipulation via rAF) */}
      <div className="absolute top-0 left-0 right-0 h-[2px] bg-white/10 overflow-hidden pointer-events-none">
        <div
          ref={progressRef}
          className="h-full bg-[var(--color-crystal-cyan)] w-0 transition-none"
        />
      </div>

      {/* Cover Thumbnail (40x40) */}
      <div className="relative pointer-events-none w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-[var(--color-crystal-surface)] border border-[var(--color-crystal-border)] flex items-center justify-center">
        {coverSrc ? (
          <img
            src={coverSrc}
            alt={title}
            className="w-full h-full object-cover"
            loading="lazy"
            onError={(e) => {
              (e.currentTarget as HTMLElement).style.display = 'none';
            }}
          />
        ) : (
          <Disc3 className={`w-5 h-5 text-[var(--color-crystal-cyan)] ${isPlaying ? 'animate-spin' : ''}`} />
        )}
      </div>

      {/* Track info (1 line, truncated) */}
      <div className="relative pointer-events-none flex-1 min-w-0 flex flex-col justify-center">
        <p className="text-sm font-semibold text-white truncate leading-tight">
          {title}
        </p>
        <p className="text-xs text-gray-400 truncate leading-tight mt-0.5">
          {artist}
        </p>
      </div>

      {/* Actions: Favorite + Play/Pause */}
      <div className="relative flex items-center gap-1 flex-shrink-0">
        {set?.id && <FavoriteButton setId={set.id} />}
        <button
          type="button"
          onClick={handlePlayPause}
          className="w-10 h-10 rounded-full flex items-center justify-center text-white hover:text-[var(--color-crystal-cyan)] active:scale-95 transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-crystal-cyan)]"
          aria-label={isPlaying ? 'Pauzeer' : 'Afspelen'}
        >
          {isLoading ? (
            <Loader2 className="w-5 h-5 animate-spin text-[var(--color-crystal-cyan)]" />
          ) : isPlaying ? (
            <Pause className="w-5 h-5 fill-current" />
          ) : (
            <Play className="w-5 h-5 fill-current translate-x-0.5" />
          )}
        </button>
      </div>
    </section>
  );
}

export default MiniPlayerBar;
