import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const ALBUM = 'fixture-album';
const album = {
  id: ALBUM, name: 'Audit Fixture Liveset', title: 'Audit Fixture Liveset',
  artist: 'Audit Fixture Artist', duration: 180, coverArt: '/app/icon-192.png',
  song: [
    { id: 'fixture-song-one', albumId: ALBUM, title: 'First fixture song', duration: 180 },
  ],
};

interface MockJob {
  id: string;
  url: string;
  status: string;
  owner?: string;
  created_at?: string;
  error?: string | null;
}

let mockJobs: MockJob[] = [];
let jobSeq = 1;
let return401OnPost = false;

async function setupUnifiedFixtures(context: BrowserContext, page: Page) {
  const violations: string[] = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.hostname === 'music.cyberspeeze.online' && response.headers()['x-fixture'] !== '1') {
      violations.push(response.url());
    }
  });

  await context.addInitScript(() => {
    try {
      void navigator.serviceWorker?.getRegistrations?.().then(regs => regs.forEach(r => r.unregister()));
      if (navigator.serviceWorker) {
        navigator.serviceWorker.register = () => Promise.reject(new Error('service worker disabled in tests'));
      }
    } catch { /* no worker */ }
  });

  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === '127.0.0.1' && !url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (url.hostname !== 'music.cyberspeeze.online' && url.hostname !== '127.0.0.1') {
      await route.abort();
      return;
    }

    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Cache-Control': 'no-store',
      'x-fixture': '1',
    };

    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }

    const json = async (value: unknown, status = 200) =>
      route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(value) });
    const sub = async (value: object) =>
      json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...value } });

    // YouTube endpoints
    if (url.pathname === '/api/youtube/jobs') {
      if (request.method() === 'GET') {
        await json(mockJobs);
        return;
      }
      if (request.method() === 'POST') {
        if (return401OnPost) {
          await route.fulfill({ status: 401, headers, contentType: 'application/json', body: JSON.stringify({ detail: 'Unauthorized' }) });
          return;
        }
        const postData = JSON.parse(request.postData() || '{}');
        const newJob: MockJob = {
          id: `job-${jobSeq++}`,
          url: postData.url,
          status: 'pending',
          created_at: new Date().toISOString(),
        };
        mockJobs.push(newJob);
        // 202 Accepted only
        await json(newJob, 202);
        return;
      }
    }

    if (url.pathname.startsWith('/api/youtube/jobs/')) {
      const id = url.pathname.replace('/api/youtube/jobs/', '');
      const job = mockJobs.find(j => j.id === id);
      if (job) {
        await json(job);
      } else {
        await json({ detail: 'Job not found' }, 404);
      }
      return;
    }

    // Subsonic endpoints
    const method = url.pathname.split('/').at(-1)?.replace(/\.view$/, '');
    if (url.pathname.startsWith('/rest/')) {
      if (method === 'ping') { await sub({}); return; }
      if (method === 'getAlbum') { await sub({ album }); return; }
      if (method === 'getAlbumList2') { await sub({ albumList2: { album: [album] } }); return; }
      if (method === 'getPlayQueue') { await sub({}); return; }
      if (method === 'getStarred2') { await sub({ starred2: { album: [], song: [] } }); return; }
      if (method === 'getArtists') { await sub({ artists: { index: [] } }); return; }
      if (method === 'getArtist') { await sub({ artist: { id: 'fixture-artist', name: 'Audit Fixture Artist', album: [album] } }); return; }
      if (method === 'search3') { await sub({ searchResult3: { album: [album], artist: [], song: [] } }); return; }
      await sub({}); return;
    }

    if (url.pathname === '/api/navidrome/recent-albums') { await json({ albums: [album] }); return; }
    if (url.pathname === '/api/festivals') { await json([]); return; }
    if (url.pathname === '/api/discover/djs') { await json({ djs: [] }); return; }
    if (url.pathname === '/api/spotlight') { await route.fulfill({ status: 204, headers }); return; }

    await json({ detail: 'No synthetic fixture for this endpoint' }, 404);
  });

  return violations;
}

async function login(page: Page, user = 'audit-user-a') {
  await page.goto('/app/');
  await page.getByLabel('Gebruikersnaam', { exact: true }).fill(user);
  await page.getByLabel('Wachtwoord', { exact: true }).fill('synthetic-fixture-only');
  await page.getByRole('button', { name: 'Inloggen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Instellingen', exact: true })).toBeVisible();
}

