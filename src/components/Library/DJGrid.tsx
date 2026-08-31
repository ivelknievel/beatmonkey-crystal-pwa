import { useNavigate } from '@tanstack/react-router';
import type { ArtistInfo } from '../../types';
import { DJCard } from './DJCard';

interface DJGridProps {
  artists: ArtistInfo[];
}

export function DJGrid({ artists }: DJGridProps) {
  const navigate = useNavigate();

  if (!artists || artists.length === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
      {artists.map((artist) => (
        <DJCard
          key={artist.id}
          artist={artist}
          onClick={() => navigate({ to: `/djs/${artist.id}` })}
        />
      ))}
    </div>
  );
}

export default DJGrid;
