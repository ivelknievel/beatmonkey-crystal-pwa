import React, { useEffect, useState } from 'react';

export interface EqualizerIndicatorProps {
  color?: string;
  barCount?: number;
  className?: string;
}

export const EqualizerIndicator: React.FC<EqualizerIndicatorProps> = ({
  color = '#FF4081',
  barCount = 3,
  className = '',
}) => {
  const [heights, setHeights] = useState<number[]>(() =>
    Array.from({ length: barCount }, () => Math.floor(Math.random() * 15) + 4)
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setHeights(
        Array.from({ length: barCount }, () => Math.floor(Math.random() * 15) + 4)
      );
    }, 350);

    return () => clearInterval(interval);
  }, [barCount]);

  return (
    <div
      className={`inline-flex items-end gap-[2px] h-[22px] px-1 select-none pointer-events-none ${className}`}
      aria-hidden="true"
    >
      {heights.map((h, i) => (
        <span
          key={i}
          className="w-[2.5px] rounded-[1px] block shrink-0"
          style={{
            height: `${h}px`,
            backgroundColor: color,
            transition: 'height 350ms ease-in-out',
          }}
        />
      ))}
    </div>
  );
};

export default EqualizerIndicator;
