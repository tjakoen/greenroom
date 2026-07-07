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
const path = require('path');
const { buildPdf } = require('./pdf');
const { zipStore } = require('./zip');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 4321);
const URLS_PATH = path.join(ROOT, 'config', 'urls.json');
const URLS_EXAMPLE_PATH = path.join(ROOT, 'config', 'urls.example.json');

// urls.json holds your real environments and is git-ignored. On a fresh clone
// it won't exist, so seed it from the committed template on first boot.
function seedUrls() {
  if (!fs.existsSync(URLS_PATH) && fs.existsSync(URLS_EXAMPLE_PATH)) {
    fs.copyFileSync(URLS_EXAMPLE_PATH, URLS_PATH);
  }
}
seedUrls();

// Environments are read fresh every time so edits from the app take effect
// without restarting the server.
function loadUrls() {
  const file = fs.existsSync(URLS_PATH) ? URLS_PATH : URLS_EXAMPLE_PATH;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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

// Add or update an environment in config/urls.json and seed a login block in
// .env.example. Preserves other fields on an existing entry (e.g. "default").
// If this is the first environment, it becomes the default.
function saveEnv(name, baseURL) {
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

function deleteEnv(name) {
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
  env: null,
  light: false,
  lines: [],
  proc: null,
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
    light: state.light,
    envs: envNames(),
    envFileExists: fs.existsSync(path.join(ROOT, '.env')),
    reportExists: fs.existsSync(path.join(ROOT, 'playwright-report', 'index.html')),
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
// every test in tests/. Tests are not tied to an environment; `env` only picks
// which baseURL/logins they run against.
function startRun(env, light, files, grep) {
  if (state.proc) return { ok: false, error: 'A run is already in progress.' };
  if (!envNames().includes(env)) return { ok: false, error: `Unknown environment "${env}".` };

  let targets;
  if (Array.isArray(files) && files.length) {
    targets = files.filter(validTestFile);
    if (!targets.length) return { ok: false, error: 'None of the selected test files exist.' };
  } else {
    targets = ['tests'];
  }
  const grepArgs = typeof grep === 'string' && grep.trim() ? ['--grep', grep.trim()] : [];

  state.status = 'running';
  state.env = env;
  state.light = !!light;
  state.lines = [];

  const proc = spawn('npx', ['playwright', 'test', ...targets, ...grepArgs], {
    cwd: ROOT,
    env: {
      ...process.env,
      TEST_ENV: env,
      ...(light ? { CAPTURE: 'light' } : {}),
    },
  });
  state.proc = proc;

  proc.stdout.on('data', pushOutput);
  proc.stderr.on('data', pushOutput);
  proc.on('close', (code) => {
    state.proc = null;
    if (state.status === 'running') state.status = code === 0 ? 'passed' : 'failed';
    archiveRun(env, state.status);
    broadcast('done', publicState());
  });

  broadcast('started', publicState());
  return { ok: true };
}

function stopRun() {
  if (!state.proc) return { ok: false, error: 'Nothing is running.' };
  state.status = 'stopped';
  state.proc.kill('SIGTERM');
  return { ok: true };
}

// ------------------------------------------------------------------- recording
// Opens Playwright's recorder: a real browser on this machine. Whatever the user
// clicks becomes a test file. Local only (needs a screen). Reports the saved path.
function startRecording(env, name) {
  if (state.proc) return { ok: false, error: 'A run is in progress — finish it first.' };
  if (!envNames().includes(env)) return { ok: false, error: `Unknown environment "${env}".` };

  const safe = String(name || '').trim().replace(/[^a-zA-Z0-9-]/g, '-') || 'recorded';
  const out = `tests/${safe}.spec.ts`;
  const url = baseURLof(env);

  state.status = 'running';
  state.env = env;
  state.lines = [`Opening a browser to record "${out}" against ${url}…`, 'Click through the site, then close the browser to save.'];
  broadcast('started', publicState());
  for (const line of state.lines) broadcast('line', { line });

  const proc = spawn('npx', ['playwright', 'codegen', '--target', 'playwright-test', '-o', out, url], {
    cwd: ROOT,
    env: { ...process.env, TEST_ENV: env },
  });
  state.proc = proc;
  proc.stdout.on('data', pushOutput);
  proc.stderr.on('data', pushOutput);
  proc.on('close', () => {
    state.proc = null;
    state.status = 'idle';
    pushOutput(`\nSaved: ${out}\nRun it from the list above.`);
    broadcast('done', publicState());
  });
  return { ok: true, out };
}

// ------------------------------------------------------------------ run history
// Every finished run's report is archived to runs/<timestamp>-<env>-<result>/
// so past results can be reviewed any time (git-ignored, stays on this machine).
const RUNS_DIR = path.join(ROOT, 'runs');

function archiveRun(env, result) {
  try {
    const src = path.join(ROOT, 'playwright-report');
    if (!fs.existsSync(path.join(src, 'index.html'))) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(RUNS_DIR, `${stamp}-${env}-${result}`);
    fs.cpSync(src, dest, { recursive: true });
    // Also keep the raw results (snapshots + pdf-record.json) so past runs can
    // still export PDFs.
    const tr = path.join(ROOT, 'test-results');
    if (fs.existsSync(tr)) fs.cpSync(tr, path.join(dest, 'results'), { recursive: true });
    // Keep the newest 30 runs; delete older ones.
    const all = fs.readdirSync(RUNS_DIR).sort().reverse();
    for (const old of all.slice(30)) {
      fs.rmSync(path.join(RUNS_DIR, old), { recursive: true, force: true });
    }
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
      return { id: d, when: d.slice(0, 19).replace('T', ' '), env, result };
    });
}

// ---------------------------------------------------------- snapshots -> PDF
// Where the pdf-record.json + snapshot PNGs live for a given run.
function resultsDir(run) {
  if (run && run !== 'latest') return path.join(RUNS_DIR, path.basename(run), 'results');
  return path.join(ROOT, 'test-results');
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

// Flatten Playwright's JSON reporter tree into [{ file, title, status, durationMs }].
function flattenSuites(suites, file, acc) {
  for (const s of suites || []) {
    const f = s.file || file;
    for (const spec of s.specs || []) {
      const dur = (spec.tests || []).flatMap((t) => t.results || []).reduce((n, r) => n + (r.duration || 0), 0);
      acc.push({ file: spec.file || f, title: spec.title, status: spec.ok ? 'passed' : 'failed', durationMs: dur });
    }
    if (s.suites) flattenSuites(s.suites, f, acc);
  }
  return acc;
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
function testHistory() {
  const runs = ['latest', ...listRuns().map((r) => r.id)];
  const hist = new Map(); // title -> { statuses:[], lastStatus, lastDurationMs, runCount }
  for (const run of runs) {
    for (const r of readResults(run)) {
      const h = hist.get(r.title) || { statuses: [], lastStatus: null, lastDurationMs: 0, runCount: 0 };
      h.statuses.push(r.status);
      h.runCount++;
      if (h.lastStatus === null) { h.lastStatus = r.status; h.lastDurationMs = r.durationMs; } // 'latest' is first
      hist.set(r.title, h);
    }
  }
  for (const h of hist.values()) {
    h.flaky = h.statuses.includes('passed') && h.statuses.includes('failed');
  }
  return hist;
}

// ---- test metadata sidecar (group / priority / owner / notes), app-managed
const META_FILE = path.join(TESTS_DIR, 'tests-meta.json');
const metaKey = (file, title) => `${file}::${title}`;

function loadMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveMeta(file, title, fields) {
  if (!validTestFile(file)) return { ok: false, error: 'No such test file.' };
  const meta = loadMeta();
  const key = metaKey(file, title);
  const cur = meta[key] || {};
  for (const k of ['group', 'priority', 'owner', 'notes']) {
    if (typeof fields[k] === 'string') cur[k] = fields[k].trim();
  }
  meta[key] = cur;
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + '\n');
  return { ok: true };
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
    for (const { title, tags } of parseTests(path.join(ROOT, rel))) {
      const h = hist.get(title);
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
  return { ok: true, file: path.relative(ROOT, dest) };
}

function deleteTest(file) {
  if (!validTestFile(file)) return { ok: false, error: 'No such test file.' };
  fs.rmSync(path.join(ROOT, file));
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

// The roles the app knows about per env: any *_USERNAME/_PASSWORD var found in
// .env.example or .env, grouped by env prefix. Returns "set" booleans only.
function credRoles() {
  const dot = parseEnvText(readFileMaybe(ENV_FILE));
  const known = new Set([...Object.keys(parseEnvText(readFileMaybe(ENV_EXAMPLE))), ...Object.keys(dot)]);
  const out = [];
  for (const env of envNames()) {
    const prefix = envPrefix(env);
    const roleKeys = new Set();
    for (const v of known) {
      if (v.startsWith(prefix) && (v.endsWith('_USERNAME') || v.endsWith('_PASSWORD'))) {
        const mid = v.slice(prefix.length).replace(/_(USERNAME|PASSWORD)$/, '');
        if (mid) roleKeys.add(mid);
      }
    }
    for (const roleKey of [...roleKeys].sort()) {
      const u = dot[`${prefix}${roleKey}_USERNAME`];
      const p = dot[`${prefix}${roleKey}_PASSWORD`];
      out.push({
        env,
        roleKey,
        role: roleKey.toLowerCase().replace(/_/g, '-'), // what login(page, 'admin') expects
        label: roleKey.toLowerCase().replace(/_/g, ' '),
        usernameSet: !!(u && u.trim()),
        passwordSet: !!(p && p.trim()),
      });
    }
  }
  return out;
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
  if (!envNames().includes(env)) return { ok: false, error: `Unknown environment "${env}".` };
  const roleKey = String(role || '')
    .toUpperCase()
    .replace(/-/g, '_')
    .replace(/[^A-Z0-9_]/g, '');
  if (!roleKey) return { ok: false, error: 'Enter a role name (e.g. admin).' };
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
  lines.push(`## Console (${record.console?.length || 0})`);
  lines.push(record.console?.length ? '```\n' + record.console.join('\n') + '\n```' : 'Nothing logged.');
  lines.push('');
  lines.push(`## Network issues (${record.network?.length || 0})`);
  lines.push(record.network?.length ? '```\n' + record.network.join('\n') + '\n```' : 'No failed or error responses.');
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
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

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
      const list = envNames().map((n) => ({ name: n, baseURL: u[n].baseURL }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(list));
    }
    if (req.method === 'POST') {
      const { name, baseURL } = await readBody(req);
      const result = saveEnv(String(name || '').trim(), String(baseURL || '').trim());
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
    const { env, light, files, grep } = await readBody(req);
    const result = startRun(env, light, files, grep);
    res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  if (p === '/api/stop' && req.method === 'POST') {
    const result = stopRun();
    res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  if (p === '/api/record' && req.method === 'POST') {
    const { env, name } = await readBody(req);
    const result = startRecording(env, name);
    res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' });
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
      snapshots: record.snapshots.map((s) => ({ index: s.index, title: s.title, url: s.url, final: !!s.final })),
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

  // The test's video (for the frame scrubber).
  if (p === '/api/video') {
    const run = url.searchParams.get('run') || 'latest';
    const test = url.searchParams.get('test');
    const found = findRecord(run, test);
    if (!found?.record.videoFile || !fs.existsSync(found.record.videoFile)) {
      res.writeHead(404);
      return res.end('No video');
    }
    return serveRanged(req, res, found.record.videoFile);
  }

  // Build + return the PDF for a chosen snapshot.
  if (p === '/api/pdf' && req.method === 'POST') {
    const { run = 'latest', test, i = 0, imageData, caption, time } = await readBody(req);
    const found = findRecord(run, test);
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Snapshot data not found.' }));
    }
    try {
      const pdf = await buildPdf(found.record, Number(i), { imageData, caption, time: typeof time === 'number' ? time : undefined });
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
    if (!target.startsWith(reportDir)) {
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
    if (!target.startsWith(RUNS_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    return serveFile(res, target);
  }

  res.writeHead(404);
  res.end('Not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Interface already running on port ${PORT}.`);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Test interface ready → http://localhost:${PORT}`);
});
