import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Heart, Compass } from 'lucide-react';
import { usePlayerStore } from '../stores/playerStore';
import type { SetInfo } from '../types';
import { SetCard } from '../components/Favorites/SetCard';
import { getStarred } from '../services/subsonic';
import { useAuthStore } from '../stores/useAuthStore';

export function FavoritesPage() {
  const navigate = useNavigate();
  const likedSetIds = usePlayerStore((s) => s.likedSetIds);
  const recentSets = usePlayerStore((s) => s.recentSets);
  const festivals = usePlayerStore((s) => s.festivals);
  const [starredResult, setStarredResult] = useState<{ scope: string | null; sets: SetInfo[] } | null>(null);

  const accountScope = useAuthStore((s) => s.accountScope);
  const starredSets = useMemo(() => starredResult?.scope === accountScope ? starredResult.sets : [], [starredResult, accountScope]);
  useEffect(() => {
    let mounted = true;
    // The account-scoped player action is the sole owner of favourite IDs.
    void usePlayerStore.getState().syncLikedSets().catch(() => {});
    getStarred().then((sets) => { if (mounted) setStarredResult({ scope: accountScope, sets }); }).catch(() => {
      // A failed fetch is not a successful empty list; retain player cache.
    });
    return () => { mounted = false; };
  }, [accountScope]);

  // Pool all known sets
  const favoriteSets = useMemo(() => {
    const setMap = new Map<string, SetInfo>();

    // Add starred sets from Subsonic
    starredSets.forEach((s) => setMap.set(s.id, s));

    // Add recent sets
    recentSets.forEach((s) => setMap.set(s.id, s));

    // Add festival sets
    festivals.forEach((f) => {
      f.stages.forEach((st) => {
        st.sets.forEach((s) => setMap.set(s.id, s));
      });
    });

    const result: SetInfo[] = [];
    likedSetIds.forEach((id) => {
      if (setMap.has(id)) {
        result.push(setMap.get(id)!);
      } else {
        // Fallback placeholder if not found in memory pool
        result.push({
          id,
          title: `Favoriete Set #${id.slice(0, 8)}`,
          artist: 'Beatmonkey Artist',
          coverArt: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=600&auto=format&fit=crop&q=80',
          duration: 3600,
          genre: 'Electronic',
        });
      }
    });

    return result;
  }, [likedSetIds, recentSets, festivals, starredSets]);

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6 pb-20">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-[var(--color-crystal-border)] pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-[var(--color-crystal-surface)] border border-[var(--color-crystal-border)] text-[var(--color-crystal-pink)]">
            <Heart className="w-6 h-6 fill-current" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Mijn Favorieten</h1>
            <p className="text-xs sm:text-sm text-gray-400">
              Jouw opgeslagen en gemarkeerde festival sets
            </p>
          </div>
        </div>

        {favoriteSets.length > 0 && (
          <span className="text-xs font-bold px-3 py-1 rounded-full bg-[var(--color-crystal-pink)]/20 text-[var(--color-crystal-pink)] border border-[var(--color-crystal-pink)]/30">
            {favoriteSets.length} {favoriteSets.length === 1 ? 'set' : 'sets'}
          </span>
        )}
      </header>

      {/* Content */}
      {favoriteSets.length > 0 ? (
        <div className="space-y-3">
          {favoriteSets.map((set) => (
            <SetCard key={set.id} set={set} />
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-[var(--color-crystal-border)] bg-[var(--color-crystal-card)]/50 p-10 text-center space-y-4 my-8">
          <div className="w-14 h-14 rounded-full bg-[var(--color-crystal-surface)] flex items-center justify-center mx-auto text-[var(--color-crystal-pink)] border border-[var(--color-crystal-pink)]/20">
            <Heart className="w-7 h-7" />
          </div>
          <div className="space-y-1 max-w-sm mx-auto">
            <h3 className="text-base font-bold text-white">Nog Geen Favorieten</h3>
            <p className="text-xs sm:text-sm text-gray-400">
              Tik op het hart-icoon bij een set om deze toe te voegen aan je persoonlijke favorietenlijst.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate({ to: '/discover' })}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-[var(--color-crystal-cyan)] to-[#00a3cc] text-black text-xs sm:text-sm font-bold shadow-[0_0_20px_rgba(0,229,255,0.3)] hover:opacity-95 transition-opacity cursor-pointer"
          >
            <Compass size={16} />
            <span>Ontdek Festivals & Sets</span>
          </button>
        </div>
      )}
    </div>
  );
}

export default FavoritesPage;
