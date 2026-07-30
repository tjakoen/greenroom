import { test, expect } from './helpers/fixtures';
import { getUser } from '../users/roles';

/**
 * TEMPLATE — smoke login check for one of YOUR roles. Copy this shape for your
 * own app; the `@example` specs beside it are the ones that run green out of the
 * box against public demo sites.
 *
 * The `login` fixture is environment-aware: it reads the active environment's
 * login form (Settings → Environments → Login form) and the `admin` credentials
 * from your .env, fills the form, submits, and asserts you leave the login page.
 * Run it against an environment where `admin` has a login — pick that env on the
 * Run or Tests page.
 *
 * Rename `admin` to whichever role you created in Settings → Roles & logins.
 *
 * On a fresh clone no role has a login yet, so this test SKIPS rather than fails
 * — a red row here would read as "the app is broken" when it only means "you
 * haven't added a login yet". It goes live the moment that role has credentials.
 *
 * Tagged @smoke @login so you can run it alone: Tests → Run by tag.
 */
test('admin can log in @smoke @login', async ({ page, login, envName }) => {
  const configured = (() => {
    try {
      getUser('admin', envName || undefined);
      return true;
    } catch {
      return false;
    }
  })();
  test.skip(!configured, 'No "admin" login yet — add one in Settings → Roles & logins to run this');

  await login('admin');
  // login() already fails if we don't leave the login page; restate it as this
  // test's explicit assertion. Adjust to something app-specific (e.g. a nav
  // element only visible when signed in) if you want a stronger check.
  await expect(page).not.toHaveURL(/login/i);
});
