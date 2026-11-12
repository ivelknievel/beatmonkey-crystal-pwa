import { useEffect, useState } from 'react';

export interface EqualizerIndicatorProps {
  color?: string;
  barCount?: number;
  isPlaying?: boolean;
}

const STATIC_HEIGHTS = [6, 11, 8];

function getStaticHeights(barCount: number): number[] {
  return Array.from({ length: barCount }, (_, i) => STATIC_HEIGHTS[i % STATIC_HEIGHTS.length]);
}

function getAnimatedHeights(barCount: number, step: number): number[] {
  return Array.from({ length: barCount }, (_, i) => {
    const rand = Math.random() * 14 + 4;
    const staticH = STATIC_HEIGHTS[i % STATIC_HEIGHTS.length];
    return rand === staticH ? ((staticH + step + i) % 14) + 4 : rand;
  });
}

export function EqualizerIndicator({
  color = '#FF4081',
  barCount = 3,
  isPlaying = false,
}: EqualizerIndicatorProps) {
  const [heights, setHeights] = useState<number[]>(getStaticHeights(barCount));

  useEffect(() => {
    if (!isPlaying) {
      setHeights(getStaticHeights(barCount));
      return;
    }
    let step = 1;
    setHeights(getAnimatedHeights(barCount, step));
    const interval = setInterval(() => {
      step += 1;
      setHeights(getAnimatedHeights(barCount, step));
    }, 350);
    return () => clearInterval(interval);
  }, [barCount, isPlaying]);

  return (
    <div
      className="flex items-end gap-[2px] h-[22px] px-1"
      data-playing={isPlaying ? 'true' : 'false'}
      aria-hidden="true"
    >
      {heights.map((h, i) => (
        <div
          key={i}
          className="w-[2.5px] rounded-[1px]"
          style={{
            height: `${h}px`,
            backgroundColor: color,
            transition: isPlaying ? 'height 350ms ease-in-out' : 'none',
          }}
        />
      ))}
    </div>
  );
}

export default EqualizerIndicator;
