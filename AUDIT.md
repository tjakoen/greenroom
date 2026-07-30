# AUDIT.md — alignment runbook

A repeatable check that this repo still obeys its own rules ([CLAUDE.md](CLAUDE.md) + the
published BREAD standards, <https://tjakoen.github.io/standards>). The canon defines "aligned";
this file only references it — if a check and the canon disagree, the canon wins and this file
gets fixed.

Run before a commit and after any big change. Each check is a command plus a pass bar.
Findings template: ✅ passing / ⚠️ `file:line` — what — fix-or-flag. "Done" = all green +
every finding fixed or explicitly flagged.

Run all from the repo root.

## 1. No secrets committed

Logins live only in the git-ignored `.env`. Nothing real in tracked files.

```bash
# .env must be ignored, .env.example must be tracked — expect ".env" ignored
grep -nE '(^|/)\.env($|\s)' .gitignore || echo "MISSING: .env not git-ignored"
# no real-looking passwords hardcoded in tests/config — expect zero hits
# (globs quoted so zsh doesn't abort on no-match; excludes CSS selectors like '#password',
#  the data.password() generator ref, and saucedemo's intentionally-public demo password)
grep -rnE "password\s*[:=]\s*['\"][^'\"]{3,}" tests config lib pages --include='*.ts' --include='*.js' | grep -viE "REPLACE_ME|getUser|placeholder|Selector|'#password'|data\.password|secret_sauce"
```

Pass: `.env` is ignored, `.env.example` exists with only blank/placeholder values, zero
hardcoded credentials.

## 2. No real environment URLs committed

A user's real environments live in the git-ignored `config/urls.json`; only the generic
`config/urls.example.json` is tracked. No hardcoded hostnames in code.

```bash
# urls.json must be git-ignored — expect a match
grep -nE 'config/urls\.json' .gitignore || echo "MISSING: config/urls.json not git-ignored"
# the committed example must not contain a real-looking host — expect only the
# safe public demo hosts (saucedemo powers the shipped @example specs)
grep -oE "https?://[a-z0-9.-]+" config/urls.example.json | grep -viE "example\.com|saucedemo\.com" || echo "OK: only safe public hosts"
# no hardcoded hosts in tests/lib/pages — expect zero (tests use relative paths;
# the shipped @example specs use safe PUBLIC test sites by design, hence the allowlist)
grep -rnE "https?://[a-z0-9.-]+\.[a-z]{2,}" tests lib pages config/environments.ts --include='*.ts' --include='*.js' | grep -viE "example\.com|localhost|playwright\.dev|nodejs\.org|code\.visualstudio|saucedemo\.com|wikipedia\.org|the-internet\.herokuapp\.com"
```

Pass: `urls.json` is ignored, the committed example/config hosts are only safe public demo
sites, zero hardcoded real hosts in code (your tests navigate with relative paths against
the active `baseURL`; only the shipped `@example` specs may use their allowlisted public sites).

## 3. No app-under-test source in this repo

Only derived context, never the tested app's code.

```bash
# a stray copy of a web app would show framework files at the root — expect zero
find . -path ./node_modules -prune -o \( -name "next.config.*" -o -name "docker-compose*.yml" \) -print
# context is docs only — expect only .md files
find context -type f ! -name "*.md"
```

Pass: no framework/compose files; `context/` holds only markdown, all generic (no real
routes/selectors from any specific app).

## 4. Typecheck is green

```bash
npm run check          # the composition root: tsc --noEmit -p tsconfig.next.json (server.ts + lib/ + pages/)
npm run check:legacy   # tests/ specs + root config files: plain tsc --noEmit
```

Pass: both exit 0, no errors.

## 5. The app still boots

```bash
# start the app (bun) on a scratch port, hit the state endpoint, stop — expect JSON with "status"
PORT=4899 bun server.ts & sleep 2; curl -s http://localhost:4899/api/state; echo; pkill -f "bun server.ts"
```

Pass: returns JSON including `"status"` and the environment list.

## 6. Envs are wired consistently

Tests are flat in `tests/` and run against any environment — there is no per-env folder or
per-env npm script. Each env in `config/urls.json` just needs a `baseURL`; exactly one must
be the default.

```bash
# list the source-of-truth envs
node -e "const u=require('./config/urls.json');console.log(Object.keys(u).filter(k=>!k.startsWith('_')).join(' '))"
# exactly one env marked default — expect 1
node -e "const u=require('./config/urls.json');console.log(Object.values(u).filter(v=>v&&v.default===true).length)"
# no per-env test folders should exist (helpers is the only subfolder) — expect only 'helpers'
ls -d tests/*/ 2>/dev/null | sed 's#tests/##;s#/##'
```

Pass: every env has a `baseURL`, exactly one has `"default": true`, and `tests/` has no
per-environment subfolders (only `helpers/`).

## 7. Docs synced

The sync table in [CLAUDE.md](CLAUDE.md) is the contract. Spot-check the high-drift rows:
`.env.example` roles line up with what the Logins UI discovers; every `/api/*` endpoint in
`server.ts` has UI in its matching `pages/*-page.ts` + `pages/*.js`; README's "What gets captured"
matches `playwright.config.ts` + `tests/helpers/fixtures.ts`.

```bash
# no leftover company/app-specific brand strings in TRACKED files — expect zero.
# Scans `git ls-files` via `git grep` rather than a `grep -r --include` extension list: an
# extension filter silently skips extensionless tracked files, and a stale employer name sat
# in LICENSE:3 while this check reported green (audit 2026-07-30). Only tracked content ships.
# Replace the alternation with YOUR OWN company name, app-under-test name and real env names
# — this repo ships generic, so these are placeholders, not real brands.
git grep -inE "<your-company>|<your-app>|<your-env-names>" -- \
  ':!AUDIT.md' ':!runs' ':!.claude'
```

Pass: no mismatch found (or each fixed in the same session), and zero brand-string hits.
Scan **tracked files, not the working tree** — `git grep` is the gate, because only
tracked content goes public.

## 8. Public-repo gates

Only relevant when this repo is (or is about to be) public. §1–§7 all scan the *current*
tree; publishing exposes **history** too, and history is the one thing a later fix cannot
reach. Added after the 2026-07-30 public-readiness audit, which found a real address in a
deleted screenshot that no text scan could ever have flagged.

```bash
# 8a. Files that exist in history but not in the tree — each one still ships. Expect only
#     deliberate deletions (superseded docs, spikes); investigate anything with data in it.
comm -23 <(git log --all --pretty=format: --name-only | sort -u | grep -v '^$') \
         <(git ls-files | sort)
# 8b. Images anywhere in history are opaque to every grep above. Expect zero UI captures of
#     a real deployment (account lists, admin pages, anything with an address on screen).
git log --all --pretty=format: --name-only | grep -iE '\.(png|jpg|jpeg|webp|gif)$' | sort -u
# 8c. Can a stranger install? Check the registry the scope is ACTUALLY mapped to (.npmrc),
#     not just npmjs. Today: 404 on npmjs + 401 on GitHub Packages = token required, so a
#     stranger CANNOT install (verified 2026-07-30). Both must read 200 to call this green.
curl -s -o /dev/null -w "npmjs:  %{http_code}\n" https://registry.npmjs.org/@tjakoen%2fgrain
curl -s -o /dev/null -w "ghpkg:  %{http_code}\n" https://npm.pkg.github.com/@tjakoen%2fgrain
# 8d. No auth token in the committed npm config — expect zero. (The scope->registry MAPPING
#     line must stay: deleting .npmrc sends @tjakoen to npmjs, which only appears to work on
#     a machine whose own ~/.npmrc still maps it.)
grep -nE "_authToken" .npmrc 2>/dev/null; echo "exit=$? (1 = clean)"
# 8e. `npm install` must work, or say so loudly. It currently FAILS on a dead git pin in
#     @tjakoen/pantry — expect a "git reference could not be found" error until pantry is
#     re-pinned. Bun is the only working installer.
grep -n "afc640a" bun.lock 2>/dev/null && echo "STILL PINNED to the dead commit" || echo "clean"
```

Pass: every history-only path is a known, data-free deletion; no image in history shows a
real deployment's data; the dependency scope resolves **anonymously** (a `401`/`404` means
only token-holders can install — state that plainly in [README](README.md) rather than
implying a clone Just Works); `.npmrc` carries the scope mapping but no token; `npm install`
either works or is documented as broken with the reason.

Note on 8a/8b: the only real remedy is a history rewrite (`git filter-repo --path … --invert-paths`),
which is free while the repo is private and coordination-expensive after it is public. Run
this section **before** the first publish, not after.

---

*Living document. When a new drift is discovered, add a check for it here (the §7 hardening
ladder: promote the rule to a grep with a pass bar).*
