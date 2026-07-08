#!/usr/bin/env node
/**
 * Minimal web interface for running the Playwright tests.
 * Zero dependencies — plain Node. Start with: npm start
 *
 * Serves:
 *   /            the one-page UI (interface/index.html)
 *   /api/state   current status (idle/running/passed/failed, env list, .env check)
 *   /api/run     POST { env, light } — starts a run (light = less capture, faster)
 *   /api/stop    POST — stops the current run
 *   /api/stream  SSE — live test output
 *   /api/envs    GET / POST / DELETE — view + edit environments (config/urls.json)
 *   /report/     the latest Playwright HTML report
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildPdf } = require('./pdf');
const { zipStore } = require('./zip');
const ffmpeg = require('./ffmpeg');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 4321);

// This is a LOCAL app. It binds loopback only (see server.listen below), but a
// malicious web page in the user's own browser can still try to reach it, and a
// domain resolving to 127.0.0.1 (DNS-rebinding) can send a foreign Host header.
// These two checks close both: only loopback Hosts are served, and cross-origin
// writes are rejected.
function isLoopbackHost(host) {
  if (!host) return true; // some clients omit Host; loopback bind already gates reachability
  const h = String(host).replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}
function isLoopbackOrigin(origin) {
  try {
    return isLoopbackHost(new URL(origin).host);
  } catch {
    return false;
  }
}

// Demo mode: read seeded fixtures from demo/ instead of the user's live data, and
// refuse every write. Lets a fresh clone show a fully-populated, safe, read-only
// app (npm run demo). See DEMO_DIR overrides below.
const IS_DEMO = process.env.GREENROOM_DEMO === '1';
const DEMO_DIR = path.join(ROOT, 'demo');
const denyInDemo = { ok: false, demo: true, error: 'Demo mode is read-only.' };
const URLS_PATH = path.join(ROOT, 'config', 'urls.json');
const URLS_EXAMPLE_PATH = path.join(ROOT, 'config', 'urls.example.json');

// urls.json holds your real environments and is git-ignored. On a fresh clone
// it won't exist, so seed it from the committed template on first boot.
function seedUrls() {
  if (IS_DEMO) return; // demo reads config via the committed example; never write
  if (!fs.existsSync(URLS_PATH) && fs.existsSync(URLS_EXAMPLE_PATH)) {
    fs.copyFileSync(URLS_EXAMPLE_PATH, URLS_PATH);
  }
}
seedUrls();

// Environments are read fresh every time so edits from the app take effect
// without restarting the server.
let lastConfigError = null;
function loadUrls() {
  // Demo always uses the committed generic envs — never the user's real urls.json.
  const file = !IS_DEMO && fs.existsSync(URLS_PATH) ? URLS_PATH : URLS_EXAMPLE_PATH;
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    lastConfigError = null;
    return obj;
  } catch (err) {
    // A hand-edited, malformed urls.json must NOT crash the server (it's read on
    // every request, including /api/state). Degrade to no environments and
    // surface the reason so the UI can tell the user what to fix.
    lastConfigError = `${path.relative(ROOT, file)} is not valid JSON — ${err.message}`;
    return {};
  }
}
function envNames() {
  return Object.keys(loadUrls()).filter((k) => !k.startsWith('_'));
}
function baseURLof(env) {
  return loadUrls()[env]?.baseURL;
}

// ---------------------------------------------------------- environment editing
function isValidEnvName(n) {
  return /^[a-z0-9][a-z0-9-]{0,40}$/.test(n);
}

// The login-form fields kept per env (or under the shared `_login` key) — how a
// site's login form is laid out, so login()/pre-auth recording can drive it.
// These are selectors + button text, not secrets; still trimmed + single-line.
const LOGIN_FIELDS = ['path', 'username', 'password', 'submit'];
function sanitizeLoginForm(login) {
  const out = {};
  if (login && typeof login === 'object') {
    for (const k of LOGIN_FIELDS) {
      const v = login[k];
      if (typeof v === 'string' && v.trim() && !/[\x00-\x1f\x7f]/.test(v)) out[k] = v.trim();
    }
  }
  return out;
}

// Add or update an environment in config/urls.json and seed a login block in
// .env.example. Preserves other fields on an existing entry (e.g. "default").
// If this is the first environment, it becomes the default. `login` (optional)
// sets that env's own login-form override; pass {} (or all-empty) to clear it,
// omit it (undefined) to leave any existing block untouched.
function saveEnv(name, baseURL, login) {
  if (IS_DEMO) return denyInDemo;
  if (!isValidEnvName(name)) {
    return { ok: false, error: 'Name must be lowercase letters/numbers/dashes (e.g. staging).' };
  }
  if (!/^https?:\/\/.+/.test(baseURL)) {
    return { ok: false, error: 'URL must start with http:// or https://' };
  }
  const u = loadUrls();
  const isFirst = envNames().length === 0;
  u[name] = { ...(u[name] || {}), baseURL: baseURL.replace(/\/+$/, '') };
  if (isFirst) u[name].default = true;
  if (login !== undefined) {
    const form = sanitizeLoginForm(login);
    if (Object.keys(form).length) u[name].login = form;
    else delete u[name].login;
  }
  fs.writeFileSync(URLS_PATH, JSON.stringify(u, null, 2) + '\n');

  try {
    const p = path.join(ROOT, '.env.example');
    const prefix = name.toUpperCase().replace(/-/g, '_');
    let txt = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    if (!txt.includes(`${prefix}_`)) {
      txt += `\n# ---- ${name} ----\n${prefix}_ADMIN_USERNAME=\n${prefix}_ADMIN_PASSWORD=\n`;
      fs.writeFileSync(p, txt);
    }
  } catch {
    /* seeding the template is best-effort */
  }
  return { ok: true };
}

// The shared login form (top-level `_login`), applied to every env that doesn't
// define its own. Pass an all-empty form to remove it.
function saveSharedLogin(login) {
  if (IS_DEMO) return denyInDemo;
  const u = loadUrls();
  const form = sanitizeLoginForm(login);
  if (Object.keys(form).length) u._login = form;
  else delete u._login;
  fs.writeFileSync(URLS_PATH, JSON.stringify(u, null, 2) + '\n');
  return { ok: true };
}

function deleteEnv(name) {
  if (IS_DEMO) return denyInDemo;
  const u = loadUrls();
  if (!u[name]) return { ok: false, error: 'No such environment.' };
  delete u[name];
  fs.writeFileSync(URLS_PATH, JSON.stringify(u, null, 2) + '\n');
  // Note: the tests/<name> folder and its files are left alone on purpose.
  return { ok: true };
}

const MAX_LINES = 2000;
const state = {
  status: 'idle', // idle | running | passed | failed | stopped
  env: null, // display label: single env name, or "a+b" for a multi-env run
  envs: [], // the env list the current/last run targeted
  light: false,
  lines: [],
  proc: null,
  recording: false, // true during the async pre-auth window before proc is set
};
const clients = new Set();

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function pushOutput(chunk) {
  const lines = stripAnsi(chunk.toString()).split('\n');
  for (const line of lines) {
    if (line.trim() === '') continue;
    state.lines.push(line);
    if (state.lines.length > MAX_LINES) state.lines.shift();
    broadcast('line', { line });
  }
}

function publicState() {
  return {
    status: state.status,
    env: state.env,
    runEnvs: state.envs, // which envs the current/last run targeted
    light: state.light,
    envs: envNames(),
    demo: IS_DEMO,
    envFileExists: IS_DEMO || fs.existsSync(path.join(ROOT, '.env')),
    reportExists: IS_DEMO
      ? fs.existsSync(path.join(RUNS_DIR)) // demo: report links resolve to seeded runs
      : fs.existsSync(path.join(ROOT, 'playwright-report', 'index.html')),
    // Non-null when config/urls.json can't be parsed — the UI can show a fix hint
    // instead of a silently empty environment list.
    configError: lastConfigError,
  };
}

// Validate a user-supplied test path: must be a *.spec.ts inside tests/.
function validTestFile(rel) {
  if (typeof rel !== 'string' || !rel.endsWith('.spec.ts')) return false;
  const target = path.normalize(path.join(ROOT, rel));
  return target.startsWith(path.join(ROOT, 'tests') + path.sep) && fs.existsSync(target);
}

