import { X, Trash2, Disc3 } from 'lucide-react';
import { usePlayerStore } from '../../stores/playerStore';
import { getCoverUrl } from '../../services/subsonic';

export interface QueueSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

export function QueueSheet({ isOpen, onClose }: QueueSheetProps) {
  const queue = usePlayerStore((s) => s.queue);
  const queueIndex = usePlayerStore((s) => s.queueIndex);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);
  const clearQueue = usePlayerStore((s) => s.clearQueue);
  const loadSet = usePlayerStore((s) => s.loadSet);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center animate-in fade-in duration-200"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-xs" />

      {/* Sheet */}
      <div
        className="relative w-full max-w-xl bg-[var(--color-crystal-card)] border-t border-[var(--color-crystal-border)] rounded-t-3xl p-5 max-h-[70vh] flex flex-col shadow-2xl z-10 animate-in slide-in-from-bottom duration-300"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag pill handle */}
        <div className="w-12 h-1 bg-gray-600 rounded-full mx-auto mb-4 cursor-pointer" onClick={onClose} />

        {/* Sheet Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-white">Afspeelwachtrij</h3>
            <span className="text-xs text-gray-400">({queue.length})</span>
          </div>

          <div className="flex items-center gap-3">
            {queue.length > 0 && (
              <button
                type="button"
                onClick={clearQueue}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-red-400 px-2 py-1 rounded transition-colors cursor-pointer"
                title="Wachtrij leegmaken"
              >
                <Trash2 size={13} />
                <span>Wissen</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-white p-1 rounded-full hover:bg-white/5 transition-colors cursor-pointer"
              aria-label="Sluit wachtrij"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Queue Items List */}
        <div className="flex-1 overflow-y-auto space-y-1.5 scrollbar-none pr-1">
          {queue.length === 0 ? (
            <div className="py-12 text-center text-gray-500">
              <Disc3 className="w-12 h-12 mx-auto mb-3 opacity-30 text-[var(--color-crystal-cyan)]" />
              <p className="text-sm">Geen sets in de wachtrij</p>
              <p className="text-xs text-gray-600 mt-1">Voeg sets toe via de bibliotheek of ontdekpagina</p>
            </div>
          ) : (
            queue.map((set, i) => {
              const isCurrent = i === queueIndex;
              const coverSrc = set.coverArt
                ? set.coverArt.startsWith('http://') || set.coverArt.startsWith('https://') || set.coverArt.startsWith('/')
                  ? set.coverArt
                  : getCoverUrl(set.coverArt, 100)
                : null;

              return (
                <div
                  key={`${set.id}-${i}`}
                  onClick={() => loadSet(set)}
                  className={`flex items-center gap-3 py-2 px-3 rounded-xl cursor-pointer transition-colors group ${
                    isCurrent
                      ? 'bg-[var(--color-crystal-cyan)]/15 border border-[var(--color-crystal-cyan)]/30'
                      : 'hover:bg-[var(--color-crystal-surface)] text-gray-300 hover:text-white'
                  }`}
                >
                  <span
                    className={`text-xs font-mono w-5 text-center flex-shrink-0 ${
                      isCurrent ? 'text-[var(--color-crystal-cyan)] font-bold' : 'text-gray-500'
                    }`}
                  >
                    {i + 1}
                  </span>

                  <div className="w-10 h-10 rounded-lg overflow-hidden bg-[var(--color-crystal-surface)] flex-shrink-0 flex items-center justify-center border border-white/5">
                    {coverSrc ? (
                      <img
                        src={coverSrc}
                        alt={set.title}
                        className="w-full h-full object-cover"
                        loading="lazy"
                        onError={(e) => {
                          (e.currentTarget as HTMLElement).style.display = 'none';
                        }}
                      />
                    ) : (
                      <Disc3 className="w-5 h-5 text-gray-600" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p
                      className={`text-sm truncate leading-snug ${
                        isCurrent ? 'text-[var(--color-crystal-cyan)] font-semibold' : 'text-white'
                      }`}
                    >
                      {set.title}
                    </p>
                    <p className="text-xs text-gray-400 truncate leading-snug">
                      {set.artist}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFromQueue(i);
                    }}
                    className="text-gray-500 hover:text-red-400 p-1.5 rounded hover:bg-white/5 transition-colors opacity-60 group-hover:opacity-100 cursor-pointer flex-shrink-0"
                    aria-label={`Verwijder ${set.title} uit wachtrij`}
                  >
                    <X size={16} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export default QueueSheet;
