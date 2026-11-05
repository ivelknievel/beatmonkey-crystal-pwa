import { createRoute, useNavigate } from '@tanstack/react-router';
import { Route as rootRoute } from './__root';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/useAuthStore';
import { AudioEngine } from '../engine/AudioEngine';
import { usePlayerStore } from '../stores/playerStore';
import { setCredentials } from '../services/subsonic';
import { Loader2, AlertCircle } from 'lucide-react';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/callback',
  component: AuthCallbackPage,
});

function AuthCallbackPage() {
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function handle() {
      // Google returned with #id_token=... in the URL fragment
      const hash = window.location.hash.substring(1);
      const params = new URLSearchParams(hash);
      const idToken = params.get('id_token');
      
      if (!idToken) {
        setError('Geen token ontvangen van Google');
        return;
      }
      
      const ok = await login(idToken);
      if (ok) {
        const { subsonic_user, subsonic_pass } = useAuthStore.getState();
        if (subsonic_user) {
          setCredentials(subsonic_user, subsonic_pass || '');
        }
        AudioEngine.init();
        usePlayerStore.getState().setStatus('idle');
        usePlayerStore.getState().syncLikedSets();
        // Shared set navigation takes priority over the saved play queue.
        const returnUrl = sessionStorage.getItem('auth_return_url') || '/discover';
        sessionStorage.removeItem('auth_return_url');
        const safeReturn = returnUrl.startsWith('/') && !returnUrl.startsWith('//') ? returnUrl.replace(/^\/app(?=\/|$)/, '') : '/discover';
        window.location.replace('/app' + safeReturn);
      } else {
        setError('Authenticatie mislukt');
      }
    }
    handle();
  }, [login, navigate]);

  return (
    <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 text-center p-6">
        {error ? (
          <>
            <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400">
              <AlertCircle size={24} />
            </div>
            <p className="text-sm text-red-400">{error}</p>
          </>
        ) : (
          <>
            <Loader2 className="w-8 h-8 text-[var(--color-crystal-cyan)] animate-spin" />
            <p className="text-sm text-gray-400">Bezig met inloggen...</p>
          </>
        )}
      </div>
    </div>
  );
}
