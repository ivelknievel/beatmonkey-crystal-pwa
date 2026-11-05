import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ListPlus, Disc3, Sparkles, Share2 } from 'lucide-react';
import { usePlayerStore } from '../../stores/playerStore';
import { getCoverUrl } from '../../services/subsonic';
import { FavoriteButton } from '../Shared/FavoriteButton';
import { Scrubber } from './Scrubber';
import { PlaybackControls } from './PlaybackControls';
import { TracklistSection } from './TracklistSection';
import { QueueSheet } from './QueueSheet';
import { Visualizer } from './Visualizer';
import { AudioEngine } from '../../engine/AudioEngine';

export function FullscreenPlayerOverlay() {
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);

  const currentSet = usePlayerStore((s) => s.currentSet);
  const setFullscreen = usePlayerStore((s) => s.setFullscreen);
  const queue = usePlayerStore((s) => s.queue);
  const status = usePlayerStore((s) => s.status);

  // Trigger slide-up on mount
  useEffect(() => {
    // Micro-delay so initial translateY(100%) renders before transitioning to translateY(0)
    const timer = requestAnimationFrame(() => {
      setIsMounted(true);
    });
    return () => cancelAnimationFrame(timer);
  }, []);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      setFullscreen(false);
    }, 300);
  }, [setFullscreen]);

  // Handle ESC key to close overlay
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isQueueOpen) {
          setIsQueueOpen(false);
        } else if (isShareDialogOpen) {
          setIsShareDialogOpen(false);
        } else {
          handleClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClose, isQueueOpen, isShareDialogOpen]);

  const title = currentSet?.title || 'Geen set geselecteerd';
  const artist = currentSet?.artist || 'Onbekende artiest';
  const festival = currentSet?.festival;
  const stage = currentSet?.stage;
  const year = currentSet?.year;

  const coverSrc = currentSet?.coverArt
    ? currentSet.coverArt.startsWith('http://') ||
      currentSet.coverArt.startsWith('https://') ||
      currentSet.coverArt.startsWith('/')
      ? currentSet.coverArt
      : getCoverUrl(currentSet.coverArt, 600)
    : null;

  const isVisible = isMounted && !isClosing;

  // Format time as mm:ss
  const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Share handler
  const handleShare = (fromCurrent: boolean) => {
    const currentTime = AudioEngine.getCurrentTime();
    const timeStr = formatTime(currentTime);
    const currentSecs = Math.floor(currentTime);
    const setId = currentSet?.id || '';
    const shareText = fromCurrent
      ? `Luister naar ${title} van ${artist} op Beatmonkey Crystal vanaf ${timeStr}!\n\nhttps://music.cyberspeeze.online/go/album/${setId}?t=${currentSecs}`
      : `Luister naar ${title} van ${artist} op Beatmonkey Crystal!\n\nhttps://music.cyberspeeze.online/go/album/${setId}`;

    if (navigator.share) {
      navigator.share({ title: 'Deel Liveset', text: shareText });
    } else {
      navigator.clipboard.writeText(shareText).then(() => {
        alert('📋 Link gekopieerd naar klembord!');
      });
    }
    setIsShareDialogOpen(false);
  };

  return (
    <div
      className={`fixed inset-0 z-50 bg-[#0a0a0f] text-white flex flex-col overflow-hidden transition-transform duration-300 ease-out safe-top safe-bottom ${
        isVisible ? 'translate-y-0' : 'translate-y-full'
      }`}
      role="dialog"
      aria-modal="true"
      aria-label="Volledig scherm speler"
    >
      {/* Blurred background backdrop */}
      {coverSrc && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden opacity-25 z-0">
          <img
            src={coverSrc}
            alt=""
            className="w-full h-full object-cover scale-125 blur-3xl"
          />
          <div className="absolute inset-0 bg-radial from-transparent via-[#0a0a0f]/80 to-[#0a0a0f]" />
        </div>
      )}

      {/* Share Dialog */}
      {isShareDialogOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setIsShareDialogOpen(false)}
        >
          <div
            className="bg-[#141C2E] rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl border border-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-bold text-[var(--color-crystal-cyan)] mb-1">Liveset Delen</h3>
            <p className="text-sm text-gray-300 mb-2">Kies hoe je deze liveset wilt delen:</p>
            <p className="text-xs text-gray-500 mb-4">
              Huidig tijdstip: {formatTime(AudioEngine.getCurrentTime())}
            </p>

            <button
              onClick={() => handleShare(true)}
              className="w-full py-3 px-4 rounded-xl bg-[var(--color-crystal-cyan)] text-[#0F172A] font-bold text-sm mb-3 hover:opacity-90 transition-opacity cursor-pointer"
            >
              Vanaf dit moment ({formatTime(AudioEngine.getCurrentTime())})
            </button>

            <button
              onClick={() => handleShare(false)}
              className="w-full py-3 px-4 rounded-xl border border-gray-500 text-white font-semibold text-sm mb-4 hover:bg-white/5 transition-colors cursor-pointer"
            >
              Vanaf het begin
            </button>

            <button
              onClick={() => setIsShareDialogOpen(false)}
              className="w-full text-center text-gray-500 text-sm hover:text-gray-300 transition-colors cursor-pointer"
            >
              Annuleren
            </button>
          </div>
        </div>
      )}

      {/* Main scrollable/flex column */}
      <div className="relative z-10 flex flex-col h-full overflow-y-auto scrollbar-none pb-6">
        {/* <Header> */}
        <header className="flex items-center justify-between px-6 py-4 flex-shrink-0">
          <button
            type="button"
            onClick={handleClose}
            className="w-10 h-10 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-gray-300 hover:text-white transition-colors cursor-pointer"
            aria-label="Sluit overlay"
          >
            <ChevronDown size={24} />
          </button>

          <div className="text-center">
            <span className="text-xs font-semibold tracking-wider uppercase text-[var(--color-crystal-cyan)] flex items-center justify-center gap-1">
              <Sparkles size={12} />
              Nu Aan Het Afspelen
            </span>
          </div>

          <div className="flex items-center gap-1">
            {/* Share button */}
            <button
              type="button"
              onClick={() => setIsShareDialogOpen(true)}
              className="w-10 h-10 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-gray-300 hover:text-[var(--color-crystal-cyan)] transition-colors cursor-pointer"
              aria-label="Deel liveset"
            >
              <Share2 size={20} />
            </button>
            {currentSet?.id && <FavoriteButton setId={currentSet.id} />}
            <button
              type="button"
              onClick={() => setIsQueueOpen(true)}
              className="w-10 h-10 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-gray-300 hover:text-[var(--color-crystal-cyan)] transition-colors relative cursor-pointer"
              aria-label="Open wachtrij"
            >
              <ListPlus size={20} />
              {queue.length > 0 && (
                <span className="absolute -top-1 -right-1 bg-[var(--color-crystal-cyan)] text-black text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center shadow">
                  {queue.length}
                </span>
              )}
            </button>
          </div>
        </header>

        {/* <ArtworkStage> */}
        <div className="flex-1 flex flex-col items-center justify-center px-6 my-auto min-h-[260px] max-h-[360px]">
          <div className="relative group">
            {/* Glow behind artwork */}
            <div className="absolute -inset-1 bg-gradient-to-r from-[var(--color-crystal-cyan)] to-[var(--color-crystal-pink)] rounded-3xl blur-xl opacity-30 group-hover:opacity-50 transition duration-500" />

            <div className="relative w-64 h-64 sm:w-72 sm:h-72 max-w-[70vw] max-h-[70vw] aspect-square rounded-2xl overflow-hidden bg-[var(--color-crystal-surface)] border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.8)] flex items-center justify-center">
              {coverSrc ? (
                <img
                  src={coverSrc}
                  alt={title}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    (e.currentTarget as HTMLElement).style.display = 'none';
                  }}
                />
              ) : (
                <Disc3 className="w-24 h-24 text-[var(--color-crystal-cyan)]/40 animate-pulse" />
              )}
            </div>
          </div>
        </div>

        {/* <Metadata> */}
        <div className="px-6 text-center mt-4 mb-2 max-w-lg mx-auto w-full">
          <div className="flex items-center justify-center gap-3">
            <h2 className="text-xl sm:text-2xl font-bold text-white truncate leading-tight">
              {title}
            </h2>
            {currentSet?.id && (
              <FavoriteButton setId={currentSet.id} />
            )}
          </div>

          <div className="mt-1 flex items-center justify-center gap-2 flex-wrap">
            <span className="text-sm sm:text-base font-medium text-gray-300 hover:text-[var(--color-crystal-cyan)] transition-colors">
              {artist}
            </span>
          </div>

          {/* Festival / Stage / Year Badges */}
          {(festival || stage || year) && (
            <div className="mt-2.5 flex items-center justify-center gap-2 flex-wrap">
              {festival && (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[var(--color-crystal-cyan)]/15 text-[var(--color-crystal-cyan)] border border-[var(--color-crystal-cyan)]/30">
                  {festival}
                </span>
              )}
              {stage && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs text-gray-400 bg-white/5 border border-white/10">
                  {stage}
                </span>
              )}
              {year && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs text-gray-400 bg-white/5 border border-white/10 font-mono">
                  {year}
                </span>
              )}
            </div>
          )}
        </div>

        {/* <Visualizer> */}
        <div className="px-6 my-2 max-w-lg mx-auto w-full flex justify-center">
          <Visualizer engine={AudioEngine} isPlaying={status === 'playing'} />
        </div>

        {/* <Scrubber> */}
        <div className="mt-2">
          <Scrubber />
        </div>

        {/* <Controls> */}
        <PlaybackControls />

        {/* <TracklistSection> */}
        <TracklistSection />
      </div>

      {/* <QueueSheet> */}
      <QueueSheet
        isOpen={isQueueOpen}
        onClose={() => setIsQueueOpen(false)}
      />
    </div>
  );
}

export default FullscreenPlayerOverlay;