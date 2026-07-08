import { test, expect } from './helpers/fixtures';
import { getUser } from '../users/roles';

/**
 * EXAMPLE — a login test against https://www.saucedemo.com, the public demo
 * store whose test credentials are published for exactly this purpose. It runs
 * green on a fresh clone with zero configuration: the `example` role has a
 * built-in public credential fallback (see users/roles.ts), so no .env needed.
 *
 * It is self-contained on purpose: saucedemo's login form differs from the
 * placeholder selectors in helpers/auth.ts (which you edit for YOUR app), so
 * this spec fills the form itself. For your own tests, prefer the `login`
 * fixture: `await login('yourRole')`.
 *
 * Note the relative `page.goto('/')` — the shipped "demo"/"demo2" environments
 * point their baseURL at saucedemo, so this same spec demonstrates a
 * simultaneous multi-environment run.
 */
test('logs in as a standard user @example', async ({ page, envName }) => {
  const { username, password } = getUser('example', envName || undefined);

  await page.goto('/');
  await page.locator('#user-name').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#login-button').click();

  // Success = saucedemo lands on the inventory page.
  await expect(page).toHaveURL(/inventory\.html/);
  await expect(page.locator('.inventory_list')).toBeVisible();
});
