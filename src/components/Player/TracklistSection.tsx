import { useEffect, useState, useRef } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { getTracklist } from '../../services/discoveryApi';
import { TrackRow } from './TrackRow';
import type { TrackCue } from '../../types';
import { ListMusic, ChevronDown, Loader2, AlertCircle } from 'lucide-react';
import { AudioEngine } from '../../engine/AudioEngine';

export function TracklistSection() {
  const [isOpen, setIsOpen] = useState(false);
  const [tracklist, setTracklist] = useState<TrackCue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const currentSetId = usePlayerStore(s => s.currentSetId);
  const activeCueIndex = usePlayerStore(s => s.activeCueIndex);
  
  // Fetch tracklist when set changes
  useEffect(() => {
    if (!currentSetId) return;
    setLoading(true);
    setError(null);
    
    // Try cache first, then API
    getTracklist(currentSetId)
      .then(data => {
        const list = data || [];
        setTracklist(list);
        usePlayerStore.getState().setTracklistForSet(currentSetId, list);
        setLoading(false);
      })
      .catch(() => {
        setError('Tracklist niet beschikbaar');
        setLoading(false);
      });
  }, [currentSetId]);
  
  // Auto-scroll naar actieve track
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isOpen && activeCueIndex >= 0 && listRef.current) {
      const activeEl = listRef.current.children[activeCueIndex] as HTMLElement;
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }, [activeCueIndex, isOpen]);
  
  return (
    <div className="mt-6 px-6">
      <button onClick={() => setIsOpen(!isOpen)} className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors cursor-pointer">
        <ListMusic size={16} />
        Tracklist {tracklist.length > 0 && `(${tracklist.length})`}
        <ChevronDown size={14} className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      
      {loading && (
        <div className="flex items-center gap-2 mt-3 text-sm text-gray-500">
          <Loader2 size={14} className="animate-spin" /> Tracklist laden...
        </div>
      )}
      
      {error && (
        <div className="flex items-center gap-2 mt-3 text-sm text-yellow-500">
          <AlertCircle size={14} /> {error}
        </div>
      )}
      
      {isOpen && !loading && tracklist.length > 0 && (
        <div ref={listRef} className="mt-3 space-y-0.5 max-h-60 overflow-y-auto">
          {tracklist.map((track, i) => (
            <TrackRow
              key={i}
              track={track}
              isActive={i === activeCueIndex}
              onSeek={() => {
                AudioEngine.seek(track.timeSec);
                usePlayerStore.getState().setActiveCueIndex(i);
              }}
            />
          ))}
        </div>
      )}
      
      {isOpen && !loading && tracklist.length === 0 && !error && (
        <div className="text-center py-8 text-gray-500">
          <p className="text-sm">Geen tracklist beschikbaar voor deze set</p>
        </div>
      )}
    </div>
  );
}

export default TracklistSection;
