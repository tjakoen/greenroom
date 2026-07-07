import { Page, expect } from '@playwright/test';
import { getUser } from '../../users/roles';

/**
 * Log in through your app's login form using a role from your .env.
 * Works against whichever environment is active (the current TEST_ENV) —
 * page.goto uses a relative path so it hits that env's baseURL automatically.
 *
 * ▸ EDIT THIS FOR YOUR APP. The values below are placeholders: the login
 *   path, the field selectors, and the submit button name will differ per
 *   site. Use "Record a new test" to click through your real login form and
 *   copy the selectors Playwright generates.
 *
 * Usage:
 *   await login(page, 'admin');
 */
const LOGIN = {
  path: '/login', // login page, relative to the environment's baseURL
  usernameSelector: '#email', // the username / email input
  passwordSelector: '#password', // the password input
  submitName: /log ?in|sign ?in/i, // the submit button's accessible name
};

export async function login(page: Page, role: string): Promise<void> {
  const { username, password } = getUser(role);

  await page.goto(LOGIN.path);
  await page.locator(LOGIN.usernameSelector).fill(username);
  await page.locator(LOGIN.passwordSelector).fill(password);
  await page.getByRole('button', { name: LOGIN.submitName }).click();

  // Success = we left the login page. Adjust if your app redirects elsewhere
  // or requires MFA for the account.
  await expect(page).not.toHaveURL(new RegExp(LOGIN.path, 'i'), { timeout: 20_000 });
}
