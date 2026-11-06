import { test, expect, type BrowserContext, type Page } from '@playwright/test';

// Explicit synthetic fixtures: never reach the production API, Google or audio origin.
// Every fulfilled response carries x-fixture; a leaked production response fails the test.
const ALBUM = '2tOSEwE7kRK1Mg0jJsBXDn';
const SONG = '2tOSEwE7kRK1Mg0jJsBXDn';
const album = {
  id: ALBUM, name: 'Cosmic Gate live at EDC Colombia 2026', title: 'Cosmic Gate live at EDC Colombia 2026',
  artist: 'Audit Fixture Artist', duration: 7200, coverArt: '/app/icon-192.png',
  song: [
    { id: 'fixture-song-one', albumId: ALBUM, title: 'First fixture song', duration: 7200 },
    { id: SONG, albumId: ALBUM, title: 'Second fixture song', duration: 7200 },
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
async function fixtures(context: BrowserContext, page: Page, options: { restore?: boolean; blockServiceWorker?: boolean } = {}) {
  const violations: string[] = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.hostname === 'music.cyberspeeze.online' && response.headers()['x-fixture'] !== '1') violations.push(response.url());
  });
  await context.addInitScript(({ block }) => {
    const Original = window.Audio;
    const Wrapped = function (...args: ConstructorParameters<typeof Audio>) {
      const audio = new Original(...args);
      let paused = true;
      let src = '';
      Object.defineProperties(audio, {
        src: { get: () => src, set: value => { src = value; } },
        currentSrc: { get: () => src }, duration: { get: () => 7200 },
        readyState: { get: () => 4 }, paused: { get: () => paused },
        load: { value: () => { queueMicrotask(() => { audio.dispatchEvent(new Event('loadedmetadata')); audio.dispatchEvent(new Event('canplay')); }); } },
        play: { value: async () => { paused = false; audio.dispatchEvent(new Event('play')); } },
        pause: { value: () => { paused = true; audio.dispatchEvent(new Event('pause')); } },
      });
      (window as any).__fixtureAudio = audio;
      return audio;
    };
    Wrapped.prototype = Original.prototype;
    window.Audio = Wrapped as typeof Audio;
    if (block) {
      // Keep Playwright request routing authoritative: a controlling worker bypasses
      // it for page fetches in WebKit and could otherwise reach the live server.
      try {
        void navigator.serviceWorker?.getRegistrations?.().then(regs => regs.forEach(r => r.unregister()));
        if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(new Error('service worker disabled in tests'));
      } catch { /* no worker support */ }
    }
  }, { block: !!options.blockServiceWorker });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === '127.0.0.1' && !url.pathname.startsWith('/api/')) { await route.continue(); return; }
    if (!['music.cyberspeeze.online', '127.0.0.1'].includes(url.hostname)) { await route.abort(); return; }
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Cache-Control': 'no-store', 'x-fixture': '1' };
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
    if (url.pathname.startsWith('/api/navidrome/source/')) { await json({ youtube_url: 'https://www.youtube.com/watch?v=yClxCRg6b-8' }); return; }
    if (url.pathname === '/api/navidrome/recent-albums') { await json({ albums: [album] }); return; }
    if (url.pathname.startsWith('/api/tracklists/')) { await json([{ title: 'Intro', artist: 'Intro Artist', timeSec: 0 }, { title: 'Nothing To Hide WAKE YOUR MIND (BLACK HOLE )', artist: 'Cosmic Gate & Diana Miro', timeSec: 1050 }]); return; }
    if (url.pathname === '/api/tracklist/resolve') { await json({ found: false }); return; }
    if (url.pathname === '/api/festivals') { await json([]); return; }
    if (url.pathname === '/api/discover/djs') { await json({ djs: [] }); return; }
    if (url.pathname === '/api/spotlight') { await route.fulfill({ status: 204, headers }); return; }
    await json({ detail: 'No synthetic fixture for this endpoint' }, 404);
  });
  return violations;
}
async function login(page: Page, user = 'audit-a') {
  await page.goto('/app/');
  await page.getByLabel('Gebruikersnaam', { exact: true }).fill(user);
  // Synthetic fixture value, not a real user credential.
  await page.getByLabel('Wachtwoord', { exact: true }).fill('synthetic-fixture-only');
  await page.getByRole('button', { name: 'Inloggen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Instellingen', exact: true })).toBeVisible();
}


