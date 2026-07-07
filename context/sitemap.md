# Sitemap (test context)

> This file is a **map only** — it lists the important page routes/URLs of the app
> you're testing, so you (or an AI helper) can write Playwright tests that navigate
> the real site **without needing its source code**.
>
> Greenroom never contains the app under test. Fill in the table below with the
> routes that matter for your tests: the pages you sign in on, the dashboards you
> land on, the flows you want to check. Add rows as you go.

## How to use this

- List the **paths** (the part after the domain), not full URLs — the domain comes
  from your environment config in [config/urls.json](../config/urls.json).
- For pages with an id in the URL (a product page, a user profile), note it as a
  placeholder like `/item/[id]` and substitute a real id from your environment when
  you write the test.
- Not sure what a page's route is? Open the app, use **Record a new test** in
  Greenroom, and click through — the recorder shows the URLs as you navigate.

## Routes

| Route | Purpose | Notes |
|-------|---------|-------|
| `/` | Landing / home page | Where the app opens by default |
| `/login` | Sign-in form | Selectors live in [frontend-structure.md](./frontend-structure.md) |
| `/dashboard` | Main screen after login | Requires an authenticated session |
| `/item/[id]` | Example detail page with a dynamic id | Replace `[id]` with a real id from your env |

<!-- Add your own routes above. Delete the example rows once you have real ones. -->