test.describe('YouTube Download Panel Unified Flows', () => {
  test.beforeEach(() => {
    mockJobs = [];
    jobSeq = 1;
    return401OnPost = false;
  });

  test('manual paste -> 202 accepted pending -> completed transitions correctly', async ({ page, context }) => {
    const leaks = await setupUnifiedFixtures(context, page);
    await login(page, 'user-yt-1');

    await page.goto('/app/library');
    const openBtn = page.getByRole('button', { name: 'YouTube-set toevoegen', exact: true });
    await expect(openBtn).toBeVisible();
    await openBtn.click();

    const input = page.getByLabel('YouTube URL', { exact: false });
    await expect(input).toBeVisible();

    const validUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    await input.fill(validUrl);

    const submitBtn = page.getByRole('button', { name: 'Download starten', exact: false });
    await submitBtn.click();

    // Verify 202 accepted creates pending job displayed with Dutch label "In wachtrij"
    await expect(page.getByText('In wachtrij')).toBeVisible();

    // Transition to completed
    mockJobs[0].status = 'completed';

    // Wait for polling or trigger refresh
    await expect(page.getByText('Voltooid')).toBeVisible({ timeout: 10000 });
    expect(leaks).toEqual([]);
  });

  test('clipboard rejected fallback leaves input intact with safe message', async ({ page, context }) => {
    await setupUnifiedFixtures(context, page);
    await login(page, 'user-yt-2');

    await page.goto('/app/library');
    await page.getByRole('button', { name: 'YouTube-set toevoegen', exact: true }).click();

    const input = page.getByLabel('YouTube URL', { exact: false });
    await input.fill('https://youtu.be/existing');

    // Deny clipboard permission or mock clipboard.readText failure
    await context.clearPermissions();
    await page.evaluate(() => {
      navigator.clipboard.readText = () => Promise.reject(new Error('Permission denied'));
    });

    const pasteBtn = page.getByRole('button', { name: 'Plakken', exact: true });
    if (await pasteBtn.isVisible()) {
      await pasteBtn.click();
      // Safe fallback message without destroying manual input
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(input).toHaveValue('https://youtu.be/existing');
    }
  });

  test('401 error retains pending draft and crossaccount logout clears status', async ({ page, context }) => {
    await setupUnifiedFixtures(context, page);
    await login(page, 'user-yt-3');

    await page.goto('/app/library');
    await page.getByRole('button', { name: 'YouTube-set toevoegen', exact: true }).click();

    const input = page.getByLabel('YouTube URL', { exact: false });
    const draftUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    await input.fill(draftUrl);

    // Simulate 401 on submit
    return401OnPost = true;
    const submitBtn = page.getByRole('button', { name: 'Download starten', exact: false });
    await submitBtn.click();

    // Error alert displayed offering login link/action, retaining draft in input
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(input).toHaveValue(draftUrl);

    // Explicit logout
    await page.getByRole('button', { name: 'Instellingen', exact: true }).click();
    await page.getByRole('button', { name: 'Uitloggen', exact: true }).click();

    // Login as cross-account user
    await login(page, 'user-yt-4');
    await page.goto('/app/library');
    await page.getByRole('button', { name: 'YouTube-set toevoegen', exact: true }).click();

    // The cross account must NOT have user-yt-3's draft or statuses
    const crossInput = page.getByLabel('YouTube URL', { exact: false });
    await expect(crossInput).toHaveValue('');
    await expect(page.getByText('In wachtrij')).not.toBeVisible();
  });

  test('close and reopen resumes server state via listYoutubeJobs', async ({ page, context }) => {
    mockJobs = [{
      id: 'job-server-1',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      status: 'running',
      created_at: new Date().toISOString(),
    }];

    await setupUnifiedFixtures(context, page);
    await login(page, 'user-yt-5');

    await page.goto('/app/library');
    const openBtn = page.getByRole('button', { name: 'YouTube-set toevoegen', exact: true });
    await openBtn.click();

    // Should restore running job Dutch label "Bezig"
    await expect(page.getByText('Bezig')).toBeVisible();

    // Navigate away to discover and back to library
    await page.getByRole('button', { name: 'Ontdekken', exact: true }).click();
    await expect(page.getByRole('button', { name: 'YouTube-set toevoegen', exact: true })).not.toBeVisible();

    await page.getByRole('button', { name: 'Bibliotheek', exact: true }).click();
    await page.getByRole('button', { name: 'YouTube-set toevoegen', exact: true }).click();

    await expect(page.getByText('Bezig')).toBeVisible();
  });
});