const expected = '🎵 Om 17:30 in Cosmic Gate live at EDC Colombia 2026\n' +
  'Cosmic Gate & Diana Miro - Nothing To Hide WAKE YOUR MIND (BLACK HOLE )\n\n' +
  `Android: https://music.cyberspeeze.online/go/set/${SONG}?t=1050\n\n` +
  `IOS: https://music.cyberspeeze.online/app/set/${SONG}?t=1050\n\n` +
  'YouTube: https://www.youtube.com/watch?v=yClxCRg6b-8&t=1050s\n\n#BeatmonkeyCrystal';

async function openShare(page: Page) {
  await page.getByRole('button', { name: 'Deel liveset', exact: true }).click();
  return page.getByRole('dialog', { name: 'Liveset delen', exact: true });
}

test('share composer: real source fixture, current store cue, same timestamps, native full text and cancellation', async ({ context, page }) => {
  const leaks = await fixtures(context, page, { blockServiceWorker: true });
  await context.addInitScript(() => {
    (window as any).__shareCalls = [];
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => {
      (window as any).__shareCalls.push(data);
      if ((window as any).__cancelShare) throw new DOMException('Cancelled', 'AbortError');
    } });
  });
  await login(page);
  await page.goto(`/app/set/${SONG}?t=1050`);
  const player = page.getByRole('dialog', { name: 'Volledig scherm speler', exact: true });
  await expect(player).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__fixtureAudio?.currentTime)).toBe(1050);
  // Open tracklist to fetch actual fixture cues into the live store.
  await player.getByRole('button', { name: /Tracklist/ }).click();
  await expect(page.getByRole('dialog', { name: 'Tracklist', exact: true })).toContainText('Nothing To Hide');
  await page.keyboard.press('Escape');
  const share = await openShare(page);
  await expect(share.getByLabel('Deeltekst', { exact: true })).toHaveText(expected);
  await share.getByRole('button', { name: /Vanaf dit moment/ }).click();
  expect(await page.evaluate(() => (window as any).__shareCalls)).toEqual([{ title: 'Deel Liveset', text: expected }]);
  await page.evaluate(() => { (window as any).__cancelShare = true; });
  const cancelled = await openShare(page);
  await cancelled.getByRole('button', { name: 'Vanaf het begin', exact: true }).click();
  await expect(player).not.toContainText('Delen is niet gelukt');
  const calls = await page.evaluate(() => (window as any).__shareCalls);
  expect(calls[1].text).toContain('?t=0');
  expect(calls[1].text).toContain('&t=0s');
  expect(calls[1]).not.toHaveProperty('url');
  expect(leaks).toEqual([]);
});

test('clipboard fallback preserves complete text, missing source omits only YouTube', async ({ context, page }) => {
  const leaks = await fixtures(context, page, { blockServiceWorker: true });
  await context.route('**/api/navidrome/source/**', route => route.fulfill({ status: 200,
    headers: { 'x-fixture': '1', 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: '{"youtube_url":null}' }));
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copied = text; } } });
  });
  await login(page);
  await page.goto(`/app/set/${SONG}?t=1050`);
  const player = page.getByRole('dialog', { name: 'Volledig scherm speler', exact: true });
  await expect(player).toBeVisible();
  const share = await openShare(page);
  await share.getByRole('button', { name: 'Vanaf het begin', exact: true }).click();
  const text = await page.evaluate(() => (window as any).__copied);
  expect(text).toBe(`🎵 Om 0:00 in Cosmic Gate live at EDC Colombia 2026\n\nAndroid: https://music.cyberspeeze.online/go/set/${SONG}?t=0\n\nIOS: https://music.cyberspeeze.online/app/set/${SONG}?t=0\n\n#BeatmonkeyCrystal`);
  await expect(player).toContainText('Link gekopieerd.');
  expect(leaks).toEqual([]);
});
