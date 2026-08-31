import { useEffect, useState } from 'react';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { BottomNav } from '../Navigation/BottomNav';
import { MiniPlayerBar } from '../MiniPlayer/MiniPlayerBar';
import { FullscreenPlayerOverlay } from '../Player/FullscreenPlayerOverlay';
import { LoginFlow } from '../Auth/LoginFlow';
import { AudioEngine } from '../../engine/AudioEngine';
import { setCredentials, ping } from '../../services/subsonic';
import { loadSubsonicCredentials } from '../../services/authService';
import { usePlayerStore } from '../../stores/playerStore';
import { useAuthStore } from '../../stores/useAuthStore';

export function RootLayout() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);
  const checkSession = useAuthStore((s) => s.checkSession);
  const isGoogleAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  const isAuthCallback = pathname.includes('/auth/callback');

  // Check login on mount
  useEffect(() => {
    checkSession();
    async function checkAuth() {
      const creds = await loadSubsonicCredentials();
      if (creds) {
        setCredentials(creds.user, creds.pass);
        const ok = await ping();
        if (ok) {
          setIsLoggedIn(true);
          AudioEngine.init();
          usePlayerStore.getState().setStatus('idle');
          usePlayerStore.getState().syncLikedSets();
          usePlayerStore.getState().restoreLastPosition();
        }
      }
    }
    checkAuth();
  }, [checkSession]);

  // Sync Subsonic state when Google session is established
  useEffect(() => {
    if (isGoogleAuthenticated) {
      async function syncGoogleAuth() {
        const creds = await loadSubsonicCredentials();
        const storeUser = useAuthStore.getState().subsonic_user;
        const storePass = useAuthStore.getState().subsonic_pass;
        const user = creds?.user || storeUser;
        const pass = creds?.pass || storePass || '';
        if (user) {
          setCredentials(user, pass);
          AudioEngine.init();
          usePlayerStore.getState().setStatus('idle');
          usePlayerStore.getState().syncLikedSets();
          usePlayerStore.getState().restoreLastPosition();
          setIsLoggedIn(true);
        }
      }
      syncGoogleAuth();
    }
  }, [isGoogleAuthenticated]);

  if (isAuthCallback) {
    return <Outlet />;
  }

  if (!isLoggedIn && !isGoogleAuthenticated) {
    return <LoginFlow onLogin={() => setIsLoggedIn(true)} />;
  }

  return (
    <div className="grid h-dvh grid-rows-[1fr_auto_auto] overflow-hidden bg-[var(--color-crystal-bg)] text-[#e0e0e0]">
      {/* Scrollable Content Area */}
      <main className="min-h-0 overflow-y-auto scrollbar-none relative safe-bottom">
        <Outlet />
      </main>

      {/* Floating MiniPlayerBar */}
      <MiniPlayerBar />

      {/* Fixed Bottom Navigation */}
      <BottomNav />

      {/* Fullscreen Player Overlay */}
      {isFullscreen && <FullscreenPlayerOverlay />}
    </div>
  );
}

export default RootLayout;
