import { test, expect } from './helpers/fixtures';

/**
 * EXAMPLE — a no-login form interaction. It types into Wikipedia's search box
 * (absolute URL — safe public site, by design for the shipped examples) and
 * asserts on the result page. A template for search boxes, filters and other
 * type-then-check flows.
 */
test('searches Wikipedia @example', async ({ page }) => {
  await page.goto('https://www.wikipedia.org/');

  await page.locator('#searchInput').fill('Playwright (software)');
  await page.locator('#searchInput').press('Enter');

  // An exact title match lands directly on the article.
  await expect(page).toHaveURL(/wikipedia\.org\/(wiki|w)\//);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Playwright');
});
