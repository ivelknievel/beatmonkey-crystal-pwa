import type { SetInfo } from '../../types';
import { SetCard } from './RecentSetCard';

interface RecentCarouselProps {
  sets: SetInfo[];
}

export function RecentCarousel({ sets }: RecentCarouselProps) {
  if (!sets || sets.length === 0) {
    return null;
  }

  return (
    <div className="overflow-x-auto scrollbar-none -mx-4 px-4 py-2">
      <div className="flex gap-3">
        {sets.map((set) => (
          <SetCard key={set.id} set={set} />
        ))}
      </div>
    </div>
  );
}

export default RecentCarousel;
