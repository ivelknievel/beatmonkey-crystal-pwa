import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const cosmic = { id: 'cached-cosmic', title: 'Cached Cosmic Gate', artist: 'Cosmic Gate', duration: 3600 };
const side = { id: 'fresh-sidepiece', title: 'SIDEPIECE Open Air LA2026', artist: 'SIDEPIECE', duration: 3600 };

async function fixture(context: BrowserContext, page: Page) {
  let newest = cosmic;
  let djName = 'Cosmic Gate';
  let completed = false;
  let gate: Promise<void> | null = null;
  let release: (() => void) | undefined;
  let newestRequests = 0;
  const leaks: string[] = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if ((url.pathname.startsWith('/api/') || url.pathname.startsWith('/rest/')) && response.headers()['x-fixture'] !== '1') leaks.push(url.pathname);
  });
  await context.addInitScript(() => {
    if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(new Error('fixture: worker disabled'));
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === '127.0.0.1' && !url.pathname.startsWith('/api/')) return route.continue();
    if (!['127.0.0.1', 'music.cyberspeeze.online'].includes(url.hostname)) return route.abort();
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Cache-Control': 'no-store', 'x-fixture': '1' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const json = (value: unknown) => route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(value) });
    const sub = (value: object) => json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...value } });
    if (url.pathname.startsWith('/rest/')) {
      const method = url.pathname.split('/').at(-1)?.replace(/\.view$/, '');
      if (method === 'getAlbumList2') { newestRequests++; if (gate) await gate; return sub({ albumList2: { album: [newest] } }); }
      if (method === 'getStarred2') return sub({ starred2: { album: [], song: [] } });
      if (method === 'getArtists') return sub({ artists: { index: [] } });
      return sub({});
    }
    if (url.pathname === '/api/discover/djs') return json({ djs: [{ id: 'fixture-dj', dj_name: djName, liveset_count: 1 }] });
    if (url.pathname === '/api/navidrome/recent-albums') return json({ albums: [newest] });
    if (url.pathname === '/api/festivals') return json([]);
    if (url.pathname === '/api/spotlight') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/api/youtube/jobs') return json([{ id: 'fixture-existing-job', url: 'https://www.youtube.com/watch?v=hTBlDqsvwi8', status: completed ? 'completed' : 'running' }]);
    return route.fulfill({ status: 404, headers, contentType: 'application/json', body: '{}' });
  });
  return {
    leaks, requests: () => newestRequests,
    hold() { gate = new Promise<void>(r => { release = r; }); },
    release() { release?.(); gate = null; },
    sidepiece() { newest = side; djName = 'SIDEPIECE'; },
    complete() { completed = true; newest = side; djName = 'SIDEPIECE'; },
  };
}
async function login(page: Page) {
  await page.goto('/app/');
  await page.getByLabel('Gebruikersnaam', { exact: true }).fill('recent-fixture-user');
  await page.getByLabel('Wachtwoord', { exact: true }).fill('synthetic-fixture-only');
  await page.getByRole('button', { name: 'Inloggen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Instellingen', exact: true })).toBeVisible();
}
const recent = (page: Page) => page.locator('section').filter({ has: page.getByRole('heading', { name: 'Recent Toegevoegd', exact: true }) });

test('mounted cached CosmicGate revalidates to SIDEPIECE without reload; remount and foreground remain fresh', async ({ context, page }) => {
  const f = await fixture(context, page);
  await login(page);
  await expect(recent(page)).toContainText('Cached Cosmic Gate');
  await page.getByRole('button', { name: 'Bibliotheek', exact: true }).click();
  f.hold();
  await page.getByRole('button', { name: 'Ontdekken', exact: true }).click();
  await expect(recent(page)).toContainText('Cached Cosmic Gate');
  const before = f.requests();
  f.sidepiece(); f.release();
  await expect(recent(page)).toContainText('SIDEPIECE Open Air LA2026');
  await expect(recent(page)).not.toContainText('Cached Cosmic Gate');
  await page.getByRole('button', { name: 'Bibliotheek', exact: true }).click();
  f.hold();
  await page.getByRole('button', { name: 'Ontdekken', exact: true }).click();
  await expect(recent(page)).toContainText('SIDEPIECE Open Air LA2026');
  f.release();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(f.requests).toBeGreaterThan(before);
  await expect(recent(page)).toContainText('SIDEPIECE Open Air LA2026');
  expect(f.leaks).toEqual([]);
});

test('restored completed download invalidates recent and refreshes mounted DJ library without reload', async ({ context, page }) => {
  const f = await fixture(context, page);
  await login(page);
  await expect(recent(page)).toContainText('Cached Cosmic Gate');
  await page.getByRole('button', { name: 'Bibliotheek', exact: true }).click();
  await expect(page.locator('main')).toContainText('Cosmic Gate');
  f.complete();
  await page.getByRole('button', { name: 'YouTube-set toevoegen', exact: true }).click();
  await expect(page.locator('main')).toContainText('Voltooid');
  await expect(page.locator('main')).toContainText('SIDEPIECE');
  await expect(page.locator('main')).not.toContainText('Cosmic Gate');
  await page.getByRole('button', { name: 'Ontdekken', exact: true }).click();
  await expect(recent(page)).toContainText('SIDEPIECE Open Air LA2026');
  expect(f.leaks).toEqual([]);
});
