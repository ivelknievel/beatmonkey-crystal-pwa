import { createRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Route as rootRoute } from './__root';
import { getAlbum, getSong, getCoverUrl } from '../services/subsonic';
import { usePlayerStore } from '../stores/playerStore';
import { parseShareTime } from '../utils/shareLinks';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/set/$id',
  validateSearch: (search: Record<string, unknown>) => ({ t: parseShareTime(search.t) }),
  component: SharedSetPage,
});

function SharedSetPage() {
  const { id } = Route.useParams();
  const { t } = Route.useSearch();
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    // Owned by this effect run only: aborting it cancels the store load this route
    // started, without resetting a newer selection made elsewhere.
    const controller = new AbortController();
    setError('');
    async function open() {
      try {
        // RootLayout gates this route on the established account session.
        const song = await getSong(id).catch(() => null);
        if (cancelled || controller.signal.aborted) return;
        const albumId = song?.song?.albumId || id;
        const result = await getAlbum(albumId);
        if (cancelled || controller.signal.aborted) return;
        const album = result?.album;
        if (!album?.song?.length) throw new Error('Set niet gevonden');
        const songId = song?.song?.id;
        if (songId && !album.song.some((s: { id: string }) => s.id === songId)) throw new Error('Track niet gevonden in deze set');
        await usePlayerStore.getState().loadSet({
          id: albumId, songId, title: album.name || album.title || 'Live Set',
          artist: album.artist || '', duration: song?.song?.duration || album.duration || 0,
          coverArt: getCoverUrl(album.coverArt || albumId),
          year: album.year || 0, genre: album.genre || '',
        }, t, controller.signal);
        if (cancelled || controller.signal.aborted) return;
        const state = usePlayerStore.getState();
        if (state.error) throw new Error(state.error);
        state.setFullscreen(true);
      } catch (e) {
        if (!cancelled && !controller.signal.aborted) setError(e instanceof Error ? e.message : 'Set openen mislukt');
      }
    }
    void open();
    return () => { cancelled = true; controller.abort(); };
  }, [id, t]);
  return <div className="p-6" role="status">{error || 'Gedeelde set openen…'}</div>;
}
