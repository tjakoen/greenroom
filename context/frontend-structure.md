# Frontend Structure & Selector Guide (test context)

> This file captures **how your app's pages are built** — the selectors and
> interaction patterns your Playwright tests rely on. It's reference only:
> Greenroom never contains the app under test, so this is where you write down the
> facts a test author needs.
>
> The most important part is the **login form**, because
> [tests/helpers/auth.ts](../tests/helpers/auth.ts) reads its selectors from here.
> Keep the login table below accurate and the sign-in helper keeps working.

## How to pick selectors

Prefer **role/label locators** — they're readable and survive restyling better than
CSS classes:

```ts
// Preferred — resilient and readable
page.getByLabel('Email')
page.getByRole('button', { name: 'Sign in' })
page.getByRole('link', { name: 'Dashboard' })

// OK — when the element has a stable id
page.locator('#email')

// Avoid — auto-generated / hashed classes change between builds
page.locator('.btn-a1b2c3')
```

Not sure what selector to use for something? Open the app and use **Record a new
test** in Greenroom — click the element and the recorder suggests a locator.

## Login flow (important for tests)

Fill in your app's sign-in page and its form fields. `auth.ts` uses these.

Login page: `/login` (adjust to your app)

| Element | Selector | Notes |
|---------|----------|-------|
| Email / username input | `#email` | Or `page.getByLabel('Email')` if a label is present |
| Password input | `#password` | Or `page.getByLabel('Password')` |
| Submit button | `page.getByRole('button', { name: 'Sign in' })` | Match the real button text |

**Don't hardcode credentials in tests.** Pull them from your private `.env`
(copied from [.env.example](../.env.example)) via `getUser(role)`. If your app has
an extra step after login (e.g. MFA), note how to handle it here, or use test
accounts that skip it.

## Interaction notes

Write down any per-app quirks a test author would otherwise have to rediscover, e.g.:

- Custom dropdowns that aren't native `<select>` (how to open them and pick an option).
- Modals/dialogs and how to scope selectors inside them (`page.getByRole('dialog')`).
- Date pickers, file uploads, or anything with a non-obvious interaction.

## Suggested test pattern

Put reusable navigation and selectors in **Page Objects** under `tests/helpers/`
(one file per feature area). Keep the individual test files focused on the scenario,
not the plumbing.
