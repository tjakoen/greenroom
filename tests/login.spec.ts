import { test, expect } from './helpers/fixtures';
import { login } from './helpers/auth';

/**
 * Example login test — a template. It logs in as a role, then checks you
 * landed somewhere past the login page.
 *
 * Before this passes you need to:
 *   1. Add a login for the role in Settings → Logins (writes your .env).
 *   2. Point tests/helpers/auth.ts at your app's login form (URL + fields).
 *   3. Replace the assertion below with something true for your app.
 *
 * Roles are just names you choose (here 'admin'); the credential comes from
 * <ENV>_<ROLE>_USERNAME / <ENV>_<ROLE>_PASSWORD in your .env.
 */
test.describe('Login', () => {
  test('a user can log in @smoke @login', async ({ page }) => {
    await login(page, 'admin');
    // Landed off the login page → treat as signed in. Tighten to your app.
    await expect(page).not.toHaveURL(/login/i);
  });
});
