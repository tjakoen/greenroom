import { test, expect } from './helpers/fixtures';

/**
 * Smoke login check — confirms the `admin` role can sign in.
 *
 * The `login` fixture is environment-aware: it reads the active environment's
 * login form (Settings → Environments → Login form) and the admin
 * credentials from your .env, fills the form, submits, and asserts you leave the
 * login page. Run it against an env where admin has a login (e.g. demo-dev)
 * — pick that env on the Run/Tests page.
 *
 * Tagged @smoke @login so you can run it alone: Tests → Run by tag.
 */
test('admin can log in @smoke @login', async ({ page, login }) => {
  await login('admin');
  // login() already fails if we don't leave the login page; restate it as this
  // test's explicit assertion. Adjust to something app-specific (e.g. a nav
  // element only visible when signed in) if you want a stronger check.
  await expect(page).not.toHaveURL(/login/i);
});
