import { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { AudioEngine } from '../engine/AudioEngine';

export function PwaUpdatePrompt() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [activated, setActivated] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState('');
  const consent = useRef(false);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const status = usePlayerStore(s => s.status);
  const busy = isPlaying || status === 'loading';
  const canReload = () => {
    const state = usePlayerStore.getState();
    const audio = AudioEngine.getAudioElement();
    return !state.isPlaying && state.status !== 'loading' && (!audio || audio.paused);
  };

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    let disposed = false;
    let registration: ServiceWorkerRegistration | undefined;
    let installing: ServiceWorker | null = null;
    const observe = () => {
      if (!disposed && registration?.waiting) { setWaiting(registration.waiting); setDismissed(false); }
    };
    const stateChanged = () => observe();
    const updateFound = () => {
      installing?.removeEventListener('statechange', stateChanged);
      installing = registration?.installing || null;
      installing?.addEventListener('statechange', stateChanged);
      observe();
    };
    const controllerChanged = () => {
      if (disposed) return;
      // Other tabs can activate the update, but cannot authorize this tab's reload.
      setActivated(true);
      setDismissed(false);
      if (consent.current && canReload()) window.location.reload();
      consent.current = false;
    };
    navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
    void navigator.serviceWorker.register('/app/service-worker.js', { scope: '/app/', updateViaCache: 'none' }).then(reg => {
      if (disposed) return;
      registration = reg;
      reg.addEventListener('updatefound', updateFound);
      updateFound();
    }).catch(() => { /* Offline first visit remains usable without an installed SW. */ });
    return () => {
      disposed = true;
      registration?.removeEventListener('updatefound', updateFound);
      installing?.removeEventListener('statechange', stateChanged);
      navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged);
    };
  }, []);

  const apply = () => {
    if (!canReload()) { setError('Pauzeer eerst de muziek en werk daarna bij.'); return; }
    setError('');
    if (activated) { window.location.reload(); return; }
    if (waiting) {
      consent.current = true;
      waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
    }
  };
  if ((!waiting && !activated) || dismissed) return null;
  return <aside className="pwa-update-prompt" role="region" aria-label="App-update">
    <p role="status">Nieuwe versie beschikbaar. {busy ? 'Pauzeer de muziek om veilig bij te werken.' : 'Nu bijwerken herlaadt de app.'}</p>
    {error && <p role="alert">{error}</p>}
    <div className="flex gap-4 mt-2">
      <button type="button" disabled={busy} onClick={apply}>Nu bijwerken</button>
      <button type="button" onClick={() => { consent.current = false; setDismissed(true); }}>Later</button>
    </div>
  </aside>;
}
