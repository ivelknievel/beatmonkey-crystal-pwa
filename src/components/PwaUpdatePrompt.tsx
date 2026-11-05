import { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { AudioEngine } from '../engine/AudioEngine';

export function PwaUpdatePrompt() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [activated, setActivated] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState('');
  // Consent belongs to one worker, never to an arbitrary controllerchange.
  const consent = useRef<ServiceWorker | null>(null);
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
    const container = navigator.serviceWorker;
    let disposed = false;
    let controller = container.controller;
    let registration: ServiceWorkerRegistration | undefined;
    let installing: ServiceWorker | null = null;
    let offered: ServiceWorker | null = null;
    let completed: ServiceWorker | null = null;
    const didActivate = (worker: ServiceWorker) => {
      if (disposed || completed === worker) return;
      completed = worker;
      setActivated(true);
      setDismissed(false);
      // Other tabs may activate an update, but cannot authorize this tab's reload.
      const authorized = consent.current === worker;
      consent.current = null;
      if (authorized && canReload()) window.location.reload();
    };
    const waitingChanged = () => {
      if (offered?.state === 'activated') didActivate(offered);
    };
    const observe = () => {
      if (disposed) return;
      const next = registration?.waiting;
      // First installation briefly has a waiting worker too. Require an older worker.
      // An active registration also covers an existing install in an uncontrolled tab.
      if (!next || (!container.controller && !registration?.active) || next === offered) return;
      offered?.removeEventListener?.('statechange', waitingChanged);
      offered = next;
      completed = null;
      consent.current = null;
      offered.addEventListener?.('statechange', waitingChanged);
      setWaiting(next);
      setActivated(false);
      setDismissed(false);
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
      const previous = controller;
      controller = container.controller;
      // Ignore initial acquisition, loss and duplicates, including acquisition
      // before the register() promise settles.
      if (!previous || !controller || previous === controller) return;
      didActivate(controller);
    };
    container.addEventListener('controllerchange', controllerChanged);
    void container.register('/app/service-worker.js', { scope: '/app/', updateViaCache: 'none' }).then(reg => {
      if (disposed) return;
      registration = reg;
      reg.addEventListener('updatefound', updateFound);
      updateFound();
    }).catch(() => { /* Offline first visit remains usable without an installed SW. */ });
    return () => {
      disposed = true;
      consent.current = null;
      registration?.removeEventListener('updatefound', updateFound);
      installing?.removeEventListener('statechange', stateChanged);
      offered?.removeEventListener?.('statechange', waitingChanged);
      container.removeEventListener('controllerchange', controllerChanged);
    };
  }, []);

  const apply = () => {
    if (!canReload()) { setError('Pauzeer eerst de muziek en werk daarna bij.'); return; }
    setError('');
    if (activated || waiting?.state === 'activated') { window.location.reload(); return; }
    if (waiting) {
      consent.current = waiting;
      waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
    }
  };
  if ((!waiting && !activated) || dismissed) return null;
  return <aside className="pwa-update-prompt" role="region" aria-label="App-update">
    <p role="status">Nieuwe versie beschikbaar. {busy ? 'Pauzeer de muziek om veilig bij te werken.' : 'Nu bijwerken herlaadt de app.'}</p>
    {error && <p role="alert">{error}</p>}
    <div className="flex gap-4 mt-2">
      <button type="button" disabled={busy} onClick={apply}>Nu bijwerken</button>
      <button type="button" onClick={() => { consent.current = null; setDismissed(true); }}>Later</button>
    </div>
  </aside>;
}
