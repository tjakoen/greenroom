import { test, expect } from './helpers/fixtures';

/**
 * Smoke test — runs against EVERY environment. No credentials needed.
 * It just opens the site's home page (the baseURL for the active TEST_ENV)
 * and checks the page loaded. A good "is the site up?" first check.
 *
 * Every test lives directly in tests/ and runs against whichever environment
 * you pick — tests are not tied to a specific environment.
 */
test.describe('Home page', () => {
  test('home page loads @smoke', async ({ page }) => {
    const res = await page.goto('/');
    expect(res?.ok()).toBeTruthy();
    // The page produced a document with a <title>. Adjust to something more
    // specific to your app once you know what the home page should show.
    await expect(page).toHaveTitle(/.+/);
  });
});
