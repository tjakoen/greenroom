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
grep -rnE "password\s*[:=]\s*['\"][^'\"]{3,}" tests config interface --include=*.ts --include=*.js | grep -viE "REPLACE_ME|getUser|placeholder|Selector"
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
# no hardcoded hosts in tests/interface — expect zero (tests use relative paths;
# the shipped @example specs use safe PUBLIC test sites by design, hence the allowlist)
grep -rnE "https?://[a-z0-9.-]+\.[a-z]{2,}" tests interface config/environments.ts --include='*.ts' --include='*.js' | grep -viE "example\.com|localhost|playwright\.dev|nodejs\.org|code\.visualstudio|saucedemo\.com|wikipedia\.org|the-internet\.herokuapp\.com"
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
npx tsc --noEmit
```

Pass: no errors.

## 5. The app still boots

```bash
# start on a scratch port, hit the state endpoint, stop — expect JSON with "status"
PORT=4899 node interface/server.js & sleep 1; curl -s http://localhost:4899/api/state; echo; pkill -f "node interface/server.js"
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
`.env.example` roles line up with what the Logins UI discovers; the interface endpoints in
`interface/server.js` all have UI in `interface/index.html`; README's "What gets captured"
matches `playwright.config.ts` + `tests/helpers/fixtures.ts`.

```bash
# no leftover company/app-specific brand strings in committed files — expect zero
grep -rinE "career ?team|careeredge|spark-uat|edge tests" \
  --include='*.md' --include='*.ts' --include='*.js' --include='*.json' --include='*.html' --include='*.css' \
  --exclude-dir=node_modules --exclude-dir=runs --exclude-dir=.claude . \
  | grep -vE "config/urls\.json|AUDIT\.md"
```

Pass: no mismatch found (or each fixed in the same session), and zero brand-string hits.

---

*Living document. When a new drift is discovered, add a check for it here (the §7 hardening
ladder: promote the rule to a grep with a pass bar).*
