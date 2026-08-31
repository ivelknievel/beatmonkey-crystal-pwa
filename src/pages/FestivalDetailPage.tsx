import { useEffect, useState } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import { getFestivalDetail } from '../services/discoveryApi';
import { usePlayerStore } from '../stores/playerStore';
import type { FestivalInfo, SetInfo, StageInfo } from '../types';
import { Loader2, AlertCircle, Play, ExternalLink, Heart, Flame, ChevronLeft } from 'lucide-react';
import { getCoverUrl } from '../services/subsonic';

function YoutubeIcon({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}

export function FestivalDetailPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const navigate = useNavigate();

  const [festival, setFestival] = useState<FestivalInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeStage, setActiveStage] = useState(0);

  useEffect(() => {
    let isMounted = true;
    async function load() {
      if (!slug) return;
      setLoading(true);
      setError(null);
      try {
        const data = await getFestivalDetail(slug);
        if (isMounted) {
          setFestival(data);
          setActiveStage(0);
          setLoading(false);
        }
      } catch (err: any) {
        console.error('Error loading festival detail:', err);
        if (isMounted) {
          setError(err?.message || 'Fout bij het laden van het festival');
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      isMounted = false;
    };
  }, [slug]);

  if (loading) {
    return (
      <div className="min-h-screen bg-crystal-bg text-white flex flex-col items-center justify-center p-6 space-y-4">
        <Loader2 className="w-8 h-8 text-crystal-cyan animate-spin" />
        <p className="text-sm text-gray-400 font-medium">Festival laden...</p>
      </div>
    );
  }

  if (error || !festival) {
    return (
      <div className="min-h-screen bg-crystal-bg text-white flex flex-col items-center justify-center p-6 space-y-4 text-center">
        <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400">
          <AlertCircle size={24} />
        </div>
        <h2 className="text-xl font-bold">{error || 'Festival niet gevonden'}</h2>
        <button
          type="button"
          onClick={() => navigate({ to: '/discover' })}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-crystal-cyan text-black font-semibold text-sm cursor-pointer"
        >
          <ChevronLeft size={16} /> Terug naar Ontdekken
        </button>
      </div>
    );
  }

  // Get sets for active stage
  const stages = festival.stages || [];
  const currentStage: StageInfo | undefined = stages[activeStage] || stages[0];
  const sets: SetInfo[] = currentStage?.sets || [];

  return (
    <div className="min-h-screen bg-crystal-bg text-white pb-32 max-w-5xl mx-auto px-4 sm:px-6 pt-4">
      {/* Back button */}
      <div className="mb-4">
        <button
          type="button"
          onClick={() => navigate({ to: '/discover' })}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-crystal-surface border border-crystal-border text-gray-300 hover:text-white hover:border-crystal-cyan/40 text-xs font-semibold transition-all cursor-pointer"
        >
          <ChevronLeft size={16} /> Terug
        </button>
      </div>

      {/* Hero banner */}
      <HeroBanner festival={festival} />

      {/* Action buttons */}
      <ActionButtons festival={festival} sets={sets} />

      {/* Area tabs */}
      {stages.length > 0 && (
        <div className="mt-6">
          <AreaTabs stages={stages} activeIndex={activeStage} onSelect={setActiveStage} />
        </div>
      )}

      {/* Sets grid */}
      <SetsGrid sets={sets} />
    </div>
  );
}

function HeroBanner({ festival }: { festival: FestivalInfo | null }) {
  if (!festival) return null;
  return (
    <div className="relative w-full rounded-2xl overflow-hidden min-h-[260px] flex flex-col justify-end p-6 border border-crystal-border">
      <img
        src={festival.logo || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=600'}
        alt={festival.name}
        className="absolute inset-0 w-full h-full object-cover"
        onError={(e) => {
          (e.target as HTMLImageElement).src = 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=600';
        }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-crystal-bg via-crystal-bg/75 to-black/30" />
      <div className="relative z-10">
        <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold bg-crystal-cyan/20 text-crystal-cyan border border-crystal-cyan/40 backdrop-blur-md">
          <Flame size={14} className="text-crystal-pink" />
          SPOTLIGHT FESTIVAL
        </span>
        <h1 className="text-3xl font-bold mt-3 text-white tracking-tight">{festival.name}</h1>
        <p className="text-sm text-gray-300 mt-1 font-medium">{festival.date}</p>
        {festival.description && (
          <p className="text-xs sm:text-sm text-gray-300/90 mt-2 max-w-2xl line-clamp-2 leading-relaxed">
            {festival.description}
          </p>
        )}
      </div>
    </div>
  );
}

function AreaTabs({
  stages,
  activeIndex,
  onSelect,
}: {
  stages?: { name: string; sets: any[] }[];
  activeIndex: number;
  onSelect: (i: number) => void;
}) {
  if (!stages || stages.length === 0) return null;

  const icons = ['🏠', '🎧', '🎪', '🌴', '🔊', '⭐'];

  return (
    <div className="flex gap-2 overflow-x-auto scrollbar-none -mx-4 px-4 py-1">
      {stages.map((stage, i) => (
        <button
          key={stage.name}
          type="button"
          onClick={() => onSelect(i)}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all cursor-pointer ${
            i === activeIndex
              ? 'bg-crystal-cyan/20 text-crystal-cyan border border-crystal-cyan/40 shadow-[0_0_15px_rgba(0,229,255,0.2)]'
              : 'bg-crystal-surface text-gray-400 border border-transparent hover:border-crystal-border hover:text-white'
          }`}
        >
          <span>{icons[i] || '🎵'}</span>
          <span>{stage.name}</span>
          {stage.sets && stage.sets.length > 0 && (
            <span
              className={`text-xs ml-1 px-1.5 py-0.5 rounded-full ${
                i === activeIndex ? 'bg-crystal-cyan/20 text-crystal-cyan' : 'bg-white/10 text-gray-400'
              }`}
            >
              {stage.sets.length}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function ActionButtons({ festival, sets }: { festival: FestivalInfo | null; sets: any[] }) {
  const playAll = () => {
    if (!sets || sets.length === 0) return;
    // Queue all sets, play first
    const queue = sets.map((s) => ({
      id: s.id || (s as any).albumId,
      title: s.title,
      artist: s.artist,
      coverArt: s.coverArt || s.id,
      duration: s.duration || 0,
      year: s.year,
      genre: s.genre,
      festival: s.festival,
      stage: s.stage,
      youtubeUrl: s.youtubeUrl,
    }));
    usePlayerStore.getState().clearQueue();
    queue.forEach((s) => usePlayerStore.getState().addToQueue(s));
    usePlayerStore.getState().loadSet(queue[0]);
    usePlayerStore.getState().setFullscreen(true);
  };

  const websiteUrl = festival?.slug === 'lief' || !festival ? 'https://lieffestival.nl/' : 'https://lieffestival.nl/';

  return (
    <div className="flex flex-wrap gap-3 mt-4">
      <button
        type="button"
        onClick={playAll}
        disabled={!sets || sets.length === 0}
        className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-crystal-cyan to-crystal-pink text-black font-bold rounded-xl text-sm hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-opacity"
      >
        <Play size={16} className="fill-black" /> Speel Alles
      </button>
      <a
        href={websiteUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 px-5 py-3 bg-crystal-surface border border-crystal-border text-gray-300 rounded-xl text-sm hover:border-crystal-cyan/40 hover:text-white transition-colors cursor-pointer"
      >
        <ExternalLink size={16} /> Bekijk Website
      </a>
    </div>
  );
}

function SetsGrid({ sets }: { sets: any[] }) {
  const loadSet = usePlayerStore((s) => s.loadSet);
  const setFullscreen = usePlayerStore((s) => s.setFullscreen);
  const likedSetIds = usePlayerStore((s) => s.likedSetIds);
  const toggleLike = usePlayerStore((s) => s.toggleLike);

  const handlePlaySet = (set: any) => {
    loadSet({
      id: set.id || set.albumId,
      title: set.title,
      artist: set.artist,
      coverArt: set.coverArt || set.id,
      duration: set.duration || 0,
      year: set.year,
      genre: set.genre,
      festival: set.festival,
      stage: set.stage,
      youtubeUrl: set.youtubeUrl,
    });
    setFullscreen(true);
  };

  if (!sets || sets.length === 0) {
    return (
      <div className="rounded-xl border border-crystal-border bg-crystal-card/50 p-8 text-center mt-4">
        <p className="text-sm text-gray-400">Geen sets beschikbaar voor deze area.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 mt-4">
      {sets.map((set) => {
        const isLiked = set.id ? likedSetIds.includes(set.id) : false;

        return (
          <div
            key={set.id}
            onClick={() => handlePlaySet(set)}
            className="group relative bg-crystal-card rounded-xl overflow-hidden border border-crystal-border hover:border-crystal-cyan/40 transition-all cursor-pointer flex flex-col justify-between"
          >
            {/* Cover art */}
            <div className="relative aspect-square overflow-hidden bg-crystal-surface">
              <img
                src={getCoverUrl(set.coverArt || set.id, 300)}
                alt={set.title}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=600';
                }}
              />

              {/* Play overlay */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handlePlaySet(set);
                }}
                className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                aria-label={`Speel ${set.title}`}
              >
                <div className="w-12 h-12 rounded-full bg-crystal-cyan flex items-center justify-center shadow-lg transform group-hover:scale-110 transition-transform">
                  <Play size={22} className="text-black ml-0.5 fill-black" />
                </div>
              </button>

              {/* Year badge */}
              {set.year && (
                <span className="absolute top-2 left-2 text-[10px] font-semibold bg-black/60 text-gray-300 px-2 py-0.5 rounded-full backdrop-blur-sm border border-white/10">
                  {set.year}
                </span>
              )}
            </div>

            {/* Info */}
            <div className="p-3 space-y-1">
              <p className="text-sm font-medium text-white truncate" title={set.title}>
                {set.title}
              </p>
              <p className="text-xs text-gray-400 truncate" title={set.artist}>
                {set.artist}
              </p>
              <div className="flex items-center gap-2 mt-2 pt-1 border-t border-crystal-border/50">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (set.id) handlePlaySet(set);
                  }}
                  className="p-1.5 rounded-lg bg-crystal-surface hover:bg-crystal-cyan/20 transition-colors cursor-pointer"
                  aria-label="Afspelen"
                >
                  <Play size={14} className="text-crystal-cyan fill-crystal-cyan" />
                </button>
                {set.youtubeUrl && (
                  <a
                    href={set.youtubeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-1.5 rounded-lg bg-crystal-surface hover:bg-red-500/20 text-red-400 transition-colors cursor-pointer"
                    onClick={(e) => e.stopPropagation()}
                    title="Bekijk op YouTube"
                  >
                    <YoutubeIcon size={14} />
                  </a>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (set.id) toggleLike(set.id);
                  }}
                  className="p-1.5 rounded-lg bg-crystal-surface hover:bg-crystal-pink/20 transition-colors ml-auto cursor-pointer"
                  aria-label={isLiked ? 'Verwijder uit favorieten' : 'Voeg toe aan favorieten'}
                >
                  <Heart
                    size={14}
                    className={isLiked ? 'text-crystal-pink fill-crystal-pink' : 'text-gray-500'}
                  />
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default FestivalDetailPage;

