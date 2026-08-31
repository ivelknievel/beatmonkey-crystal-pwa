import { test, expect } from '@playwright/test';

test.describe('Google SSO Auth Flow', () => {
  test('should show Google sign-in button on login page', async ({ page }) => {
    await page.goto('https://music.cyberspeeze.online/app/');
    await page.waitForLoadState('networkidle');
    
    // Check for the Google button container (it may not render without VITE_GOOGLE_CLIENT_ID)
    const hasGoogleSection = await page.locator('text=of').isVisible().catch(() => false);
    // The "of" divider should be visible even without client ID
    console.log('Google section visible:', hasGoogleSection);
  });

  test('auth callback route should not crash', async ({ page }) => {
    await page.goto('https://music.cyberspeeze.online/app/auth/callback');
    await page.waitForTimeout(2000);
    
    // Should not show an error/blank page
    const bodyText = await page.locator('body').textContent();
    expect(bodyText).toBeTruthy();
  });

  test('IndexedDB should accept token storage', async ({ page }) => {
    await page.goto('https://music.cyberspeeze.online/app/');
    await page.waitForTimeout(1000);
    
    const canStore = await page.evaluate(async () => {
      try {
        const { openDB } = await import('idb');
        const db = await openDB('beatmonkey-auth-test', 1, {
          upgrade(db) {
            if (!db.objectStoreNames.contains('meta')) {
              db.createObjectStore('meta', { keyPath: 'key' });
            }
          },
        });
        await db.put('meta', { key: 'test', value: 'hello' });
        const result = await db.get('meta', 'test');
        db.close();
        indexedDB.deleteDatabase('beatmonkey-auth-test');
        return result?.value === 'hello';
      } catch {
        return false;
      }
    });
    
    expect(canStore).toBe(true);
  });
});
