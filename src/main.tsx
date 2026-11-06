import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import './styles/index.css';
import { PwaUpdatePrompt } from './components/PwaUpdatePrompt';

import { useAuthStore } from './stores/useAuthStore';
import { setAccountScope, getAccountGeneration } from './services/discoveryApi';
import { usePlayerStore } from './stores/playerStore';
import { fetchShareSource } from './services/shareSource';

setAccountScope(useAuthStore.getState().accountScope);
useAuthStore.subscribe(state => setAccountScope(state.accountScope));

let lastSetIdentity: string | null = null;
usePlayerStore.subscribe((state) => {
  const currentSet = state.currentSet;
  const currentIdentity = currentSet ? `${currentSet.id}:${currentSet.songId || ''}` : null;
  if (currentIdentity === lastSetIdentity) {
    return;
  }
  lastSetIdentity = currentIdentity;

  if (!currentSet || (!currentSet.id && !currentSet.songId)) {
    return;
  }

  if (currentSet.youtubeUrl) {
    return;
  }

  const targetId = currentSet.id || currentSet.songId!;
  const targetSongId = currentSet.songId;
  const capturedGen = getAccountGeneration();

  fetchShareSource(targetId).then((youtubeUrl) => {
    if (!youtubeUrl) return;
    const latest = usePlayerStore.getState().currentSet;
    const currentGen = getAccountGeneration();
    if (
      currentGen === capturedGen &&
      latest &&
      (latest.id === targetId || (targetSongId && latest.songId === targetSongId))
    ) {
      if (latest.youtubeUrl !== youtubeUrl) {
        usePlayerStore.setState({
          currentSet: {
            ...latest,
            youtubeUrl,
          },
        });
      }
    }
  }).catch(() => {
    // Gracefully ignore fetch failure
  });
});

const router = createRouter({
  routeTree,
  basepath: import.meta.env.BASE_URL || '/',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <>
    <RouterProvider router={router} />
    <PwaUpdatePrompt />
  </>
);
