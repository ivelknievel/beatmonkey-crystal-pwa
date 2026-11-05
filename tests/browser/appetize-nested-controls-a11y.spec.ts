import { test, expect } from '@playwright/test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Hermetic component fixture: real React, components, FavoriteButton and Tailwind
// CSS; only router/store/media/API dependencies are replaced by explicit spies.
// No live API, media, credentials, Appetize or deployment is involved.
let fixtureHtml: string;
test.beforeAll(async () => {
  const root = process.cwd();
  const mocks: Record<string, string> = {
    '@tanstack/react-router': `export const useNavigate = () => value => window.__a11yCalls.navigate.push(value);`,
    '../../stores/playerStore': `
      const state = {
        currentSet: { id: 'fixture-set', title: 'Fixture set', artist: 'Fixture artist' },
        isPlaying: false, status: 'paused', isFullscreen: false, likedSetIds: [],
        loadSet: (...args) => window.__a11yCalls.load.push(args),
        togglePlay: () => window.__a11yCalls.toggle++,
        setFullscreen: value => window.__a11yCalls.fullscreen.push(value),
        toggleLike: id => window.__a11yCalls.like.push(id),
      };
      export const usePlayerStore = select => select(state);`,
    '../../engine/AudioEngine': 'export const AudioEngine = { getCurrentTime: () => 0, getDuration: () => 0 };',
    '../../services/subsonic': 'export const getCoverUrl = () => "/fixture-cover.svg";',
  };
  const entryId = 'virtual:appetize-nested-controls-fixture';
  const entry = `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { SpotlightCard } from ${JSON.stringify(path.join(root, 'src/components/Discover/SpotlightCard.tsx'))};
    import { MiniPlayerBar } from ${JSON.stringify(path.join(root, 'src/components/MiniPlayer/MiniPlayerBar.tsx'))};
    import ${JSON.stringify(path.join(root, 'src/styles/index.css'))};
    window.__a11yCalls = { navigate: [], load: [], toggle: 0, fullscreen: [], like: [] };
    const festival = {
      slug: 'fixture-festival', name: 'Fixture Festival', logo: '/fixture-cover.svg',
      date: 'Fixture date', description: 'Fixture description',
      stages: [{ sets: [{ id: 'fixture-set', title: 'Fixture set', artist: 'Fixture artist' }] }],
    };
    createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null,
      React.createElement(SpotlightCard, { festival }), React.createElement(MiniPlayerBar)));
  `;
  const result = await build({
    configFile: false, root, logLevel: 'error',
    plugins: [
      {
        name: 'appetize-a11y-explicit-fixtures', enforce: 'pre',
        resolveId(id) { if (id === entryId || id in mocks) return `\0${id}`; },
        load(id) { if (id === `\0${entryId}`) return entry; if (id.startsWith('\0')) return mocks[id.slice(1)]; },
      },
      react(), tailwindcss(),
    ],
    build: { write: false, minify: false, rollupOptions: { input: entryId } },
  });
  if (Array.isArray(result) || !('output' in result)) throw Error('Expected one in-memory fixture bundle');
  const js = result.output.filter(output => output.type === 'chunk').map(output => output.code).join('\n');
  const css = result.output.filter(output => output.type === 'asset' && output.fileName.endsWith('.css')).map(output => output.source).join('\n');
  fixtureHtml = `<!doctype html><html lang="nl"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main id="root" style="max-width:640px;margin:auto"></main><script type="module">${js}</script></body></html>`;
});

test.beforeEach(async ({ page, context }) => {
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    const headers = { 'x-fixture': '1' };
    if (url.hostname === '127.0.0.1' && url.pathname === '/app/__appetize-a11y-fixture') {
      return route.fulfill({ contentType: 'text/html', headers, body: fixtureHtml });
    }
    if (url.hostname === '127.0.0.1' && url.pathname === '/fixture-cover.svg') {
      return route.fulfill({ contentType: 'image/svg+xml', headers, body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300"><rect width="100%" height="100%" fill="#123"/></svg>' });
    }
    return route.abort();
  });
  await page.goto('/app/__appetize-a11y-fixture');
  await expect(page.getByRole('button', { name: 'Speel Top Set', exact: true })).toBeVisible();
});

