import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = new URL('../../', import.meta.url);

function source(path) {
  return readFileSync(new URL(path, root), 'utf8');
}

function loadTs(path, deps = {}, globals = {}) {
  const text = source(path)
    .replace(/import\.meta\.env\.VITE_GOOGLE_CLIENT_ID/g, "'fixture-client'")
    .replace(/import\.meta\.env\.PROD/g, 'true');
  const js = ts.transpileModule(text, {
    fileName: path,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;

  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' };
  const context = {
    exports: {},
    require: (id) => {
      if (id === 'react/jsx-runtime') return jsx;
      if (id in deps) return deps[id];
      if (id === '../stores/useAuthStore') {
        return {
          useAuthStore: {
            getState: () => ({ accountScope: null }),
            subscribe: () => () => {},
          },
        };
      }
      throw Error('Unexpected dependency: ' + id);
    },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Headers,
    Request,
    Response,
    atob,
    btoa,
    fetch: async () => { throw Error('Unexpected network fetch call'); },
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    AbortSignal,
    document: globals.document || {
      hidden: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    window: globals.window || {
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    ...globals,
  };
  vm.runInNewContext(js, context, { filename: path });
  return context.exports;
}

// Minimal React hook harness
function createHookHarness() {
  const slots = [];
  let cursor = 0;
  let queued = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  const react = {
    useState(initial) {
      const n = cursor++;
      slots[n] ??= { value: typeof initial === 'function' ? initial() : initial };
      const setter = (v) => {
        slots[n].value = typeof v === 'function' ? v(slots[n].value) : v;
      };
      return [slots[n].value, setter];
    },
    useRef(initial) {
      const n = cursor++;
      return slots[n] ??= { current: initial };
    },
    useCallback(fn, deps) {
      const n = cursor++;
      if (!slots[n] || !same(slots[n].deps, deps)) slots[n] = { fn, deps };
      return slots[n].fn;
    },
    useEffect(fn, deps) {
      const n = cursor++;
      if (!slots[n] || !same(slots[n].deps, deps)) {
        const old = slots[n];
        slots[n] = { deps, cleanup: old?.cleanup };
        queued.push(() => {
          old?.cleanup?.();
          slots[n].cleanup = fn();
        });
      }
    },
    useMemo(fn, deps) {
      const n = cursor++;
      if (!slots[n] || !same(slots[n].deps, deps)) {
        slots[n] = { value: fn(), deps };
      }
      return slots[n].value;
    },
  };

  return {
    react,
    slots,
    render(fn, props) {
      cursor = 0;
      const tree = fn(props);
      const work = queued;
      queued = [];
      work.forEach((cb) => cb());
      return tree;
    },
    unmount() {
      slots.forEach((s) => s?.cleanup?.());
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

// Test 1: Regression check - getRecentSets subscription and publication contract
test('regression: getRecentSets background network revalidation must publish fresh SIDEPIECE to mounted listener/state', async () => {
  const cosmicGate = [{
    id: 'cosmic-gate-set',
    title: 'Cosmic Gate - Live at ASOT',
    artist: 'Cosmic Gate',
    duration: 3600,
    coverArt: 'cover-cosmic',
  }];

  const sidepiece = [{
    id: 'sidepiece-open-air-la-2026',
    title: 'SIDEPIECE Open Air LA2026',
    artist: 'SIDEPIECE',
    duration: 3600,
    coverArt: 'cover-sidepiece',
  }];

  const cacheStore = new Map([['recent_sets_v2:signed-out', cosmicGate]]);
  let resolveNetwork;
  const networkPromise = new Promise((resolve) => { resolveNetwork = resolve; });

  const cacheMock = {
    get: async (store, key) => cacheStore.get(key) || null,
    set: async (store, key, val) => { cacheStore.set(key, val); },
    del: async (store, key) => { cacheStore.delete(key); },
    TTL: { SET: 86400000, FESTIVAL: 3600000, ARTIST: 86400000 },
  };

  const subsonicMock = {
    getAlbumList: async () => {
      await networkPromise;
      return { albumList2: { album: sidepiece } };
    },
    getCoverUrl: (id) => `url-${id}`,
  };

  const discoveryApi = loadTs('src/services/discoveryApi.ts', {
    './authService': { authenticatedFetch: async () => new Response('{}') },
    './cache': cacheMock,
    './subsonic': subsonicMock,
    '../types': {},
  });

  assert.strictEqual(
    typeof discoveryApi.subscribeRecentSets,
    'function',
    'discoveryApi must export subscribeRecentSets function for reactive publication'
  );

  let publishedSets = null;
  const unsubscribe = discoveryApi.subscribeRecentSets((sets) => {
    publishedSets = sets;
  });

  const initial = await discoveryApi.getRecentSets();
  assert.deepStrictEqual(initial, cosmicGate, 'Initial return must be cached Cosmic Gate');

  resolveNetwork();
  await flush();
  await flush();

  assert.notStrictEqual(publishedSets, null, 'subscribeRecentSets listener must have received network update');
  assert.strictEqual(publishedSets[0].id, 'sidepiece-open-air-la-2026', 'Published set must be SIDEPIECE Open Air LA2026');

  unsubscribe();
});

// Test 2: DiscoverPage mounted component: cached CosmicGate renders initially -> network revalidation updates visible list to SIDEPIECE
test('DiscoverPage mounted: cached CosmicGate renders initially -> network revalidation updates visible list to SIDEPIECE', async () => {
  const cosmicGate = [{
    id: 'cosmic-gate-set',
    title: 'Cosmic Gate - Live at ASOT',
    artist: 'Cosmic Gate',
    duration: 3600,
    coverArt: 'cover-cosmic',
  }];

  const sidepiece = [{
    id: 'sidepiece-open-air-la-2026',
    title: 'SIDEPIECE Open Air LA2026',
    artist: 'SIDEPIECE',
    duration: 3600,
    coverArt: 'cover-sidepiece',
  }];

  const cacheStore = new Map([['recent_sets_v2:signed-out', cosmicGate]]);
  let resolveNetwork;
  const networkPromise = new Promise((resolve) => { resolveNetwork = resolve; });

  const cacheMock = {
    get: async (store, key) => cacheStore.get(key) || null,
    set: async (store, key, val) => { cacheStore.set(key, val); },
    del: async (store, key) => { cacheStore.delete(key); },
    TTL: { SET: 86400000, FESTIVAL: 3600000, ARTIST: 86400000 },
  };

  const subsonicMock = {
    getAlbumList: async () => {
      await networkPromise;
      return { albumList2: { album: sidepiece } };
    },
    getCoverUrl: (id) => `url-${id}`,
  };

  const discoveryApi = loadTs('src/services/discoveryApi.ts', {
    './authService': { authenticatedFetch: async () => new Response('{}') },
    './cache': cacheMock,
    './subsonic': subsonicMock,
    '../types': {},
  });

  let storeRecentSets = [];
  let storeFestivals = [];
  const playerStoreMock = {
    usePlayerStore: (selector) => {
      const state = {
        festivals: storeFestivals,
        recentSets: storeRecentSets,
        setFestivals: (f) => { storeFestivals = f; },
        setRecentSets: (s) => { storeRecentSets = s; },
      };
      return selector(state);
    },
  };

  const h = createHookHarness();
  const { DiscoverPage } = loadTs('src/pages/DiscoverPage.tsx', {
    react: h.react,
    'lucide-react': {
      Disc3: () => null,
      PartyPopper: () => null,
      AlertCircle: () => null,
      RotateCcw: () => null,
    },
    '../services/discoveryApi': discoveryApi,
    '../stores/playerStore': playerStoreMock,
    '../components/Discover/FestivalCarousel': { FestivalCarousel: () => null },
    '../components/Discover/RecentCarousel': { RecentCarousel: () => null },
    '../components/Discover/SpotlightCard': { SpotlightCard: () => null },
    '../components/Shared/LoadingSpinner': { LoadingSpinner: () => null },
  });

  h.render(DiscoverPage, {});
  await flush();
  await flush();

  // Initial render: Cosmic Gate is rendered from cache
  assert.strictEqual(storeRecentSets.length, 1, 'Should have 1 set from cache');
  assert.strictEqual(storeRecentSets[0].id, 'cosmic-gate-set', 'Should render Cosmic Gate initially');

  // Network completes: SIDEPIECE should now be published and visible in store
  resolveNetwork();
  await flush();
  await flush();

  assert.strictEqual(storeRecentSets[0].id, 'sidepiece-open-air-la-2026', 'Mounted visible state should update to SIDEPIECE');
  h.unmount();
});

// Test 3: Remount: after revalidation, remount immediately renders SIDEPIECE from updated cache
test('DiscoverPage remount: after revalidation, remount immediately renders SIDEPIECE from updated cache', async () => {
  const sidepiece = [{
    id: 'sidepiece-open-air-la-2026',
    title: 'SIDEPIECE Open Air LA2026',
    artist: 'SIDEPIECE',
    duration: 3600,
    coverArt: 'cover-sidepiece',
  }];

  const cacheStore = new Map([['recent_sets_v2:signed-out', sidepiece]]);

  const cacheMock = {
    get: async (store, key) => cacheStore.get(key) || null,
    set: async (store, key, val) => { cacheStore.set(key, val); },
    del: async (store, key) => { cacheStore.delete(key); },
    TTL: { SET: 86400000, FESTIVAL: 3600000, ARTIST: 86400000 },
  };

  const discoveryApi = loadTs('src/services/discoveryApi.ts', {
    './authService': { authenticatedFetch: async () => new Response('{}') },
    './cache': cacheMock,
    './subsonic': { getAlbumList: async () => ({ albumList2: { album: sidepiece } }), getCoverUrl: (id) => `url-${id}` },
    '../types': {},
  });

  let storeRecentSets = [];
  const playerStoreMock = {
    usePlayerStore: (selector) => {
      const state = {
        festivals: [{ name: 'Awakenings' }],
        recentSets: storeRecentSets,
        setFestivals: () => {},
        setRecentSets: (s) => { storeRecentSets = s; },
      };
      return selector(state);
    },
  };

  const h = createHookHarness();
  const { DiscoverPage } = loadTs('src/pages/DiscoverPage.tsx', {
    react: h.react,
    'lucide-react': { Disc3: () => null, PartyPopper: () => null, AlertCircle: () => null, RotateCcw: () => null },
    '../services/discoveryApi': discoveryApi,
    '../stores/playerStore': playerStoreMock,
    '../components/Discover/FestivalCarousel': { FestivalCarousel: () => null },
    '../components/Discover/RecentCarousel': { RecentCarousel: () => null },
    '../components/Discover/SpotlightCard': { SpotlightCard: () => null },
    '../components/Shared/LoadingSpinner': { LoadingSpinner: () => null },
  });

  h.render(DiscoverPage, {});
  await flush();
  await flush();

  assert.strictEqual(storeRecentSets[0].id, 'sidepiece-open-air-la-2026', 'Remount must render SIDEPIECE immediately from cache');
  h.unmount();
});

// Test 4: Offline retained: cached sets retained without error when network fails
test('DiscoverPage offline retained: cached CosmicGate retained when network fails or device is offline', async () => {
  const cosmicGate = [{
    id: 'cosmic-gate-set',
    title: 'Cosmic Gate - Live at ASOT',
    artist: 'Cosmic Gate',
    duration: 3600,
    coverArt: 'cover-cosmic',
  }];

  const cacheStore = new Map([['recent_sets_v2:signed-out', cosmicGate]]);

  const cacheMock = {
    get: async (store, key) => cacheStore.get(key) || null,
    set: async (store, key, val) => { cacheStore.set(key, val); },
    del: async (store, key) => { cacheStore.delete(key); },
    TTL: { SET: 86400000, FESTIVAL: 3600000, ARTIST: 86400000 },
  };

  const subsonicMock = {
    getAlbumList: async () => {
      throw new Error('Network offline');
    },
    getCoverUrl: (id) => `url-${id}`,
  };

  const discoveryApi = loadTs('src/services/discoveryApi.ts', {
    './authService': { authenticatedFetch: async () => { throw new Error('Network offline'); } },
    './cache': cacheMock,
    './subsonic': subsonicMock,
    '../types': {},
  });

  let storeRecentSets = [];
  const playerStoreMock = {
    usePlayerStore: (selector) => {
      const state = {
        festivals: [{ name: 'Awakenings' }],
        recentSets: storeRecentSets,
        setFestivals: () => {},
        setRecentSets: (s) => { storeRecentSets = s; },
      };
      return selector(state);
    },
  };

  const h = createHookHarness();
  const { DiscoverPage } = loadTs('src/pages/DiscoverPage.tsx', {
    react: h.react,
    'lucide-react': { Disc3: () => null, PartyPopper: () => null, AlertCircle: () => null, RotateCcw: () => null },
    '../services/discoveryApi': discoveryApi,
    '../stores/playerStore': playerStoreMock,
    '../components/Discover/FestivalCarousel': { FestivalCarousel: () => null },
    '../components/Discover/RecentCarousel': { RecentCarousel: () => null },
    '../components/Discover/SpotlightCard': { SpotlightCard: () => null },
    '../components/Shared/LoadingSpinner': { LoadingSpinner: () => null },
  });

  h.render(DiscoverPage, {});
  await flush();
  await flush();

  assert.strictEqual(storeRecentSets.length, 1, 'Should retain cached set');
  assert.strictEqual(storeRecentSets[0].id, 'cosmic-gate-set', 'Should retain Cosmic Gate in offline mode');
  h.unmount();
});

// Test 5: Account switch race: delayed accountA cache or network response never affects accountB visible state or cache
test('Account switch race: delayed accountA cache or network response never affects accountB visible state or cache', async () => {
  const accountASets = [{ id: 'account-a-set', title: 'Account A Exclusive', artist: 'Artist A' }];
  const accountBSets = [{ id: 'account-b-set', title: 'Account B Exclusive', artist: 'Artist B' }];

  let resolveAccountAFetch;
  const accountAFetchPromise = new Promise((resolve) => { resolveAccountAFetch = resolve; });

  const cacheStore = new Map();
  const cacheMock = {
    get: async (store, key) => cacheStore.get(key) || null,
    set: async (store, key, val) => { cacheStore.set(key, val); },
    del: async (store, key) => { cacheStore.delete(key); },
    TTL: { SET: 86400000, FESTIVAL: 3600000, ARTIST: 86400000 },
  };

  let isAccountA = true;
  const subsonicMock = {
    getAlbumList: async () => {
      if (isAccountA) {
        await accountAFetchPromise;
        return { albumList2: { album: accountASets } };
      }
      return { albumList2: { album: accountBSets } };
    },
    getCoverUrl: (id) => `url-${id}`,
  };

  const discoveryApi = loadTs('src/services/discoveryApi.ts', {
    './authService': { authenticatedFetch: async () => new Response('{}') },
    './cache': cacheMock,
    './subsonic': subsonicMock,
    '../types': {},
  });

  // Start an actual network request under Account A (not just a pending cache read).
  discoveryApi.setAccountScope('userA');
  const initialFetch = discoveryApi.getRecentSets();
  await flush();

  // User logs out and switches to Account B while fetch is inflight.
  isAccountA = false;
  discoveryApi.setAccountScope('userB');
  let publishedSets = [];
  discoveryApi.subscribeRecentSets((sets) => { publishedSets = sets; });
  await discoveryApi.getRecentSets();
  assert.equal(publishedSets[0].id, 'account-b-set');

  // Now resolve Account A's inflight fetch
  resolveAccountAFetch();
  await initialFetch.catch(() => {});
  await flush();
  await flush();

  // The published sets must NOT be Account A's sets!
  const hasAccountASets = publishedSets.some((s) => s.id === 'account-a-set');
  assert.strictEqual(hasAccountASets, false, 'Account A sets must never be published to Account B');

  // Also check cache: Account B cache must not contain Account A sets
  const cachedAfter = cacheStore.get(discoveryApi.getAccountScopedKey('recent_sets_v2', 'userB'));
  const cacheHasAccountA = Array.isArray(cachedAfter) && cachedAfter.some((s) => s.id === 'account-a-set');
  assert.strictEqual(cacheHasAccountA, false, 'Account B cache must not be contaminated by Account A response');
});

// Test 6: Concurrent invalidation: inflight response started before invalidation does not overwrite cache or publish stale data
test('Concurrent invalidation: inflight response started before invalidation does not overwrite cache or publish stale data', async () => {
  const staleSets = [{ id: 'stale-set', title: 'Stale Pre-Invalidation Set', artist: 'Old' }];
  const freshSets = [{ id: 'fresh-set', title: 'Fresh Post-Invalidation Set', artist: 'New' }];

  let resolveStaleFetch;
  const stalePromise = new Promise((resolve) => { resolveStaleFetch = resolve; });

  const cacheStore = new Map();
  const cacheMock = {
    get: async (store, key) => cacheStore.get(key) || null,
    set: async (store, key, val) => { cacheStore.set(key, val); },
    del: async (store, key) => { cacheStore.delete(key); },
    TTL: { SET: 86400000, FESTIVAL: 3600000, ARTIST: 86400000 },
  };

  let fetchCount = 0;
  const subsonicMock = {
    getAlbumList: async () => {
      fetchCount++;
      if (fetchCount === 1) {
        await stalePromise;
        return { albumList2: { album: staleSets } };
      }
      return { albumList2: { album: freshSets } };
    },
    getCoverUrl: (id) => `url-${id}`,
  };

  const discoveryApi = loadTs('src/services/discoveryApi.ts', {
    './authService': { authenticatedFetch: async () => new Response('{}') },
    './cache': cacheMock,
    './subsonic': subsonicMock,
    '../types': {},
  });

  let publishedSets = [];
  discoveryApi.subscribeRecentSets?.((sets) => {
    publishedSets = sets;
  });

  // Start fetch 1
  const p1 = discoveryApi.getRecentSets();
  await flush(); // Prove the first network request has actually started.
  assert.equal(fetchCount, 1);

  // While fetch 1 is inflight, download completes -> targeted invalidation
  await discoveryApi.invalidateDiscoveryCache?.('all');

  // Now resolve fetch 1
  resolveStaleFetch();
  await p1.catch(() => {});
  await flush();
  await flush();

  // Published sets must NOT be stale sets!
  const hasStale = publishedSets.some((s) => s.id === 'stale-set');
  assert.strictEqual(hasStale, false, 'Stale inflight data must not be published after invalidation');
  assert.equal(publishedSets[0].id, 'fresh-set');
});

test('delayed account A cache read cannot publish or start network after switching to B', async () => {
  let resolveRead;
  const delayed = new Promise(resolve => { resolveRead = resolve; });
  let requests = 0;
  const api = loadTs('src/services/discoveryApi.ts', {
    './authService': { authenticatedFetch: async () => { throw Error('Unexpected'); } },
    './cache': { get: () => delayed, set: async () => {}, del: async () => {}, TTL: {} },
    './subsonic': { getAlbumList: async () => { requests++; return {}; }, getCoverUrl: id => id },
  });
  api.setAccountScope('A');
  const pending = api.getRecentSets(); await flush();
  api.setAccountScope('B');
  const values = []; api.subscribeRecentSets(v => values.push(v));
  resolveRead([{ id: 'private-a' }]); await pending;
  assert.equal(values.length, 0);
  assert.equal(requests, 0);
});
