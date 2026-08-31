import { useState, useRef, useEffect, useCallback } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { AudioEngine } from '../../engine/AudioEngine';
import { formatTime } from '../../utils/format';
import type { TrackCue } from '../../types';

const EMPTY_CUES: TrackCue[] = [];

export function Scrubber() {
  const seekRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const currentTimeRef = useRef<HTMLSpanElement>(null);
  const dragProgressPctRef = useRef<number>(0);
  const isDraggingRef = useRef<boolean>(false);
  const lastActiveCueRef = useRef<number>(-1);

  const [isDragging, setIsDragging] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [previewX, setPreviewX] = useState(0);

  const durationStore = usePlayerStore((s) => s.duration);
  const currentSet = usePlayerStore((s) => s.currentSet);
  const setActiveCueIndex = usePlayerStore((s) => s.setActiveCueIndex);

  const cues = currentSet?.tracklist || EMPTY_CUES;
  const duration = durationStore || currentSet?.duration || 0;

  const cuesRef = useRef(cues);
  const durationRef = useRef(duration);

  useEffect(() => {
    cuesRef.current = cues;
  }, [cues]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  // Keep isDraggingRef in sync with state
  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  // rAF update (60fps, direct DOM, zero React re-renders during playback)
  useEffect(() => {
    let rafId: number;

    const update = () => {
      const audio = AudioEngine.getAudioElement();
      const dur = audio && !isNaN(audio.duration) && audio.duration > 0
        ? audio.duration
        : durationRef.current;

      if (!isDraggingRef.current) {
        if (audio && dur > 0) {
          const ct = audio.currentTime || 0;
          const pct = Math.min(100, Math.max(0, (ct / dur) * 100));

          if (fillRef.current) {
            fillRef.current.style.width = `${pct}%`;
          }
          if (thumbRef.current) {
            thumbRef.current.style.left = `${pct}%`;
          }
          if (currentTimeRef.current) {
            currentTimeRef.current.textContent = formatTime(ct);
          }

          // Check active cue
          const currentCues = cuesRef.current;
          if (currentCues.length > 0) {
            let activeIdx = -1;
            for (let i = 0; i < currentCues.length; i++) {
              if (currentCues[i].timeSec <= ct) {
                activeIdx = i;
              } else {
                break;
              }
            }
            if (activeIdx !== lastActiveCueRef.current) {
              lastActiveCueRef.current = activeIdx;
              setActiveCueIndex(activeIdx);
            }
          }
        }
      }

      rafId = requestAnimationFrame(update);
    };

    rafId = requestAnimationFrame(update);
    return () => cancelAnimationFrame(rafId);
  }, [setActiveCueIndex]);

  const calculatePct = useCallback((clientX: number): number => {
    if (!seekRef.current) return 0;
    const rect = seekRef.current.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
    isDraggingRef.current = true;

    const pct = calculatePct(e.clientX);
    dragProgressPctRef.current = pct;

    const currentDuration = AudioEngine.getDuration() || durationRef.current || 0;
    const targetTime = pct * currentDuration;

    if (fillRef.current) {
      fillRef.current.style.width = `${pct * 100}%`;
    }
    if (thumbRef.current) {
      thumbRef.current.style.left = `${pct * 100}%`;
    }
    if (currentTimeRef.current) {
      currentTimeRef.current.textContent = formatTime(targetTime);
    }

    if (seekRef.current) {
      const rect = seekRef.current.getBoundingClientRect();
      const relativeX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      setPreviewTime(targetTime);
      setPreviewX(relativeX);
      setShowPreview(true);
    }
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!seekRef.current) return;
    const rect = seekRef.current.getBoundingClientRect();
    const relativeX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const pct = calculatePct(e.clientX);
    const currentDuration = AudioEngine.getDuration() || durationRef.current || 0;
    const targetTime = pct * currentDuration;

    setPreviewTime(targetTime);
    setPreviewX(relativeX);

    if (isDraggingRef.current) {
      dragProgressPctRef.current = pct;
      if (fillRef.current) {
        fillRef.current.style.width = `${pct * 100}%`;
      }
      if (thumbRef.current) {
        thumbRef.current.style.left = `${pct * 100}%`;
      }
      if (currentTimeRef.current) {
        currentTimeRef.current.textContent = formatTime(targetTime);
      }
    }
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (isDraggingRef.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // pointer capture already released
      }

      const pct = calculatePct(e.clientX);
      const currentDuration = AudioEngine.getDuration() || durationRef.current || 0;
      if (currentDuration > 0) {
        AudioEngine.seek(pct * currentDuration);
      }

      setIsDragging(false);
      isDraggingRef.current = false;
      setShowPreview(false);
    }
  };

  const handlePointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (isDraggingRef.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // pointer capture already released
      }
      setIsDragging(false);
      isDraggingRef.current = false;
      setShowPreview(false);
    }
  };

  return (
    <div className="w-full px-6 max-w-lg mx-auto select-none">
      {/* Seek bar container */}
      <div
        ref={seekRef}
        className="relative h-6 flex items-center cursor-pointer group touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerEnter={() => !isDragging && setShowPreview(true)}
        onPointerLeave={() => !isDragging && setShowPreview(false)}
        role="slider"
        aria-label="Tijdlijn"
        aria-valuemin={0}
        aria-valuemax={duration}
      >
        {/* Track background */}
        <div className="relative w-full h-1.5 bg-[var(--color-crystal-surface)] rounded-full overflow-hidden border border-white/5">
          {/* Filled progress */}
          <div
            ref={fillRef}
            className="h-full bg-[var(--color-crystal-cyan)] rounded-full transition-none"
            style={{ width: '0%' }}
          />
        </div>

        {/* Cue dots (1001Tracklists markers) */}
        {duration > 0 &&
          cues.map((cue, idx) => {
            const cuePct = Math.min(100, Math.max(0, (cue.timeSec / duration) * 100));
            return (
              <div
                key={`${cue.timeSec}-${idx}`}
                className="absolute top-1/2 -translate-y-1/2 w-1.5 h-1.5 bg-white/60 hover:bg-[var(--color-crystal-cyan)] hover:scale-150 rounded-full transition-transform pointer-events-none"
                style={{ left: `${cuePct}%` }}
                title={`${cue.title} (${formatTime(cue.timeSec)})`}
              />
            );
          })}

        {/* Scrubber thumb handle (glows on hover/drag) */}
        <div
          ref={thumbRef}
          className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 bg-white rounded-full shadow-[0_0_10px_rgba(0,229,255,0.8)] transition-transform pointer-events-none ${
            isDragging ? 'scale-125' : 'scale-0 group-hover:scale-100'
          }`}
          style={{ left: '0%' }}
        />

        {/* Timestamp preview popup tooltip */}
        {showPreview && (
          <div
            className="absolute -top-8 bg-[var(--color-crystal-card)] text-[var(--color-crystal-cyan)] border border-[var(--color-crystal-border)] px-2 py-0.5 rounded text-xs font-mono font-medium shadow-lg pointer-events-none"
            style={{
              left: `${previewX}px`,
              transform: 'translateX(-50%)',
            }}
          >
            {formatTime(previewTime)}
          </div>
        )}
      </div>

      {/* Time labels */}
      <div className="flex justify-between mt-1 text-xs font-mono text-gray-400">
        <span ref={currentTimeRef}>0:00</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
}

export default Scrubber;
