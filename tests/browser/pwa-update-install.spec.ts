import { test, expect } from '@playwright/test';

test('fresh real service-worker install and first controlled navigation never show update prompt; install assets resolve', async ({ page, context }) => {
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') await route.continue();
    else await route.abort();
  });
  await page.goto('/app/');
  await expect(page.getByLabel('Gebruikersnaam', { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (registration.active?.state !== 'activated') {
      await new Promise<void>(resolve => registration.active?.addEventListener('statechange', () => {
        if (registration.active?.state === 'activated') resolve();
      }));
    }
  });
  await expect(page.getByRole('region', { name: 'App-update' })).toHaveCount(0);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect(page.getByRole('region', { name: 'App-update' })).toHaveCount(0);
  const config = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!;
    const response = await fetch(link.href);
    const manifest = await response.json();
    const icons = await Promise.all(manifest.icons.filter((icon: { type: string }) => icon.type === 'image/png').map(async (icon: { src: string }) => {
      const result = await fetch(icon.src);
      return { status: result.status, type: result.headers.get('content-type') };
    }));
    const start = await fetch(manifest.start_url);
    return { status: response.status, id: manifest.id, scope: manifest.scope, display: manifest.display, start: start.status, icons };
  });
  expect(config).toEqual({ status: 200, id: '/app/', scope: '/app/', display: 'standalone', start: 200, icons: [{ status: 200, type: 'image/png' }, { status: 200, type: 'image/png' }] });
});
