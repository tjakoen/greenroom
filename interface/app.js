'use strict';
// Greenroom. Single-page app with a sidebar and hash routing.
// Zero dependencies. Talks to the plain-Node server in server.js.

const $ = (id) => document.getElementById(id);
// Any write refused by demo mode comes back as { demo:true }; surface it once here
// so every caller gets the friendly read-only message without special-casing.
const api = (path, opts) =>
  fetch(path, opts).then((r) => r.json()).then((j) => {
    if (j && j.demo) toast('Demo mode — this is read-only. Clone the repo to run it for real.');
    return j;
  });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Playwright's own error text (from the JSON results, not the live process
// stream) carries raw terminal colour codes — strip them before they ever
// reach the DOM. Apply BEFORE esc() wherever this kind of text is rendered.
const stripAnsi = (s) => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '');

let selectedEnv = null; // Run page
let testsEnv = null; // Tests page
let running = false;
let pdfData = [];

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ---------------- tiny markdown renderer (guide + summaries) ---------------- */
function md(src) {
  const lines = String(src || '').split('\n');
  let html = '';
  let inList = null; // 'ul' | 'ol'
  let inCode = false;
  let para = [];
  let quote = []; // buffered consecutive "> " lines, flushed as one <blockquote>
  // Only allow schemes that can't execute script in the browser.
  const safeHref = (href) => (/^(https?:\/\/|\/|#|mailto:)/i.test(String(href).trim()) ? href : null);
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      // underscore italics: only when the `_` sits on a word boundary, so
      // SNAKE_CASE / TEST_ENV-style identifiers are left alone.
      .replace(/\b_([^_]+)_\b/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, text, href) => {
        const h = safeHref(href);
        return h ? `<a href="${h}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
      });
  const flushPara = () => { if (para.length) { html += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } };
  const flushQuote = () => { if (quote.length) { html += '<blockquote>' + inline(quote.join(' ')) + '</blockquote>'; quote = []; } };
  const closeList = () => { if (inList) { html += `</${inList}>`; inList = null; } };
  for (const raw of lines) {
    if (raw.trim().startsWith('```')) {
      flushPara(); flushQuote(); closeList();
      if (!inCode) { html += '<pre><code>'; inCode = true; } else { html += '</code></pre>'; inCode = false; }
      continue;
    }
    if (inCode) { html += esc(raw) + '\n'; continue; }
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); flushQuote(); closeList(); html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; }
    else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { flushPara(); flushQuote(); if (inList !== 'ul') { closeList(); html += '<ul>'; inList = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { flushPara(); flushQuote(); if (inList !== 'ol') { closeList(); html += '<ol>'; inList = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); closeList(); quote.push(m[1]); }
    else if (line.trim() === '') { flushPara(); flushQuote(); closeList(); }
    else { flushQuote(); para.push(line); }
  }
  flushPara(); flushQuote(); closeList();
  if (inCode) html += '</code></pre>';
  return html;
}

/* ---------------- router ---------------- */
const ROUTES = ['run', 'tests', 'history', 'share', 'guide', 'settings'];
function route() {
  let name = (location.hash || '#/run').replace('#/', '');
  if (!ROUTES.includes(name)) name = 'run';
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.route === name));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === name));
  onEnter[name] && onEnter[name]();
}
const onEnter = {
  tests: loadTests,
  history: refreshRuns,
  share: refreshShare,
  guide: loadGuide,
  settings: loadSettings,
};

/* ---------------- env pills ---------------- */
function renderEnvPills(container, envs, current, onPick) {
  container.innerHTML = '';
  for (const env of envs) {
    const b = document.createElement('button');
    b.innerHTML = `<span class="dot" data-env="${esc(env)}"></span>${esc(env)}`;
    b.className = env === current ? 'active' : '';
    b.onclick = () => onPick(env);
    container.appendChild(b);
  }
  paintEnvDots();
}
// Colour each env's readiness dot: green = has a complete login, amber = missing.
let credsCache = [];
function paintEnvDots() {
  document.querySelectorAll('.dot[data-env]').forEach((d) => {
    const env = d.getAttribute('data-env');
    const ready = credsCache.some((c) => c.env === env && c.usernameSet && c.passwordSet);
    d.classList.toggle('green', ready);
    d.classList.toggle('amber', !ready);
    d.style.animation = 'none';
  });
}

/* ---------------- RUN page ---------------- */
function setStatus(status, env) {
  running = status === 'running';
  const pill = $('statusPill');
  const dot = $('statusDot');
  pill.className = 'pill ' + (status === 'running' ? 'running' : status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'none');
  dot.className = 'dot ' + (status === 'running' ? 'amber' : status === 'passed' ? 'green' : status === 'failed' ? 'red' : '');
  $('statusText').textContent = { idle: 'Ready', running: 'Running ' + (env || '') + '…', passed: 'All passed', failed: 'Some failed', stopped: 'Stopped' }[status] || 'Ready';
  $('runBtn').disabled = running;
  const stopBtn = $('stopBtn');
  stopBtn.disabled = !running;
  if (!running) stopBtn.textContent = 'Stop'; // revert any "Stopping…" label once the run has actually ended
  const nd = $('navRunDot');
  nd.className = 'badge-dot';
  nd.style.background = status === 'running' ? 'var(--amber)' : status === 'failed' ? 'var(--red)' : status === 'passed' ? 'var(--green)' : 'transparent';
}

const cleanTitle = (t) => String(t).replace(/\s*@[\w-]+/g, '').trim();

// Run-page environment selection is MULTI-select: pick one env (today's flow) or
// several to run the same tests against all of them at once. Each selected env
// becomes a column in the results matrix.
let selectedEnvs = new Set();
const runEnvList = () => [...selectedEnvs];
let runRole = ''; // "Run as" override; '' = each test keeps its own role
let roleByTitle = {}; // test title -> baked-in login role (for the checklist "runs as")
let groupsCache = []; // saved site groups (named env presets)

// The live results model: title -> Map(env -> { status, time }). With one env this
// renders as the familiar flat checklist; with several, as a test × env matrix.
let matrix = new Map();
let matrixCols = []; // env column order for the current view
function cellRow(title) {
  let row = matrix.get(title);
  if (!row) { row = new Map(); matrix.set(title, row); }
  return row;
}
const statusMark = (status) =>
  status === 'passed' ? ['pass', '✓'] : status === 'failed' ? ['fail', '✕'] : status === 'running' ? ['run', '◐'] : ['wait', '○'];
// The login shown next to a checklist item: the "Run as" override if set, else the
// role baked into that test. Blank for tests that don't log in.
function roleLabel(title) {
  const r = runRole || roleByTitle[title];
  return r ? ` <span class="crole">as ${esc(r)}${runRole ? ' (override)' : ''}</span>` : '';
}

