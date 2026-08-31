import { useNavigate } from '@tanstack/react-router';
import type { FestivalInfo } from '../../types';
import { FestivalCard } from './FestivalCard';

interface FestivalCarouselProps {
  festivals: FestivalInfo[];
}

export function FestivalCarousel({ festivals }: FestivalCarouselProps) {
  const navigate = useNavigate();

  if (!festivals || festivals.length === 0) {
    return null;
  }

  return (
    <div className="overflow-x-auto scrollbar-none -mx-4 px-4 py-2">
      <div className="flex gap-3">
        {festivals.map((fest) => (
          <FestivalCard
            key={fest.slug || fest.name}
            festival={fest}
            onClick={() => navigate({ to: `/festivals/${fest.slug || encodeURIComponent(fest.name.toLowerCase())}` })}
          />
        ))}
      </div>
    </div>
  );
}

export default FestivalCarousel;
