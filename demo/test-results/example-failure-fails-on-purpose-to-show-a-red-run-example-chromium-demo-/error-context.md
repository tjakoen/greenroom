# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: example-failure.spec.ts >> fails on purpose to show a red run @example
- Location: tests/example-failure.spec.ts:18:5

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator:  getByRole('heading', { level: 1 })
Expected: "This assertion is intentionally wrong — see the comment above."
Received: "Welcome to the-internet"
Timeout:  10000ms

Call log:
  - Expect "toHaveText" with timeout 10000ms
  - waiting for getByRole('heading', { level: 1 })
    24 × locator resolved to <h1 class="heading">Welcome to the-internet</h1>
       - unexpected value "Welcome to the-internet"

```

```yaml
- heading "Welcome to the-internet" [level=1]
```

# Test source

```ts
  1  | /**
  2  |  * ─────────────────────────────────────────────────────────────────────────────
  3  |  * COPY ME — change the URL/selectors for your app.
  4  |  * ─────────────────────────────────────────────────────────────────────────────
  5  |  * A permanent "Examples" test that FAILS ON PURPOSE.
  6  |  *
  7  |  * ⚠️  THIS TEST IS *SUPPOSED* TO FAIL. It is not broken — do not "fix" it.
  8  |  *
  9  |  * Its job is to show you what a red run looks like: a failing tile on the
  10 |  * dashboard, a failure screenshot, a video, and a trace you can hand to a dev in
  11 |  * a one-click bug bundle. It runs against a classic public QA sandbox
  12 |  * (https://the-internet.herokuapp.com), which is built for exactly this.
  13 |  *
  14 |  * The page really loads fine; only the final assertion is deliberately wrong.
  15 |  */
  16 | import { test, expect } from './helpers/fixtures';
  17 | 
  18 | test('fails on purpose to show a red run @example', async ({ page }) => {
  19 |   await page.goto('https://the-internet.herokuapp.com/');
  20 | 
  21 |   // The real heading on this page is "Welcome to the-internet".
  22 |   // We assert the wrong text on purpose, so this test fails and you get to see
  23 |   // the failure artifacts. Change/remove this to make it green.
> 24 |   await expect(page.getByRole('heading', { level: 1 })).toHaveText(
     |                                                         ^ Error: expect(locator).toHaveText(expected) failed
  25 |     'This assertion is intentionally wrong — see the comment above.',
  26 |   );
  27 | });
  28 | 
```