function renderChecklist() {
  if (!matrix.size) { $('resultsCard').style.display = 'none'; return; }
  $('resultsCard').style.display = 'block';
  const cols = matrixCols.length ? matrixCols : [''];
  // Tally every cell (test × env) for the overall tiles, and per-env for the health row.
  let pass = 0, fail = 0, pending = 0, total = 0;
  const per = new Map(cols.map((e) => [e, { pass: 0, fail: 0, pending: 0 }]));
  for (const [, row] of matrix) {
    for (const env of cols) {
      total++;
      const st = (row.get(env) || {}).status;
      if (st === 'passed') { pass++; per.get(env).pass++; }
      else if (st === 'failed') { fail++; per.get(env).fail++; }
      else { pending++; per.get(env).pending++; }
    }
  }
  const pct = (n) => (total ? (n / total) * 100 : 0);
  $('statTiles').innerHTML =
    `<div class="stat pass"><div class="num">${pass}</div><div class="lbl">Passed</div></div>` +
    `<div class="stat fail"><div class="num">${fail}</div><div class="lbl">Failed</div></div>` +
    `<div class="stat skip"><div class="num">${pending}</div><div class="lbl">Pending</div></div>` +
    `<div class="stat total"><div class="num">${total}</div><div class="lbl">Total</div></div>`;
  $('healthBar').innerHTML =
    `<div class="seg pass" style="width:${pct(pass)}%"></div><div class="seg fail" style="width:${pct(fail)}%"></div><div class="seg skip" style="width:${pct(pending)}%"></div>`;
  const done = pass + fail;
  // Per-env health line only when running against more than one environment.
  const perEnv = cols.length > 1
    ? '<div class="env-health">' + cols.map((e) => {
        const p = per.get(e); const d = p.pass + p.fail;
        return `<span class="eh"><span class="eh-name mono">${esc(e)}</span> <b>${d ? Math.round((p.pass / d) * 100) : 0}%</b> <span class="muted">${p.pass}/${p.pass + p.fail + p.pending}</span></span>`;
      }).join('') + '</div>'
    : '';
  $('healthCap').innerHTML = `<span><b>${done ? Math.round((pass / done) * 100) : 0}%</b> healthy</span><span>${pass}/${total} passing${fail ? ` · ${fail} failing` : ''}</span>`;
  const eh = document.getElementById('envHealth');
  if (eh) eh.innerHTML = perEnv;
  const ul = $('checklist');
  ul.innerHTML = '';
  if (cols.length > 1) {
    ul.classList.add('matrix');
    for (const [title, row] of matrix) {
      const li = document.createElement('li');
      const cells = cols.map((env) => {
        const s = row.get(env) || {}; const m = statusMark(s.status);
        return `<span class="mcell"><span class="cmark ${m[0]}" title="${esc(env)}${s.time ? ' · ' + s.time : ''}">${m[1]}</span><i class="mono">${esc(env)}</i></span>`;
      }).join('');
      const failed = cols.some((env) => (row.get(env) || {}).status === 'failed');
      li.className = 'mrow';
      li.innerHTML = `<span class="mtitle">${esc(cleanTitle(title))}${roleLabel(title)}</span><span class="mcells">${cells}</span>` +
        (failed ? `<button class="btn sm" data-report="${esc(title)}">Report this</button>` : '');
      if (failed) li.querySelector('[data-report]').onclick = () => goToShare('latest', undefined, title);
      ul.appendChild(li);
    }
  } else {
    ul.classList.remove('matrix');
    const env = cols[0];
    for (const [title, row] of matrix) {
      const s = row.get(env) || {}; const m = statusMark(s.status);
      const li = document.createElement('li');
      li.innerHTML = `<span class="cmark ${m[0]}">${m[1]}</span><span>${esc(cleanTitle(title))}${roleLabel(title)}</span><span class="ctime">${s.time || ''}</span>` +
        (s.status === 'failed' ? `<button class="btn sm" data-report="${esc(title)}">Report this</button>` : '');
      if (s.status === 'failed') li.querySelector('[data-report]').onclick = () => goToShare('latest', undefined, title);
      ul.appendChild(li);
    }
  }
}
// seed: array of titles to pre-list as "waiting"; null → every test for the env.
async function seedChecklist(seed) {
  matrix = new Map();
  matrixCols = runEnvList();
  const cols = matrixCols.length ? matrixCols : [''];
  // Always pull the test list so the checklist can show each test's login role.
  const payload = await api('/api/tests?env=' + encodeURIComponent(cols[0])).catch(() => ({ tests: [] }));
  roleByTitle = {};
  for (const t of payload.tests || []) roleByTitle[t.title] = t.role || '';
  const titles = seed || (payload.tests || []).map((t) => t.title);
  for (const t of titles) for (const env of cols) cellRow(t).set(env, { status: 'waiting' });
  renderChecklist();
}
// Like seedChecklist, but never clears an existing cell — used to restore the
// correct total (and roles) for a run already in progress (reconnect/refresh)
// without discarding any pass/fail already parsed from the replayed buffer.
async function fillChecklistTotals(env) {
  const cols = matrixCols.length ? matrixCols : [''];
  const payload = await api('/api/tests?env=' + encodeURIComponent(env || '')).catch(() => ({ tests: [] }));
  for (const t of payload.tests || []) roleByTitle[t.title] = t.role || '';
  for (const t of payload.tests || []) {
    for (const c of cols) {
      const row = cellRow(t.title);
      if (!row.has(c)) row.set(c, { status: 'waiting' });
    }
  }
  renderChecklist();
}
// Parse a Playwright "list" reporter line into a matrix cell update. In a multi-env
// run each line is prefixed with "[chromium (<env>)]" — we key the cell by that env.
function parseLine(line) {
  const pass = /[✓✔]/.test(line);
  const fail = /[✘✗×]/.test(line);
  if (!pass && !fail) return;
  const timeM = line.match(/\((\d+(?:\.\d+)?m?s)\)\s*$/);
  const time = timeM ? timeM[1] : '';
  let body = line.replace(/\((\d+(?:\.\d+)?m?s)\)\s*$/, '').trim();
  const em = body.match(/\[chromium \(([^)]+)\)\]/);
  const env = em ? em[1] : matrixCols[0] || '';
  if (body.includes('›')) body = body.split('›').pop().trim();
  else body = body.replace(/^[^A-Za-z0-9]*\d*\s*/, '').trim();
  if (!body) return;
  if (!matrixCols.includes(env)) matrixCols.push(env);
  cellRow(body).set(env, { status: fail ? 'failed' : 'passed', time });
  renderChecklist();
}

// Fill the "Run as" dropdown: a default ("each test's own role") plus every role
// that has a login on ALL currently-selected environments (so an override can
// actually authenticate everywhere the run targets).
let rolesCache = [];
async function populateRunRoles() {
  const sel = $('runRole');
  if (!sel) return;
  if (!rolesCache.length) rolesCache = await api('/api/roles').catch(() => []);
  const envs = runEnvList();
  const usableEverywhere = rolesCache.filter((r) =>
    envs.every((env) => (r.sites || []).some((s) => s.env === env && s.usernameSet && s.passwordSet))
  );
  const prev = runRole;
  sel.innerHTML =
    `<option value="">Each test's own role</option>` +
    usableEverywhere.map((r) => `<option value="${esc(r.name)}">${esc(r.label || r.name)}</option>`).join('');
  // keep the prior choice if still valid, else fall back to default
  if (prev && usableEverywhere.some((r) => r.name === prev)) sel.value = prev;
  else runRole = '';
  sel.value = runRole;
}

async function startRun({ files, grep, seed } = {}) {
  const envs = runEnvList();
  if (!envs.length) return toast('Pick at least one environment to run against.');
  // Cheap insurance: confirm before hitting a production-looking environment.
  const prod = envs.filter((e) => /prod|production|live/i.test(e));
  if (prod.length && !confirm(`Run against ${prod.join(', ')}? That looks like a production environment.`)) return;
  $('output').textContent = '';
  await seedChecklist(seed || null);
  const res = await api('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envs, light: $('light').checked, files: files || undefined, grep: grep || undefined, role: runRole || undefined }),
  });
  if (!res.ok) toast(res.error);
}
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Run-page test scope: the tests behind the "Tests" dropdown, so a Run can be
// limited to a group or tag instead of everything.
let runScopeTests = [];
async function populateRunScope() {
  const sel = $('runScope');
  if (!sel) return;
  const payload = await api('/api/tests').catch(() => ({ tests: [], tags: [], groups: [] }));
  runScopeTests = payload.tests || [];
  const prev = sel.value;
  const opts = ['<option value="">All tests</option>'];
  if ((payload.groups || []).length) {
    opts.push('<optgroup label="Groups">');
    for (const g of payload.groups) opts.push(`<option value="g:${esc(g)}">${esc(g)}</option>`);
    opts.push('</optgroup>');
  }
  if ((payload.tags || []).length) {
    opts.push('<optgroup label="Tags">');
    for (const t of payload.tags) opts.push(`<option value="t:${esc(t)}">${esc(t)}</option>`);
    opts.push('</optgroup>');
  }
  sel.innerHTML = opts.join('');
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev; // keep selection across refreshes
}
// Turn the current "Tests" dropdown choice into startRun scope (files/grep/seed).
// Groups are sidecar metadata (not in the title, so not greppable) → resolve to
// the specs + a grep of their titles, like "Run selected". Tags live in the
// title → a plain --grep does it.
function resolveRunScope() {
  const v = $('runScope') ? $('runScope').value : '';
  if (v.startsWith('t:')) {
    const tag = v.slice(2);
    const seed = runScopeTests.filter((t) => (t.tags || []).includes(tag)).map((t) => t.title);
    return { grep: escRe(tag), seed: seed.length ? seed : null };
  }
  if (v.startsWith('g:')) {
    const g = v.slice(2);
    const chosen = runScopeTests.filter((t) => (t.group || '') === g);
    if (!chosen.length) return {};
    return { files: [...new Set(chosen.map((t) => t.file))], grep: chosen.map((t) => escRe(t.title)).join('|'), seed: chosen.map((t) => t.title) };
  }
  return {}; // All tests
}

function appendLine(line) {
  const clean = stripAnsi(line);
  const out = $('output');
  const stick = out.scrollTop + out.clientHeight >= out.scrollHeight - 30;
  out.textContent += clean + '\n';
  if (stick) out.scrollTop = out.scrollHeight;
  parseLine(clean);
}

// Env names seeded from config/urls.example.json for the zero-config @example
// specs — not the user's own site. Used only to nudge onboarding; see
// context/frontend-structure.md and CLAUDE.md for the source of truth.
const EXAMPLE_ENVS = new Set(['demo', 'demo2']);
async function refreshOnboarding() {
  const o = await api('/api/onboarding').catch(() => null);
  if (!o) return;
  const envs = envsCache.length ? envsCache : (await api('/api/state').catch(() => ({ envs: [] }))).envs || [];
  const hasOwnSite = envs.some((e) => !EXAMPLE_ENVS.has(e));
  const steps = [
    { done: hasOwnSite, txt: 'Add your site (Settings → Environments)', route: 'settings' },
    { done: o.anyCreds, txt: 'Add a login (Settings → Roles & logins)', route: 'settings' },
    { done: o.hasRuns, txt: 'Run the tests for the first time', route: 'run' },
    { done: o.reportExists, txt: 'Open a report to see results', route: 'run' },
    // Not derived from hasRuns — that only proves a run happened, not that
    // anything was shared. Set once the user actually downloads a bundle or
    // copies a summary from the Report-a-bug page (see markShared()).
    { done: localStorage.getItem('gr_shared') === '1', txt: 'Share a result with the dev team', route: 'share' },
  ];
  const allDone = steps.every((s) => s.done);
  $('onboardCard').style.display = allDone ? 'none' : 'block';
  $('onboardList').innerHTML = steps
    .map((s) => `<li class="${s.done ? 'done' : ''}"><span class="box">${s.done ? '✓' : ''}</span><span class="txt">${s.done ? esc(s.txt) : `<a href="#/${esc(s.route)}">${esc(s.txt)}</a>`}</span></li>`)
    .join('');
}
// Real signal for the "share a result" onboarding step: only set once the
// user has actually acted on the Report-a-bug page, not merely run a test.
function markShared() {
  localStorage.setItem('gr_shared', '1');
  refreshOnboarding();
}

