import { useEffect, useState } from 'react';

export interface EqualizerIndicatorProps {
  color?: string;
  barCount?: number;
}

export function EqualizerIndicator({
  color = '#FF4081',
  barCount = 3,
}: EqualizerIndicatorProps) {
  const [heights, setHeights] = useState<number[]>(() =>
    Array.from({ length: barCount }, () => Math.random() * 12 + 4)
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setHeights(
        Array.from({ length: barCount }, () => Math.random() * 14 + 4)
      );
    }, 350);
    return () => clearInterval(interval);
  }, [barCount]);

  return (
    <div className="flex items-end gap-[2px] h-[22px] px-1">
      {heights.map((h, i) => (
        <div
          key={i}
          className="w-[2.5px] rounded-[1px]"
          style={{
            height: `${h}px`,
            backgroundColor: color,
            transition: 'height 350ms ease-in-out',
          }}
        />
      ))}
    </div>
  );
}

export default EqualizerIndicator;
