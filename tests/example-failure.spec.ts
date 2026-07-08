import { test, expect } from './helpers/fixtures';

/**
 * EXAMPLE — this test FAILS ON PURPOSE. Do not fix it.
 *
 * It exists so a fresh clone can see what a red run looks like: the failure
 * tile and health bar, the error message, the failure screenshot, the video,
 * the trace and the one-click bug bundle — without having to break anything.
 */
test('fails on purpose to show a red run @example', async ({ page }) => {
  await page.goto('https://the-internet.herokuapp.com/');

  // The page's real heading is "Welcome to the-internet". The expected text
  // below is deliberately wrong, so this assertion always fails.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'This assertion is intentionally wrong — see the comment above.',
    { timeout: 10_000 },
  );
});