/* ---------------- TESTS page ---------------- */
let testsPayload = { tests: [], tags: [], groups: [] };
let activeTags = new Set();
let activeSmart = 'all';
let testSearchQ = '';
let selectedKeys = new Set(); // `${file}::${title}`
const collapsedGroups = new Set();
const SMART = [
  { key: 'all', label: 'All' },
  { key: 'failing', label: 'Failing' },
  { key: 'never', label: 'Never run' },
  { key: 'flaky', label: 'Flaky' },
  { key: 'slowest', label: 'Slowest' },
];
const tkey = (t) => `${t.file}::${t.title}`;

async function loadTests() {
  const envs = envsCache.length ? envsCache : (await api('/api/state')).envs;
  if (!testsEnv || !envs.includes(testsEnv)) testsEnv = selectedEnv || envs[0];
  renderEnvPills($('testsEnvPills'), envs, testsEnv, (e) => { testsEnv = e; selectedKeys.clear(); loadTests(); });
  await populateRecordRoles();
  testsPayload = await api('/api/tests?env=' + encodeURIComponent(testsEnv)).catch(() => ({ tests: [], tags: [], groups: [] }));
  renderSmartFilters();
  renderTagFilters();
  renderTestGroups();
}

function renderSmartFilters() {
  $('smartFilters').innerHTML = SMART.map(
    (s) => `<button class="chip ${activeSmart === s.key ? 'on' : ''}" data-smart="${s.key}">${s.label}</button>`
  ).join('');
  $('smartFilters').querySelectorAll('[data-smart]').forEach((b) => (b.onclick = () => { activeSmart = b.dataset.smart; renderSmartFilters(); renderTestGroups(); }));
}
function renderTagFilters() {
  const bar = $('tagFilters');
  if (!testsPayload.tags.length) { bar.innerHTML = '<span class="small muted">No @tags yet — add e.g. <code>@smoke</code> to a test title to filter and run by tag.</span>'; updateRunTag(); return; }
  bar.innerHTML = testsPayload.tags.map((t) => `<button class="chip tag ${activeTags.has(t) ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('');
  bar.querySelectorAll('[data-tag]').forEach((b) => (b.onclick = () => {
    const t = b.dataset.tag;
    activeTags.has(t) ? activeTags.delete(t) : activeTags.add(t);
    renderTagFilters(); renderTestGroups();
  }));
  updateRunTag();
}
function updateRunTag() {
  const btn = $('runTagBtn');
  btn.disabled = activeTags.size === 0;
  btn.textContent = activeTags.size ? `Run ${[...activeTags].join(', ')}` : 'Run by tag';
}

function filteredTests() {
  let t = testsPayload.tests;
  const q = testSearchQ.toLowerCase();
  if (q) t = t.filter((x) => (x.cleanTitle + ' ' + x.file + ' ' + x.tags.join(' ') + ' ' + x.owner + ' ' + x.group).toLowerCase().includes(q));
  if (activeTags.size) t = t.filter((x) => x.tags.some((tag) => activeTags.has(tag)));
  if (activeSmart === 'failing') t = t.filter((x) => x.status === 'failed');
  else if (activeSmart === 'never') t = t.filter((x) => x.neverRun);
  else if (activeSmart === 'flaky') t = t.filter((x) => x.flaky);
  else if (activeSmart === 'slowest') t = [...t].filter((x) => x.durationMs > 0).sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
  return t;
}
function groupName(t) {
  if (t.group) return t.group;
  // No explicit group set → fall back to the spec file the test lives in.
  return t.file.replace(/^tests\//, '');
}
function renderTestGroups() {
  const tests = filteredTests();
  $('testsEmpty').style.display = tests.length ? 'none' : 'block';
  const groups = {};
  for (const t of tests) (groups[groupName(t)] = groups[groupName(t)] || []).push(t);
  const wrap = $('testGroups');
  wrap.innerHTML = '';
  for (const gname of Object.keys(groups).sort()) {
    const items = groups[gname];
    const pass = items.filter((t) => t.status === 'passed').length;
    const fail = items.filter((t) => t.status === 'failed').length;
    const collapsed = collapsedGroups.has(gname);
    const head = document.createElement('div');
    head.className = 'group-head' + (collapsed ? ' collapsed' : '');
    head.innerHTML = `<span class="caret">▾</span><span class="gname">${esc(gname)}</span><span class="gcount">${items.length}</span>` +
      `<span class="gstat">${pass ? `<span class="pill passed">${pass}✓</span>` : ''}${fail ? `<span class="pill failed">${fail}✕</span>` : ''}</span>`;
    head.onclick = () => { collapsed ? collapsedGroups.delete(gname) : collapsedGroups.add(gname); renderTestGroups(); };
    wrap.appendChild(head);
    if (collapsed) continue;
    const ul = document.createElement('ul');
    ul.className = 'rows';
    for (const t of items) ul.appendChild(testRow(t));
    wrap.appendChild(ul);
  }
  updateRunSelected();
}
function testRow(t) {
  const k = tkey(t);
  const li = document.createElement('li');
  const statusPill = t.status ? `<span class="pill ${esc(t.status)}">${esc(t.status)}</span>` : '<span class="pill none">not run</span>';
  const tags = t.tags.map((tag) => `<span class="chip tag">${esc(tag)}</span>`).join('');
  const flaky = t.flaky ? '<span class="chip" style="color:var(--amber)">flaky</span>' : '';
  const prio = t.priority ? `<span class="prio ${esc(t.priority)}">${esc(t.priority)}</span>` : '';
  const sub = [esc(t.scope), t.role ? 'runs as: ' + esc(t.role) : '', t.owner ? '👤 ' + esc(t.owner) : '', t.runCount ? `${t.runCount} run${t.runCount === 1 ? '' : 's'}` : '', t.durationMs ? fmtTime(t.durationMs / 1000) : ''].filter(Boolean).join(' · ');
  li.innerHTML =
    `<input type="checkbox" class="tsel" data-key="${esc(k)}" ${selectedKeys.has(k) ? 'checked' : ''}>` +
    `<div class="grow"><div class="name">${esc(t.cleanTitle)}</div>` +
    (tags || flaky ? `<div class="test-tags">${tags}${flaky}</div>` : '') +
    `<div class="sub">${sub}</div></div>` +
    prio + statusPill +
    `<div class="hover-actions">` +
    `<button class="btn sm" data-run="${esc(k)}">Run</button>` +
    `<button class="btn icon" data-inputs="${esc(t.file)}" title="Make inputs dynamic">⌗</button>` +
    `<button class="btn icon" data-edit="${esc(k)}" title="Tag / priority / owner">🏷</button>` +
    `<button class="btn icon" data-rename="${esc(t.file)}" title="Rename file">✎</button>` +
    `<button class="btn danger" data-del="${esc(t.file)}" title="Delete file">🗑</button>` +
    `</div>`;
  li.querySelector('.tsel').onchange = (e) => { e.target.checked ? selectedKeys.add(k) : selectedKeys.delete(k); updateRunSelected(); };
  li.querySelector('[data-run]').onclick = () => runOne(t);
  li.querySelector('[data-inputs]').onclick = () => toggleInputsEdit(li, t);
  li.querySelector('[data-edit]').onclick = () => toggleMetaEdit(li, t);
  li.querySelector('[data-rename]').onclick = () => renameTest(t.file);
  li.querySelector('[data-del]').onclick = () => deleteTest(t.file);
  return li;
}
// "Make inputs dynamic": list the recorded .fill() values with a per-field
// generator picker, then rewrite the spec so each run submits fresh data.
const INPUT_GENS = [
  { key: 'keep', label: 'Keep as recorded' },
  { key: 'email', label: 'Unique email' },
  { key: 'name', label: 'Random name' },
  { key: 'text', label: 'Random text' },
  { key: 'id', label: 'Unique id' },
  { key: 'phone', label: 'Random phone' },
  { key: 'password', label: 'Random password' },
];
async function toggleInputsEdit(li, t) {
  const existing = li.nextElementSibling;
  if (existing && existing.classList.contains('metaedit')) { existing.remove(); return; }
  const data = await api('/api/recorded-inputs?file=' + encodeURIComponent(t.file)).catch(() => null);
  const ed = document.createElement('div');
  ed.className = 'metaedit';
  if (!data || !data.ok || !data.inputs.length) {
    ed.innerHTML = `<div class="full"><p class="small muted">No filled inputs found in this test — nothing to make dynamic.</p><div class="row" style="justify-content:flex-end"><button class="btn sm" id="i-cancel">Close</button></div></div>`;
    li.after(ed);
    ed.querySelector('#i-cancel').onclick = () => ed.remove();
    return;
  }
  const guess = (v) => (/@/.test(v) ? 'email' : /^\+?[\d ()-]{7,}$/.test(v) ? 'phone' : 'keep');
  const rows = data.inputs.map((inp, i) =>
    `<div class="input-map">` +
    `<div class="im-label"><span class="mono">${esc(inp.label)}</span><span class="small muted">${esc(inp.value).slice(0, 40) || '(empty)'}</span></div>` +
    `<select class="select" data-imline="${inp.line}">` +
    INPUT_GENS.map((g) => `<option value="${g.key}" ${guess(inp.value) === g.key ? 'selected' : ''}>${g.label}</option>`).join('') +
    `</select></div>`
  ).join('');
  ed.innerHTML =
    `<div class="full"><p class="small muted" style="margin:0 0 8px">Pick a generator for any field that must change each run (e.g. a signup email). "Keep as recorded" leaves it alone.</p>${rows}` +
    `<div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn sm" id="i-cancel">Cancel</button><button class="btn primary sm" id="i-apply">Apply</button></div></div>`;
  li.after(ed);
  ed.querySelector('#i-cancel').onclick = () => ed.remove();
  ed.querySelector('#i-apply').onclick = async () => {
    const mappings = [...ed.querySelectorAll('[data-imline]')]
      .map((s) => ({ line: Number(s.dataset.imline), generator: s.value }))
      .filter((m) => m.generator !== 'keep');
    if (!mappings.length) { toast('Nothing to change — pick a generator first.'); return; }
    const r = await api('/api/apply-inputs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: t.file, mappings }) });
    if (!r.ok) return toast(r.error);
    toast(`Updated ${r.changed} input${r.changed === 1 ? '' : 's'} to generate fresh data each run.`);
    ed.remove();
  };
}
function toggleMetaEdit(li, t) {
  const existing = li.nextElementSibling;
  if (existing && existing.classList.contains('metaedit')) { existing.remove(); return; }
  const ed = document.createElement('div');
  ed.className = 'metaedit';
  ed.innerHTML =
    `<div><label class="field">Group</label><input class="text" id="m-group" value="${esc(t.group)}" placeholder="e.g. Auth"></div>` +
    `<div><label class="field">Priority</label><select class="select" id="m-prio"><option value="">—</option>${['P1', 'P2', 'P3'].map((p) => `<option ${t.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>` +
    `<div><label class="field">Owner</label><input class="text" id="m-owner" value="${esc(t.owner)}" placeholder="name"></div>` +
    `<div class="full"><label class="field">Tags</label><input class="text" id="m-tags" value="${esc((t.tags || []).join(' '))}" placeholder="@smoke @login"><span class="small muted">Space-separated. Live in the test title; used by Run by tag.</span></div>` +
    `<div class="full"><label class="field">Notes</label><input class="text" id="m-notes" value="${esc(t.notes)}" placeholder="e.g. flaky on demo, needs data reset"></div>` +
    `<div class="full row" style="justify-content:flex-end"><button class="btn sm" id="m-cancel">Cancel</button><button class="btn primary sm" id="m-save">Save</button></div>`;
  li.after(ed);
  ed.querySelector('#m-cancel').onclick = () => ed.remove();
  ed.querySelector('#m-save').onclick = async () => {
    // Tags first — this can rewrite the test title in the file, so meta must be
    // keyed to the NEW title it returns.
    const tags = ed.querySelector('#m-tags').value.split(/[\s,]+/).filter(Boolean);
    const tr = await api('/api/test-tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: t.file, title: t.title, tags }) });
    if (!tr.ok) return toast(tr.error);
    const title = tr.title || t.title;
    const body = { file: t.file, title, group: ed.querySelector('#m-group').value, priority: ed.querySelector('#m-prio').value, owner: ed.querySelector('#m-owner').value, notes: ed.querySelector('#m-notes').value };
    const r = await api('/api/test-meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return toast(r.error);
    toast('Saved'); await loadTests();
  };
}
function updateRunSelected() {
  const n = selectedKeys.size;
  const runBtn = $('runSelectedBtn');
  runBtn.disabled = n === 0;
  runBtn.textContent = n ? `Run selected (${n})` : 'Run selected';
  const delBtn = $('deleteSelectedBtn');
  if (delBtn) {
    // Delete acts on whole files; count the distinct files behind the selection.
    const files = new Set(testsPayload.tests.filter((t) => selectedKeys.has(tkey(t))).map((t) => t.file));
    delBtn.disabled = files.size === 0;
    delBtn.textContent = files.size ? `Delete selected (${files.size})` : 'Delete selected';
  }
  const selAll = $('selectAllBtn');
  if (selAll) {
    const shown = filteredTests();
    const allOn = shown.length > 0 && shown.every((t) => selectedKeys.has(tkey(t)));
    selAll.textContent = allOn ? 'Clear all' : 'Select all';
  }
}
// Toggle every currently-shown (filtered) test in/out of the selection.
function toggleSelectAll() {
  const shown = filteredTests();
  const allOn = shown.length > 0 && shown.every((t) => selectedKeys.has(tkey(t)));
  for (const t of shown) allOn ? selectedKeys.delete(tkey(t)) : selectedKeys.add(tkey(t));
  renderTestGroups();
  updateRunSelected();
}
// Delete every file behind the current selection (deduped), one confirm for the batch.
async function deleteSelected() {
  const files = [...new Set(testsPayload.tests.filter((t) => selectedKeys.has(tkey(t))).map((t) => t.file))];
  if (!files.length) return;
  if (!confirm(`Delete ${files.length} test file${files.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
  let ok = 0;
  for (const file of files) {
    const r = await api('/api/tests?file=' + encodeURIComponent(file), { method: 'DELETE' });
    if (r.ok) ok++;
    else if (r.demo) return; // demo mode already toasted; stop
  }
  selectedKeys.clear();
  toast(`Deleted ${ok} file${ok === 1 ? '' : 's'}.`);
  loadTests();
}
async function gotoRunWithEnv() {
  // Running from the Tests page targets that page's single selected env.
  selectedEnv = testsEnv;
  selectedEnvs = new Set([testsEnv].filter(Boolean));
  renderRunEnvPills();
  location.hash = '#/run';
}
async function runOne(t) {
  await gotoRunWithEnv();
  await startRun({ files: [t.file], grep: escRe(t.title), seed: [t.title] });
}
async function runSelected() {
  const chosen = testsPayload.tests.filter((t) => selectedKeys.has(tkey(t)));
  if (!chosen.length) return;
  const files = [...new Set(chosen.map((t) => t.file))];
  const grep = chosen.map((t) => escRe(t.title)).join('|');
  await gotoRunWithEnv();
  await startRun({ files, grep, seed: chosen.map((t) => t.title) });
}
async function runByTag() {
  if (!activeTags.size) return;
  const grep = [...activeTags].map(escRe).join('|');
  const seed = testsPayload.tests.filter((t) => t.tags.some((tag) => activeTags.has(tag))).map((t) => t.title);
  await gotoRunWithEnv();
  await startRun({ grep, seed });
}
async function renameTest(file) {
  const name = prompt('New file name (letters, numbers, dashes):');
  if (!name) return;
  const r = await api('/api/tests/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, name }) });
  if (!r.ok) return toast(r.error);
  toast('Renamed'); loadTests();
}
async function deleteTest(file) {
  if (!confirm('Delete this test file? This cannot be undone.')) return;
  const r = await api('/api/tests?file=' + encodeURIComponent(file), { method: 'DELETE' });
  if (!r.ok) return toast(r.error);
  toast('Deleted'); loadTests();
}

/* ---------------- HISTORY page ---------------- */
let allRuns = [];
async function refreshRuns() {
  allRuns = await api('/api/runs').catch(() => []);
  renderRuns();
}
function renderRuns() {
  const q = ($('historySearch').value || '').toLowerCase();
  const runs = allRuns.filter((r) => !q || r.env.toLowerCase().includes(q) || r.result.toLowerCase().includes(q));
  const list = $('runsList');
  list.innerHTML = '';
  $('runsEmpty').style.display = allRuns.length ? 'none' : 'block';
  for (const run of runs) {
    const li = document.createElement('li');
    const failed = run.result === 'failed';
    li.innerHTML =
      `<div class="grow"><div class="name">${esc(run.env)}</div><div class="sub">${esc(run.when)}</div></div>` +
      `<span class="pill ${esc(run.result)}">${esc(run.result)}</span>` +
      `<div class="hover-actions">${failed ? `<button class="btn sm" data-reportrun="${esc(run.id)}">Report this</button>` : ''}<a class="btn sm" href="/runs/${encodeURIComponent(run.id)}/" target="_blank">Open report ↗</a></div>`;
    if (failed) li.querySelector('[data-reportrun]').onclick = () => reportRunFailure(run.id);
    list.appendChild(li);
  }
}
// A failed run has no per-test breakdown in the list itself — look up the
// first failed test in that run so the Share page lands on something useful.
async function reportRunFailure(runId) {
  const data = await api('/api/pdf-data?run=' + encodeURIComponent(runId)).catch(() => []);
  const failedTest = data.find((t) => t.status === 'failed');
  goToShare(encodeURIComponent(runId), failedTest ? failedTest.test : undefined, failedTest ? failedTest.title : undefined);
}

/* ---------------- SHARE / BUG page ---------------- */
const fmtTime = (s) => (Number(s) || 0).toFixed(1) + 's';
let ffmpegAvailable = null; // null = not checked yet
// Set by "Report this" links (Run-page checklist / History) just before
// navigating to #/share, so the Run + Test pickers default to the failure
// the user came from instead of "Latest run". Consumed once applied.
let pendingShare = null; // { run: <option value>, test?: <option value>, testTitle?: <raw title> }
function goToShare(run, test, testTitle) {
  pendingShare = { run: run || 'latest', test, testTitle };
  location.hash = '#/share';
}

async function refreshShare() {
  if (ffmpegAvailable === null) {
    ffmpegAvailable = await api('/api/ffmpeg-available').then((d) => !!d.available).catch(() => false);
  }
  const runs = await api('/api/runs').catch(() => []);
  $('shareRun').innerHTML = ['<option value="latest">Latest run</option>']
    .concat(runs.map((r) => `<option value="${encodeURIComponent(r.id)}">${esc(r.when)} · ${esc(r.env)} · ${esc(r.result)}</option>`))
    .join('');
  if (pendingShare && pendingShare.run && [...$('shareRun').options].some((o) => o.value === pendingShare.run)) {
    $('shareRun').value = pendingShare.run;
  }
  await loadShareTests();
}
async function loadShareTests() {
  const run = $('shareRun').value || 'latest';
  pdfData = await api('/api/pdf-data?run=' + run).catch(() => []);
  const sel = $('shareTest');
  sel.innerHTML = '';
  const has = pdfData.length > 0;
  $('shareEmpty').style.display = has ? 'none' : 'block';
  $('shareBody').style.display = has ? 'block' : 'none';
  $('pdfCard').style.display = has ? 'block' : 'none';
  for (const t of pdfData) {
    const o = document.createElement('option');
    o.value = t.test; o.textContent = `${t.title}  [${t.status}]`;
    sel.appendChild(o);
  }
  if (pendingShare) {
    const wantTest = pendingShare.test || (pendingShare.testTitle && pdfData.find((t) => t.title === pendingShare.testTitle)?.test);
    if (wantTest && pdfData.some((t) => t.test === wantTest)) sel.value = wantTest;
    pendingShare = null;
  }
  if (has) await onTestSelected();
}
// Everything that depends on the chosen test, in the order each needs the last:
// full logs first (both the summary's collapsible sections and the scrubber
// below read from the same fetch), then the summary text, then the scrubber.
async function onTestSelected() {
  const run = $('shareRun').value || 'latest';
  const test = $('shareTest').value;
  await loadFullLogs(run, test);
  if ($('shareTest').value !== test) return; // user switched again mid-fetch
  await loadSummary(run, test);
  loadPdfSnaps(run, test);
}
async function loadSummary(run, test) {
  const raw = await fetch('/api/bug-summary?run=' + run + '&test=' + encodeURIComponent(test)).then((r) => r.text());
  const txt = stripAnsi(raw); // the JSON results' error text can carry raw terminal colour codes
  $('shareSummary').innerHTML = md(txt);
  $('shareSummary').dataset.raw = txt;
}

// The full console/network/requests for the selected test (unfiltered) — feeds
// the always-visible collapsible sections in the Summary card. The scrubber
// below re-filters this same data to the interval around each screenshot.
let momentData = { consoleTimed: [], networkTimed: [], requests: [], console: [], network: [], durationMs: 0 };
let curSnaps = []; // snapshots for the selected test
let curSnapIdx = 0;

function setMomentData(d) {
  momentData = {
    consoleTimed: (d && d.consoleTimed) || [],
    networkTimed: (d && d.networkTimed) || [],
    requests: (d && d.requests) || [],
    console: (d && d.console) || [],
    network: (d && d.network) || [],
    durationMs: (d && d.durationMs) || 0,
  };
}
async function loadFullLogs(run, test) {
  setMomentData(null);
  const d = await api('/api/moment?run=' + run + '&test=' + encodeURIComponent(test)).catch(() => null);
  if ($('shareTest').value !== test) return;
  setMomentData(d);
  renderTopLogs();
}
const classifyConsole = (line) => (/^\[(error|pageerror)\]/i.test(line) ? 'err' : /^\[warning\]/i.test(line) ? 'warn' : '');
const shortUrl = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
// One rendered row. Console/issue entries have `.line`; request entries have
// `.method`/`.status`/`.url`.
function logRow(e, cls) {
  const time = typeof e.t === 'number' ? fmtTime(e.t / 1000) : '';
  if (e.url !== undefined) {
    const bad = e.status === 0 || e.status >= 400;
    const status = e.status === 0 ? 'ERR' : e.status;
    const body = `<b>${esc(status)}</b> ${esc(e.method)} <span title="${esc(e.url)}">${esc(shortUrl(e.url))}</span>`;
    return `<div class="log-line ${bad ? 'err' : ''}"><span class="lt">${time}</span><span>${body}</span></div>`;
  }
  return `<div class="log-line ${cls || ''}"><span class="lt">${time}</span><span>${esc(stripAnsi(e.line))}</span></div>`;
}
// The always-visible, collapsible Console / Network-issues sections in the
// Summary card — the whole test's logs, timestamped, never filtered.
function renderTopLogs() {
  const timedConsole = momentData.consoleTimed.length > 0;
  const timedNetwork = momentData.networkTimed.length > 0;
  const c = timedConsole ? momentData.consoleTimed : momentData.console.map((line) => ({ line }));
  const n = timedNetwork ? momentData.networkTimed : momentData.network.map((line) => ({ line }));
  $('topConsoleCount').textContent = c.length;
  $('topNetworkCount').textContent = n.length;
  // Runs recorded before per-line timing existed have entries but no `.t` — the
  // rows below will render with no timestamp, so say so instead of looking broken.
  const noTimingNote = '<div class="none">Timing not recorded for this run — re-run the test to add timestamps.</div>';
  $('topConsoleLogs').innerHTML = c.length
    ? (timedConsole ? '' : noTimingNote) + c.map((e) => logRow(e, classifyConsole(e.line))).join('')
    : '<div class="none">Nothing logged.</div>';
  $('topNetworkLogs').innerHTML = n.length
    ? (timedNetwork ? '' : noTimingNote) + n.map((e) => logRow(e)).join('')
    : '<div class="none">No failed or error responses.</div>';
}

async function loadPdfSnaps(run, test) {
  run = run || $('shareRun').value || 'latest';
  test = test || $('shareTest').value;
  const t = pdfData.find((x) => x.test === test);
  if (!t) return;
  curSnaps = t.snapshots || [];
  curSnapIdx = 0;
  const range = $('snapRange');
  range.max = Math.max(0, curSnaps.length - 1);
  range.value = 0;
  range.disabled = curSnaps.length <= 1;
  // The full recording is a secondary reference, tucked in a <details>.
  const v = $('pdfVideo');
  if (t.hasVideo) {
    v.src = '/api/video?run=' + run + '&test=' + encodeURIComponent(t.test);
    primeVideo(v);
    $('pdfVideoDetails').style.display = '';
    $('downloadClipBtn').style.display = ffmpegAvailable ? '' : 'none';
    $('downloadFailClipBtn').style.display = ffmpegAvailable && t.status === 'failed' ? '' : 'none';
    $('clipNote').style.display = ffmpegAvailable ? 'none' : '';
  } else {
    v.removeAttribute('src');
    $('pdfVideoDetails').style.display = 'none';
  }
  showSnap(0);
}

// Show one captured screenshot + the logs from the previous screenshot up to
// this one — i.e. "what happened since the last scrub position".
function showSnap(i) {
  if (!curSnaps.length) {
    $('pdfPreview').innerHTML = '';
    $('snapLabel').textContent = 'No screenshots';
    $('pdfBtn').disabled = true;
    renderMomentLogs(null, null);
    return;
  }
  curSnapIdx = Math.min(Math.max(0, i), curSnaps.length - 1);
  $('snapRange').value = curSnapIdx;
  const s = curSnaps[curSnapIdx];
  const run = $('shareRun').value || 'latest';
  const test = $('shareTest').value;
  $('pdfPreview').innerHTML = `<img src="/api/pdf-image?run=${run}&test=${encodeURIComponent(test)}&i=${s.index}">`;
  $('snapLabel').textContent = `${curSnapIdx + 1} / ${curSnaps.length}` + (s.title ? ' · ' + s.title : s.url ? ' · ' + s.url : '') + (s.final ? ' (final)' : '');
  $('pdfBtn').disabled = false;
  if (typeof s.t === 'number') {
    const prev = curSnapIdx > 0 ? curSnaps[curSnapIdx - 1] : null;
    renderMomentLogs(prev && typeof prev.t === 'number' ? prev.t : 0, s.t);
  } else {
    renderMomentLogs(null, null);
  }
}

// [fromMs, toMs] for the currently displayed screenshot, in seconds — used both
// to render the on-screen logs and to scope the exported PDF / video clip to
// the exact same interval.
function currentInterval() {
  const s = curSnaps[curSnapIdx];
  if (!s || typeof s.t !== 'number') return null;
  const prev = curSnapIdx > 0 ? curSnaps[curSnapIdx - 1] : null;
  const fromMs = prev && typeof prev.t === 'number' ? prev.t : 0;
  return { fromMs, toMs: s.t, fromSec: fromMs / 1000, toSec: s.t / 1000 };
}

// Playwright's webm reports duration = Infinity until the browser is forced to
// seek past the end. Resolve the real duration so the reference player is seekable.
function primeVideo(v) {
  const onMeta = () => {
    if (isFinite(v.duration) && v.duration > 0) return;
    const onSeek = () => { v.removeEventListener('seeked', onSeek); v.currentTime = 0; };
    v.addEventListener('seeked', onSeek);
    try { v.currentTime = 1e6; } catch { /* browser clamps + resolves duration */ }
  };
  v.addEventListener('loadedmetadata', onMeta, { once: true });
  v.load();
}

// Console + network for [fromMs, toMs] — the interval since the previous
// screenshot — rendered as two chronological columns sharing one scrollbar.
// Older runs with no per-line timing fall back to showing everything, so the
// panel is never blank.
function renderMomentLogs(fromMs, toMs) {
  const el = $('momentLogs');
  if (!el) return;
  const hasReq = momentData.requests.length > 0;
  const timed = momentData.consoleTimed.length || momentData.networkTimed.length || hasReq;
  let c, net, netLabel, head;
  if (fromMs !== null && timed) {
    const within = (arr) => (arr || []).filter((e) => e.t >= fromMs && e.t <= toMs);
    c = within(momentData.consoleTimed);
    net = hasReq ? within(momentData.requests) : within(momentData.networkTimed);
    netLabel = hasReq ? 'Network requests' : 'Network issues';
    head = `<div class="mhead"><span>${fmtTime(fromMs / 1000)} – ${fmtTime(toMs / 1000)}</span><span class="win">— since the last screenshot (what the PDF will include)</span></div>`;
  } else {
    c = (momentData.console || []).map((line) => ({ line }));
    net = hasReq ? momentData.requests : (momentData.network || []).map((line) => ({ line }));
    netLabel = hasReq ? 'Network requests' : 'Network issues';
    head = `<div class="mhead"><span>All logs for this test</span><span class="win">— per-moment timing not recorded; re-run to pinpoint</span></div>`;
  }
  let html = head;
  if (!c.length && !net.length) {
    html += '<div class="none">No console or network activity in this window.</div>';
  } else {
    html += `<div class="log-group"><div class="glabel">Console</div>${c.length ? c.map((e) => logRow(e, classifyConsole(e.line))).join('') : '<div class="none">—</div>'}</div>`;
    html += `<div class="log-group"><div class="glabel">${netLabel}</div>${net.length ? net.map((e) => logRow(e)).join('') : '<div class="none">—</div>'}</div>`;
  }
  el.innerHTML = html;
}

/* -- download the recording, or a clip of it (whole test / this step / near the failure) -- */
function downloadVideo() {
  const run = $('shareRun').value || 'latest';
  const test = $('shareTest').value;
  window.location = '/api/video?run=' + run + '&test=' + encodeURIComponent(test) + '&download=1';
}
function downloadClip(fromSec, toSec) {
  const run = $('shareRun').value || 'latest';
  const test = $('shareTest').value;
  window.location = `/api/video-clip?run=${run}&test=${encodeURIComponent(test)}&from=${fromSec}&to=${toSec}`;
}
function downloadStepClip() {
  const iv = currentInterval();
  if (!iv) return toast('This run has no per-screenshot timing to clip — try the full video instead.');
  // Small padding so the clip isn't cut exactly on the boundary.
  downloadClip(Math.max(0, iv.fromSec - 0.5), iv.toSec + 0.5);
}
function downloadFailClip() {
  // No exact failure timestamp is recorded, so approximate it: the final
  // screenshot is taken right after the test ends/throws, so a few seconds
  // either side of it is the best available proxy for "the failure moment".
  const final = curSnaps.find((s) => s.final) || curSnaps[curSnaps.length - 1];
  const centerMs = final && typeof final.t === 'number' ? final.t : momentData.durationMs;
  if (!centerMs) return toast('No timing recorded for this run — try the full video instead.');
  downloadClip(Math.max(0, centerMs / 1000 - 4), centerMs / 1000 + 1);
}

/* ---------------- GUIDE page ---------------- */
let guideLoaded = false;
async function loadGuide() {
  if (guideLoaded) return;
  const txt = await fetch('/api/guide').then((r) => r.text());
  $('guideDoc').innerHTML = md(txt);
  guideLoaded = true;
}

/* ---------------- SETTINGS page ---------------- */
async function loadSettings() {
  await loadCreds();
  await refreshEnvs();
  await loadGroups();
}

// Settings → Site groups: list existing groups (envs + pinned role, with delete)
// and a "new group" form (name + env checkboxes + optional role).
async function loadGroups() {
  const [groups, roles] = await Promise.all([
    api('/api/groups').catch(() => []),
    api('/api/roles').catch(() => []),
  ]);
  groupsCache = groups;
  const wrap = $('groupsList');
  if (wrap) {
    wrap.innerHTML = groups.length
      ? groups
          .map(
            (g) =>
              `<div class="role-card"><div class="role-head"><div class="role-title"><span class="rname">${esc(g.label || g.name)}</span> <span class="mono muted sm">${esc(g.envs.join(', ')) || 'no sites'}${g.role ? ' · as ' + esc(g.role) : ''}${g.missing ? ' · some sites removed' : ''}</span></div><button class="btn danger sm" data-groupdel="${esc(g.name)}">Delete</button></div></div>`
          )
          .join('')
      : '<p class="small muted">No groups yet. Create one below to run several sites in one click.</p>';
    wrap.querySelectorAll('[data-groupdel]').forEach((b) => (b.onclick = () => removeGroup(b.dataset.groupdel)));
  }
  // new-group form: env checkboxes + role options
  const envWrap = $('newGroupEnvs');
  if (envWrap) envWrap.innerHTML = allEnvNames.map((e) => `<label class="check sm"><input type="checkbox" data-groupenv="${esc(e)}"> ${esc(e)}</label>`).join('');
  const roleSel = $('newGroupRole');
  if (roleSel) roleSel.innerHTML = `<option value="">Each test's own role</option>` + roles.map((r) => `<option value="${esc(r.name)}">${esc(r.label || r.name)}</option>`).join('');
}
async function addGroup() {
  const name = $('newGroupName').value.trim();
  const envs = [...document.querySelectorAll('[data-groupenv]')].filter((c) => c.checked).map((c) => c.dataset.groupenv);
  const role = $('newGroupRole').value;
  if (!name) return toast('Enter a group name (e.g. non-prod).');
  if (!envs.length) return toast('Tick at least one site for the group.');
  const r = await api('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, envs, role }) });
  if (!r.ok) return toast(r.error);
  $('newGroupName').value = '';
  toast('Group saved'); loadGroups();
}
async function removeGroup(name) {
  if (!confirm(`Delete group "${name}"? (Sites and logins are untouched.)`)) return;
  const r = await api('/api/groups?name=' + encodeURIComponent(name), { method: 'DELETE' });
  if (!r.ok) return toast(r.error);
  toast('Group deleted'); loadGroups();
}
let allEnvNames = [];
async function loadCreds() {
  const [roles, creds, envsResp] = await Promise.all([
    api('/api/roles').catch(() => []),
    api('/api/creds').catch(() => []), // kept for the env-readiness dots
    api('/api/envs').catch(() => ({ envs: [] })),
  ]);
  credsCache = creds;
  allEnvNames = ((envsResp && envsResp.envs) || []).map((e) => e.name);
  paintEnvDots();
  renderRoles(roles);
}

// One card per role: which sites (envs) it maps to, then a login row per mapped site.
function renderRoles(roles) {
  const wrap = $('rolesList');
  wrap.innerHTML = '';
  if (!roles.length) {
    wrap.innerHTML = '<p class="small muted">No roles yet. Add one below (e.g. <code>admin</code>), pick its sites, then fill in each login.</p>';
    return;
  }
  for (const r of roles) {
    const isAll = r.envs === 'all';
    const mapped = new Set(isAll ? allEnvNames : r.envs);
    const card = document.createElement('div');
    card.className = 'role-card';

    const sites = allEnvNames
      .map((env) => {
        const on = mapped.has(env);
        return `<label class="check sm"><input type="checkbox" data-rolesite="${esc(r.name)}|${esc(env)}" ${on ? 'checked' : ''}${isAll ? ' disabled' : ''}> ${esc(env)}</label>`;
      })
      .join('');

    const loginRows = (r.sites || [])
      .map((s) => {
        const set = s.usernameSet && s.passwordSet;
        return (
          `<div class="login-row">` +
          `<div class="site mono">${esc(s.env)}</div>` +
          `<input class="text" placeholder="username" value="${esc(s.username || '')}" data-cu="${esc(r.name)}|${esc(s.env)}">` +
          `<input class="text" type="password" placeholder="${set ? '•••••• (saved)' : 'password'}" data-cp="${esc(r.name)}|${esc(s.env)}">` +
          `<button class="btn sm" data-csave="${esc(r.name)}|${esc(s.env)}">Save</button>` +
          `<span class="dot ${set ? 'green' : 'amber'}" title="${set ? 'login saved' : 'missing'}"></span>` +
          `</div>`
        );
      })
      .join('');

    card.innerHTML =
      `<div class="role-head">` +
      `<div class="role-title"><span class="rname">${esc(r.label || r.name)}</span> <span class="mono muted sm">${esc(r.name)}</span></div>` +
      `<button class="btn danger sm" data-roledel="${esc(r.name)}">Delete</button>` +
      `</div>` +
      `<div class="role-sites"><label class="check sm"><input type="checkbox" data-roleall="${esc(r.name)}" ${isAll ? 'checked' : ''}> All sites</label>${sites}</div>` +
      `<div class="login-rows">${loginRows || '<p class="small muted">Tick a site above to add its login.</p>'}</div>`;
    wrap.appendChild(card);
  }

  wrap.querySelectorAll('[data-csave]').forEach((b) => (b.onclick = () => saveCred(b.dataset.csave)));
  wrap.querySelectorAll('[data-roledel]').forEach((b) => (b.onclick = () => removeRole(b.dataset.roledel)));
  wrap.querySelectorAll('[data-roleall]').forEach((c) => (c.onchange = () => setRoleEnvs(c.dataset.roleall, c.checked ? 'all' : collectSites(c.dataset.roleall))));
  wrap.querySelectorAll('[data-rolesite]').forEach((c) => (c.onchange = () => setRoleEnvs(c.dataset.rolesite.split('|')[0], collectSites(c.dataset.rolesite.split('|')[0]))));
}

// The env names currently ticked for a role (ignores the "All sites" master box).
function collectSites(role) {
  return [...document.querySelectorAll(`[data-rolesite^="${CSS.escape(role)}|"]`)]
    .filter((c) => c.checked)
    .map((c) => c.dataset.rolesite.split('|')[1]);
}
async function setRoleEnvs(name, envs) {
  const r = await api('/api/roles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, envs }) });
  if (!r.ok) return toast(r.error);
  loadCreds();
}
async function addRole() {
  const name = $('newRoleName').value.trim();
  const label = $('newRoleLabel').value.trim();
  if (!name) return toast('Enter a role name (e.g. admin).');
  const r = await api('/api/roles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, label, envs: 'all' }) });
  if (!r.ok) return toast(r.error);
  $('newRoleName').value = ''; $('newRoleLabel').value = '';
  rolesCache = []; // so the new role shows up in "Run as" without a reload
  toast('Role added'); loadCreds();
}
async function removeRole(name) {
  if (!confirm(`Delete role "${name}"? Its saved logins in .env are left untouched.`)) return;
  const r = await api('/api/roles?name=' + encodeURIComponent(name), { method: 'DELETE' });
  if (!r.ok) return toast(r.error);
  toast('Role deleted'); loadCreds();
}
async function saveCred(key) {
  const [role, env] = key.split('|');
  const username = document.querySelector(`[data-cu="${CSS.escape(key)}"]`).value;
  const password = document.querySelector(`[data-cp="${CSS.escape(key)}"]`).value;
  if (!username && !password) return toast('Enter a username and/or password.');
  const r = await api('/api/creds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ env, role, username, password }) });
  if (!r.ok) return toast(r.error);
  rolesCache = []; // so the newly-usable role shows up in "Run as" without a reload
  toast('Login saved'); loadCreds(); refreshOnboarding();
}
// The four fields that describe a login form, shown per env and for the shared block.
const LOGIN_FORM_FIELDS = [
  { key: 'path', label: 'Login path', ph: '/login' },
  { key: 'username', label: 'Username field', ph: '#email' },
  { key: 'password', label: 'Password field', ph: '#password' },
  { key: 'submit', label: 'Submit button text', ph: 'Sign in' },
];
// Build the 4 labelled inputs for a login form. `scope` namespaces the data
// attribute so several forms coexist; `values` pre-fills; `inherited` supplies
// the placeholder (the shared form's value, so an env field shows what it would
// inherit if left blank).
function loginFieldsHtml(scope, values = {}, inherited = {}) {
  return (
    `<div class="login-form">` +
    LOGIN_FORM_FIELDS.map((f) => {
      const ph = (inherited[f.key] && String(inherited[f.key])) || f.ph;
      return (
        `<label class="lf-field"><span class="lf-label">${esc(f.label)}</span>` +
        `<input class="text" data-lf="${esc(scope)}|${f.key}" value="${esc(values[f.key] || '')}" placeholder="${esc(ph)}"></label>`
      );
    }).join('') +
    `</div>`
  );
}
// Read the 4 fields for a scope back into a plain object.
function readLoginFields(scope) {
  const out = {};
  for (const f of LOGIN_FORM_FIELDS) {
    const el = document.querySelector(`[data-lf="${cssEsc(scope)}|${f.key}"]`);
    if (el && el.value.trim()) out[f.key] = el.value.trim();
  }
  return out;
}
// Escape a scope string for use inside a CSS attribute selector.
const cssEsc = (s) => String(s).replace(/["\\]/g, '\\$&');

let sharedLoginCache = {};
async function refreshEnvs() {
  const resp = await api('/api/envs').catch(() => ({ envs: [], sharedLogin: {} }));
  const envs = (resp && resp.envs) || [];
  sharedLoginCache = (resp && resp.sharedLogin) || {};
  const list = $('envList');
  list.innerHTML = '';
  for (const e of envs) {
    const li = document.createElement('li');
    li.className = 'env-row';
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<div style="width:120px" class="name mono">${esc(e.name)}</div>`;
    const url = document.createElement('input');
    url.className = 'text'; url.value = e.baseURL;
    const save = document.createElement('button');
    save.className = 'btn sm'; save.textContent = 'Save';
    save.onclick = () => saveEnv(e.name, url.value, readLoginFields('env:' + e.name));
    const del = document.createElement('button');
    del.className = 'btn danger'; del.textContent = 'Remove';
    del.onclick = () => { if (confirm(`Remove environment "${e.name}"?`)) removeEnv(e.name); };
    const wrap = document.createElement('div');
    wrap.className = 'hover-actions'; wrap.style.opacity = '1'; wrap.append(save, del);
    row.append(url, wrap);
    // Per-env login override (blank = inherits the shared form).
    const det = document.createElement('details');
    det.className = 'tech env-login';
    const hasOwn = e.login && Object.keys(e.login).length;
    det.innerHTML =
      `<summary>Login form${hasOwn ? ' <span class="pill sm">custom</span>' : ' <span class="small muted">(inherits shared)</span>'}</summary>` +
      `<p class="small muted" style="margin:6px 0 8px">Leave blank to use the shared login form. Fill a field here only if this environment's form differs.</p>` +
      loginFieldsHtml('env:' + e.name, e.login || {}, sharedLoginCache);
    li.append(row, det);
    list.appendChild(li);
  }
  // Shared login form block.
  const sharedWrap = $('sharedLoginFields');
  if (sharedWrap) sharedWrap.innerHTML = loginFieldsHtml('shared', sharedLoginCache, {});
}
async function saveEnv(name, baseURL, login) {
  const body = { name, baseURL };
  if (login !== undefined) body.login = login; // {} clears the env's own override
  const r = await api('/api/envs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) return toast(r.error);
  toast('Saved'); await reloadEverything();
}
async function saveSharedLogin() {
  const login = readLoginFields('shared');
  const r = await api('/api/envs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shared: true, login }) });
  if (!r.ok) return toast(r.error);
  toast('Login form saved'); await reloadEverything();
}
async function removeEnv(name) {
  const r = await api('/api/envs?name=' + encodeURIComponent(name), { method: 'DELETE' });
  if (!r.ok) return toast(r.error);
  toast('Removed'); await reloadEverything();
}
async function reloadEverything() {
  const s = await api('/api/state');
  envsCache = s.envs;
  if (!s.envs.includes(selectedEnv)) selectedEnv = s.envs[0];
  // Keep only still-valid selections; never leave the run page with none selected.
  selectedEnvs = new Set([...selectedEnvs].filter((e) => s.envs.includes(e)));
  if (!selectedEnvs.size) selectedEnvs = new Set([selectedEnv].filter(Boolean));
  renderRunEnvPills();
  await loadCreds();
  await refreshEnvs();
  await populateRunScope();
}

/* ---------------- theme ---------------- */
function setTheme(t) {
  localStorage.setItem('theme', t);
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  document.querySelectorAll('#themePills button').forEach((b) => b.classList.toggle('active', b.dataset.theme === t));
}

/* ---------------- init ---------------- */
let envsCache = [];
// Run-page pills are toggles (multi-select). Clicking adds/removes an env; the
// last selected env can't be removed (a run needs at least one target).
function renderRunEnvPills() {
  const c = $('envPills');
  c.innerHTML = '';
  for (const env of envsCache) {
    const on = selectedEnvs.has(env);
    const b = document.createElement('button');
    b.innerHTML = `<span class="dot" data-env="${esc(env)}"></span>${esc(env)}`;
    b.className = on ? 'active' : '';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.onclick = () => {
      if (selectedEnvs.has(env)) { if (selectedEnvs.size > 1) selectedEnvs.delete(env); }
      else selectedEnvs.add(env);
      selectedEnv = [...selectedEnvs][selectedEnvs.size - 1] || selectedEnv;
      renderRunEnvPills();
    };
    c.appendChild(b);
  }
  paintEnvDots();
  const n = selectedEnvs.size;
  const btn = $('runBtn');
  if (btn && !running) btn.textContent = n > 1 ? `Run on ${n} sites` : 'Run';
  const hint = document.getElementById('runEnvHint');
  if (hint) hint.textContent = n > 1 ? `Same tests will run against all ${n} selected sites at once.` : 'Tip: pick more than one site to run everywhere at once.';
  populateRunRoles(); // available override roles depend on which envs are selected
  renderGroupChips(); // reflect whether the current selection matches a saved group
}

// One-click chips for saved site groups: selecting a group ticks its envs (and
// applies its pinned role, if any). A chip is "active" when the current selection
// exactly matches the group.
function renderGroupChips() {
  const c = $('groupChips');
  if (!c) return;
  const usable = groupsCache.filter((g) => g.envs.length);
  if (!usable.length) { c.innerHTML = ''; c.style.display = 'none'; return; }
  c.style.display = '';
  c.innerHTML = '<span class="gc-label small muted">Groups:</span>';
  for (const g of usable) {
    const active = g.envs.length === selectedEnvs.size && g.envs.every((e) => selectedEnvs.has(e));
    const b = document.createElement('button');
    b.className = 'chip' + (active ? ' on' : '');
    b.textContent = g.label || g.name;
    if (g.role) b.title = `Runs as ${g.role}`;
    b.onclick = () => applyGroup(g);
    c.appendChild(b);
  }
}
function applyGroup(g) {
  const valid = g.envs.filter((e) => envsCache.includes(e));
  if (!valid.length) return toast('This group has no valid sites — edit it in Settings.');
  selectedEnvs = new Set(valid);
  selectedEnv = valid[valid.length - 1];
  runRole = g.role || '';
  renderRunEnvPills(); // also re-renders the group chips + role dropdown
  const sel = $('runRole');
  if (sel && runRole) sel.value = runRole; // honored if that role is usable on all envs
}

async function init() {
  setTheme(localStorage.getItem('theme') || 'system');
  document.querySelectorAll('#themePills button').forEach((b) => (b.onclick = () => setTheme(b.dataset.theme)));

  credsCache = await api('/api/creds').catch(() => []);
  const s = await api('/api/state');
  if (s.demo && $('demoBadge')) { $('demoBadge').style.display = ''; document.body.classList.add('is-demo'); }
  envsCache = s.envs;
  groupsCache = await api('/api/groups').catch(() => []); // for the Run-page group chips
  selectedEnv = s.env && s.envs.includes(s.env) ? s.env : s.envs[0];
  selectedEnvs = new Set([selectedEnv].filter(Boolean));
  renderRunEnvPills();
  setStatus(s.status, s.env);
  $('reportBtn').disabled = !s.reportExists;
  refreshOnboarding();
  populateRunScope();
  showLastRun();

  // live stream
  const streamEvents = new EventSource('/api/stream');
  // The server sends one `state` event right when the connection opens (both
  // on first load and on every auto-reconnect), then replays every buffered
  // output line as its own `line` event. Reset the raw output here so that
  // replay — which happens on every reconnect, not just the first connect —
  // rebuilds it exactly once instead of doubling up on top of what's already
  // there. If a run is actually in progress, also re-seed the checklist from
  // the real test list for the envs being run, so a mid-run refresh shows the
  // correct total instead of whatever the last *completed* run happened to have.
  streamEvents.addEventListener('state', (e) => {
    const st = JSON.parse(e.data);
    $('output').textContent = '';
    setStatus(st.status, st.env);
    $('reportBtn').disabled = !st.reportExists;
    if (st.status === 'running') {
      matrix = new Map(); // synchronous — happens before any buffered `line` events are processed
      matrixCols = (st.runEnvs && st.runEnvs.length) ? st.runEnvs : runEnvList();
      selectedEnvs = new Set(matrixCols);
      renderRunEnvPills();
      fillChecklistTotals(matrixCols[0]); // async: only adds placeholders for tests not already reported by a buffered line
    }
  });
  streamEvents.addEventListener('line', (e) => appendLine(JSON.parse(e.data).line));
  streamEvents.addEventListener('started', (e) => {
    const st = JSON.parse(e.data);
    $('output').textContent = '';
    setStatus(st.status, st.env);
  });
  streamEvents.addEventListener('done', (e) => {
    const st = JSON.parse(e.data);
    setStatus(st.status, st.env);
    $('reportBtn').disabled = !st.reportExists;
    reconcileResults();
    refreshOnboarding();
    populateRunScope(); // a recording may have added a new test/group/tag
  });

  // nav
  document.querySelectorAll('.nav-item[data-route]').forEach((b) => (b.onclick = () => (location.hash = '#/' + b.dataset.route)));
  window.addEventListener('hashchange', route);

  // collapsible sidebar (icon rail), remembered across sessions
  const app = document.querySelector('.app');
  const applyRail = (rail) => {
    app.classList.toggle('rail', rail);
    $('sidebarToggle').title = rail ? 'Expand sidebar' : 'Collapse sidebar';
  };
  applyRail(localStorage.getItem('sidebar') === 'rail');
  $('sidebarToggle').onclick = () => {
    const rail = !app.classList.contains('rail');
    localStorage.setItem('sidebar', rail ? 'rail' : 'full');
    applyRail(rail);
  };

  // run page buttons
  $('runBtn').onclick = () => startRun(resolveRunScope());
  $('runRole').onchange = (e) => { runRole = e.target.value; renderChecklist(); };
  $('stopBtn').onclick = () => {
    // Immediate feedback — otherwise the button gives no sign anything
    // happened until the process actually dies and the `done` event lands.
    const btn = $('stopBtn');
    btn.disabled = true;
    btn.textContent = 'Stopping…';
    fetch('/api/stop', { method: 'POST' });
  };
  $('reportBtn').onclick = () => window.open('/report/', '_blank');

  // tests page
  $('runSelectedBtn').onclick = runSelected;
  $('selectAllBtn').onclick = toggleSelectAll;
  $('deleteSelectedBtn').onclick = deleteSelected;
  $('runTagBtn').onclick = runByTag;
  $('testSearch').oninput = (e) => { testSearchQ = e.target.value; renderTestGroups(); };
  $('recordBtn').onclick = recordTest;

  // history
  $('historySearch').oninput = renderRuns;

  // share page
  $('shareRun').onchange = loadShareTests;
  $('shareTest').onchange = onTestSelected;
  $('snapRange').oninput = (e) => showSnap(Number(e.target.value));
  $('snapPrev').onclick = () => showSnap(curSnapIdx - 1);
  $('snapNext').onclick = () => showSnap(curSnapIdx + 1);
  $('bundleBtn').onclick = () => { markShared(); downloadBundle(); };
  $('bundleBtn2').onclick = () => { markShared(); downloadBundle(); };
  $('copySummaryBtn').onclick = () => { markShared(); copySummary(); };
  $('pdfBtn').onclick = downloadPdf;
  $('downloadVideoBtn').onclick = downloadVideo;
  $('downloadClipBtn').onclick = downloadStepClip;
  $('downloadFailClipBtn').onclick = downloadFailClip;

  // moment picker layout: full width (image above logs) or half (side by side),
  // remembered across sessions like the sidebar.
  const applyPdfLayout = (mode) => {
    $('pdfLayoutWrap').classList.toggle('grid2', mode === 'half');
    $('pdfLayoutToggle').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.layout === mode));
  };
  applyPdfLayout(localStorage.getItem('pdfLayout') || 'full');
  $('pdfLayoutToggle').querySelectorAll('button').forEach((b) => (b.onclick = () => {
    localStorage.setItem('pdfLayout', b.dataset.layout);
    applyPdfLayout(b.dataset.layout);
  }));

  // settings
  $('addEnvBtn').onclick = async () => {
    const name = $('newEnvName').value.trim();
    const url = $('newEnvUrl').value.trim();
    if (!name || !url) return toast('Enter a name and a URL.');
    await saveEnv(name, url);
    $('newEnvName').value = ''; $('newEnvUrl').value = '';
  };
  const saveSharedBtn = $('saveSharedLoginBtn');
  if (saveSharedBtn) saveSharedBtn.onclick = saveSharedLogin;
  $('addRoleBtn').onclick = addRole;
  $('addGroupBtn').onclick = addGroup;

  route();
}

// Fold the authoritative per-(test, env) results back into the matrix once a run
// finishes (the live list parse can miss lines under load).
async function reconcileResults() {
  const results = await api('/api/results?run=latest').catch(() => []);
  const cols = new Set(matrixCols);
  for (const r of results) {
    const env = r.env || matrixCols[0] || '';
    cols.add(env);
    cellRow(r.title).set(env, { status: r.status, time: r.durationMs ? fmtTime(r.durationMs / 1000) : (cellRow(r.title).get(env) || {}).time || '' });
  }
  matrixCols = [...cols].filter(Boolean);
  if (!matrixCols.length) matrixCols = [''];
  renderChecklist();
}
// Populate the dashboard from the last run so it isn't blank on load.
async function showLastRun() {
  if (running) return;
  const results = await api('/api/results?run=latest').catch(() => []);
  if (!results.length) return;
  matrix = new Map();
  const cols = new Set();
  for (const r of results) {
    const env = r.env || '';
    cols.add(env);
    cellRow(r.title).set(env, { status: r.status, time: r.durationMs ? fmtTime(r.durationMs / 1000) : '' });
  }
  matrixCols = [...cols].filter(Boolean);
  if (!matrixCols.length) matrixCols = [''];
  renderChecklist();
}

// Fill the "Log in as" dropdown with the roles mapped to the Tests-page env.
// Roles missing a login for that env are shown but flagged, so the picker also
// nudges the user to add the login in Settings.
async function populateRecordRoles() {
  const sel = $('recordRole');
  if (!sel) return;
  const roles = await api('/api/roles').catch(() => []);
  const forEnv = roles.filter((r) => (r.sites || []).some((s) => s.env === testsEnv));
  const opts = ['<option value="">No login (public pages)</option>'];
  for (const r of forEnv) {
    const site = (r.sites || []).find((s) => s.env === testsEnv);
    const ready = site && site.usernameSet && site.passwordSet;
    opts.push(`<option value="${esc(r.name)}">${esc(r.label || r.name)}${ready ? '' : ' — no login set'}</option>`);
  }
  sel.innerHTML = opts.join('');
}
async function recordTest() {
  const role = $('recordRole') ? $('recordRole').value : '';
  const res = await api('/api/record', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ env: testsEnv || selectedEnv, name: $('recordName').value, role: role || undefined }) });
  if (!res.ok) return toast(res.error);
  $('recordName').value = '';
  toast(role ? `Recorder opening — login as "${role}" will be added automatically.` : 'Recorder opening — click through the site, then close the browser.');
}

function downloadBundle() {
  const run = $('shareRun').value || 'latest';
  const test = $('shareTest').value;
  window.location = '/api/bug-bundle?run=' + run + '&test=' + encodeURIComponent(test);
}
async function copySummary() {
  const raw = $('shareSummary').dataset.raw || '';
  try { await navigator.clipboard.writeText(raw); toast('Summary copied — paste into ClickUp, Slack or email.'); }
  catch { toast('Copy failed — select the text manually.'); }
}
async function downloadPdf() {
  const btn = $('pdfBtn');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Building…';
  try {
    const s = curSnaps[curSnapIdx];
    const body = { run: $('shareRun').value || 'latest', test: $('shareTest').value, i: s ? s.index : 0 };
    // Scope the PDF's logs to exactly the interval shown on screen for this step.
    const iv = currentInterval();
    if (iv) { body.from = iv.fromMs; body.to = iv.toMs; }
    const res = await fetch('/api/pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { toast('PDF failed: ' + (await res.text())); return; }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'report.pdf'; a.click();
    URL.revokeObjectURL(a.href);
  } finally { btn.textContent = prev; btn.disabled = false; }
}

init();
