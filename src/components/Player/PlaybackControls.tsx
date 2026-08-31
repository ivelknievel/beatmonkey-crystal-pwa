import { Play, Pause, RotateCcw, RotateCw, SkipBack, SkipForward, Loader2 } from 'lucide-react';
import { usePlayerStore } from '../../stores/playerStore';
import { AudioEngine } from '../../engine/AudioEngine';

export function PlaybackControls() {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const status = usePlayerStore((s) => s.status);
  const queue = usePlayerStore((s) => s.queue);
  const queueIndex = usePlayerStore((s) => s.queueIndex);
  const nextTrack = usePlayerStore((s) => s.nextTrack);
  const prevTrack = usePlayerStore((s) => s.prevTrack);

  const isLoading = status === 'loading';
  const hasPrev = queueIndex > 0;
  const hasNext = queueIndex >= 0 && queueIndex < queue.length - 1;

  return (
    <div className="flex items-center justify-center gap-6 sm:gap-8 mt-6 select-none">
      {/* Previous Track in Queue */}
      <button
        type="button"
        onClick={prevTrack}
        disabled={!hasPrev}
        className={`p-2 rounded-full transition-all ${
          hasPrev
            ? 'text-gray-300 hover:text-white active:scale-95 cursor-pointer'
            : 'text-gray-600 cursor-not-allowed opacity-40'
        }`}
        aria-label="Vorig nummer"
      >
        <SkipBack size={22} />
      </button>

      {/* Skip back 15s */}
      <button
        type="button"
        onClick={() => AudioEngine.skipBack(15)}
        className="relative flex flex-col items-center justify-center text-gray-300 hover:text-[var(--color-crystal-cyan)] active:scale-95 transition-all cursor-pointer p-2"
        aria-label="15 seconden terugspoelen"
      >
        <RotateCcw size={28} />
        <span className="text-[10px] font-bold absolute -bottom-1">15</span>
      </button>

      {/* Play / Pause / Loading */}
      <button
        type="button"
        onClick={() => AudioEngine.togglePlay()}
        className="w-16 h-16 bg-[var(--color-crystal-cyan)] text-black rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(0,229,255,0.4)] hover:shadow-[0_0_35px_rgba(0,229,255,0.6)] hover:scale-105 active:scale-95 transition-all cursor-pointer focus:outline-none"
        aria-label={isPlaying ? 'Pauzeren' : 'Afspelen'}
      >
        {isLoading ? (
          <Loader2 size={32} className="text-black animate-spin" />
        ) : isPlaying ? (
          <Pause size={32} className="text-black fill-black" />
        ) : (
          <Play size={32} className="text-black fill-black ml-1" />
        )}
      </button>

      {/* Skip forward 15s */}
      <button
        type="button"
        onClick={() => AudioEngine.skipForward(15)}
        className="relative flex flex-col items-center justify-center text-gray-300 hover:text-[var(--color-crystal-cyan)] active:scale-95 transition-all cursor-pointer p-2"
        aria-label="15 seconden vooruitspoelen"
      >
        <RotateCw size={28} />
        <span className="text-[10px] font-bold absolute -bottom-1">15</span>
      </button>

      {/* Next Track in Queue */}
      <button
        type="button"
        onClick={nextTrack}
        disabled={!hasNext}
        className={`p-2 rounded-full transition-all ${
          hasNext
            ? 'text-gray-300 hover:text-white active:scale-95 cursor-pointer'
            : 'text-gray-600 cursor-not-allowed opacity-40'
        }`}
        aria-label="Volgend nummer"
      >
        <SkipForward size={22} />
      </button>
    </div>
  );
}

export default PlaybackControls;
