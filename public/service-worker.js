/* Generated build injects the complete, content-versioned shell here. */
/* __PRECACHE_CONFIG__ */
const CONFIG = self.__PRECACHE__;
const PREFIX = 'beatmonkey-shell-';
const CACHE = PREFIX + (CONFIG?.version || 'unbuilt');
const SHELL = new Set(CONFIG?.urls || []);

self.addEventListener('install', event => {
  // Failed installation must leave every previous cache intact.
  event.waitUntil((async () => {
    if (!CONFIG?.urls?.includes('/app/index.html')) throw new Error('Missing generated app shell');
    const cache = await caches.open(CACHE);
    await cache.addAll(CONFIG.urls);
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'ACTIVATE_UPDATE' || !event.source?.url) return;
  const source = new URL(event.source.url);
  if (source.origin === self.location.origin && source.pathname.startsWith('/app/')) {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // A previous document may still request its hashed chunks. Keep its cache.
    const openClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (openClients.length) return;
    const cache = await caches.open(CACHE);
    if (!await cache.match('/app/index.html')) return;
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(PREFIX) && name !== CACHE).map(name => caches.delete(name)));
    // No claim: existing clients must opt in with a safe reload.
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || request.headers.has('Range') || request.headers.has('Authorization')) return;
  if (request.destination === 'audio' || request.destination === 'video' || /\.(?:mp3|m4a|aac|ogg|opus|flac|wav|mp4|webm|m3u8|mpd)$/i.test(url.pathname)) return;
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/app/')) return;
  if (/(?:^|\/)(?:api|rest|auth|stream)(?:[/.]|$)/i.test(url.pathname)) return;
  if ([...url.searchParams.keys()].some(key => /^(?:token|jwt|code|state|nonce|password|authorization|u|p|s|access_token|id_token)$/i.test(key))) return;
  if (request.mode !== 'navigate' && url.searchParams.has('t')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try { return await fetch(request); }
      catch {
        const cache = await caches.open(CACHE);
        return await cache.match('/app/index.html') || new Response('App offline. Verbind opnieuw om de app te installeren.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
  } else if (!url.search && SHELL.has(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return await cache.match(url.pathname) || fetch(request);
    })());
  } else if (!url.search && url.pathname.startsWith('/app/assets/')) {
    event.respondWith((async () => {
      for (const name of await caches.keys()) {
        if (!name.startsWith(PREFIX)) continue;
        const cached = await (await caches.open(name)).match(url.pathname);
        if (cached) return cached;
      }
      return fetch(request);
    })());
  }
});
