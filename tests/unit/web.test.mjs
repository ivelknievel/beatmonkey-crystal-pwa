import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
const root = process.cwd();
const read = p => fs.readFile(path.join(root, p), 'utf8');
async function moduleSource(file, deps = {}) {
  const code = ts.transpileModule(await read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('require', 'exports', code)(id => { if (id in deps) return deps[id]; throw Error(`Unexpected import ${id}`); }, exports);
  return exports;
}
async function worker({ failInstall = false, clients = [] } = {}) {
  const handlers = {}, deleted = [], names = ['other-app-v1', 'beatmonkey-crystal-v20', 'beatmonkey-shell-old'];
  const storage = new Map(names.map(n => [n, new Map()]));
  let skipped = 0, claimed = 0;
  const context = { URL, Response, Request, console,
    self: { location: { origin: 'https://example.test' }, addEventListener: (n, fn) => { handlers[n] = fn; }, skipWaiting: () => { skipped++; }, clients: { claim: () => { claimed++; }, matchAll: async () => clients } },
    caches: { keys: async () => [...storage.keys()], delete: async n => { deleted.push(n); return storage.delete(n); }, open: async n => {
      if (!storage.has(n)) storage.set(n, new Map());
      const m = storage.get(n);
      return { addAll: async urls => { if (failInstall) throw Error('offline install'); for (const u of urls) m.set(u, new Response(u)); }, match: async req => m.get(typeof req === 'string' ? req : new URL(req.url).pathname) };
    } }, fetch: async () => { throw Error('offline'); },
  };
  context.clients = context.self.clients;
  const code = (await read('public/service-worker.js')).replace('/* __PRECACHE_CONFIG__ */', `self.__PRECACHE__ = { version: 'fixture', urls: ['/app/', '/app/index.html', '/app/assets/index-abc.js', '/app/manifest.json'] };`);
  vm.runInNewContext(code, context);
  const fire = async (type, extras = {}) => { let promise; let response; handlers[type]({ waitUntil: p => { promise = p; }, respondWith: p => { response = p; }, ...extras }); await promise; return response ? await response : undefined; };
  return { fire, deleted, storage, skipped: () => skipped, claimed: () => claimed };
}
test('failed SW install leaves previous and unrelated caches intact; no unconditional takeover', async () => {
  const w = await worker({ failInstall: true });
  await assert.rejects(w.fire('install'));
  assert.deepEqual(w.deleted, []);
  assert.equal(w.skipped(), 0);
});
test('successful shell install provides hashed bundles and navigation fallback, not API/stream/mutation/Range', async () => {
  const w = await worker(); await w.fire('install'); await w.fire('activate');
  assert.equal(w.claimed(), 0);
  assert.ok(w.storage.has('other-app-v1'));
  assert.equal(w.storage.has('beatmonkey-shell-old'), false);
  assert.ok(w.storage.has('beatmonkey-crystal-v20'), 'legacy cache retained for old clients');
  const request = (url, extra = {}) => ({ url: `https://example.test${url}`, method: 'GET', headers: new Headers(), mode: 'cors', ...extra });
  const nav = await w.fire('fetch', { request: request('/app/set/song?t=12', { mode: 'navigate' }) });
  assert.equal(await nav.text(), '/app/index.html');
  const asset = await w.fire('fetch', { request: request('/app/assets/index-abc.js') });
  assert.equal(await asset.text(), '/app/assets/index-abc.js');
  for (const r of [request('/api/private'), request('/app/auth/callback', { mode: 'navigate' }), request('/rest/stream.view'), request('/app/assets/music.mp3', { destination: 'audio' }), request('/app/assets/video.mp4', { destination: 'video' }), request('/app/assets/index-abc.js', { method: 'POST' }), request('/app/assets/index-abc.js', { headers: new Headers({ Range: 'bytes=0-' }) }), request('/app/index.html?token=private')]) {
    assert.equal(await w.fire('fetch', { request: r }), undefined, r.url);
  }
});
test('activation retains old owned assets for open clients and skipWaiting requires explicit scoped message', async () => {
  const w = await worker({ clients: [{ url: 'https://example.test/app/' }] });
  await w.fire('install'); await w.fire('activate');
  assert.deepEqual(w.deleted, []);
  w.storage.get('beatmonkey-shell-old').set('/app/assets/old-bundle.js', new Response('old release'));
  const old = await w.fire('fetch', { request: { url: 'https://example.test/app/assets/old-bundle.js', method: 'GET', mode: 'cors', headers: new Headers() } });
  assert.equal(await old.text(), 'old release');
  await w.fire('message', { data: { type: 'ACTIVATE_UPDATE' }, source: { url: 'https://example.test/other/' } });
  await w.fire('message', { data: { type: 'UNRELATED' }, source: { url: 'https://example.test/app/' } });
  assert.equal(w.skipped(), 0);
  await w.fire('message', { data: { type: 'ACTIVATE_UPDATE' }, source: { url: 'https://example.test/app/' } });
  assert.equal(w.skipped(), 1);
  assert.equal(w.claimed(), 0);
});
test('generated worker hashes real build shell and changes version when content changes', async () => {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'web-shell-'));
  try {
    await fs.mkdir(path.join(dir, 'assets'));
    await fs.writeFile(path.join(dir, 'index.html'), '<script src="/app/assets/index-abcd.js"></script>');
    await fs.writeFile(path.join(dir, 'assets/index-abcd.js'), 'fixture-v1');
    await fs.writeFile(path.join(dir, 'manifest.json'), '{}');
    const run = () => execFileSync(process.execPath, ['scripts/generate-service-worker.mjs', dir], { cwd: root, encoding: 'utf8' });
    run(); const first = await fs.readFile(path.join(dir, 'service-worker.js'), 'utf8');
    assert.ok(first.includes('/app/assets/index-abcd.js'));
    run(); assert.equal(await fs.readFile(path.join(dir, 'service-worker.js'), 'utf8'), first);
    await fs.writeFile(path.join(dir, 'assets/index-abcd.js'), 'fixture-v2');
    run(); assert.notEqual(await fs.readFile(path.join(dir, 'service-worker.js'), 'utf8'), first);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('generator refuses an index that refers to a missing release bundle', async () => {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'web-missing-'));
  try {
    await fs.writeFile(path.join(dir, 'index.html'), '<script type="module" src="/app/assets/missing-abc.js"></script>');
    await fs.writeFile(path.join(dir, 'manifest.json'), '{}');
    assert.throws(() => execFileSync(process.execPath, ['scripts/generate-service-worker.mjs', dir], { cwd: root, stdio: 'pipe' }));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('credential navigation bypasses the shell but shared timestamps do not', async () => {
  const w = await worker(); await w.fire('install');
  for (const query of ['u=private&p=private', 'token=private', 'access_token=private', 'id_token=private']) {
    const response = await w.fire('fetch', { request: { url: `https://example.test/app/?${query}`, method: 'GET', mode: 'navigate', headers: new Headers() } });
    assert.equal(response, undefined, query);
  }
});
test('sharing uses HTTPS browser song identity and integer times, cancellation is not an error', async () => {
  const { buildShareUrl, shareLink, parseShareTime } = await moduleSource('src/utils/shareLinks.ts');
  assert.equal(buildShareUrl({ id: 'album', songId: 'song /?#' }, 42.9), 'https://music.cyberspeeze.online/app/set/song%20%2F%3F%23?t=42');
  assert.equal(buildShareUrl({ id: 'album /' }, NaN), 'https://music.cyberspeeze.online/app/set/album%20%2F?t=0');
  for (const v of ['-1', '1.5', 'Infinity', '9007199254740992', undefined]) assert.equal(parseShareTime(v), 0);
  assert.equal(parseShareTime('42'), 42);
  assert.equal(await shareLink({ title: 't', text: 's', url: 'https://example.test' }, { share: async () => { throw Object.assign(Error(), { name: 'AbortError' }); } }), 'cancelled');
  assert.equal(await shareLink({ title: 't', url: 'https://example.test' }, { share: async () => { throw { name: 'AbortError' }; } }), 'cancelled');
  await assert.rejects(shareLink({ title: 't', text: 's', url: 'https://example.test' }, { share: async () => { throw Error('denied'); } }));
});
test('shared route observes timestamp and ignores late song metadata', async () => {
  let params = { id: 'song-A' }, search = { t: 42 }, effects = [], cleanups = [], selected = [], resolveA;
  const a = new Promise(r => { resolveA = r; });
  const react = { useState: v => [v, () => {}], useRef: v => ({ current: v }), useEffect: (fn, deps) => { effects.push({ fn, deps }); } };
  const store = { getState: () => ({ loadSet: async (set, t) => { selected.push({ set, t }); }, setFullscreen() {} }) };
  const { Route } = await moduleSource('src/routes/set.$id.tsx', {
    '@tanstack/react-router': { createRoute: config => ({ ...config, useParams: () => params, useSearch: () => search }) }, react,
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null }, './__root': { Route: {} },
    '../services/subsonic': { getSong: id => id === 'song-A' ? a : Promise.resolve({ song: { id, albumId: 'album-B' } }), getAlbum: async id => ({ album: { id, name: id, song: [{ id: 'first-song' }, { id: 'song-B' }] } }), getCoverUrl: id => id },
    '../stores/playerStore': { usePlayerStore: store }, '../utils/shareLinks': await moduleSource('src/utils/shareLinks.ts'),
  });
  Route.component(); assert.ok(effects[0].deps.includes(42), 'timestamp is an effect dependency');
  cleanups.push(effects[0].fn()); effects = []; params = { id: 'song-B' }; search = { t: 81 };
  cleanups[0]?.(); Route.component(); cleanups.push(effects[0].fn());
  await new Promise(r => setImmediate(r)); resolveA({ song: { id: 'song-A', albumId: 'album-A' } }); await new Promise(r => setImmediate(r));
  assert.equal(selected.length, 1); assert.equal(selected[0].set.id, 'album-B'); assert.equal(selected[0].set.songId, 'song-B'); assert.equal(selected[0].t, 81);
  // Same component and song identity: a query-only navigation still opens its new time.
  cleanups[1]?.(); effects = []; search = { t: 99 }; Route.component(); effects[0].fn();
  await new Promise(r => setImmediate(r)); assert.equal(selected.length, 2); assert.equal(selected[1].t, 99);
});
test('web UI accessibility, safe areas, gesture cancellation and opt-in visualisation contracts', async () => {
  const scrub = await read('src/components/Player/Scrubber.tsx');
  assert.match(scrub, /aria-valuenow/); assert.match(scrub, /onKeyDown/); assert.match(scrub, /tabIndex=\{0\}/);
  const row = await read('src/components/Player/TrackRow.tsx'); assert.match(row, /onTouchCancel/); assert.match(row, /clientY/); assert.match(row, /suppressClick/);
  const css = await read('src/styles/index.css'); assert.match(css, /prefers-reduced-motion/); assert.match(css, /safe-area-inset-left/); assert.match(css, /font-size: 16px/);
  assert.doesNotMatch(await read('index.html'), /user-scalable=no|maximum-scale/);
  const manifest = JSON.parse(await read('public/manifest.json')); assert.equal(manifest.id, '/app/'); assert.equal(manifest.scope, '/app/');
  const visualizer = await read('src/components/Player/Visualizer.tsx'); assert.match(visualizer, /enabled = false/);
  const tracklist = await read('src/components/Player/TracklistSection.tsx'); assert.match(tracklist, /currentSet\?\.id/); assert.match(tracklist, /requestGeneration/);
});