// `files` (optional) limits the run to specific spec files. `grep` (optional) is a
// Playwright --grep pattern (used for run-by-tag or a single test title). Empty →
// every test in tests/. Tests are not tied to an environment; `envs` only picks
// which baseURL/logins they run against.
//
// `envs` may be a single env name (today's behaviour, one project) or an array of
// names (a simultaneous multi-environment run — one Playwright project per env,
// each with its own baseURL + per-env account). We pass TEST_ENVS to the runner
// (read by playwright.config's getSelectedEnvs) and also TEST_ENV=<first> so any
// code that reads the process-wide env still resolves to a sensible default.
function startRun(envs, light, files, grep, role) {
  if (IS_DEMO) return denyInDemo;
  if (state.proc) return { ok: false, error: 'A run is already in progress.' };
  const list = (Array.isArray(envs) ? envs : [envs]).map((e) => String(e || '').trim()).filter(Boolean);
  const unique = [...new Set(list)];
  if (!unique.length) return { ok: false, error: 'Pick at least one environment.' };
  const known = envNames();
  const bad = unique.filter((e) => !known.includes(e));
  if (bad.length) return { ok: false, error: `Unknown environment${bad.length > 1 ? 's' : ''}: ${bad.join(', ')}.` };

  let targets;
  if (Array.isArray(files) && files.length) {
    targets = files.filter(validTestFile);
    if (!targets.length) return { ok: false, error: 'None of the selected test files exist.' };
  } else {
    targets = ['tests'];
  }
  const grepArgs = typeof grep === 'string' && grep.trim() ? ['--grep', grep.trim()] : [];

  const envLabel = unique.join('+'); // folder/display label for the run
  state.status = 'running';
  state.env = envLabel;
  state.envs = unique;
  state.light = !!light;
  state.lines = [];
  const startedAt = Date.now();

  // detached: give the child its own process group so Stop can kill the whole
  // tree (Playwright spawns worker processes) — see killProc/stopRun.
  const proc = spawn('npx', ['playwright', 'test', ...targets, ...grepArgs], {
    cwd: ROOT,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      TEST_ENVS: unique.join(','),
      TEST_ENV: unique[0],
      // "Run as" override: force every login('…') to use this role (see the login
      // fixture). Empty/unset → each test keeps its own role.
      ...(role && typeof role === 'string' && role.trim() ? { GR_ROLE: role.trim() } : {}),
      ...(light ? { CAPTURE: 'light' } : {}),
    },
  });
  state.proc = proc;

  let settled = false;
  proc.stdout.on('data', pushOutput);
  proc.stderr.on('data', pushOutput);
  // spawn itself failing (e.g. `npx` not on PATH — common when VS Code is
  // launched from the Dock with a GUI-only PATH) fires 'error', not 'close'.
  // Tell the user instead of crashing the server on an unhandled event.
  proc.on('error', (err) => {
    if (settled) return;
    settled = true;
    state.proc = null;
    state.status = 'failed';
    pushOutput(`\nCouldn't start the test runner: ${err.message}\nIs Node/npx on your PATH? Try launching the app from a terminal, or reinstall dependencies (npm install).`);
    broadcast('done', publicState());
  });
  proc.on('close', (code) => {
    if (settled) return;
    settled = true;
    state.proc = null;
    if (state.status === 'running') state.status = code === 0 ? 'passed' : 'failed';
    archiveRun(envLabel, state.status, startedAt);
    broadcast('done', publicState());
  });

  broadcast('started', publicState());
  return { ok: true };
}

