import { useEffect, useRef } from 'react';
import { AudioEngine } from '../../engine/AudioEngine';

const BAR_COUNT = 32;
const BAR_COLOR = '#00e5ff';
const BAR_GAP = 2;

interface VisualizerProps {
  engine: AudioEngine;
  isPlaying: boolean;
}

export function Visualizer({ engine, isPlaying }: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    engine.onVisualizationData = (data) => {
      if (!ctx || !canvas) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const width = canvas.width;
      const height = canvas.height;
      const barWidth = (width - BAR_GAP * (BAR_COUNT - 1)) / BAR_COUNT;

      for (let i = 0; i < BAR_COUNT; i++) {
        const value = data[i] / 255;
        const barHeight = value * height;
        const x = i * (barWidth + BAR_GAP);
        const y = height - barHeight;

        ctx.fillStyle = BAR_COLOR;
        ctx.globalAlpha = 0.3 + value * 0.7;
        ctx.fillRect(x, y, barWidth, barHeight);
      }
    };

    if (isPlaying) {
      engine.startVisualization();
    }

    return () => {
      engine.stopVisualization();
      engine.onVisualizationData = null;
    };
  }, [engine, isPlaying]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-32 rounded-lg"
      width={300}
      height={80}
    />
  );
}
