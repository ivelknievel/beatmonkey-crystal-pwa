import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import './styles/index.css';
import { PwaUpdatePrompt } from './components/PwaUpdatePrompt';

import { useAuthStore } from './stores/useAuthStore';
import { setAccountScope } from './services/discoveryApi';

setAccountScope(useAuthStore.getState().accountScope);
useAuthStore.subscribe(state => setAccountScope(state.accountScope));

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
