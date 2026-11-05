import { useEffect } from 'react';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { BottomNav } from '../Navigation/BottomNav';
import { MiniPlayerBar } from '../MiniPlayer/MiniPlayerBar';
import { FullscreenPlayerOverlay } from '../Player/FullscreenPlayerOverlay';
import { LoginFlow } from '../Auth/LoginFlow';
import { decodeJwt, isTokenValid } from '../../services/authService';
import { usePlayerStore } from '../../stores/playerStore';
import { useAuthStore } from '../../stores/useAuthStore';

export function RootLayout() {
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);
  const { checkSession, isAuthenticated, isLoading, token, logout } = useAuthStore();
  const routerState = useRouterState();
  const isAuthCallback = routerState.location.pathname.includes('/auth/callback');

  useEffect(() => {
    if (isAuthCallback) return;
    void checkSession();
    const recheck = () => { if (document.visibilityState === 'visible') void checkSession(); };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    return () => { window.removeEventListener('focus', recheck); document.removeEventListener('visibilitychange', recheck); };
  }, [checkSession, isAuthCallback]);

  useEffect(() => {
    if (!token) return;
    const exp = decodeJwt(token)?.exp;
    let timer: number;
    let cancelled = false;
    const schedule = () => {
      const remaining = typeof exp === 'number' ? exp * 1000 - Date.now() : 0;
      // Re-arm long sessions after the browser's maximum timer interval.
      timer = window.setTimeout(() => {
        if (cancelled) return;
        if (isTokenValid(token)) schedule(); else void logout();
      }, Math.min(Math.max(remaining, 0), 2147483647));
    };
    schedule();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [token, logout]);

  if (isAuthCallback) return <Outlet />;
  if (isLoading) return <div role="status" className="min-h-dvh grid place-items-center">Sessie controleren...</div>;
  if (!isAuthenticated) return <LoginFlow />;

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