const calls = (page: import('@playwright/test').Page) => page.evaluate(() => (window as any).__a11yCalls);

test('separate roles/names and native Tab order are exposed without nested interactive ancestors', async ({ page }) => {
  const spotlight = page.getByRole('article', { name: 'Spotlight festival: Fixture Festival', exact: true });
  const mini = page.getByRole('region', { name: 'Mini-player: Fixture set - Fixture artist', exact: true });
  await expect(spotlight.getByRole('button')).toHaveCount(2);
  await expect(mini.getByRole('button')).toHaveCount(3);
  const labels = ['Bekijk Festival: Fixture Festival', 'Speel Top Set', 'Open speler: Fixture set - Fixture artist', 'Voeg toe aan favorieten', 'Afspelen'];
  for (const label of labels) {
    const control = page.getByRole('button', { name: label, exact: true });
    await expect(control).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(control).toBeFocused();
    expect(await control.evaluate(el => el.parentElement?.closest('button, a, [role="button"], [tabindex="0"]') !== null)).toBe(false);
    expect(await control.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
  }
  expect(await calls(page)).toEqual({ navigate: [], load: [], toggle: 0, fullscreen: [], like: [] });
});

for (const activation of ['pointer', 'Enter', 'Space']) {
  test(`${activation}: spotlight play and open are independent; background and visible open target still navigate`, async ({ page }) => {
    const play = page.getByRole('button', { name: 'Speel Top Set', exact: true });
    const open = page.getByRole('button', { name: 'Bekijk Festival: Fixture Festival', exact: true });
    if (activation === 'pointer') await play.click();
    else await play.press(activation);
    expect(await calls(page)).toMatchObject({ navigate: [], load: [[{ id: 'fixture-set', title: 'Fixture set', artist: 'Fixture artist' }, 0]] });
    if (activation === 'pointer') {
      // Force only bypasses the label span's intentional pointer-events:none;
      // the browser still hit-tests and dispatches to the underlying open button.
      await page.getByText('Bekijk Festival', { exact: true }).click({ force: true });
      const box = await open.boundingBox();
      if (!box) throw Error('Missing spotlight bounds');
      await page.mouse.click(box.x + box.width - 10, box.y + 10);
    } else await open.press(activation);
    expect((await calls(page)).navigate).toEqual(Array(activation === 'pointer' ? 2 : 1).fill({ to: '/festivals/fixture-festival' }));
    expect((await calls(page)).load).toHaveLength(1);
  });
  test(`${activation}: mini-player play/favorite do not open, while cover/title/background do`, async ({ page }) => {
    const play = page.getByRole('button', { name: 'Afspelen', exact: true });
    const like = page.getByRole('button', { name: 'Voeg toe aan favorieten', exact: true });
    for (const button of [play, like]) {
      if (activation === 'pointer') await button.click(); else await button.press(activation);
    }
    expect(await calls(page)).toMatchObject({ toggle: 1, like: ['fixture-set'], fullscreen: [] });
    const mini = page.getByRole('region', { name: 'Mini-player: Fixture set - Fixture artist', exact: true });
    if (activation === 'pointer') {
      await mini.getByText('Fixture set', { exact: true }).click({ force: true });
      const box = await mini.boundingBox();
      if (!box) throw Error('Missing mini-player bounds');
      await page.mouse.click(box.x + 30, box.y + box.height / 2); // Cover
      await page.mouse.click(box.x + 2, box.y + box.height / 2); // Padding
    } else await page.getByRole('button', { name: 'Open speler: Fixture set - Fixture artist', exact: true }).press(activation);
    expect((await calls(page)).fullscreen).toEqual(Array(activation === 'pointer' ? 3 : 1).fill(true));
    expect((await calls(page)).toggle).toBe(1);
  });
}
