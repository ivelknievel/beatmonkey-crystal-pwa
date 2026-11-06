import { useEffect, useState, useRef, useCallback } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { getTracklist } from '../../services/discoveryApi';
import { TrackRow } from './TrackRow';
import { WaveCurveCanvas } from './WaveCurveCanvas';
import type { TrackCue } from '../../types';
import { ListMusic, ChevronDown, Loader2, AlertCircle, Music, RefreshCw, Plus, X, Play, Pause, Disc } from 'lucide-react';
import { AudioEngine } from '../../engine/AudioEngine';
import { formatTime } from '../../utils/format';
import { shareLink, composeShareText } from '../../utils/shareLinks';
import { authenticatedFetch } from '../../services/authService';

const BASE = 'https://music.cyberspeeze.online';

function normalizeTracks(data: any): TrackCue[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.tracks)) {
    return data.tracks.map((t: any) => ({
      position: t.position ?? t.effectivePosition,
      title: t.title ?? t.effectiveTitle ?? 'Unknown Title',
      artist: t.artist ?? t.effectiveArtist ?? '',
      timeSec: t.timeSec ?? t.effectiveTimestampSeconds ?? t.timestamp ?? 0,
      timestamp: t.timestamp ?? t.timeSec ?? t.effectiveTimestampSeconds ?? 0,
      displayTime: t.displayTime ?? t.effectiveTimestampDisplay,
      spotifyUri: t.spotifyUri,
      artworkUrl: t.artworkUrl ?? t.effectiveArtworkUrl,
      coverUrl: t.coverUrl,
      durationSec: t.durationSec ?? t.duration ?? undefined,
    }));
  }
  return [];
}

export interface TracklistSectionProps {
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTriggerButton?: boolean;
}

