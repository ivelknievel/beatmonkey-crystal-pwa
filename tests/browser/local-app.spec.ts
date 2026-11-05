import { test, expect, type BrowserContext, type Page } from '@playwright/test';

// Explicit synthetic fixtures: never talk to the production API or Google.
const ALBUM = 'fixture-album';
const SONG = 'fixture-song-two';
const album = {
  id: ALBUM, name: 'Audit Fixture Liveset', title: 'Audit Fixture Liveset',
  artist: 'Audit Fixture Artist', duration: 180, coverArt: '/app/icon-192.png',
  song: [
    { id: 'fixture-song-one', albumId: ALBUM, title: 'First fixture song', duration: 180 },
    { id: SONG, albumId: ALBUM, title: 'Second fixture song', duration: 180 },
  ],
};
function silentWav(seconds = 180) {
  const rate = 8000, bytes = seconds * rate * 2;
  const data = Buffer.alloc(44 + bytes);
  data.write('RIFF', 0); data.writeUInt32LE(36 + bytes, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(bytes, 40);
  return data;
}
const wav = silentWav();
async function fixtures(context: BrowserContext, options: { restore?: boolean } = {}) {
  await context.addInitScript(() => {
    const Original = window.Audio;
    const Wrapped = function (...args: ConstructorParameters<typeof Audio>) {
      const audio = new Original(...args);
      (window as any).__fixtureAudio = audio;
      return audio;
    };
    Wrapped.prototype = Original.prototype;
    window.Audio = Wrapped as typeof Audio;
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === '127.0.0.1') { await route.continue(); return; }
    if (url.hostname !== 'music.cyberspeeze.online') { await route.abort(); return; }
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Cache-Control': 'no-store' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    const json = async (value: unknown, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(value) });
    const sub = async (value: object) => json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...value } });
    const method = url.pathname.split('/').at(-1)?.replace(/\.view$/, '');
    if (url.pathname.startsWith('/rest/')) {
      if (method === 'stream') {
        const range = request.headers().range;
        if (range) {
          const match = /^bytes=(\d+)-(\d*)/.exec(range);
          const start = Number(match?.[1] || 0), end = Math.min(wav.length - 1, match?.[2] ? Number(match[2]) : wav.length - 1);
          await route.fulfill({ status: 206, headers: { ...headers, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${wav.length}` }, contentType: 'audio/wav', body: wav.subarray(start, end + 1) });
        } else await route.fulfill({ status: 200, headers: { ...headers, 'Accept-Ranges': 'bytes' }, contentType: 'audio/wav', body: wav });
        return;
      }
      if (method === 'ping') { await sub({}); return; }
      if (method === 'getSong') {
        const song = album.song.find(s => s.id === url.searchParams.get('id'));
        if (song) await sub({ song }); else await json({ 'subsonic-response': { status: 'failed', error: { code: 70, message: 'Fixture song not found' } } });
        return;
      }
      if (method === 'getAlbum') { await sub({ album }); return; }
      if (method === 'getAlbumList2') { await sub({ albumList2: { album: [album] } }); return; }
      if (method === 'getPlayQueue') {
        await sub(options.restore ? { playQueue: { current: SONG, position: 42000, entry: [{ id: SONG, albumId: ALBUM }] } } : {}); return;
      }
      if (method === 'getStarred2') { await sub({ starred2: { album: url.searchParams.get('u') === 'audit-a' ? [album] : [], song: [] } }); return; }
      if (method === 'getArtists') { await sub({ artists: { index: [] } }); return; }
      if (method === 'getArtist') { await sub({ artist: { id: 'fixture-artist', name: 'Audit Fixture Artist', album: [album] } }); return; }
      if (method === 'search3') { await sub({ searchResult3: { album: [album], artist: [], song: [] } }); return; }
      if (method === 'getCoverArt') { await route.abort(); return; }
      await sub({}); return;
    }
    if (url.pathname === '/api/navidrome/recent-albums') { await json({ albums: [album] }); return; }
    if (url.pathname.startsWith('/api/tracklists/')) { await json([{ title: 'Fixture cue one', artist: 'Fixture DJ', timeSec: 0 }, { title: 'Fixture cue two', artist: 'Fixture DJ', timeSec: 60 }]); return; }
    if (url.pathname === '/api/tracklist/resolve') { await json({ found: false }); return; }
    if (url.pathname === '/api/festivals') { await json([]); return; }
    if (url.pathname === '/api/discover/djs') { await json({ djs: [] }); return; }
    if (url.pathname === '/api/spotlight') { await route.fulfill({ status: 204, headers }); return; }
    await json({ detail: 'No synthetic fixture for this endpoint' }, 404);
  });
}
async function login(page: Page, user = 'audit-a') {
  await page.goto('/app/');
  await page.getByLabel('Gebruikersnaam', { exact: true }).fill(user);
  // Synthetic fixture value, not a real user credential.
  await page.getByLabel('Wachtwoord', { exact: true }).fill('synthetic-fixture-only');
  await page.getByRole('button', { name: 'Inloggen', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Beatmonkey Crystal', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Instellingen/i })).toBeVisible();
}

test('manual login, explicit second song, real media seek and full logout', async ({ page, context }, info) => {
  await fixtures(context); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await login(page);
  await page.goto(`/app/set/${SONG}?t=12`);
  const player = page.getByRole('dialog', { name: 'Volledig scherm speler', exact: true });
  await expect(player).toBeVisible();
  await expect(player).toContainText('Audit Fixture Liveset');
  await expect.poll(() => page.evaluate(() => (window as any).__fixtureAudio?.src || '')).toContain(`id=${SONG}`);
  await expect.poll(() => page.evaluate(() => (window as any).__fixtureAudio?.readyState || 0)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as any).__fixtureAudio?.currentTime || 0)).toBeGreaterThanOrEqual(11);
  const media = await page.evaluate(() => ({ paused: (window as any).__fixtureAudio.paused }));
  if (media.paused) await player.getByRole('button', { name: 'Afspelen', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__fixtureAudio.paused)).toBe(false);
  const slider = player.getByRole('slider', { name: 'Tijdlijn' });
  await slider.focus(); await slider.press('Home');
  await expect.poll(() => page.evaluate(() => (window as any).__fixtureAudio.currentTime)).toBeLessThan(3);
  await slider.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => (window as any).__fixtureAudio.currentTime)).toBeGreaterThanOrEqual(4);
  await page.screenshot({ path: info.outputPath('player.png') });
  await page.keyboard.press('Escape');
  await expect(player).not.toBeVisible();
  await page.getByRole('link', { name: /Instellingen/i }).click();
  await page.getByRole('button', { name: 'Uitloggen', exact: true }).click();
  await expect(page.getByLabel('Gebruikersnaam', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({ paused: (window as any).__fixtureAudio?.paused, source: (window as any).__fixtureAudio?.getAttribute('src') || '' }))).toEqual({ paused: true, source: '' });
  expect(errors).toEqual([]);
});

test('cold session restore prepares the real source paused at the saved position', async ({ page, context }) => {
  await fixtures(context, { restore: true }); await login(page);
  await page.reload();
  await expect(page.getByRole('link', { name: /Instellingen/i })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__fixtureAudio?.src || '')).toContain(`id=${SONG}`);
  await expect.poll(() => page.evaluate(() => (window as any).__fixtureAudio?.currentTime || 0)).toBeGreaterThanOrEqual(41);
  expect(await page.evaluate(() => (window as any).__fixtureAudio.paused)).toBe(true);
});

test('generated service worker supports a cold offline app-shell navigation', async ({ page, context }, info) => {
  await fixtures(context);
  await page.goto('/app/');
  await expect(page.getByLabel('Gebruikersnaam', { exact: true })).toBeVisible();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const assets = await page.evaluate(async () => {
    const names = (await caches.keys()).filter(n => n.startsWith('beatmonkey-shell-'));
    const keys = (await Promise.all(names.map(async n => (await (await caches.open(n)).keys()).map(r => new URL(r.url).pathname)))).flat();
    return keys;
  });
  expect(assets.some(p => p.endsWith('.js'))).toBe(true);
  expect(assets.some(p => p.endsWith('.css'))).toBe(true);
  await context.setOffline(true);
  await page.goto('/app/library');
  await expect(page.getByLabel('Gebruikersnaam', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('offline-shell.png') });
  await context.setOffline(false);
});
