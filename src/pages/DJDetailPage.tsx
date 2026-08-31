import { useEffect, useState } from 'react';
import { useParams, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Play, Disc3, Heart, ChevronDown, ChevronUp, Calendar, Tag } from 'lucide-react';
import { getDJDetail } from '../services/discoveryApi';
import type { ArtistInfo, SetInfo } from '../types';
import { usePlayerStore } from '../stores/playerStore';
import { LoadingSpinner } from '../components/Shared/LoadingSpinner';
import { formatTime } from '../utils/format';

export function DJDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [artist, setArtist] = useState<ArtistInfo | null>(null);
  const [sets, setSets] = useState<SetInfo[]>([]);
  const [bioExpanded, setBioExpanded] = useState(false);

  const loadSet = usePlayerStore((s) => s.loadSet);
  const setFullscreen = usePlayerStore((s) => s.setFullscreen);
  const toggleLike = usePlayerStore((s) => s.toggleLike);
  const isLiked = usePlayerStore((s) => s.isLiked);
  const currentSetId = usePlayerStore((s) => s.currentSetId);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  useEffect(() => {
    let isMounted = true;
    async function load() {
      if (!id) return;
      setLoading(true);
      try {
        const data = await getDJDetail(id);
        if (isMounted) {
          setArtist(data.artist);
          setSets(data.sets);
          setLoading(false);
        }
      } catch (err) {
        console.error('Error loading DJ detail:', err);
        if (isMounted) setLoading(false);
      }
    }
    load();
    return () => {
      isMounted = false;
    };
  }, [id]);

  const handlePlaySet = (set: SetInfo) => {
    loadSet(set, 0);
    setFullscreen(true);
  };

  if (loading) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <LoadingSpinner label="DJ profiel laden..." />
      </div>
    );
  }

  if (!artist) {
    return (
      <div className="p-6 max-w-4xl mx-auto text-center space-y-4">
        <h2 className="text-xl font-bold text-white">DJ niet gevonden</h2>
        <button
          type="button"
          onClick={() => navigate({ to: '/library' })}
          className="px-4 py-2 rounded-xl bg-[var(--color-crystal-cyan,#00e5ff)] text-black font-semibold text-sm cursor-pointer"
        >
          Terug naar Bibliotheek
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto pb-24">
      {/* Header Banner & Profile */}
      <div className="relative w-full bg-[var(--color-crystal-card,#1a1a26)] border-b border-[var(--color-crystal-border,#222230)] overflow-hidden">
        {/* Blurred backdrop image */}
        <div className="absolute inset-0 opacity-20 pointer-events-none">
          <img
            src={artist.image}
            alt=""
            className="w-full h-full object-cover blur-2xl scale-125"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[var(--color-crystal-bg,#0a0a0f)] via-[var(--color-crystal-card,#1a1a26)]/80 to-transparent" />
        </div>

        {/* Back Button */}
        <div className="relative z-10 p-4 sm:p-6">
          <button
            type="button"
            onClick={() => navigate({ to: '/library' })}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-black/40 hover:bg-black/60 text-gray-300 hover:text-white border border-white/10 text-xs font-semibold backdrop-blur-md transition-colors cursor-pointer"
          >
            <ArrowLeft size={16} />
            <span>Terug</span>
          </button>
        </div>

        {/* Artist Profile Content */}
        <div className="relative z-10 px-6 pb-6 pt-2 flex flex-col sm:flex-row items-center sm:items-end gap-5 text-center sm:text-left">
          {/* Avatar (rounded-2xl / rounded-full) */}
          <div className="w-28 h-28 sm:w-36 sm:h-36 rounded-2xl overflow-hidden flex-shrink-0 bg-[var(--color-crystal-surface,#12121a)] border-2 border-[var(--color-crystal-cyan,#00e5ff)] shadow-[0_10px_30px_rgba(0,0,0,0.7)]">
            <img
              src={artist.image}
              alt={artist.name}
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLElement).style.display = 'none';
              }}
            />
          </div>

          <div className="flex-1 space-y-2">
            <span className="inline-block px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-[var(--color-crystal-cyan,#00e5ff)]/20 text-[var(--color-crystal-cyan,#00e5ff)] border border-[var(--color-crystal-cyan,#00e5ff)]/30">
              DJ / Producer
            </span>

            <h1 className="text-2xl sm:text-4xl font-extrabold text-white tracking-tight leading-tight">
              {artist.name}
            </h1>

            {/* Genre Tags */}
            {artist.genres && artist.genres.length > 0 && (
              <div className="flex items-center justify-center sm:justify-start gap-1.5 flex-wrap pt-1">
                {artist.genres.map((genre) => (
                  <span
                    key={genre}
                    className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg text-xs font-medium bg-white/10 text-gray-200 border border-white/10"
                  >
                    <Tag size={10} className="text-[var(--color-crystal-cyan,#00e5ff)]" />
                    {genre}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Expandable Bio */}
        {artist.bio && (
          <div className="relative z-10 px-6 pb-6 pt-2 border-t border-white/5">
            <p
              className={`text-xs sm:text-sm text-gray-300 leading-relaxed transition-all ${
                bioExpanded ? '' : 'line-clamp-2'
              }`}
            >
              {artist.bio}
            </p>
            {artist.bio.length > 120 && (
              <button
                type="button"
                onClick={() => setBioExpanded((prev) => !prev)}
                className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-[var(--color-crystal-cyan,#00e5ff)] hover:underline cursor-pointer"
              >
                <span>{bioExpanded ? 'Minder tonen' : 'Lees meer'}</span>
                {bioExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Sets Section */}
      <div className="p-4 sm:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Disc3 size={20} className="text-[var(--color-crystal-cyan,#00e5ff)]" />
            <h2 className="text-lg sm:text-xl font-bold text-white">
              Beschikbare Livesets ({sets.length})
            </h2>
          </div>
        </div>

        {sets.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {sets.map((set) => {
              const isCurrent = currentSetId === set.id;
              const liked = isLiked(set.id);

              return (
                <div
                  key={set.id}
                  onClick={() => handlePlaySet(set)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handlePlaySet(set);
                    }
                  }}
                  className={`group relative p-3.5 rounded-2xl bg-[var(--color-crystal-card,#1a1a26)]/80 hover:bg-[var(--color-crystal-card,#1a1a26)] border transition-all duration-200 cursor-pointer select-none space-y-3 flex flex-col justify-between ${
                    isCurrent
                      ? 'border-[var(--color-crystal-cyan,#00e5ff)] shadow-[0_0_20px_rgba(0,229,255,0.2)]'
                      : 'border-[var(--color-crystal-border,#222230)] hover:border-white/20'
                  }`}
                >
                  <div className="space-y-3">
                    {/* Cover art image */}
                    <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-[var(--color-crystal-surface,#12121a)] border border-white/5">
                      <img
                        src={set.coverArt || artist.image}
                        alt={set.title}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        loading="lazy"
                        onError={(e) => {
                          (e.currentTarget as HTMLElement).style.display = 'none';
                        }}
                      />

                      {/* Play overlay button */}
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <div className="w-11 h-11 rounded-full bg-[var(--color-crystal-cyan,#00e5ff)] text-black flex items-center justify-center shadow-lg transform group-hover:scale-110 transition-transform">
                          <Play size={20} className="fill-black ml-0.5" />
                        </div>
                      </div>

                      {/* Festival badge */}
                      {set.festival && (
                        <div className="absolute top-2 left-2 px-2 py-0.5 rounded-md text-[10px] font-bold bg-black/70 text-[var(--color-crystal-cyan,#00e5ff)] border border-white/10 backdrop-blur-md">
                          {set.festival}
                        </div>
                      )}

                      {/* Duration */}
                      <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded-md text-[10px] font-mono font-medium bg-black/80 text-white backdrop-blur-sm">
                        {formatTime(set.duration)}
                      </div>
                    </div>

                    {/* Title and details */}
                    <div>
                      <h3 className="text-sm font-bold text-white group-hover:text-[var(--color-crystal-cyan,#00e5ff)] transition-colors line-clamp-2 leading-tight">
                        {set.title}
                      </h3>

                      <div className="flex items-center gap-2 mt-1.5 text-xs text-gray-400">
                        {set.year && (
                          <span className="flex items-center gap-1 font-mono">
                            <Calendar size={11} />
                            {set.year}
                          </span>
                        )}
                        {set.stage && (
                          <span className="text-gray-500">• {set.stage}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Actions footer */}
                  <div className="flex items-center justify-between pt-2 border-t border-white/5">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleLike(set.id);
                      }}
                      className={`p-1.5 rounded-lg hover:bg-white/10 transition-colors cursor-pointer ${
                        liked ? 'text-[var(--color-crystal-pink,#ff007f)]' : 'text-gray-500 hover:text-white'
                      }`}
                      aria-label={liked ? 'Verwijder uit favorieten' : 'Voeg toe aan favorieten'}
                    >
                      <Heart size={18} className={liked ? 'fill-current' : ''} />
                    </button>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handlePlaySet(set);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-[var(--color-crystal-cyan,#00e5ff)]/15 hover:bg-[var(--color-crystal-cyan,#00e5ff)]/25 text-[var(--color-crystal-cyan,#00e5ff)] text-xs font-bold border border-[var(--color-crystal-cyan,#00e5ff)]/30 transition-colors cursor-pointer"
                    >
                      <Play size={13} className="fill-current" />
                      <span>{isCurrent && isPlaying ? 'Spelend' : 'Afspelen'}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-12 text-gray-400">
            <Disc3 size={48} className="mx-auto mb-4 opacity-30" />
            <p className="font-medium">Geen sets gevonden</p>
            <p className="text-sm mt-1">Er zijn nog geen livesets van {artist?.name} in de bibliotheek</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default DJDetailPage;
