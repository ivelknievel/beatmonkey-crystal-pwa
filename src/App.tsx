import { usePlayerStore } from './stores/playerStore';

export default function App() {
  const { status, currentSet, isPlaying, togglePlay } = usePlayerStore();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--color-crystal-bg)] text-[#e0e0e0] p-4">
      <div className="w-full max-w-md rounded-2xl bg-[var(--color-crystal-card)] p-6 shadow-2xl border border-[var(--color-crystal-border)]">
        <h1 className="text-2xl font-bold text-center mb-2 bg-gradient-to-r from-[var(--color-crystal-cyan)] to-[var(--color-crystal-pink)] bg-clip-text text-transparent">
          Beatmonkey Crystal PWA
        </h1>
        <p className="text-sm text-center text-gray-400 mb-6">
          Sprint 1 Core Engine & Store Initialized
        </p>

        <div className="space-y-3 text-xs bg-[var(--color-crystal-surface)] p-4 rounded-xl border border-[var(--color-crystal-border)]">
          <div className="flex justify-between">
            <span className="text-gray-400">Player Status:</span>
            <span className="font-mono text-[var(--color-crystal-cyan)] uppercase">{status}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Is Playing:</span>
            <span className="font-mono text-gray-200">{isPlaying ? 'Yes' : 'No'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Current Set:</span>
            <span className="font-mono text-gray-200">{currentSet?.title || 'None'}</span>
          </div>
        </div>

        <div className="mt-6 flex justify-center">
          <button
            onClick={togglePlay}
            className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-[var(--color-crystal-cyan)] to-[#0099cc] text-black font-semibold text-sm hover:opacity-90 transition-opacity"
          >
            {isPlaying ? 'Pauzeer' : 'Afspelen'}
          </button>
        </div>
      </div>
    </div>
  );
}