export function TracklistSection({
  isOpen: controlledIsOpen,
  onOpenChange,
  hideTriggerButton = false,
}: TracklistSectionProps = {}) {
  const [internalIsOpen, setInternalIsOpen] = useState(false);
  const isControlled = controlledIsOpen !== undefined;
  const isOpen = isControlled ? controlledIsOpen : internalIsOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!isControlled) {
        setInternalIsOpen(open);
      }
      onOpenChange?.(open);
    },
    [isControlled, onOpenChange]
  );

  const [tracklist, setTracklist] = useState<TrackCue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showManualDialog, setShowManualDialog] = useState(false);
  const [manualUrl, setManualUrl] = useState('');
  const [manualSubmitting, setManualSubmitting] = useState(false);

  const activeCueIndex = usePlayerStore(s => s.activeCueIndex);
  const currentTime = usePlayerStore(s => s.currentTime);
  const duration = usePlayerStore(s => s.duration);
  const currentSet = usePlayerStore(s => s.currentSet);
  const currentSetId = currentSet?.id; // Discovery expects the album identity, never the engine song id.
  const requestGeneration = useRef(0);
  const sheetRef = useRef<HTMLDivElement>(null);
  const manualRef = useRef<HTMLDivElement>(null);
  const [shareMessage, setShareMessage] = useState('');
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const status = usePlayerStore(s => s.status);
  const togglePlay = usePlayerStore(s => s.togglePlay);
  const setFullscreen = usePlayerStore(s => s.setFullscreen);

  const listRef = useRef<HTMLDivElement>(null);
  const miniPlayerProgressRef = useRef<HTMLDivElement | null>(null);

  // Update mini player progress bar
  useEffect(() => {
    if (!isOpen) return;
    let animId: number;
    const update = () => {
      if (miniPlayerProgressRef.current) {
        const cur = AudioEngine.getCurrentTime();
        const dur = AudioEngine.getDuration();
        if (dur > 0) {
          const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
          miniPlayerProgressRef.current.style.width = `${pct}%`;
        } else {
          miniPlayerProgressRef.current.style.width = '0%';
        }
      }
      animId = requestAnimationFrame(update);
    };

    animId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animId);
  }, [isOpen]);

  const fetchTracklist = useCallback(async () => {
    if (!currentSetId || !isOpen) return;
    const generation = ++requestGeneration.current;
    const isCurrent = () => generation === requestGeneration.current && usePlayerStore.getState().currentSet?.id === currentSetId;
    setLoading(true);
    setError(null);
    try {
      const data = await getTracklist(currentSetId);
      if (!isCurrent()) return;
      const list = normalizeTracks(data);
      setTracklist(list);
      usePlayerStore.getState().setTracklistForSet(currentSetId, list);
    } catch {
      if (isCurrent()) setError('Tracklist niet beschikbaar');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [currentSetId, isOpen]);

  useEffect(() => {
    setTracklist([]);
    setShowManualDialog(false);
    setManualSubmitting(false);
    setManualUrl('');
    void fetchTracklist();
    return () => { requestGeneration.current++; };
  }, [fetchTracklist]);

  useEffect(() => {
    if (!isOpen && !showManualDialog) return;
    const root = showManualDialog ? manualRef.current : sheetRef.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    const items = () => Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, [tabindex="0"]')).filter(el => el.getClientRects().length > 0);
    (items()[0] || root).focus();
    const keydown = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== root) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (showManualDialog) setShowManualDialog(false); else handleOpenChange(false);
      } else if (event.key === 'Tab') {
        const list = items(); const first = list[0], last = list[list.length - 1];
        if (!first) { event.preventDefault(); root.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); previous?.focus(); };
  }, [isOpen, showManualDialog, handleOpenChange]);

  // Auto-scroll naar actieve track (bij verandering van cue index)
  useEffect(() => {
    scrollToActiveTrack();
  }, [activeCueIndex]);

  // Scroll ook direct nadat tracklist geladen is (bij openen)
  useEffect(() => {
    if (isOpen && !loading && tracklist.length > 0 && activeCueIndex >= 0) {
      // Korte timeout zodat DOM is gerenderd
      const timer = setTimeout(() => scrollToActiveTrack(), 100);
      return () => clearTimeout(timer);
    }
  }, [isOpen, loading, tracklist.length]);

  function scrollToActiveTrack() {
    if (!listRef.current || activeCueIndex < 0) return;
    const children = listRef.current.children;
    if (children[activeCueIndex]) {
      (children[activeCueIndex] as HTMLElement).scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    }
  }

  const activeTrack = tracklist[activeCueIndex];
  const totalDurationSec = duration > 0 ? duration : 3600;

  const miniPlayerTitle = activeTrack?.title || currentSet?.title || 'Beatmonkey Crystal';
  const miniPlayerArtist = activeTrack?.artist || currentSet?.artist || 'Onbekende artiest';
  const miniPlayerCover = currentSet?.coverArt
    ? currentSet.coverArt.startsWith('http://') || currentSet.coverArt.startsWith('https://') || currentSet.coverArt.startsWith('/')
      ? currentSet.coverArt
      : `${BASE}/rest/getCoverArt.view?id=${encodeURIComponent(currentSet.coverArt)}&size=100`
    : null;

  // Check incomplete (< 25% timestamps > 0)
  const incompleteTracklist = tracklist.length > 0 &&
    tracklist.filter(t => t.timeSec > 0).length < (tracklist.length * 0.25);

  // ── Handmatige URL submit ──
  const handleManualSubmit = useCallback(async () => {
    const url = manualUrl.trim();
    if (!url || !currentSetId) return;
    const generation = ++requestGeneration.current;
    const isCurrent = () => generation === requestGeneration.current && usePlayerStore.getState().currentSet?.id === currentSetId;
    setManualSubmitting(true);
    try {
      const res = await authenticatedFetch(`${BASE}/api/tracklist/manual-map?tracklistUrl=${encodeURIComponent(url)}&albumName=${encodeURIComponent(currentSet?.title || '')}&artist=${encodeURIComponent(currentSet?.artist || '')}`, {
        method: 'POST',
      });
      if (!isCurrent()) return;
      if (res.ok) {
        // Re-fetch tracklist
        setLoading(true);
        setError(null);
        const data = await getTracklist(currentSetId);
        if (!isCurrent()) return;
        const list = normalizeTracks(data);
        setTracklist(list);
        usePlayerStore.getState().setTracklistForSet(currentSetId, list);
        setLoading(false);
      }
    } catch (e) {
      console.error('Manual map failed', e);
    }
    if (!isCurrent()) return;
    setLoading(false);
    setManualSubmitting(false);
    setShowManualDialog(false);
    setManualUrl('');
  }, [manualUrl, currentSetId, currentSet]);

  // ── Share track ──
  const handleShare = useCallback(async (track: TrackCue) => {
    if (!currentSet) return;
    try {
      const text = composeShareText({
        set: currentSet,
        seconds: track.timeSec,
        cue: track,
      });
      const result = await shareLink({ title: 'Deel Track', text });
      setShareMessage(result === 'copied' ? 'Link gekopieerd.' : '');
    } catch { setShareMessage('Delen is niet gelukt. Probeer opnieuw.'); }
  }, [currentSet]);

  // ── Spotify search ──
  const handleSpotifySearch = useCallback((track: TrackCue) => {
    const cleanTitle = track.title.replace(/\[.*?\]/g, '').trim();
    const cleanArtist = (track.artist || '').replace(/\[.*?\]/g, '').trim();
    const query = cleanArtist && cleanTitle ? `${cleanArtist} ${cleanTitle}` : (cleanTitle || cleanArtist);
    if (!query) return;
    window.open(`https://open.spotify.com/search/${encodeURIComponent(query)}`, '_blank');
  }, []);

  return (
    <>
      {/* ── Toggle button ── */}
      {!hideTriggerButton && (
        <button
          onClick={() => handleOpenChange(!isOpen)}
          className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors cursor-pointer"
        >
          <ListMusic size={16} />
          Tracklist {tracklist.length > 0 && `(${tracklist.length})`}
          <ChevronDown size={14} className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
        </button>
      )}

      {/* ── Modal Overlay ── */}
      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Scrim */}
          <div
            className="absolute inset-0 bg-black/65 transition-opacity"
            onClick={() => handleOpenChange(false)}
          />

          {/* Sheet */}
          <div
            ref={sheetRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="Tracklist"
            className="safe-sheet relative w-full max-h-[88dvh] rounded-t-[28px] overflow-hidden animate-slide-up flex flex-col"
            style={{ backgroundColor: 'rgba(12, 18, 30, 0.98)' }}
          >
            {/* Neon glow achtergronden */}
            <div className="absolute top-[-40px] right-[-60px] w-[260px] h-[260px] rounded-full pointer-events-none"
              style={{
                background: 'rgba(0, 229, 255, 0.18)',
                filter: 'blur(90px)',
              }}
            />
            <div className="absolute bottom-[40px] left-[-60px] w-[240px] h-[240px] rounded-full pointer-events-none"
              style={{
                background: 'rgba(255, 64, 129, 0.15)',
                filter: 'blur(90px)',
              }}
            />

            {/* Drag handle */}
            <div className="flex justify-center pt-[10px] pb-1 shrink-0">
              <div className="w-[42px] h-1 rounded-full bg-white/30" />
            </div>

            <div className="relative px-4 pb-4 overflow-y-auto flex-1 min-h-0">
              {/* ── HEADER ── */}
              <div className="flex items-start justify-between mb-2">
                <div className="flex-1 min-w-0 pr-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-lg font-bold text-white" style={{ letterSpacing: '0.5px' }}>
                      Tracklist Ticker
                    </h2>
                    <span
                      className="text-[10px] font-black px-1.5 py-0.5 rounded-md"
                      style={{
                        color: '#00E5FF',
                        backgroundColor: 'rgba(0, 229, 255, 0.15)',
                        border: '1px solid rgba(0, 229, 255, 0.4)',
                      }}
                    >
                      1001TL
                    </span>
                    <button
                      onClick={() => setShowManualDialog(true)}
                      className="p-1 rounded hover:bg-white/10 transition-colors"
                      title="Tracklist toevoegen"
                    >
                      <Plus size={18} style={{ color: '#00BCD4' }} />
                    </button>
                  </div>
                  <p className="text-xs text-gray-400 truncate mt-0.5">
                    {tracklist.length > 0
                      ? `${tracklist.length} tracks • ${currentSet?.title || currentSet?.artist || 'Live Set'}`
                      : loading
                        ? 'Tracklist ophalen...'
                        : currentSet?.title || 'Liveset'
                    }
                  </p>
                </div>

                <button
                  onClick={() => handleOpenChange(false)}
                  aria-label="Sluit tracklist"
                  className="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center bg-white/8 hover:bg-white/15 transition-colors cursor-pointer"
                >
                  <X size={18} className="text-white" />
                </button>
              </div>

              {shareMessage && <p role="status">{shareMessage}</p>}
              {/* ── CONTENT ── */}
              {loading && (
                <div className="flex flex-col items-center justify-center py-12">
                  <Loader2 size={36} className="animate-spin" style={{ color: '#00E5FF' }} />
                  <p className="mt-4 text-sm font-semibold text-white text-center">
                    Tracklist ophalen van 1001Tracklists...
                  </p>
                  <p className="mt-1 text-xs text-gray-500 text-center">
                    FlareSolverr proxy zoekt cue-punten en timestamps
                  </p>
                </div>
              )}

              {!loading && tracklist.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12">
                  <div className="w-16 h-16 rounded-full bg-white/6 flex items-center justify-center">
                    <Music size={32} style={{ color: '#FF4081' }} />
                  </div>
                  <p className="mt-4 text-base font-bold text-white text-center">
                    {error || 'Geen tracklist beschikbaar'}
                  </p>
                  <p className="mt-1 text-xs text-gray-500 text-center">
                    Voor deze liveset zijn nog geen cue-punten gevonden op 1001Tracklists.
                  </p>
                  <div className="mt-5 flex gap-2">
                    <button
                      onClick={() => { void fetchTracklist(); }}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold"
                      style={{ backgroundColor: '#00E5FF', color: '#0F172A' }}
                    >
                      <RefreshCw size={14} />
                      Opnieuw proberen
                    </button>
                    <button
                      onClick={() => setShowManualDialog(true)}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold border"
                      style={{ borderColor: 'rgba(0, 229, 255, 0.6)', color: '#00E5FF' }}
                    >
                      <Plus size={14} />
                      URL invoeren
                    </button>
                  </div>
                </div>
              )}

              {!loading && tracklist.length > 0 && (
                <>
                  {/* Waveform Card */}
                  <div
                    className="w-full h-[105px] rounded-xl overflow-hidden mb-3 shadow-lg"
                    style={{
                      boxShadow: '0 12px 24px rgba(0, 229, 255, 0.3)',
                      border: '1px solid rgba(0, 229, 255, 0.3)',
                      backgroundColor: '#0F172A',
                    }}
                  >
                    <div className="relative w-full h-full">
                      <WaveCurveCanvas
                        tracklist={tracklist}
                        activeTrackIndex={activeCueIndex}
                        currentTimeSec={currentTime}
                        totalDurationSec={totalDurationSec}
                        onSeek={(t) => AudioEngine.seek(t)}
                        className="w-full h-full"
                      />

                      {/* Info overlay */}
                      <div className="absolute top-0 left-0 right-0 flex justify-between items-start p-2 pointer-events-none">
                        <div className="flex-1 min-w-0 mr-2">
                          <p className="text-[9px] font-black tracking-wider" style={{ color: '#00E5FF' }}>
                            SET WAVE PROGRESSION
                          </p>
                          <p className="text-xs font-bold text-white truncate">
                            {activeTrack
                              ? `Track ${activeCueIndex + 1}/${tracklist.length} • ${activeTrack.title}`
                              : `${tracklist.length} tracks`
                            }
                          </p>
                        </div>
                        <div
                          className="px-1.5 py-0.5 rounded-lg"
                          style={{
                            backgroundColor: 'rgba(0, 0, 0, 0.45)',
                            border: '1px solid rgba(255, 64, 129, 0.5)',
                          }}
                        >
                          <span
                            className="text-[10px] font-bold font-mono"
                            style={{ color: '#FF4081' }}
                          >
                            {formatTime(currentTime)} / {formatTime(totalDurationSec)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Incomplete banner */}
                  {incompleteTracklist && (
                    <div className="flex items-start gap-2 p-3 mb-3 rounded-xl"
                      style={{
                        background: 'linear-gradient(135deg, rgba(26, 26, 46, 0.9), rgba(22, 33, 62, 0.9))',
                      }}
                    >
                      <AlertCircle size={16} className="flex-shrink-0 mt-0.5" style={{ color: '#F59E0B' }} />
                      <p className="text-xs leading-tight" style={{ color: '#FDE68A' }}>
                        Tracklist mogelijk onvolledig — tijden ontbreken voor sommige tracks
                      </p>
                    </div>
                  )}

                  {/* Track list */}
                  <div ref={listRef} className="space-y-1.5 pb-4">
                    {tracklist.map((track, i) => {
                      const isTrackActive = i === activeCueIndex;
                      let playProgress = 0;

                      if (isTrackActive) {
                        const currentTrackTime = track.timeSec ?? track.timestamp ?? 0;
                        let trackDuration = track.durationSec ?? 0;
                        if (trackDuration <= 0) {
                          if (i < tracklist.length - 1) {
                            const nextTrack = tracklist[i + 1];
                            const nextTrackTime = nextTrack.timeSec ?? nextTrack.timestamp ?? 0;
                            trackDuration = nextTrackTime - currentTrackTime;
                          } else {
                            trackDuration = totalDurationSec - currentTrackTime;
                          }
                        }

                        if (trackDuration > 0) {
                          playProgress = Math.max(0, Math.min(1, (currentTime - currentTrackTime) / trackDuration));
                        }
                      }

                      return (
                        <TrackRow
                          key={i}
                          track={track}
                          isActive={isTrackActive}
                          playProgress={playProgress}
                          trackNumber={i + 1}
                          onSeek={() => {
                            AudioEngine.seek(track.timeSec);
                            usePlayerStore.getState().setActiveCueIndex(i);
                          }}
                          onShare={() => handleShare(track)}
                          onSpotifySearch={() => handleSpotifySearch(track)}
                        />
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            {/* ── MiniPlayer Bar (Onderin Tracklist Overlay) ── */}
            {currentSet && (
              <div
                onClick={() => {
                  setFullscreen(true);
                  handleOpenChange(false);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    setFullscreen(true);
                    handleOpenChange(false);
                  }
                }}
                className="relative w-full h-15 bg-[var(--color-crystal-card)]/95 backdrop-blur-md border-t border-[var(--color-crystal-border)] flex items-center px-4 gap-3 cursor-pointer select-none transition-colors hover:bg-[var(--color-crystal-card)] z-20 shrink-0"
                aria-label={`Mini-player: ${miniPlayerTitle} - ${miniPlayerArtist}`}
              >
                {/* Top progress line */}
                <div className="absolute top-0 left-0 right-0 h-[2px] bg-white/10 overflow-hidden pointer-events-none">
                  <div ref={miniPlayerProgressRef} className="h-full bg-[var(--color-crystal-cyan)] w-0 transition-none" />
                </div>

                {/* Cover image */}
                <div className="relative w-10 h-10 rounded-lg overflow-hidden shrink-0 bg-[var(--color-crystal-surface)] border border-[var(--color-crystal-border)] flex items-center justify-center">
                  {miniPlayerCover ? (
                    <img src={miniPlayerCover} alt={miniPlayerTitle} className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <Disc className={`w-5 h-5 text-[var(--color-crystal-cyan)] ${isPlaying ? 'animate-spin' : ''}`} />
                  )}
                </div>

                {/* Title / Artist */}
                <div className="flex-1 min-w-0 flex flex-col justify-center">
                  <p className="text-sm font-semibold text-white truncate leading-tight">{miniPlayerTitle}</p>
                  <p className="text-xs text-gray-400 truncate leading-tight mt-0.5">{miniPlayerArtist}</p>
                </div>

                {/* Controls: Play/Pause & Tracklist */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePlay();
                    }}
                    className="w-10 h-10 rounded-full flex items-center justify-center text-white hover:text-[var(--color-crystal-cyan)] active:scale-95 transition-all focus:outline-none cursor-pointer"
                    aria-label={isPlaying ? 'Pauzeer' : 'Afspelen'}
                  >
                    {status === 'loading' ? (
                      <Loader2 className="w-5 h-5 animate-spin text-[var(--color-crystal-cyan)]" />
                    ) : isPlaying ? (
                      <Pause className="w-5 h-5 fill-current" />
                    ) : (
                      <Play className="w-5 h-5 fill-current translate-x-0.5" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleOpenChange(false);
                    }}
                    className="w-10 h-10 rounded-full flex items-center justify-center text-[var(--color-crystal-cyan)] hover:text-white active:scale-95 transition-all focus:outline-none cursor-pointer"
                    aria-label="Sluit tracklist"
                    title="Tracklist sluiten"
                  >
                    <ListMusic className="w-5 h-5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Manual URL Dialog ── */}
      {showManualDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => { setShowManualDialog(false); setManualUrl(''); }} />
          <div ref={manualRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Tracklist toevoegen" className="relative w-full max-w-sm rounded-xl p-5" style={{ backgroundColor: '#1E293B' }}>
            <h3 className="text-base font-bold text-white mb-1">Tracklist toevoegen</h3>
            <p className="text-xs text-gray-400 mb-3">Voer een 1001Tracklists URL of pad in voor deze set:</p>
            <input
              type="url"
              aria-label="1001Tracklists URL"
              value={manualUrl}
              onChange={(e) => setManualUrl(e.target.value)}
              placeholder="/tracklist/qz04ypk/..."
              className="w-full px-3 py-2 rounded-lg text-base text-white bg-transparent border outline-none transition-colors"
              style={{
                borderColor: manualUrl ? '#00E5FF' : 'rgba(255,255,255,0.3)',
              }}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleManualSubmit(); }}
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => { setShowManualDialog(false); setManualUrl(''); }}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
              >
                Annuleren
              </button>
              <button
                onClick={handleManualSubmit}
                disabled={!manualUrl.trim() || manualSubmitting}
                className="px-4 py-2 text-sm font-bold rounded-lg transition-colors disabled:opacity-50"
                style={{
                  backgroundColor: manualUrl.trim() ? '#00E5FF' : 'rgba(255,255,255,0.1)',
                  color: manualUrl.trim() ? '#0F172A' : '#666',
                }}
              >
                {manualSubmitting ? 'Bezig...' : 'Toevoegen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default TracklistSection;
