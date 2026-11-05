import { useState, useRef, useCallback } from 'react';
import { Music2, Share2, ChevronRight } from 'lucide-react';
import type { TrackCue } from '../../types';
import { formatTime } from '../../utils/format';
import { EqualizerIndicator } from './EqualizerIndicator';

export interface TrackRowProps {
  track: TrackCue;
  isActive: boolean;
  onSeek: () => void;
  onShare?: () => void;
  onSpotifySearch?: () => void;
  trackNumber: number;
  playProgress?: number;
}

export function TrackRow({
  track,
  isActive,
  onSeek,
  onShare,
  onSpotifySearch,
  trackNumber,
  playProgress = 0,
}: TrackRowProps) {
  const [swipeOffset, setSwipeOffset] = useState(0);
  const touchStartX = useRef(0);
  const isDragging = useRef(false);
  const SWIPE_THRESHOLD = 80;

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    isDragging.current = true;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging.current) return;
    const diff = e.touches[0].clientX - touchStartX.current;
    setSwipeOffset(Math.max(-150, Math.min(150, diff)));
  }, []);

  const handleTouchEnd = useCallback(() => {
    isDragging.current = false;
    if (swipeOffset < -SWIPE_THRESHOLD && onShare) {
      onShare();
    } else if (swipeOffset > SWIPE_THRESHOLD && onSpotifySearch) {
      onSpotifySearch();
    }
    setSwipeOffset(0);
  }, [swipeOffset, onShare, onSpotifySearch]);

  return (
    <div className="relative overflow-hidden rounded-lg select-none">
      <div
        className="absolute inset-0 bg-gradient-to-r from-transparent via-cyan-500/40 to-purple-500/85 rounded-lg flex items-center justify-end pr-6 transition-opacity duration-200"
        style={{ opacity: swipeOffset < 0 ? Math.min(Math.abs(swipeOffset) / SWIPE_THRESHOLD, 1) : 0 }}
      >
        <Share2 size={20} className="text-white" />
      </div>
      <div
        className="absolute inset-0 bg-gradient-to-r from-indigo-500/85 via-purple-500/40 to-transparent rounded-lg flex items-center pl-6 transition-opacity duration-200"
        style={{ opacity: swipeOffset > 0 ? Math.min(swipeOffset / SWIPE_THRESHOLD, 1) : 0 }}
      >
        <Music2 size={20} className="text-white" />
      </div>

      <div
        onClick={onSeek}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSeek(); }
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className={`relative flex items-center gap-2 py-2 px-3 rounded-lg cursor-pointer transition-[transform,colors] duration-200 select-none ${
          isActive
            ? 'bg-[#132036] border border-[var(--color-crystal-cyan)]'
            : 'bg-[#0F172A] border border-white/5 hover:bg-[#0F172A]/80'
        }`}
        style={{
          transform: `translateX(${swipeOffset}px)`,
          transition: isDragging.current ? 'none' : 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
        }}
      >
        <div
          className={`w-[34px] h-[34px] rounded-lg flex items-center justify-center flex-shrink-0 ${
            isActive
              ? 'bg-gradient-to-br from-[var(--color-crystal-cyan)] to-[#FF4081]'
              : 'bg-white/5'
          }`}
        >
          <span className={`text-xs font-black ${isActive ? 'text-[#0F172A]' : 'text-white'}`}>
            {trackNumber}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <p className={`text-sm truncate leading-snug ${isActive ? 'font-bold text-white' : 'font-medium text-gray-200'}`}>
            {track.title}
          </p>
          {track.artist && (
            <p className={`text-xs truncate leading-snug ${isActive ? 'text-[var(--color-crystal-cyan)]' : 'text-gray-400'}`}>
              {track.artist}
            </p>
          )}
        </div>

        {isActive && (
          <>
            <EqualizerIndicator color="#FF4081" />
            <div className="px-1 py-0.5 rounded-md bg-[#FF4081]/20 border border-[#FF4081]/50 flex-shrink-0">
              <span className="text-[9px] font-black text-[#FF4081]">LIVE</span>
            </div>
          </>
        )}

        <div
          className={`px-1.5 py-1 rounded-md flex-shrink-0 ${
            isActive
              ? 'bg-[var(--color-crystal-cyan)]/15 border border-[var(--color-crystal-cyan)]/50'
              : 'bg-white/5 border border-white/10'
          }`}
        >
          <span className={`text-[11px] font-mono font-bold ${isActive ? 'text-[var(--color-crystal-cyan)]' : 'text-gray-400'}`}>
            {formatTime(track.timeSec)}
          </span>
        </div>

        {track.spotifyUri && (
          <a href={track.spotifyUri} target="_blank" rel="noopener noreferrer"
            className="text-emerald-400 hover:text-emerald-300 p-1 rounded hover:bg-white/5 transition-colors flex-shrink-0"
            onClick={(e) => e.stopPropagation()}
            aria-label={`Open ${track.title} on Spotify`}
          >
            <Music2 size={15} />
          </a>
        )}

        {!track.spotifyUri && (
          <ChevronRight size={14} className="text-gray-600 flex-shrink-0" />
        )}
      </div>

      {/* Progress bar */}
      {isActive && playProgress > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-white/10 rounded-b-lg overflow-hidden">
          <div
            className="h-full rounded-r-full transition-all duration-300 ease-linear"
            style={{
              width: `${Math.min(100, playProgress * 100)}%`,
              background: 'linear-gradient(90deg, #00E5FF, #FF4081)',
            }}
          />
        </div>
      )}
    </div>
  );
}

export default TrackRow;