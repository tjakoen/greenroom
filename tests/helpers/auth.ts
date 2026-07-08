import { Page, expect } from '@playwright/test';
import { getUser } from '../../users/roles';
import { getLoginForm } from '../../config/environments';

/**
 * Log in through your app's login form using a role from your .env.
 * Works against whichever environment is active (the current TEST_ENV) —
 * page.goto uses a relative path so it hits that env's baseURL automatically.
 *
 * ▸ CONFIGURE THE LOGIN FORM IN THE APP, not here. The form layout (login path,
 *   username/password selectors, submit button) is per-app DATA, resolved by
 *   getLoginForm() from config/urls.json — set it in Settings → Environments
 *   (per env, or once under the shared `_login` block). That keeps this helper
 *   (and the repo) generic. Only hand-edit the flow below for exotic cases the
 *   simple form config can't express (multi-step logins, MFA, SSO redirects).
 *
 * Usage:
 *   await login(page, 'admin');
 *
 * `env` is optional — when omitted the current TEST_ENV account is used. In a
 * simultaneous multi-environment run each Playwright project passes its own env
 * so the right per-environment account is used. Prefer the `login` test fixture
 * (see helpers/fixtures.ts) in new specs — it wires `env` for you.
 */
export async function login(page: Page, role: string, env?: string): Promise<void> {
  const { username, password } = getUser(role, env);
  const form = getLoginForm(env);

  await page.goto(form.path);
  await page.locator(form.username).fill(username);
  await page.locator(form.password).fill(password);
  await page.getByRole('button', { name: form.submit }).click();

  // Success = we navigated away from the login page. Compare the pathname
  // EXACTLY (not a substring) — a root login path ("/") would otherwise match
  // every URL and never pass. Adjust this for apps that keep the same URL after
  // login (some SPAs) or require MFA.
  const loginPath = new URL(form.path || '/', 'http://x').pathname;
  await expect
    .poll(() => { try { return new URL(page.url()).pathname; } catch { return ''; } }, {
      timeout: 20_000,
      message: `Login didn't leave "${loginPath}" — check the login form selectors/credentials (Settings → Environments → Login form), or adjust the success check for an MFA/SPA login.`,
    })
    .not.toBe(loginPath);
}
