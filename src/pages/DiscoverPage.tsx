import { useEffect, useState, useCallback } from 'react';
import { Disc3, PartyPopper, AlertCircle, RotateCcw } from 'lucide-react';
import { getFestivals, getRecentSets } from '../services/discoveryApi';
import { usePlayerStore } from '../stores/playerStore';
import { FestivalCarousel } from '../components/Discover/FestivalCarousel';
import { RecentCarousel } from '../components/Discover/RecentCarousel';
import { SpotlightCard } from '../components/Discover/SpotlightCard';
import { LoadingSpinner } from '../components/Shared/LoadingSpinner';

export function DiscoverPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const festivals = usePlayerStore((s) => s.festivals);
  const recentSets = usePlayerStore((s) => s.recentSets);
  const setFestivals = usePlayerStore((s) => s.setFestivals);
  const setRecentSets = usePlayerStore((s) => s.setRecentSets);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [festList, setsList] = await Promise.all([
        getFestivals(),
        getRecentSets(),
      ]);

      if ((!festList || festList.length === 0) && (!setsList || setsList.length === 0)) {
        throw new Error('Data niet beschikbaar');
      }
      setFestivals(festList || []);
      setRecentSets(setsList || []);
      setLoading(false);
    } catch (err: any) {
      console.error('DiscoverPage load error:', err);
      setError(err?.message || 'Data niet beschikbaar');
      setLoading(false);
    }
  }, [setFestivals, setRecentSets]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const spotlightFestival = festivals.find((f) => f.slug === 'lief') || festivals[0];

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-8 pb-20">
      {loading ? (
        <LoadingSpinner label="Festivals & sets laden..." />
      ) : error ? (
        <div className="rounded-2xl border border-[var(--color-crystal-border,#222230)] bg-[var(--color-crystal-card,#1a1a26)]/50 p-10 text-center space-y-4 my-8">
          <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto text-red-400">
            <AlertCircle size={24} />
          </div>
          <div>
            <h3 className="text-base font-semibold text-white">Data niet beschikbaar</h3>
            <p className="text-xs sm:text-sm text-gray-400 mt-1 max-w-sm mx-auto">
              Er kon geen verbinding worden gemaakt met de festival catalogus. Probeer het opnieuw.
            </p>
          </div>
          <button
            type="button"
            onClick={loadData}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[var(--color-crystal-cyan,#00e5ff)] text-black text-xs font-bold transition-all hover:opacity-90 cursor-pointer shadow-[0_0_15px_rgba(0,229,255,0.2)]"
          >
            <RotateCcw size={14} />
            <span>Opnieuw proberen</span>
          </button>
        </div>
      ) : (
        <>
          {/* Spotlight Section */}
          {spotlightFestival && (
            <section aria-label="Uitgelicht Festival">
              <SpotlightCard festival={spotlightFestival} />
            </section>
          )}

          {/* Festival Carousel */}
          {festivals.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <PartyPopper size={20} className="text-[var(--color-crystal-cyan,#00e5ff)]" />
                  <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight">
                    Populaire Festivals
                  </h2>
                </div>
                <span className="text-xs text-gray-400 font-medium">
                  {festivals.length} festivals
                </span>
              </div>
              <FestivalCarousel festivals={festivals} />
            </section>
          )}

          {/* Recent Sets Carousel */}
          {recentSets.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Disc3 size={20} className="text-[var(--color-crystal-pink,#ff007f)]" />
                  <h2 className="text-lg sm:text-xl font-bold text-white tracking-tight">
                    Recent Toegevoegd
                  </h2>
                </div>
                <span className="text-xs text-gray-400 font-medium">
                  {recentSets.length} sets
                </span>
              </div>
              <RecentCarousel sets={recentSets} />
            </section>
          )}
        </>
      )}
    </div>
  );
}

export default DiscoverPage;
