import { useState, useEffect, useMemo } from 'react';
import { Users, SearchX } from 'lucide-react';
import { getDJs, subscribeLibrary, getAccountGeneration } from '../services/discoveryApi';
import { usePlayerStore } from '../stores/playerStore';
import { SearchBar } from '../components/Library/SearchBar';
import { AlphabeticalIndex } from '../components/Library/AlphabeticalIndex';
import { DJGrid } from '../components/Library/DJGrid';
import { LoadingSpinner } from '../components/Shared/LoadingSpinner';
import { YouTubeDownloadPanel } from '../components/YouTubeDownloadPanel';

export function LibraryPage() {
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLetter, setSelectedLetter] = useState('');

  const artists = usePlayerStore((s) => s.artists);
  const setArtists = usePlayerStore((s) => s.setArtists);

  useEffect(() => {
    let mounted = true;
    const unsubscribe = subscribeLibrary(djs => { setArtists(djs); setLoading(false); });
    const load = async () => {
      const generation = getAccountGeneration();
      try { await getDJs(); } catch { /* Retain cached content offline. */ }
      finally { if (mounted && generation === getAccountGeneration()) setLoading(false); }
    };
    void load();
    const foreground = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', foreground);
    window.addEventListener('focus', foreground);
    window.addEventListener('online', foreground);
    return () => {
      mounted = false;
      unsubscribe();
      document.removeEventListener('visibilitychange', foreground);
      window.removeEventListener('focus', foreground);
      window.removeEventListener('online', foreground);
    };
  }, [setArtists]);

  // Compute available letters from artist list
  const availableLetters = useMemo(() => {
    const set = new Set<string>();
    artists.forEach((a) => {
      const first = a.name.trim().charAt(0).toUpperCase();
      if (/[A-Z]/.test(first)) {
        set.add(first);
      } else {
        set.add('#');
      }
    });
    return set;
  }, [artists]);

  // Filter artists
  const filteredArtists = useMemo(() => {
    return artists.filter((artist) => {
      const matchesSearch =
        !searchQuery ||
        artist.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        artist.genres?.some((g) => g.toLowerCase().includes(searchQuery.toLowerCase()));

      if (!matchesSearch) return false;

      if (!selectedLetter) return true;

      const first = artist.name.trim().charAt(0).toUpperCase();
      if (selectedLetter === '#') {
        return !/[A-Z]/.test(first);
      }
      return first === selectedLetter;
    });
  }, [artists, searchQuery, selectedLetter]);

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6 pb-20">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-[var(--color-crystal-border,#222230)] pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-[var(--color-crystal-surface,#12121a)] border border-[var(--color-crystal-border,#222230)] text-[var(--color-crystal-cyan,#00e5ff)]">
            <Users className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">DJ Bibliotheek</h1>
            <p className="text-xs sm:text-sm text-gray-400">
              Blader door artiesten, producers en live resident DJs
            </p>
          </div>
        </div>

        <div className="text-right hidden sm:block">
          <span className="text-sm font-semibold text-[var(--color-crystal-cyan,#00e5ff)]">
            {artists.length}
          </span>
          <span className="text-xs text-gray-400 block">Artiesten</span>
        </div>
      </header>

      {/* YouTube Download Panel */}
      <YouTubeDownloadPanel />

      {/* Search & Alphabetical Controls */}
      <div className="space-y-3">
        <SearchBar
          value={searchQuery}
          onChange={(q) => {
            setSearchQuery(q);
            if (q && selectedLetter) {
              setSelectedLetter('');
            }
          }}
          placeholder="Zoek DJ's, festivals of sets..."
        />

        {artists.length > 0 && (
          <AlphabeticalIndex
            activeLetter={selectedLetter}
            onSelectLetter={(letter) => {
              setSelectedLetter(letter);
              if (letter && searchQuery) {
                setSearchQuery('');
              }
            }}
            availableLetters={availableLetters}
          />
        )}
      </div>

      {/* Content */}
      {loading ? (
        <LoadingSpinner label="DJ catalogus laden..." />
      ) : filteredArtists.length > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs text-gray-400 px-1">
            <span>
              {filteredArtists.length} {filteredArtists.length === 1 ? "DJ gevonden" : "DJ's gevonden"}
            </span>
            {(searchQuery || selectedLetter) && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setSelectedLetter('');
                }}
                className="text-[var(--color-crystal-cyan,#00e5ff)] hover:underline cursor-pointer"
              >
                Filters wissen
              </button>
            )}
          </div>
          <DJGrid artists={filteredArtists} />
        </div>
      ) : (
        <div className="rounded-2xl border border-[var(--color-crystal-border,#222230)] bg-[var(--color-crystal-card,#1a1a26)]/50 p-10 text-center space-y-3 my-8">
          <div className="w-12 h-12 rounded-full bg-[var(--color-crystal-surface,#12121a)] flex items-center justify-center mx-auto text-gray-400">
            <SearchX className="w-6 h-6" />
          </div>
          <h3 className="text-base font-semibold text-white">Geen DJ's gevonden</h3>
          <p className="text-xs sm:text-sm text-gray-400 max-w-sm mx-auto">
            Geen artiesten gevonden die overeenkomen met je zoekopdracht "{searchQuery || selectedLetter}".
          </p>
          <button
            type="button"
            onClick={() => {
              setSearchQuery('');
              setSelectedLetter('');
            }}
            className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition-colors cursor-pointer"
          >
            Toon alle DJ's
          </button>
        </div>
      )}
    </div>
  );
}

export default LibraryPage;
