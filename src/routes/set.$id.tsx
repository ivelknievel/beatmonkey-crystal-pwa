import { createRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Route as rootRoute } from './__root';
import { getAlbum, getSong, getCoverUrl } from '../services/subsonic';
import { usePlayerStore } from '../stores/playerStore';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/set/$id',
  component: SharedSetPage,
});

function SharedSetPage() {
  const { id } = Route.useParams();
  const started = useRef('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (started.current === id) return;
    started.current = id;
    async function open() {
      try {
        // The parent RootLayout mounts this route only after mandatory login.
        const song = await getSong(id).catch(() => null);
        const albumId = song?.song?.albumId || id;
        const result = await getAlbum(albumId);
        const album = result?.album;
        if (!album?.song?.length) throw new Error('Set niet gevonden');
        const raw = new URLSearchParams(window.location.search).get('t');
        const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : 0;
        const start = Number.isSafeInteger(seconds) ? Math.max(0, seconds) : 0;
        await usePlayerStore.getState().loadSet({
          id: albumId, title: album.name || album.title || 'Live Set',
          artist: album.artist || '', duration: album.duration || 0,
          coverArt: getCoverUrl(album.coverArt || albumId),
          year: album.year || 0, genre: album.genre || '',
        }, start);
        const state = usePlayerStore.getState();
        if (state.error) throw new Error(state.error);
        state.setFullscreen(true);
      } catch (e) { setError(e instanceof Error ? e.message : 'Set openen mislukt'); }
    }
    void open();
  }, [id]);
  return <div className="p-6">{error || 'Gedeelde set openen…'}</div>;
}
