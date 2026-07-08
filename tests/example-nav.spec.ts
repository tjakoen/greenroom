import { test, expect } from './helpers/fixtures';

/**
 * EXAMPLE — a no-login, multi-step navigation check. It visits the public
 * Playwright docs site with an absolute URL (safe public site, by design for
 * the shipped examples — YOUR tests should use relative paths so they run
 * against the selected environment's baseURL), follows a link, and asserts on
 * the destination. A template for "click through the app and check we arrived".
 */
test('navigates the Playwright docs @example', async ({ page }) => {
  await page.goto('https://playwright.dev/');

  await page.getByRole('link', { name: 'Get started' }).click();

  await expect(page).toHaveURL(/docs\/intro/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Installation');
});