// SIGTERM the whole process group (negative pid), then SIGKILL after a grace
// period so orphaned Playwright workers can't keep writing to test-results/.
function killProc(proc) {
  if (!proc || !proc.pid) return;
  const hard = () => {
    try {
      if (process.platform !== 'win32') process.kill(-proc.pid, 'SIGKILL');
      else proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  };
  try {
    if (process.platform !== 'win32') process.kill(-proc.pid, 'SIGTERM');
    else proc.kill('SIGTERM');
  } catch {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setTimeout(hard, 5000).unref();
}

function stopRun() {
  if (!state.proc && !state.recording) return { ok: false, error: 'Nothing is running.' };
  state.status = 'stopped';
  if (state.proc) killProc(state.proc); // during pre-auth there's no proc yet; the record flow sees 'stopped' and cancels
  return { ok: true };
}

// Rewrite a freshly-recorded codegen spec so login is AUTOMATED at run time:
//  - point the import at our fixtures (adds capture + the `login` fixture), and
//  - inject `await login('<role>')` as the first action of the test.
// This targets codegen's known output shape (`async ({ page }) => {`); if a user
// hand-changes that, the injection simply no-ops (login can be added by hand).
function injectLoginIntoSpec(absPath, role) {
  try {
    let s = fs.readFileSync(absPath, 'utf8');
    const before = s;
    s = s.replace(/from ['"]@playwright\/test['"]/, "from './helpers/fixtures'");
    s = s.replace(/async\s*\(\s*\{\s*page\s*\}\s*\)\s*=>\s*\{/, `async ({ page, login }) => {\n  await login('${role}');`);
    if (s !== before) fs.writeFileSync(absPath, s);
    return s !== before;
  } catch {
    return false;
  }
}

// Clean a freshly recorded codegen spec:
//  - drop the `test.use({ storageState: '…' })` block codegen injects when we
//    recorded with --load-storage. That temp session file is deleted after
//    recording (it only authenticated the recorder); login() re-auths at run
//    time. Leaving it makes the test fail loading a missing file.
//  - rewrite absolute URLs that point at this env's baseURL back to relative
//    paths, so the spec stays environment-agnostic and no real host is committed.
function cleanRecordedSpec(absPath, baseURL) {
  try {
    let s = fs.readFileSync(absPath, 'utf8');
    const before = s;
    s = s.replace(/\n?\s*test\.use\(\{[^}]*storageState[^}]*\}\);?/g, '');
    if (baseURL) {
      const b = baseURL.replace(/\/+$/, '');
      const escd = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // '<baseURL>/path' → '/path' ; bare '<baseURL>' → '/'
      s = s.replace(new RegExp(`(['"\`])${escd}(/[^'"\`]*)?\\1`, 'g'), (_m, q, p) => `${q}${p || '/'}${q}`);
    }
    if (s !== before) fs.writeFileSync(absPath, s);
  } catch {
    /* best effort — a hand-editable spec is still produced */
  }
}

// Remember which role a recorded test logs in as (shown on the Tests page as
// "runs as: <role>"), keyed to the first test title in the file.
function setRecordedRole(outRel, role) {
  try {
    const tests = parseTests(path.join(ROOT, outRel));
    if (!tests.length) return;
    const meta = loadMeta();
    const key = metaKey(outRel, tests[0].title);
    meta[key] = { ...(meta[key] || {}), role };
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + '\n');
  } catch {
    /* meta is best-effort */
  }
}

// ------------------------------------------------------------- dynamic test data
// A recorded spec hardcodes whatever the user typed (`.fill('bob@x.com')`). On
// replay that same value is submitted every time, which breaks forms with a
// uniqueness constraint (signup email "already exists") or one-time values. The
// "Make inputs dynamic" flow lets the user swap chosen fields for a generator
// from tests/helpers/data.ts, so each run submits a fresh value.
const INPUT_GENERATORS = {
  email: 'data.uniqueEmail()',
  name: 'data.randomName()',
  text: 'data.randomString()',
  id: 'data.unique()',
  phone: 'data.randomPhone()',
  password: 'data.password()',
};

// A `.fill('literal')` on a line, capturing the quoted value (handles escapes).
const FILL_RE = /\.fill\((['"`])((?:\\.|(?!\1).)*)\1\)/;

// Detect the fillable inputs in a recorded spec: one entry per `.fill('…')`,
// with a best-effort label pulled from the locator on the same line.
function recordedInputs(rel) {
  if (!validTestFile(rel)) return { ok: false, error: 'No such test file.' };
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
  const inputs = [];
  lines.forEach((line, i) => {
    const m = line.match(FILL_RE);
    if (!m) return;
    const label =
      (line.match(/getBy\w+\(\s*['"`]([^'"`]+)/) || [])[1] ||
      (line.match(/getByRole\([^,]+,\s*\{\s*name:\s*['"`]([^'"`]+)/) || [])[1] ||
      (line.match(/locator\(\s*['"`]([^'"`]+)/) || [])[1] ||
      '(field)';
    inputs.push({ line: i, label, value: m[2] });
  });
  return { ok: true, file: rel, inputs, generators: Object.keys(INPUT_GENERATORS) };
}

// Rewrite chosen fields to a generator call and ensure the data helper is imported.
// `mappings`: [{ line, generator }] where generator is a key of INPUT_GENERATORS
// (or 'keep' to leave a field as recorded).
function applyInputs(rel, mappings) {
  if (IS_DEMO) return denyInDemo;
  if (!validTestFile(rel)) return { ok: false, error: 'No such test file.' };
  const abs = path.join(ROOT, rel);
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  let changed = 0;
  for (const { line, generator } of mappings || []) {
    const call = INPUT_GENERATORS[generator];
    if (!call || typeof lines[line] !== 'string') continue;
    if (!FILL_RE.test(lines[line])) continue;
    lines[line] = lines[line].replace(FILL_RE, `.fill(${call})`);
    changed++;
  }
  let out = lines.join('\n');
  if (changed && !/from ['"]\.\/helpers\/data['"]/.test(out)) {
    // Add the import right after the first existing import line.
    out = /^import .*$/m.test(out)
      ? out.replace(/^(import .*)$/m, `$1\nimport * as data from './helpers/data';`)
      : `import * as data from './helpers/data';\n` + out;
  }
  fs.writeFileSync(abs, out);
  return { ok: true, changed };
}

// ------------------------------------------------------------------- recording
// Opens Playwright's recorder: a real browser on this machine. Whatever the user
// clicks becomes a test file. Local only (needs a screen). Reports the saved path.
// If `role` is given, login is automated: we rewrite the saved spec to call
// `login('<role>')` at the top so the run logs in with the right per-env account
// (the user should skip the login screen while recording to avoid doing it twice).
// Resolve an env's login form the same way config/environments.ts getLoginForm
// does (env.login → shared _login → generic default), but in plain JS so the
// server can pre-authenticate without importing the TS module.
const DEFAULT_LOGIN_FORM = { path: '/login', username: '#email', password: '#password', submit: 'log in' };
function resolveLoginForm(env) {
  const u = loadUrls();
  const shared = sanitizeLoginForm(u._login);
  const per = sanitizeLoginForm(u[env] && u[env].login);
  const pick = (k) => per[k] || shared[k] || DEFAULT_LOGIN_FORM[k];
  return { path: pick('path'), username: pick('username'), password: pick('password'), submit: pick('submit') };
}

// Public creds for the shipped `example` role only (mirrors users/roles.ts) so
// pre-auth recording works zero-config against the example sites.
const EXAMPLE_CREDS = { example: { username: 'standard_user', password: 'secret_sauce' } };
// Resolve a role's login for an env from .env (env-scoped var wins, shared falls
// back), else the public example cred. Mirrors users/roles.ts getUser.
function resolveCred(env, role) {
  const dot = parseEnvText(readFileMaybe(ENV_FILE));
  const rk = roleVar(role);
  const username = dot[`${envPrefix(env)}${rk}_USERNAME`] ?? dot[`${rk}_USERNAME`];
  const password = dot[`${envPrefix(env)}${rk}_PASSWORD`] ?? dot[`${rk}_PASSWORD`];
  if (username && password) return { username, password };
  return EXAMPLE_CREDS[String(role).toLowerCase()] || null;
}

// Log in headlessly and save the browser session, so the recorder can open
// ALREADY authenticated — the user records their real flow without ever seeing
// the login screen or typing credentials into the recording. Returns the
// storageState file path, or an error the caller surfaces (recording then falls
// back to opening logged-out). Generic: driven entirely by the env's login-form
// config + .env, never app-specific code.
async function preAuth(env, role) {
  const cred = resolveCred(env, role);
  if (!cred) return { ok: false, error: `no saved login for "${role}" on "${env}"` };
  const base = baseURLof(env);
  if (!base) return { ok: false, error: `no baseURL for "${env}"` };
  const form = resolveLoginForm(env);
  const { chromium } = require('@playwright/test');
  let browser;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ baseURL: base });
    const page = await ctx.newPage();
    await page.goto(form.path);
    await page.locator(form.username).fill(cred.username);
    await page.locator(form.password).fill(cred.password);
    await page.getByRole('button', { name: form.submit }).click();
    // Wait until we've left the login path (same heuristic as auth.ts login()).
    const loginPath = new URL(form.path || '/', 'http://x').pathname;
    await page.waitForFunction((lp) => new URL(location.href).pathname !== lp, loginPath, { timeout: 20000 });
    const file = path.join(os.tmpdir(), `gr-auth-${env}-${Date.now()}.json`);
    await ctx.storageState({ path: file });
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: String(err.message || err).split('\n')[0] };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function startRecording(env, name, role) {
  if (IS_DEMO) return denyInDemo;
  if (state.proc || state.recording) return { ok: false, error: 'A run is in progress — finish it first.' };
  if (!envNames().includes(env)) return { ok: false, error: `Unknown environment "${env}".` };
  const roleName = role ? String(role).trim() : '';
  if (roleName && !loadRolesRaw()[roleName]) return { ok: false, error: `Unknown role "${roleName}".` };

  const safe = String(name || '').trim().replace(/[^a-zA-Z0-9-]/g, '-') || 'recorded';
  const out = `tests/${safe}.spec.ts`;
  const url = baseURLof(env);

  state.status = 'running';
  state.recording = true; // guards a second start during the async pre-auth window (before state.proc is set)
  state.env = env;
  state.envs = [env]; // don't leave the previous run's env list advertised while recording
  state.lines = [];
  broadcast('started', publicState());
  const say = (line) => pushOutput(line);

  // Pre-authenticate so the recorder opens already logged in — driven by the
  // env's login-form config + .env, so it's generic for any app.
  let storageFile = null;
  if (roleName) {
    say(`Signing in as "${roleName}" so the recorder opens already logged in…`);
    const pre = await preAuth(env, roleName);
    if (state.status === 'stopped') { // user cancelled during pre-auth
      state.recording = false;
      state.status = 'idle';
      say('Recording cancelled.');
      broadcast('done', publicState());
      return { ok: true, out };
    }
    if (pre.ok) {
      storageFile = pre.file;
      say('Signed in — opening the recorder already logged in.');
    } else {
      say(`Couldn't pre-authenticate (${pre.error}). The recorder will open logged out — check the login form in Settings → Environments, or log in by hand and delete the recorded login lines afterward.`);
    }
  }
  say(`Opening a browser to record "${out}" against ${url}…`);
  say('Click through the site, then close the browser to save.');

  const args = ['playwright', 'codegen', '--target', 'playwright-test', '-o', out];
  if (storageFile) args.push(`--load-storage=${storageFile}`);
  args.push(url);
  const proc = spawn('npx', args, {
    cwd: ROOT,
    detached: process.platform !== 'win32',
    env: { ...process.env, TEST_ENV: env },
  });
  state.proc = proc;
  state.recording = false;
  let settled = false;
  const cleanupStorage = () => { if (storageFile) { try { fs.rmSync(storageFile, { force: true }); } catch { /* already gone */ } } };
  proc.stdout.on('data', pushOutput);
  proc.stderr.on('data', pushOutput);
  proc.on('error', (err) => {
    if (settled) return;
    settled = true;
    state.proc = null;
    state.recording = false;
    state.status = 'idle';
    cleanupStorage();
    pushOutput(`\nCouldn't open the recorder: ${err.message}\nIs Node/npx on your PATH? Try launching the app from a terminal.`);
    broadcast('done', publicState());
  });
  proc.on('close', () => {
    if (settled) return;
    settled = true;
    state.proc = null;
    state.recording = false;
    cleanupStorage(); // the pre-auth session was only for the recorder — the saved spec logs in fresh via login()
    // If the user hit Stop, don't post-process a half-written spec — just cancel.
    const aborted = state.status === 'stopped';
    state.status = 'idle';
    if (aborted) {
      pushOutput('\nRecording cancelled.');
      broadcast('done', publicState());
      return;
    }
    // Always: strip the ephemeral pre-auth storageState block + relativize URLs.
    cleanRecordedSpec(path.join(ROOT, out), url);
    if (roleName) {
      const injected = injectLoginIntoSpec(path.join(ROOT, out), roleName);
      setRecordedRole(out, roleName);
      pushOutput(injected ? `\nAdded automatic login as "${roleName}".` : `\nCouldn't auto-insert login — add \`await login('${roleName}')\` at the top by hand.`);
    }
    pushOutput(`\nSaved: ${out}\nRun it from the list above.`);
    broadcast('done', publicState());
  });
  return { ok: true, out };
}

// ------------------------------------------------------------------ run history
// Every finished run's report is archived to runs/<timestamp>-<env>-<result>/
// so past results can be reviewed any time (git-ignored, stays on this machine).
const RUNS_DIR = IS_DEMO ? path.join(DEMO_DIR, 'runs') : path.join(ROOT, 'runs');
// Cap history two ways: newest N by count, AND a total-size ceiling (each run
// duplicates the report + all videos/traces, so a handful of full-capture
// multi-env runs is many GB — the target user will never clear it by hand).
const RUNS_MAX = 30;
const RUNS_MAX_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB

function dirSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += dirSize(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  } catch {
    /* dir gone */
  }
  return total;
}

// Delete oldest runs until we're under both the count and size caps.
function pruneRuns() {
  let all = fs.readdirSync(RUNS_DIR).sort(); // oldest first
  // Count cap: drop everything but the newest RUNS_MAX.
  while (all.length > RUNS_MAX) {
    fs.rmSync(path.join(RUNS_DIR, all.shift()), { recursive: true, force: true });
  }
  // Size cap: keep dropping the oldest while over budget (always keep the newest).
  let total = all.reduce((n, d) => n + dirSize(path.join(RUNS_DIR, d)), 0);
  while (all.length > 1 && total > RUNS_MAX_BYTES) {
    const old = all.shift();
    total -= dirSize(path.join(RUNS_DIR, old));
    fs.rmSync(path.join(RUNS_DIR, old), { recursive: true, force: true });
  }
}

function archiveRun(env, result, startedAt) {
  try {
    const src = path.join(ROOT, 'playwright-report');
    const idx = path.join(src, 'index.html');
    if (!fs.existsSync(idx)) return;
    // Don't archive a STALE report: if the report predates this run (e.g. the
    // run was stopped/crashed before Playwright wrote a fresh one), archiving it
    // would file the previous run's results under this run's label — wrong data
    // shown with full confidence on the History page.
    if (startedAt && fs.statSync(idx).mtimeMs < startedAt - 2000) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(RUNS_DIR, `${stamp}-${env}-${result}`);
    fs.cpSync(src, dest, { recursive: true });
    // Also keep the raw results (snapshots + pdf-record.json) so past runs can
    // still export PDFs.
    const tr = path.join(ROOT, 'test-results');
    if (fs.existsSync(tr)) fs.cpSync(tr, path.join(dest, 'results'), { recursive: true });
    pruneRuns();
  } catch (err) {
    console.error('Could not archive run:', err.message);
  }
}

function listRuns() {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR)
    .filter((d) => fs.existsSync(path.join(RUNS_DIR, d, 'index.html')))
    .sort()
    .reverse()
    .map((d) => {
      // <timestamp>-<env>-<result> ; timestamp is 19 chars (2026-07-04T10-30-00)
      const rest = d.slice(20);
      const result = rest.split('-').pop();
      const env = rest.slice(0, rest.length - result.length - 1);
      // Stamp is "2026-07-08T02-00-37" (colons became dashes for the folder name);
      // render the time part back with colons so it reads as a clock time.
      const [date, time] = d.slice(0, 19).split('T');
      const when = `${date} ${(time || '').replace(/-/g, ':')}`;
      return { id: d, when, env, result };
    });
}

// ---------------------------------------------------------- snapshots -> PDF
// Where the pdf-record.json + snapshot PNGs live for a given run.
function resultsDir(run) {
  if (run && run !== 'latest') return path.join(RUNS_DIR, path.basename(run), 'results');
  return IS_DEMO ? path.join(DEMO_DIR, 'test-results') : path.join(ROOT, 'test-results');
}

// Read every test's pdf-record.json for a run, resolving snapshot files to the
// record's own folder (so it works for both the latest run and archived ones).
function collectRecords(run) {
  const base = resultsDir(run);
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const name of fs.readdirSync(base)) {
    const dir = path.join(base, name);
    const rp = path.join(dir, 'pdf-record.json');
    if (!fs.existsSync(rp)) continue;
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(rp, 'utf8'));
    } catch {
      continue;
    }
    rec.snapshots = (rec.snapshots || []).map((s) => ({ ...s, file: path.join(dir, path.basename(s.file)) }));
    const video = path.join(dir, 'video.webm');
    rec.videoFile = fs.existsSync(video) ? video : null;
    rec.dir = dir;
    const trace = path.join(dir, 'trace.zip');
    rec.traceFile = fs.existsSync(trace) ? trace : null;
    out.push({ test: name, record: rec });
  }
  return out;
}

function findRecord(run, test) {
  return collectRecords(run).find((r) => r.test === path.basename(test || ''));
}

// ---------------------------------------------------------- test library
// Discover every runnable spec in tests/ (recursively, ignoring the helpers/
// folder), with the test titles parsed out of each spec and last-run status
// attached. Tests are not tied to an environment.
const TESTS_DIR = path.join(ROOT, 'tests');

function titleFromFileName(file) {
  return path
    .basename(file, '.spec.ts')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Pull `test('...')` titles (but not test.describe / hooks) from a spec, plus any
// @tags in the title (Playwright convention — matched by --grep). Returns
// [{ title, tags }].
function parseTests(absPath) {
  let src = '';
  try {
    src = fs.readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  const re = /\btest(?:\.(?:only|skip|fixme))?\s*\(\s*(['"`])(.+?)\1/g;
  let m;
  while ((m = re.exec(src))) {
    const title = m[2];
    const tags = (title.match(/@[\w-]+/g) || []);
    out.push({ title, tags });
  }
  return out;
}

// Every *.spec.ts under tests/, recursively, skipping the helpers/ folder.
// Returns repo-relative POSIX paths (e.g. "tests/login.spec.ts").
function specFiles() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'helpers') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.spec.ts')) {
        out.push(path.relative(ROOT, abs).split(path.sep).join('/'));
      }
    }
  };
  walk(TESTS_DIR);
  return out;
}

// The env a Playwright project name encodes, e.g. "chromium (staging)" -> "staging".
function projectEnv(projectName) {
  const m = /\(([^)]+)\)\s*$/.exec(projectName || '');
  return m ? m[1] : projectName || '';
}

// Flatten Playwright's JSON reporter tree into [{ file, title, env, status, durationMs }].
// A spec run under N projects (a multi-env run) yields N rows — one per env — so
// the UI can show a test × environment matrix. A single-env run yields one row
// per test, exactly as before (with env filled in).
function flattenSuites(suites, file, acc) {
  for (const s of suites || []) {
    const f = s.file || file;
    for (const spec of s.specs || []) {
      const perProject = spec.tests || [];
      if (perProject.length) {
        for (const t of perProject) {
          const dur = (t.results || []).reduce((n, r) => n + (r.duration || 0), 0);
          const status = t.status === 'skipped' ? 'skipped' : t.status === 'expected' || t.status === 'flaky' ? 'passed' : 'failed';
          acc.push({ file: spec.file || f, title: spec.title, env: projectEnv(t.projectName), status, durationMs: dur });
        }
      } else {
        acc.push({ file: spec.file || f, title: spec.title, env: '', status: spec.ok ? 'passed' : 'failed', durationMs: 0 });
      }
    }
    if (s.suites) flattenSuites(s.suites, f, acc);
  }
  return acc;
}

// The role a spec logs in as, read from its first `login('<role>')` call (the role
// baked into the test). '' if it never logs in (a public-page test).
function specLoginRole(rel) {
  try {
    const m = fs.readFileSync(path.join(ROOT, rel), 'utf8').match(/\blogin\(\s*['"`]([^'"`]+)['"`]/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

// Per-test results of a run (default latest), read from results.json.
function readResults(run) {
  const file = path.join(resultsDir(run), 'results.json');
  if (!fs.existsSync(file)) return [];
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return flattenSuites(json.suites, '', []);
  } catch {
    return [];
  }
}

// Aggregate every archived run + the latest into per-test history, so the app
// can surface "flaky", "never run", "slowest", last status/duration.
// Keyed two ways: by file+title (precise — disambiguates two tests that share a
// title in different files) and by title alone (fallback for older runs whose
// results.json didn't record a file). listTests prefers the precise key.
function testHistory() {
  const runs = ['latest', ...listRuns().map((r) => r.id)];
  const byKey = new Map();
  const byTitle = new Map();
  const accumulate = (map, key, r) => {
    const h = map.get(key) || { statuses: [], lastStatus: null, lastDurationMs: 0, runCount: 0 };
    h.statuses.push(r.status);
    h.runCount++;
    if (h.lastStatus === null) { h.lastStatus = r.status; h.lastDurationMs = r.durationMs; } // 'latest' is first
    map.set(key, h);
  };
  for (const run of runs) {
    for (const r of readResults(run)) {
      accumulate(byTitle, r.title, r);
      if (r.file) accumulate(byKey, `${path.basename(r.file)}::${r.title}`, r);
    }
  }
  for (const h of [...byKey.values(), ...byTitle.values()]) {
    h.flaky = h.statuses.includes('passed') && h.statuses.includes('failed');
  }
  return { byKey, byTitle };
}

// ---- test metadata sidecar (group / priority / owner / notes), app-managed
const META_FILE = IS_DEMO ? path.join(DEMO_DIR, 'tests-meta.json') : path.join(TESTS_DIR, 'tests-meta.json');
const metaKey = (file, title) => `${file}::${title}`;

function loadMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveMeta(file, title, fields) {
  if (IS_DEMO) return denyInDemo;
  if (!validTestFile(file)) return { ok: false, error: 'No such test file.' };
  const meta = loadMeta();
  const key = metaKey(file, title);
  const cur = meta[key] || {};
  for (const k of ['group', 'priority', 'owner', 'notes', 'role']) {
    if (typeof fields[k] === 'string') cur[k] = fields[k].trim();
  }
  meta[key] = cur;
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + '\n');
  return { ok: true };
}

// Rewrite a test's @tags. Tags are Playwright's convention — they live in the
// test TITLE (so `--grep` finds them), not in the sidecar — so this edits the
// title string inside the spec file: strip its existing @tags, append the new
// set. Also migrates the sidecar meta key (`file::title`) since the title
// changed. Returns the new title so the caller can re-key.
function saveTags(file, title, tags) {
  if (IS_DEMO) return denyInDemo;
  if (!validTestFile(file)) return { ok: false, error: 'No such test file.' };
  // Normalize: '@'-prefixed, [\w-] only, deduped, non-empty.
  const norm = [...new Set(
    (Array.isArray(tags) ? tags : [])
      .map((t) => '@' + String(t).replace(/^@+/, '').replace(/[^\w-]/g, ''))
      .filter((t) => t.length > 1),
  )];
  const clean = String(title).replace(/\s*@[\w-]+/g, '').trim();
  const newTitle = clean + (norm.length ? ' ' + norm.join(' ') : '');
  if (newTitle === title) return { ok: true, title, tags: norm }; // nothing to change

  const abs = path.join(ROOT, file);
  let src;
  try {
    src = fs.readFileSync(abs, 'utf8');
  } catch {
    return { ok: false, error: 'No such test file.' };
  }
  // Replace the exact quoted title in its `test(...)` call. Try each quote style.
  let replaced = false;
  for (const c of ['`', '"', "'"]) {
    const needle = `${c}${title}${c}`;
    const idx = src.indexOf(needle);
    if (idx !== -1) {
      src = src.slice(0, idx) + `${c}${newTitle}${c}` + src.slice(idx + needle.length);
      replaced = true;
      break;
    }
  }
  if (!replaced) return { ok: false, error: 'Could not find that test in the file (was it edited elsewhere?). Reload and try again.' };
  fs.writeFileSync(abs, src);

  // Carry the sidecar metadata over to the new title.
  try {
    const meta = loadMeta();
    const oldKey = metaKey(file, title);
    const newKey = metaKey(file, newTitle);
    if (meta[oldKey] && oldKey !== newKey) {
      meta[newKey] = meta[oldKey];
      delete meta[oldKey];
      fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + '\n');
    }
  } catch {
    /* meta is best-effort */
  }
  return { ok: true, title: newTitle, tags: norm };
}

// The Tests page payload: one entry per test, enriched with tags (from the file),
// metadata (sidecar) and history (flaky/never-run/last status+duration), plus the
// distinct tag + group lists for the filter bar.
function listTests() {
  const hist = testHistory();
  const meta = loadMeta();
  const tests = [];
  const tagSet = new Set();
  const groupSet = new Set();
  for (const rel of specFiles()) {
    const parsedRole = specLoginRole(rel); // role baked into the spec's login('…') call
    for (const { title, tags } of parseTests(path.join(ROOT, rel))) {
      const h = hist.byKey.get(`${path.basename(rel)}::${title}`) || hist.byTitle.get(title);
      const m = meta[metaKey(rel, title)] || {};
      tags.forEach((t) => tagSet.add(t));
      if (m.group) groupSet.add(m.group);
      tests.push({
        file: rel,
        title,
        cleanTitle: title.replace(/\s*@[\w-]+/g, '').trim(), // title without the @tags
        tags,
        group: m.group || '',
        priority: m.priority || '',
        owner: m.owner || '',
        notes: m.notes || '',
        role: m.role || parsedRole, // login role this test runs as (meta, else parsed from login('…'))
        status: h ? h.lastStatus : null,
        durationMs: h ? h.lastDurationMs : 0,
        flaky: h ? !!h.flaky : false,
        neverRun: !h,
        runCount: h ? h.runCount : 0,
      });
    }
  }
  return { tests, tags: [...tagSet].sort(), groups: [...groupSet].sort() };
}

function renameTest(file, newName) {
  if (IS_DEMO) return denyInDemo;
  if (!validTestFile(file)) return { ok: false, error: 'No such test file.' };
  const safe = String(newName || '')
    .trim()
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase();
  if (!safe) return { ok: false, error: 'Enter a valid name.' };
  const dir = path.dirname(path.join(ROOT, file));
  const dest = path.join(dir, `${safe}.spec.ts`);
  if (fs.existsSync(dest)) return { ok: false, error: 'A test with that name already exists.' };
  fs.renameSync(path.join(ROOT, file), dest);
  const newRel = path.relative(ROOT, dest).split(path.sep).join('/');
  migrateMeta(file, newRel); // carry group/priority/owner/notes/role over to the new name
  return { ok: true, file: newRel };
}

// Move (or drop) the sidecar metadata keyed to a spec file when it's renamed or
// deleted — otherwise group/priority/owner/notes/role silently vanish on rename
// and dead entries pile up on delete. Keys are `<file>::<title>`.
function migrateMeta(oldRel, newRel) {
  if (IS_DEMO) return;
  try {
    const meta = loadMeta();
    let changed = false;
    for (const key of Object.keys(meta)) {
      if (!key.startsWith(`${oldRel}::`)) continue;
      if (newRel) meta[`${newRel}::${key.slice(oldRel.length + 2)}`] = meta[key];
      delete meta[key];
      changed = true;
    }
    if (changed) fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + '\n');
  } catch {
    /* meta is best-effort */
  }
}

function deleteTest(file) {
  if (IS_DEMO) return denyInDemo;
  if (!validTestFile(file)) return { ok: false, error: 'No such test file.' };
  fs.rmSync(path.join(ROOT, file));
  migrateMeta(file, null); // drop the orphaned sidecar entries
  return { ok: true };
}

// ---------------------------------------------------------- credentials (.env)
// Producers set logins from the app; values are written to the git-ignored .env
// and NEVER read back to the browser (the UI only learns whether each is set).
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

function readFileMaybe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function parseEnvText(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function envPrefix(env) {
  return env.toUpperCase().replace(/-/g, '_') + '_';
}

const roleVar = (name) => name.toUpperCase().replace(/-/g, '_');

// The old, pure var-name scan: which (env, role) logins are implied by the
// variable NAMES present in .env / .env.example. Kept as (a) the migration seed
// for roles.json and (b) a fallback so hand-edited .env roles still surface even
// if they were never created through the app.
function scanCredRoles() {
  const known = new Set([...Object.keys(parseEnvText(readFileMaybe(ENV_EXAMPLE))), ...Object.keys(parseEnvText(readFileMaybe(ENV_FILE)))]);
  const out = [];
  for (const env of envNames()) {
    const prefix = envPrefix(env);
    for (const v of known) {
      if (v.startsWith(prefix) && (v.endsWith('_USERNAME') || v.endsWith('_PASSWORD'))) {
        const mid = v.slice(prefix.length).replace(/_(USERNAME|PASSWORD)$/, '');
        if (mid) out.push({ env, name: mid.toLowerCase().replace(/_/g, '-') });
      }
    }
  }
  return out;
}

// The roles the app knows about per env — now sourced from role DEFINITIONS in
// config/roles.json (see below), unioned with the var-name scan so nothing that
// only exists in .env is lost. Returns "set" booleans only, never values.
function credRoles() {
  const out = [];
  for (const r of rolesWithStatus()) {
    for (const s of r.sites) {
      out.push({
        env: s.env,
        roleKey: roleVar(r.name),
        role: r.name, // what login(page, 'admin') / the login fixture expects
        label: r.label,
        usernameSet: s.usernameSet,
        passwordSet: s.passwordSet,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------- roles (config/roles.json)
// roles.json holds role DEFINITIONS ONLY — a role's name, label, and which
// environments (sites) it applies to. It NEVER holds credentials; those stay in
// the git-ignored .env. This split lets the app show a role↔site map and let
// users create roles before any login is filled in.
const ROLES_PATH = IS_DEMO ? path.join(DEMO_DIR, 'roles.json') : path.join(ROOT, 'config', 'roles.json');
const ROLES_EXAMPLE_PATH = path.join(ROOT, 'config', 'roles.example.json');

function normalizeRoles(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.startsWith('_')) continue; // skip _comment
    if (!v || typeof v !== 'object') continue;
    const envs = v.envs === 'all' ? 'all' : Array.isArray(v.envs) ? v.envs.filter((e) => typeof e === 'string') : 'all';
    out[k] = { label: typeof v.label === 'string' && v.label ? v.label : k, envs };
  }
  return out;
}

function loadRolesRaw() {
  const file = fs.existsSync(ROLES_PATH) ? ROLES_PATH : fs.existsSync(ROLES_EXAMPLE_PATH) ? ROLES_EXAMPLE_PATH : null;
  if (!file) return {};
  try {
    return normalizeRoles(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

function saveRolesRaw(roles) {
  fs.writeFileSync(ROLES_PATH, JSON.stringify(roles, null, 2) + '\n');
}

// Seed config/roles.json once, on first boot: start from the committed template
// (if any), then merge in every role already implied by existing .env vars so a
// migrating user's roles carry over. Runs only when roles.json doesn't exist yet.
function seedRoles() {
  if (IS_DEMO) return; // demo/roles.json ships committed; never write in demo
  if (fs.existsSync(ROLES_PATH)) return;
  const defs = loadRolesRaw(); // picks up roles.example.json if present
  for (const { env, name } of scanCredRoles()) {
    if (!defs[name]) defs[name] = { label: name.replace(/-/g, ' '), envs: [] };
    if (defs[name].envs !== 'all' && !defs[name].envs.includes(env)) defs[name].envs.push(env);
  }
  try {
    saveRolesRaw(defs);
  } catch {
    /* best effort — a read-only checkout still works via loadRolesRaw fallback */
  }
}
seedRoles();

// Role definitions expanded with per-env credential status. This is what the
// Roles & logins UI renders: for each role, the sites it maps to, the saved
// USERNAME (so the field pre-fills) and whether the password is set. The
// password itself is never returned.
function rolesWithStatus() {
  const dot = IS_DEMO ? {} : parseEnvText(readFileMaybe(ENV_FILE));
  // config/roles.json is the single source of truth for which roles exist. Legacy
  // roles implied only by raw .env var names are migrated into roles.json once by
  // seedRoles() on first boot; we deliberately do NOT re-union them here, so that
  // editing (or deleting a role from) roles.json is honoured immediately instead
  // of being silently overridden by a matching leftover .env credential. The .env
  // is still read below — but only to report each role's per-env credential
  // status, never to conjure a role.
  const defs = loadRolesRaw();
  const allEnvs = envNames();
  const out = [];
  for (const [name, def] of Object.entries(defs)) {
    const envs = def.envs === 'all' ? allEnvs : def.envs.filter((e) => allEnvs.includes(e));
    const roleUp = roleVar(name);
    const sites = envs.map((env) => {
      // In demo mode every login reads as configured (no real .env, never any values).
      if (IS_DEMO) return { env, username: '', usernameSet: true, passwordSet: true };
      // Same resolution order as getUser: env-scoped var wins, shared var falls back.
      const u = dot[`${envPrefix(env)}${roleUp}_USERNAME`] ?? dot[`${roleUp}_USERNAME`];
      const p = dot[`${envPrefix(env)}${roleUp}_PASSWORD`] ?? dot[`${roleUp}_PASSWORD`];
      // The saved USERNAME is returned so the field can pre-fill it — it's the
      // user's own test-account name on their own machine. The PASSWORD is never
      // returned (only whether it's set); the UI shows it masked as "•••••• (saved)".
      return { env, username: (u || '').trim(), usernameSet: !!(u && u.trim()), passwordSet: !!(p && p.trim()) };
    });
    out.push({ name, label: def.label, envs: def.envs, sites });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Create or update a role definition (name, label, which sites/envs it maps to).
function saveRole({ name, label, envs }) {
  if (IS_DEMO) return denyInDemo;
  const clean = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!clean) return { ok: false, error: 'Enter a role name (letters, numbers, dashes — e.g. admin).' };
  let envsVal = 'all';
  if (Array.isArray(envs)) envsVal = envs.filter((e) => envNames().includes(e));
  else if (envs !== 'all') envsVal = [];
  const defs = loadRolesRaw();
  defs[clean] = { label: typeof label === 'string' && label.trim() ? label.trim() : clean, envs: envsVal };
  saveRolesRaw(defs);
  return { ok: true, name: clean };
}

// Remove a role DEFINITION. Deliberately leaves any stored .env logins untouched
// — deleting a definition must never destroy secrets.
function deleteRole(name) {
  if (IS_DEMO) return denyInDemo;
  const defs = loadRolesRaw();
  if (!defs[name]) return { ok: false, error: 'No such role.' };
  delete defs[name];
  saveRolesRaw(defs);
  return { ok: true };
}

// ---------------------------------------------------------- site groups (config/groups.json)
// A named, saved set of environments (optionally pinned to a role) so a user can
// select "dev + staging" in one click on the Run page instead of re-ticking pills
// each time. Holds no secrets — just env names and an optional role name.
const GROUPS_PATH = IS_DEMO ? path.join(DEMO_DIR, 'groups.json') : path.join(ROOT, 'config', 'groups.json');
const GROUPS_EXAMPLE_PATH = path.join(ROOT, 'config', 'groups.example.json');

function normalizeGroups(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.startsWith('_')) continue;
    if (!v || typeof v !== 'object') continue;
    out[k] = {
      label: typeof v.label === 'string' && v.label ? v.label : k,
      envs: Array.isArray(v.envs) ? v.envs.filter((e) => typeof e === 'string') : [],
      role: typeof v.role === 'string' ? v.role : '',
    };
  }
  return out;
}

function loadGroupsRaw() {
  const file = fs.existsSync(GROUPS_PATH) ? GROUPS_PATH : fs.existsSync(GROUPS_EXAMPLE_PATH) ? GROUPS_EXAMPLE_PATH : null;
  if (!file) return {};
  try {
    return normalizeGroups(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

// Groups filtered to still-valid envs, with a flag if any member env is gone.
function listGroups() {
  const known = envNames();
  return Object.entries(loadGroupsRaw())
    .map(([name, g]) => {
      const envs = g.envs.filter((e) => known.includes(e));
      return { name, label: g.label, envs, role: g.role, missing: g.envs.length !== envs.length };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function saveGroup({ name, label, envs, role }) {
  if (IS_DEMO) return denyInDemo;
  const clean = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!clean) return { ok: false, error: 'Enter a group name (letters, numbers, dashes — e.g. non-prod).' };
  const envsVal = Array.isArray(envs) ? envs.filter((e) => envNames().includes(e)) : [];
  if (!envsVal.length) return { ok: false, error: 'Pick at least one environment for the group.' };
  const roleVal = typeof role === 'string' && loadRolesRaw()[role] ? role : '';
  const defs = loadGroupsRaw();
  defs[clean] = { label: typeof label === 'string' && label.trim() ? label.trim() : clean, envs: envsVal, role: roleVal };
  fs.writeFileSync(GROUPS_PATH, JSON.stringify(defs, null, 2) + '\n');
  return { ok: true, name: clean };
}

function deleteGroup(name) {
  if (IS_DEMO) return denyInDemo;
  const defs = loadGroupsRaw();
  if (!defs[name]) return { ok: false, error: 'No such group.' };
  delete defs[name];
  fs.writeFileSync(GROUPS_PATH, JSON.stringify(defs, null, 2) + '\n');
  return { ok: true };
}

function upsertEnvVar(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  return (text.endsWith('\n') || text === '' ? text : text + '\n') + line + '\n';
}

// Write a role's login into .env (creating it if needed). Only non-empty fields
// are written, so saving with one field blank won't wipe the other.
function saveCred({ env, role, username, password }) {
  if (IS_DEMO) return denyInDemo;
  if (!envNames().includes(env)) return { ok: false, error: `Unknown environment "${env}".` };
  const roleKey = String(role || '')
    .toUpperCase()
    .replace(/-/g, '_')
    .replace(/[^A-Z0-9_]/g, '');
  if (!roleKey) return { ok: false, error: 'Enter a role name (e.g. admin).' };
  // Reject control characters: a newline in a value would inject arbitrary extra
  // lines into .env (e.g. "pass\nEVIL=1"), which dotenv would then load into
  // every test run. Values are single-line by definition.
  const hasControlChars = (v) => typeof v === 'string' && /[\x00-\x1f\x7f]/.test(v);
  if (hasControlChars(username) || hasControlChars(password)) {
    return { ok: false, error: 'Username and password cannot contain line breaks or control characters.' };
  }
  const prefix = envPrefix(env) + roleKey;
  let text = readFileMaybe(ENV_FILE);
  if (typeof username === 'string' && username.trim()) text = upsertEnvVar(text, `${prefix}_USERNAME`, username.trim());
  if (typeof password === 'string' && password.trim()) text = upsertEnvVar(text, `${prefix}_PASSWORD`, password.trim());
  fs.writeFileSync(ENV_FILE, text);
  return { ok: true };
}

// ---------------------------------------------------------- bug report
function bugSummaryMd(record, run) {
  const when = run && run !== 'latest' ? run.slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ');
  const lines = [];
  lines.push(`# Bug report — ${record.title || '(untitled test)'}`);
  lines.push('');
  lines.push(`- **Result:** ${record.status || 'unknown'}`);
  lines.push(`- **Environment:** ${record.env || '—'} (${record.baseURL || '—'})`);
  lines.push(`- **When:** ${when}`);
  lines.push(`- **Browser:** ${record.browser || '—'}`);
  lines.push(`- **Viewport:** ${record.viewport ? `${record.viewport.width} × ${record.viewport.height}` : '—'}`);
  lines.push(`- **Duration:** ${record.durationMs ? (record.durationMs / 1000).toFixed(1) + 's' : '—'}`);
  lines.push('');
  lines.push('## What happened');
  lines.push(record.error ? '```\n' + record.error + '\n```' : 'Test passed — no error recorded.');
  lines.push('');
  lines.push('## Pages visited');
  (record.snapshots || []).forEach((s, i) => lines.push(`${i + 1}. ${s.title || s.url || '(page)'} — ${s.url || ''}`));
  lines.push('');
  // Full console/network text lives in the collapsible sections on the Report a
  // bug page (and console.txt/network.txt in the bundle) — kept out of this
  // summary so a Slack/ClickUp paste stays short.
  lines.push(`## Console`);
  lines.push(record.console?.length ? `${record.console.length} message(s) — see the Report a bug page or console.txt in the bundle.` : 'Nothing logged.');
  lines.push('');
  lines.push(`## Network issues`);
  lines.push(record.network?.length ? `${record.network.length} issue(s) — see the Report a bug page or network.txt in the bundle.` : 'No failed or error responses.');
  lines.push('');
  lines.push('## Files in this bundle');
  lines.push('- `summary.md` — this file');
  lines.push('- `record.json` — full machine-readable record');
  if (record.traceFile) lines.push('- `trace.zip` — open at https://trace.playwright.dev for a step-by-step replay (screenshots, console, network, DOM)');
  if (record.videoFile) lines.push('- `video.webm` — full screen recording of the test');
  lines.push('- `screenshots/` — one image per page the test visited');
  lines.push('');
  lines.push('_Generated by Greenroom._');
  return lines.join('\n');
}

function buildBugBundle(run, test) {
  const found = findRecord(run, test);
  if (!found) return null;
  const rec = found.record;
  const entries = [];
  entries.push({ name: 'summary.md', data: Buffer.from(bugSummaryMd(rec, run), 'utf8') });
  entries.push({ name: 'record.json', data: Buffer.from(JSON.stringify(rec, null, 2), 'utf8') });
  if (rec.console?.length) entries.push({ name: 'console.txt', data: Buffer.from(rec.console.join('\n'), 'utf8') });
  if (rec.network?.length) entries.push({ name: 'network.txt', data: Buffer.from(rec.network.join('\n'), 'utf8') });
  for (const s of rec.snapshots || []) {
    if (fs.existsSync(s.file)) entries.push({ name: `screenshots/${path.basename(s.file)}`, data: fs.readFileSync(s.file) });
  }
  if (rec.videoFile && fs.existsSync(rec.videoFile)) entries.push({ name: 'video.webm', data: fs.readFileSync(rec.videoFile) });
  if (rec.traceFile && fs.existsSync(rec.traceFile)) entries.push({ name: 'trace.zip', data: fs.readFileSync(rec.traceFile) });
  return { record: rec, zip: zipStore(entries) };
}

// ---------------------------------------------------------- guide + onboarding
function onboardingState() {
  return {
    envFileExists: fs.existsSync(ENV_FILE),
    anyCreds: credRoles().some((c) => c.usernameSet && c.passwordSet),
    hasRuns: listRuns().length > 0,
    reportExists: fs.existsSync(path.join(ROOT, 'playwright-report', 'index.html')),
    testCount: specFiles().length,
  };
}

// ---------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    });
    res.end(data);
  });
}

// Serve a file with HTTP Range support. Needed for <video> scrubbing/seeking:
// the browser sends `Range` and expects a 206 partial response + Content-Length.
// (serveFile sends the whole body with no length, which kills seeking.)
function serveRanged(req, res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (isNaN(start) || isNaN(end) || start > end || end >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(filePath).pipe(res);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

// ---------------------------------------------------------------------- server
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // --- local-only guardrails (see isLoopbackHost) ---
  // Serve loopback Hosts only — blocks DNS-rebinding (a domain pointing at
  // 127.0.0.1 sends its own Host header).
  if (!isLoopbackHost(req.headers.host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  // Reject cross-origin writes (CSRF): a state-changing request carrying a
  // non-loopback Origin is a foreign page poking our local API. Same-origin
  // fetches from our own UI send a loopback Origin (or none).
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !isLoopbackOrigin(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Cross-origin request refused.' }));
    }
    // A POST that carries a body must declare JSON. This blocks a cross-origin
    // "simple" form post (which can only set text/plain and skips preflight)
    // from reaching a write endpoint. Bodyless POSTs (e.g. /api/stop) are fine.
    if (req.method === 'POST' && Number(req.headers['content-length'] || 0) > 0) {
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (!ct.startsWith('application/json')) {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Expected application/json.' }));
      }
    }
  }

  if (p === '/' || p === '/index.html') {
    return serveFile(res, path.join(__dirname, 'index.html'));
  }

  if (p === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(publicState()));
  }

  if (p === '/api/envs') {
    if (req.method === 'GET') {
      const u = loadUrls();
      // Each env carries its OWN login block (empty = inherits the shared one),
      // plus the shared `_login`. Login selectors aren't secrets, so they're
      // returned so the Environments panel can show + edit them.
      const envs = envNames().map((n) => ({ name: n, baseURL: u[n].baseURL, login: sanitizeLoginForm(u[n] && u[n].login) }));
      const sharedLogin = sanitizeLoginForm(u._login);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ envs, sharedLogin }));
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      // `{ shared: true, login }` edits the shared `_login`; otherwise it's a
      // normal env upsert that may also carry that env's own `login` override.
      const result = body && body.shared
        ? saveSharedLogin(body.login)
        : saveEnv(String((body && body.name) || '').trim(), String((body && body.baseURL) || '').trim(), body ? body.login : undefined);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
    if (req.method === 'DELETE') {
      const result = deleteEnv(String(url.searchParams.get('name') || ''));
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
  }

  if (p === '/api/run' && req.method === 'POST') {
    const { env, envs, light, files, grep, role } = await readBody(req);
    // Accept either `envs` (array — multi-env run) or `env` (string — single).
    const result = startRun(envs != null ? envs : env, light, files, grep, role);
    res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  if (p === '/api/stop' && req.method === 'POST') {
    const result = stopRun();
    res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  if (p === '/api/record' && req.method === 'POST') {
    const { env, name, role } = await readBody(req);
    const result = await startRecording(env, name, role);
    res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  // ---- dynamic test data: inspect + rewrite a recorded spec's inputs ----
  if (p === '/api/recorded-inputs' && req.method === 'GET') {
    const result = recordedInputs(String(url.searchParams.get('file') || ''));
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }
  if (p === '/api/apply-inputs' && req.method === 'POST') {
    const { file, mappings } = await readBody(req);
    const result = applyInputs(file, mappings);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  if (p === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Replay what we have, then stream live.
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    for (const line of state.lines) {
      res.write(`event: line\ndata: ${JSON.stringify({ line })}\n\n`);
    }
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/runs') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(listRuns()));
  }

  // Tests + their snapshots for a run (default: the latest run).
  if (p === '/api/pdf-data') {
    const run = url.searchParams.get('run') || 'latest';
    const data = collectRecords(run).map(({ test, record }) => ({
      test,
      title: record.title,
      status: record.status,
      env: record.env,
      hasVideo: !!record.videoFile,
      snapshots: record.snapshots.map((s) => ({ index: s.index, t: typeof s.t === 'number' ? s.t : null, title: s.title, url: s.url, final: !!s.final })),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data));
  }

  // A single snapshot PNG (for the preview thumbnail).
  if (p === '/api/pdf-image') {
    const run = url.searchParams.get('run') || 'latest';
    const test = url.searchParams.get('test');
    const i = Number(url.searchParams.get('i'));
    const found = findRecord(run, test);
    const snap = found?.record.snapshots[i];
    if (!snap || !fs.existsSync(snap.file)) {
      res.writeHead(404);
      return res.end('Not found');
    }
    return serveFile(res, snap.file);
  }

  // Timed console/network/request logs + duration for the app's log views: the
  // always-visible full logs (Report a bug summary) and the per-screenshot
  // interval logs in the moment picker. The interval is computed client-side
  // (from the previous screenshot's `t` to the current one's) and echoed back
  // to /api/pdf so an exported PDF is scoped to the exact same window.
  if (p === '/api/moment') {
    const run = url.searchParams.get('run') || 'latest';
    const test = url.searchParams.get('test');
    const found = findRecord(run, test);
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Not found' }));
    }
    const r = found.record;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        durationMs: r.durationMs || 0,
        consoleTimed: r.consoleTimed || [],
        networkTimed: r.networkTimed || [],
        // Every network request (timed) — method/status/url/type.
        requests: r.requests || [],
        // Full (untimed) logs — fallback for runs recorded before per-line timing.
        console: r.console || [],
        network: r.network || [],
      })
    );
  }

  // The test's video (for the reference player). ?download=1 forces a save
  // instead of the browser trying to play it inline.
  if (p === '/api/video') {
    const run = url.searchParams.get('run') || 'latest';
    const test = url.searchParams.get('test');
    const found = findRecord(run, test);
    if (!found?.record.videoFile || !fs.existsSync(found.record.videoFile)) {
      res.writeHead(404);
      return res.end('No video');
    }
    if (url.searchParams.get('download')) {
      const name = (found.record.title || 'recording').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60);
      res.setHeader('Content-Disposition', `attachment; filename="${name || 'recording'}.webm"`);
    }
    return serveRanged(req, res, found.record.videoFile);
  }

  // Whether a clip can be cut from a recording (Playwright's bundled ffmpeg, or
  // a system one). The UI hides/disables clip export when this is false.
  if (p === '/api/ffmpeg-available') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ available: !!ffmpeg.resolveFfmpeg() }));
  }

  // A trimmed clip [from, to] (seconds) of the test's recording — a `-c copy`
  // cut, so it's fast and lossless. Needs ffmpeg; see /api/ffmpeg-available.
  if (p === '/api/video-clip') {
    const run = url.searchParams.get('run') || 'latest';
    const test = url.searchParams.get('test');
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));
    const found = findRecord(run, test);
    if (!found?.record.videoFile || !fs.existsSync(found.record.videoFile)) {
      res.writeHead(404);
      return res.end('No video');
    }
    if (!isFinite(from) || !isFinite(to) || to <= from) {
      res.writeHead(400);
      return res.end('Invalid clip range');
    }
    if (!ffmpeg.resolveFfmpeg()) {
      res.writeHead(501, { 'Content-Type': 'text/plain' });
      return res.end('ffmpeg not available — install ffmpeg, or download the full recording instead.');
    }
    const name = (found.record.title || 'clip').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    res.writeHead(200, {
      'Content-Type': 'video/webm',
      'Content-Disposition': `attachment; filename="${name || 'clip'}-${from.toFixed(1)}s-${to.toFixed(1)}s.webm"`,
    });
    ffmpeg.streamClip(found.record.videoFile, from, to, res);
    return;
  }

  // Build + return the PDF for a chosen snapshot. `from`/`to` (ms) scope the
  // console/network in the PDF to that exact interval — see pdf.js.
  if (p === '/api/pdf' && req.method === 'POST') {
    const { run = 'latest', test, i = 0, from, to } = await readBody(req);
    const found = findRecord(run, test);
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Snapshot data not found.' }));
    }
    try {
      const pdf = await buildPdf(found.record, Number(i), {
        from: typeof from === 'number' ? from : undefined,
        to: typeof to === 'number' ? to : undefined,
      });
      const name = (found.record.title || 'report').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${name || 'report'}.pdf"`,
      });
      return res.end(pdf);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // ---- test library ----
  if (p === '/api/tests') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(listTests()));
    }
    if (req.method === 'DELETE') {
      const result = deleteTest(String(url.searchParams.get('file') || ''));
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
  }

  if (p === '/api/tests/rename' && req.method === 'POST') {
    const { file, name } = await readBody(req);
    const result = renameTest(file, name);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  // Set a test's group / priority / owner / notes (app-managed sidecar).
  if (p === '/api/test-meta' && req.method === 'POST') {
    const { file, title, group, priority, owner, notes } = await readBody(req);
    const result = saveMeta(file, title, { group, priority, owner, notes });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  // Rewrite a test's @tags in its title (returns the new title).
  if (p === '/api/test-tags' && req.method === 'POST') {
    const { file, title, tags } = await readBody(req);
    const result = saveTags(file, title, tags);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  // Per-test results of a run (default latest) — the readable checklist.
  if (p === '/api/results') {
    const run = url.searchParams.get('run') || 'latest';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(readResults(run)));
  }

  // ---- credentials ----
  if (p === '/api/creds') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(credRoles()));
    }
    if (req.method === 'POST') {
      const result = saveCred(await readBody(req));
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
  }

  // ---- roles (definitions + role↔site map; never returns credential values) ----
  if (p === '/api/roles') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(rolesWithStatus()));
    }
    if (req.method === 'POST') {
      const result = saveRole(await readBody(req));
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
    if (req.method === 'DELETE') {
      const result = deleteRole(String(url.searchParams.get('name') || ''));
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
  }

  // ---- site groups (named env presets for one-click multi-env selection) ----
  if (p === '/api/groups') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(listGroups()));
    }
    if (req.method === 'POST') {
      const result = saveGroup(await readBody(req));
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
    if (req.method === 'DELETE') {
      const result = deleteGroup(String(url.searchParams.get('name') || ''));
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
  }

  // ---- bug report ----
  if (p === '/api/bug-summary') {
    const run = url.searchParams.get('run') || 'latest';
    const found = findRecord(run, url.searchParams.get('test'));
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Test not found.' }));
    }
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    return res.end(bugSummaryMd(found.record, run));
  }

  if (p === '/api/bug-bundle') {
    const run = url.searchParams.get('run') || 'latest';
    const test = url.searchParams.get('test');
    const bundle = buildBugBundle(run, test);
    if (!bundle) {
      res.writeHead(404);
      return res.end('Test not found');
    }
    const safe = (bundle.record.env || 'run') + '-' + path.basename(String(test || 'test')).replace(/[^a-z0-9]+/gi, '-').slice(0, 50);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="bug-${safe}.zip"`,
    });
    return res.end(bundle.zip);
  }

  // ---- guide + onboarding ----
  if (p === '/api/guide') {
    const md = readFileMaybe(path.join(ROOT, 'USER-GUIDE.md'));
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    return res.end(md || '# Guide\n\nUSER-GUIDE.md is missing.');
  }

  if (p === '/api/onboarding') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(onboardingState()));
  }

  // ---- app assets ----
  if (p === '/app.js' || p === '/styles.css') {
    return serveFile(res, path.join(__dirname, p.slice(1)));
  }

  if (p.startsWith('/report')) {
    const rel = p === '/report' || p === '/report/' ? 'index.html' : p.slice('/report/'.length);
    const reportDir = path.join(ROOT, 'playwright-report');
    const target = path.normalize(path.join(reportDir, decodeURIComponent(rel)));
    // dir + separator, so a sibling like ".../playwright-report-evil" can't pass.
    if (target !== reportDir && !target.startsWith(reportDir + path.sep)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    return serveFile(res, target);
  }

  if (p.startsWith('/runs/')) {
    let rel = decodeURIComponent(p.slice('/runs/'.length));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    if (!rel.includes('/')) rel += '/index.html';
    const target = path.normalize(path.join(RUNS_DIR, rel));
    if (target !== RUNS_DIR && !target.startsWith(RUNS_DIR + path.sep)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    return serveFile(res, target);
  }

  res.writeHead(404);
  res.end('Not found');
}

// Wrap every request so one thrown error (a bad fs read, a malformed body, an fs
// race) returns a 500 with a message instead of taking the whole server down —
// a silently dead page is the worst failure mode for a non-coder.
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('Request error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Server error: ' + err.message }));
    } else {
      try {
        res.end();
      } catch {
        /* connection already gone */
      }
    }
  });
});

// Kill any in-flight run/recording so exiting the server doesn't orphan a
// detached Playwright process group that keeps running invisibly.
function shutdown() {
  if (state.proc) {
    try {
      killProc(state.proc);
    } catch {
      /* best effort */
    }
  }
}
process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});
process.on('exit', shutdown);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Don't blindly assume it's us — another app on this port would otherwise
    // make the VS Code task open the browser onto the wrong app silently.
    const probe = http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', timeout: 1500 }, (r) => {
      let body = '';
      r.on('data', (c) => (body += c));
      r.on('end', () => {
        let ours = false;
        try {
          ours = typeof JSON.parse(body).demo === 'boolean';
        } catch {
          /* not JSON → not us */
        }
        if (ours) {
          console.log(`Greenroom is already running → http://localhost:${PORT}`);
          process.exit(0);
        } else {
          console.error(`Port ${PORT} is in use by another app. Set a different port and retry, e.g. PORT=4322 npm start`);
          process.exit(1);
        }
      });
    });
    probe.on('error', () => {
      console.error(`Port ${PORT} is in use. Set a different port and retry, e.g. PORT=4322 npm start`);
      process.exit(1);
    });
    return;
  }
  throw err;
});

// Loopback only — this is a local app; never expose it to the LAN.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Test interface ready → http://localhost:${PORT}`);
});
