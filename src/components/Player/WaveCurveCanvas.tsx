import React, { useRef, useEffect, useCallback } from 'react';
import type { TrackCue } from '../../types';

export interface WaveCurveCanvasProps {
  tracklist: TrackCue[];
  activeTrackIndex: number;
  currentTimeSec: number;
  totalDurationSec: number;
  onSeek?: (timeSec: number) => void;
  className?: string;
}

export const WaveCurveCanvas: React.FC<WaveCurveCanvasProps> = ({
  tracklist = [],
  activeTrackIndex = -1,
  currentTimeSec = 0,
  totalDurationSec = 3600,
  onSeek,
  className = '',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDraggingRef = useRef<boolean>(false);
  const animationFrameRef = useRef<number | null>(null);

  const propsRef = useRef({
    tracklist,
    activeTrackIndex,
    currentTimeSec,
    totalDurationSec,
    onSeek,
  });

  useEffect(() => {
    propsRef.current = {
      tracklist,
      activeTrackIndex,
      currentTimeSec,
      totalDurationSec,
      onSeek,
    };
  }, [tracklist, activeTrackIndex, currentTimeSec, totalDurationSec, onSeek]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const {
      tracklist: currentTracklist,
      activeTrackIndex: currentActiveIdx,
      currentTimeSec: curTime,
      totalDurationSec: totDur,
    } = propsRef.current;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    if (width === 0 || height === 0) return;

    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const effectiveDuration = totDur > 0 ? totDur : 3600;
    const currentRatio = Math.max(0, Math.min(1, curTime / effectiveDuration));
    const currentX = currentRatio * width;

    const pointsCount = 60;
    const baseMidY = height * 0.58;

    // 1. Shaded Gradient under Wave
    ctx.beginPath();
    ctx.moveTo(0, height);
    const startWaveOffset = Math.sin(0) * 16.0 + Math.sin(0) * 8.0;
    ctx.lineTo(0, baseMidY + startWaveOffset);

    for (let i = 0; i <= pointsCount; i++) {
      const ratio = i / pointsCount;
      const x = ratio * width;
      const waveOffset = Math.sin(ratio * 12.0) * 16.0 + Math.sin(ratio * 26.0) * 8.0;
      const y = baseMidY + waveOffset;
      ctx.lineTo(x, y);
    }

    ctx.lineTo(width, height);
    ctx.closePath();

    const fillGradient = ctx.createLinearGradient(0, baseMidY - 20, 0, height);
    fillGradient.addColorStop(0, 'rgba(0, 229, 255, 0.28)');
    fillGradient.addColorStop(0.5, 'rgba(255, 64, 129, 0.12)');
    fillGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctx.fillStyle = fillGradient;
    ctx.fill();

    // 2. Wave Outline Line
    ctx.beginPath();
    for (let i = 0; i <= pointsCount; i++) {
      const ratio = i / pointsCount;
      const x = ratio * width;
      const waveOffset = Math.sin(ratio * 12.0) * 16.0 + Math.sin(ratio * 26.0) * 8.0;
      const y = baseMidY + waveOffset;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    const strokeGradient = ctx.createLinearGradient(0, 0, width, 0);
    strokeGradient.addColorStop(0, '#00E5FF');
    strokeGradient.addColorStop(0.5, '#FF4081');
    strokeGradient.addColorStop(1, '#00E5FF');

    ctx.strokeStyle = strokeGradient;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 3. Track Markers along the wave
    if (currentTracklist && currentTracklist.length > 0) {
      currentTracklist.forEach((track, index) => {
        const time = track.timeSec ?? 0;
        const trackRatio = Math.max(0, Math.min(1, time / effectiveDuration));
        const trackX = trackRatio * width;
        const waveOffset = Math.sin(trackRatio * 12.0) * 16.0 + Math.sin(trackRatio * 26.0) * 8.0;
        const trackY = baseMidY + waveOffset;

        const isTrackActive = index === currentActiveIdx;
        const isTrackPast = index < currentActiveIdx;

        if (isTrackActive) {
          // Glow ring
          ctx.beginPath();
          ctx.arc(trackX, trackY, 8, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 64, 129, 0.4)';
          ctx.fill();

          // Center dot
          ctx.beginPath();
          ctx.arc(trackX, trackY, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#FFFFFF';
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(trackX, trackY, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = isTrackPast ? '#00E5FF' : 'rgba(255, 255, 255, 0.4)';
          ctx.fill();
        }
      });
    }

    // 4. Current Playback Scrubber Beam
    ctx.beginPath();
    ctx.moveTo(currentX, 10);
    ctx.lineTo(currentX, height - 10);
    ctx.strokeStyle = '#00E5FF';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Scrubber top dot
    ctx.beginPath();
    ctx.arc(currentX, 10, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.shadowColor = '#00E5FF';
    ctx.shadowBlur = 6;
    ctx.fill();

    ctx.restore();
  }, []);

  useEffect(() => {
    let active = true;

    const renderLoop = () => {
      if (!active) return;
      draw();
      animationFrameRef.current = requestAnimationFrame(renderLoop);
    };

    animationFrameRef.current = requestAnimationFrame(renderLoop);

    return () => {
      active = false;
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [draw]);

  const handleSeekFromEvent = (clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !propsRef.current.onSeek) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return;

    const relativeX = clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, relativeX / rect.width));
    const effectiveDuration = propsRef.current.totalDurationSec > 0 ? propsRef.current.totalDurationSec : 3600;
    const seekTime = ratio * effectiveDuration;

    propsRef.current.onSeek(seekTime);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    isDraggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    handleSeekFromEvent(e.clientX);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isDraggingRef.current) {
      handleSeekFromEvent(e.clientX);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch (_) {}
    }
  };

  return (
    <canvas
      ref={canvasRef}
      className={`w-full h-full block cursor-pointer select-none touch-none ${className}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  );
};

export default WaveCurveCanvas;
