import { createRoute } from '@tanstack/react-router';
import { Route as rootRoute } from './__root';
import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../stores/useAuthStore';
import { consumeGoogleCallback } from '../services/authRequest';
import { Loader2, AlertCircle } from 'lucide-react';

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/callback',
  component: AuthCallbackPage,
});

function AuthCallbackPage() {
  const started = useRef(false);
  const login = useAuthStore((s) => s.login);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    async function handle() {
      try {
        const fragment = window.location.hash;
        // Never leave bearer material in browser history, including failed callbacks.
        window.history.replaceState(null, '', window.location.pathname);
        const { idToken, expectedNonce, returnUrl } = consumeGoogleCallback(fragment);
        const ok = await login(idToken, expectedNonce);
        if (ok) window.location.replace('/app' + returnUrl);
        else setError('Authenticatie mislukt. Probeer opnieuw in te loggen.');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Ongeldige Google-aanvraag. Probeer opnieuw.');
      }
    }
    void handle();
  }, [login]);

  return (
    <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 text-center p-6">
        {error ? (
          <>
            <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400">
              <AlertCircle size={24} />
            </div>
            <p role="alert" className="text-sm text-red-400">{error}</p>
            <a href="/app/discover" className="text-base underline">Terug naar inloggen</a>
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
