import { Heart } from 'lucide-react';
import { usePlayerStore } from '../../stores/playerStore';

export function FavoriteButton({ setId }: { setId: string }) {
  const liked = usePlayerStore(s => s.likedSetIds.includes(setId));
  const toggleLike = usePlayerStore(s => s.toggleLike);
  
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        toggleLike(setId);
      }}
      className="p-2 rounded-full hover:bg-white/10 transition-colors cursor-pointer flex items-center justify-center"
      aria-label={liked ? 'Verwijder uit favorieten' : 'Voeg toe aan favorieten'}
    >
      <Heart
        size={20}
        className={liked ? 'text-crystal-pink fill-crystal-pink' : 'text-gray-500 hover:text-white'}
      />
    </button>
  );
}

export default FavoriteButton;
