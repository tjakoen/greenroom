'use strict';
// Greenroom. Single-page app with a sidebar and hash routing.
// Zero dependencies. Talks to the plain-Node server in server.js.

const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(path, opts).then((r) => r.json());
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let selectedEnv = null; // Run page
let testsEnv = null; // Tests page
let running = false;
let pdfData = [];
let capturedFrame = null;

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
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  const flushPara = () => { if (para.length) { html += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } };
  const closeList = () => { if (inList) { html += `</${inList}>`; inList = null; } };
  for (const raw of lines) {
    if (raw.trim().startsWith('```')) {
      flushPara(); closeList();
      if (!inCode) { html += '<pre><code>'; inCode = true; } else { html += '</code></pre>'; inCode = false; }
      continue;
    }
    if (inCode) { html += esc(raw) + '\n'; continue; }
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); closeList(); html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; }
    else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { flushPara(); if (inList !== 'ul') { closeList(); html += '<ul>'; inList = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { flushPara(); if (inList !== 'ol') { closeList(); html += '<ol>'; inList = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); closeList(); html += `<blockquote>${inline(m[1])}</blockquote>`; }
    else if (line.trim() === '') { flushPara(); closeList(); }
    else para.push(line);
  }
  flushPara(); closeList();
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
  $('stopBtn').disabled = !running;
  const nd = $('navRunDot');
  nd.className = 'badge-dot';
  nd.style.background = status === 'running' ? 'var(--amber)' : status === 'failed' ? 'var(--red)' : status === 'passed' ? 'var(--green)' : 'transparent';
}

const cleanTitle = (t) => String(t).replace(/\s*@[\w-]+/g, '').trim();

// The readable checklist + the dashboard stat tiles. Seeded with the tests about
// to run, updated live as Playwright reports each one.
let checklist = new Map(); // title -> { status, time }
function renderChecklist() {
  if (!checklist.size) { $('resultsCard').style.display = 'none'; return; }
  $('resultsCard').style.display = 'block';
  let pass = 0, fail = 0, pending = 0;
  for (const s of checklist.values()) {
    if (s.status === 'passed') pass++;
    else if (s.status === 'failed') fail++;
    else pending++;
  }
  const total = checklist.size;
  const pct = (n) => (total ? (n / total) * 100 : 0);
  $('statTiles').innerHTML =
    `<div class="stat pass"><span class="emoji">✅</span><div class="num">${pass}</div><div class="lbl">Passed</div></div>` +
    `<div class="stat fail"><span class="emoji">❌</span><div class="num">${fail}</div><div class="lbl">Failed</div></div>` +
    `<div class="stat skip"><span class="emoji">⏳</span><div class="num">${pending}</div><div class="lbl">Pending</div></div>` +
    `<div class="stat total"><span class="emoji">🧪</span><div class="num">${total}</div><div class="lbl">Total</div></div>`;
  $('healthBar').innerHTML =
    `<div class="seg pass" style="width:${pct(pass)}%"></div><div class="seg fail" style="width:${pct(fail)}%"></div><div class="seg skip" style="width:${pct(pending)}%"></div>`;
  const done = pass + fail;
  $('healthCap').innerHTML = `<span><b>${done ? Math.round((pass / done) * 100) : 0}%</b> healthy</span><span>${pass}/${total} passing${fail ? ` · ${fail} failing` : ''}</span>`;
  const ul = $('checklist');
  ul.innerHTML = '';
  for (const [title, s] of checklist) {
    const mark = s.status === 'passed' ? ['pass', '✓'] : s.status === 'failed' ? ['fail', '✕'] : s.status === 'running' ? ['run', '◐'] : ['wait', '○'];
    const li = document.createElement('li');
    li.innerHTML = `<span class="cmark ${mark[0]}">${mark[1]}</span><span>${esc(cleanTitle(title))}</span><span class="ctime">${s.time || ''}</span>`;
    ul.appendChild(li);
  }
}
// seed: array of titles to pre-list as "waiting"; null → every test for the env.
async function seedChecklist(seed) {
  checklist = new Map();
  if (seed) { for (const t of seed) checklist.set(t, { status: 'waiting' }); renderChecklist(); return; }
  const payload = await api('/api/tests?env=' + encodeURIComponent(selectedEnv)).catch(() => ({ tests: [] }));
  for (const t of payload.tests || []) checklist.set(t.title, { status: 'waiting' });
  renderChecklist();
}
// Parse a Playwright "list" reporter line into a checklist update.
function parseLine(line) {
  const pass = /[✓✔]/.test(line);
  const fail = /[✘✗×]/.test(line);
  if (!pass && !fail) return;
  const timeM = line.match(/\((\d+(?:\.\d+)?m?s)\)\s*$/);
  const time = timeM ? timeM[1] : '';
  let body = line.replace(/\((\d+(?:\.\d+)?m?s)\)\s*$/, '').trim();
  if (body.includes('›')) body = body.split('›').pop().trim();
  else body = body.replace(/^[^A-Za-z0-9]*\d*\s*/, '').trim();
  if (!body) return;
  checklist.set(body, { status: fail ? 'failed' : 'passed', time });
  renderChecklist();
}

async function startRun({ files, grep, seed } = {}) {
  $('output').textContent = '';
  await seedChecklist(seed || null);
  const res = await api('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ env: selectedEnv, light: $('light').checked, files: files || undefined, grep: grep || undefined }),
  });
  if (!res.ok) toast(res.error);
}
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function appendLine(line) {
  const out = $('output');
  const stick = out.scrollTop + out.clientHeight >= out.scrollHeight - 30;
  out.textContent += line + '\n';
  if (stick) out.scrollTop = out.scrollHeight;
  parseLine(line);
}

async function refreshOnboarding() {
  const o = await api('/api/onboarding').catch(() => null);
  if (!o) return;
  const steps = [
    { done: o.anyCreds, txt: 'Add a login (Settings → Logins)', route: 'settings' },
    { done: o.hasRuns, txt: 'Run the tests for the first time', route: 'run' },
    { done: o.reportExists, txt: 'Open a report to see results', route: 'run' },
    { done: o.hasRuns, txt: 'Share a result with the dev team', route: 'share' },
  ];
  const allDone = steps.every((s) => s.done);
  $('onboardCard').style.display = allDone ? 'none' : 'block';
  $('onboardList').innerHTML = steps
    .map((s) => `<li class="${s.done ? 'done' : ''}"><span class="box">${s.done ? '✓' : ''}</span><span class="txt">${esc(s.txt)}</span></li>`)
    .join('');
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
  { key: 'failing', label: '❌ Failing' },
  { key: 'never', label: '○ Never run' },
  { key: 'flaky', label: '🎲 Flaky' },
  { key: 'slowest', label: '🐢 Slowest' },
];
const tkey = (t) => `${t.file}::${t.title}`;

async function loadTests() {
  const envs = envsCache.length ? envsCache : (await api('/api/state')).envs;
  if (!testsEnv || !envs.includes(testsEnv)) testsEnv = selectedEnv || envs[0];
  renderEnvPills($('testsEnvPills'), envs, testsEnv, (e) => { testsEnv = e; selectedKeys.clear(); loadTests(); });
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
  btn.textContent = activeTags.size ? `▶ Run ${[...activeTags].join(', ')}` : '▶ Run by tag';
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
  return `📁 ${t.file.replace(/^tests\//, '')}`;
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
  const statusPill = t.status ? `<span class="pill ${t.status}">${t.status}</span>` : '<span class="pill none">not run</span>';
  const tags = t.tags.map((tag) => `<span class="chip tag">${esc(tag)}</span>`).join('');
  const flaky = t.flaky ? '<span class="chip" style="color:var(--amber)">🎲 flaky</span>' : '';
  const prio = t.priority ? `<span class="prio ${esc(t.priority)}">${esc(t.priority)}</span>` : '';
  const sub = [t.scope, t.owner ? '👤 ' + esc(t.owner) : '', t.runCount ? `${t.runCount} run${t.runCount === 1 ? '' : 's'}` : '', t.durationMs ? (t.durationMs / 1000).toFixed(1) + 's' : ''].filter(Boolean).join(' · ');
  li.innerHTML =
    `<input type="checkbox" class="tsel" data-key="${esc(k)}" ${selectedKeys.has(k) ? 'checked' : ''}>` +
    `<div class="grow"><div class="name">${esc(t.cleanTitle)}</div>` +
    (tags || flaky ? `<div class="test-tags">${tags}${flaky}</div>` : '') +
    `<div class="sub">${sub}</div></div>` +
    prio + statusPill +
    `<div class="hover-actions">` +
    `<button class="btn sm" data-run="${esc(k)}">▶ Run</button>` +
    `<button class="btn icon" data-edit="${esc(k)}" title="Tag / priority / owner">🏷</button>` +
    `<button class="btn icon" data-rename="${esc(t.file)}" title="Rename file">✎</button>` +
    `<button class="btn danger" data-del="${esc(t.file)}" title="Delete file">🗑</button>` +
    `</div>`;
  li.querySelector('.tsel').onchange = (e) => { e.target.checked ? selectedKeys.add(k) : selectedKeys.delete(k); updateRunSelected(); };
  li.querySelector('[data-run]').onclick = () => runOne(t);
  li.querySelector('[data-edit]').onclick = () => toggleMetaEdit(li, t);
  li.querySelector('[data-rename]').onclick = () => renameTest(t.file);
  li.querySelector('[data-del]').onclick = () => deleteTest(t.file);
  return li;
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
    `<div class="full"><label class="field">Notes</label><input class="text" id="m-notes" value="${esc(t.notes)}" placeholder="e.g. flaky on demo, needs data reset"></div>` +
    `<div class="full row" style="justify-content:flex-end"><button class="btn sm" id="m-cancel">Cancel</button><button class="btn primary sm" id="m-save">Save</button></div>`;
  li.after(ed);
  ed.querySelector('#m-cancel').onclick = () => ed.remove();
  ed.querySelector('#m-save').onclick = async () => {
    const body = { file: t.file, title: t.title, group: ed.querySelector('#m-group').value, priority: ed.querySelector('#m-prio').value, owner: ed.querySelector('#m-owner').value, notes: ed.querySelector('#m-notes').value };
    const r = await api('/api/test-meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return toast(r.error);
    toast('Saved'); await loadTests();
  };
}
function updateRunSelected() {
  const n = selectedKeys.size;
  const btn = $('runSelectedBtn');
  btn.disabled = n === 0;
  btn.textContent = n ? `▶ Run selected (${n})` : '▶ Run selected';
}
async function gotoRunWithEnv() {
  selectedEnv = testsEnv;
  renderEnvPills($('envPills'), envsCache, selectedEnv, pickRunEnv);
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
    li.innerHTML =
      `<div class="grow"><div class="name">${esc(run.env)}</div><div class="sub">${esc(run.when)}</div></div>` +
      `<span class="pill ${run.result}">${esc(run.result)}</span>` +
      `<div class="hover-actions"><a class="btn sm" href="/runs/${encodeURIComponent(run.id)}/" target="_blank">Open report ↗</a></div>`;
    list.appendChild(li);
  }
}

/* ---------------- SHARE / BUG page ---------------- */
async function refreshShare() {
  const runs = await api('/api/runs').catch(() => []);
  $('shareRun').innerHTML = ['<option value="latest">Latest run</option>']
    .concat(runs.map((r) => `<option value="${encodeURIComponent(r.id)}">${r.when} · ${r.env} · ${r.result}</option>`))
    .join('');
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
  if (has) { await loadSummary(); loadPdfSnaps(); }
}
async function loadSummary() {
  const run = $('shareRun').value || 'latest';
  const test = $('shareTest').value;
  const txt = await fetch('/api/bug-summary?run=' + run + '&test=' + encodeURIComponent(test)).then((r) => r.text());
  $('shareSummary').innerHTML = md(txt);
  $('shareSummary').dataset.raw = txt;
}
function loadPdfSnaps() {
  const t = pdfData.find((x) => x.test === $('shareTest').value);
  const sel = $('pdfSnap');
  sel.innerHTML = '';
  capturedFrame = null;
  $('frameStatus').textContent = '';
  if (!t) return;
  for (const s of t.snapshots) {
    const o = document.createElement('option');
    o.value = s.index; o.textContent = (s.title || s.url) + (s.final ? ' (final)' : '');
    sel.appendChild(o);
  }
  const run = $('shareRun').value || 'latest';
  const wrap = $('pdfVideoWrap');
  if (t.hasVideo) {
    const v = $('pdfVideo');
    v.src = '/api/video?run=' + run + '&test=' + encodeURIComponent(t.test);
    fixVideoDuration(v);
    wrap.style.display = 'block';
  } else { $('pdfVideo').removeAttribute('src'); wrap.style.display = 'none'; }
  updatePreview();
}
function updatePreview() {
  capturedFrame = null;
  $('frameStatus').textContent = '';
  const run = $('shareRun').value || 'latest';
  const test = $('shareTest').value;
  const i = $('pdfSnap').value;
  if (test === '' || i === '') { $('pdfPreview').innerHTML = ''; return; }
  $('pdfPreview').innerHTML = `<img src="/api/pdf-image?run=${run}&test=${encodeURIComponent(test)}&i=${i}">`;
  $('pdfBtn').disabled = false;
}
// Playwright's webm reports duration = Infinity until you seek to the end.
// Force the browser to compute the real duration so the scrubber works.
function fixVideoDuration(v) {
  const onMeta = () => {
    if (v.duration === Infinity || isNaN(v.duration)) {
      const onSeek = () => { v.currentTime = 0; v.removeEventListener('seeked', onSeek); };
      v.addEventListener('seeked', onSeek);
      v.currentTime = 1e6; // jump past the end; browser clamps + resolves duration
    }
  };
  v.addEventListener('loadedmetadata', onMeta, { once: true });
}

function captureVideoFrame() {
  const v = $('pdfVideo');
  if (!v.videoWidth) return toast('Let the video load, then scrub to the moment you want.');
  const c = $('frameCanvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  capturedFrame = { dataURL: c.toDataURL('image/png'), time: v.currentTime };
  $('pdfPreview').innerHTML = `<img src="${capturedFrame.dataURL}">`;
  $('frameStatus').textContent = 'Frame at ' + v.currentTime.toFixed(1) + 's — will be used in the PDF';
  $('pdfBtn').disabled = false;
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
}
async function loadCreds() {
  credsCache = await api('/api/creds').catch(() => []);
  paintEnvDots();
  const byEnv = {};
  for (const c of credsCache) (byEnv[c.env] = byEnv[c.env] || []).push(c);
  const wrap = $('credsList');
  wrap.innerHTML = '';
  for (const env of Object.keys(byEnv)) {
    const h = document.createElement('h3');
    h.textContent = env;
    wrap.appendChild(h);
    for (const c of byEnv[env]) {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.marginBottom = '8px';
      const set = c.usernameSet && c.passwordSet;
      row.innerHTML =
        `<div style="width:130px;font-size:13px" class="mono">${esc(c.role)}</div>` +
        `<input class="text" placeholder="username" data-cu="${esc(c.env)}|${esc(c.role)}">` +
        `<input class="text" type="password" placeholder="${set ? '•••••• (saved)' : 'password'}" data-cp="${esc(c.env)}|${esc(c.role)}">` +
        `<button class="btn sm" data-csave="${esc(c.env)}|${esc(c.role)}">Save</button>` +
        `<span class="dot ${set ? 'green' : 'amber'}" title="${set ? 'login saved' : 'missing'}"></span>`;
      wrap.appendChild(row);
    }
  }
  wrap.querySelectorAll('[data-csave]').forEach((b) => (b.onclick = () => saveCred(b.dataset.csave)));
}
async function saveCred(key) {
  const [env, role] = key.split('|');
  const username = document.querySelector(`[data-cu="${CSS.escape(key)}"]`).value;
  const password = document.querySelector(`[data-cp="${CSS.escape(key)}"]`).value;
  if (!username && !password) return toast('Enter a username and/or password.');
  const r = await api('/api/creds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ env, role, username, password }) });
  if (!r.ok) return toast(r.error);
  toast('Login saved'); loadCreds(); refreshOnboarding();
}
async function refreshEnvs() {
  const envs = await api('/api/envs').catch(() => []);
  const list = $('envList');
  list.innerHTML = '';
  for (const e of envs) {
    const li = document.createElement('li');
    li.innerHTML = `<div style="width:120px" class="name mono">${esc(e.name)}</div>`;
    const url = document.createElement('input');
    url.className = 'text'; url.value = e.baseURL;
    const save = document.createElement('button');
    save.className = 'btn sm'; save.textContent = 'Save';
    save.onclick = () => saveEnv(e.name, url.value);
    const del = document.createElement('button');
    del.className = 'btn danger'; del.textContent = 'Remove';
    del.onclick = () => { if (confirm(`Remove environment "${e.name}"?`)) removeEnv(e.name); };
    const wrap = document.createElement('div');
    wrap.className = 'hover-actions'; wrap.style.opacity = '1'; wrap.append(save, del);
    li.append(url, wrap);
    list.appendChild(li);
  }
}
async function saveEnv(name, baseURL) {
  const r = await api('/api/envs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, baseURL }) });
  if (!r.ok) return toast(r.error);
  toast('Saved'); await reloadEverything();
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
  renderEnvPills($('envPills'), s.envs, selectedEnv, pickRunEnv);
  await loadCreds();
  await refreshEnvs();
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
function pickRunEnv(env) {
  selectedEnv = env;
  renderEnvPills($('envPills'), envsCache, selectedEnv, pickRunEnv);
}

async function init() {
  setTheme(localStorage.getItem('theme') || 'system');
  document.querySelectorAll('#themePills button').forEach((b) => (b.onclick = () => setTheme(b.dataset.theme)));

  credsCache = await api('/api/creds').catch(() => []);
  const s = await api('/api/state');
  envsCache = s.envs;
  selectedEnv = s.env && s.envs.includes(s.env) ? s.env : s.envs[0];
  renderEnvPills($('envPills'), s.envs, selectedEnv, pickRunEnv);
  setStatus(s.status, s.env);
  $('reportBtn').disabled = !s.reportExists;
  refreshOnboarding();
  showLastRun();

  // live stream
  const streamEvents = new EventSource('/api/stream');
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
  });

  // nav
  document.querySelectorAll('.nav-item').forEach((b) => (b.onclick = () => (location.hash = '#/' + b.dataset.route)));
  window.addEventListener('hashchange', route);

  // run page buttons
  $('runBtn').onclick = () => startRun({});
  $('stopBtn').onclick = () => fetch('/api/stop', { method: 'POST' });
  $('reportBtn').onclick = () => window.open('/report/', '_blank');

  // tests page
  $('runSelectedBtn').onclick = runSelected;
  $('runTagBtn').onclick = runByTag;
  $('testSearch').oninput = (e) => { testSearchQ = e.target.value; renderTestGroups(); };
  $('recordBtn').onclick = recordTest;

  // history
  $('historySearch').oninput = renderRuns;

  // share page
  $('shareRun').onchange = loadShareTests;
  $('shareTest').onchange = async () => { await loadSummary(); loadPdfSnaps(); };
  $('pdfSnap').onchange = updatePreview;
  $('captureFrameBtn').onclick = captureVideoFrame;
  $('bundleBtn').onclick = downloadBundle;
  $('copySummaryBtn').onclick = copySummary;
  $('pdfBtn').onclick = downloadPdf;

  // settings
  $('addEnvBtn').onclick = async () => {
    const name = $('newEnvName').value.trim();
    const url = $('newEnvUrl').value.trim();
    if (!name || !url) return toast('Enter a name and a URL.');
    await saveEnv(name, url);
    $('newEnvName').value = ''; $('newEnvUrl').value = '';
  };

  route();
}

async function reconcileResults() {
  const results = await api('/api/results?run=latest').catch(() => []);
  for (const r of results) checklist.set(r.title, { status: r.status, time: r.durationMs ? (r.durationMs / 1000).toFixed(1) + 's' : (checklist.get(r.title) || {}).time || '' });
  renderChecklist();
}
// Populate the dashboard from the last run so it isn't blank on load.
async function showLastRun() {
  if (running) return;
  const results = await api('/api/results?run=latest').catch(() => []);
  if (!results.length) return;
  checklist = new Map();
  for (const r of results) checklist.set(r.title, { status: r.status, time: r.durationMs ? (r.durationMs / 1000).toFixed(1) + 's' : '' });
  renderChecklist();
}

async function recordTest() {
  const res = await api('/api/record', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ env: testsEnv || selectedEnv, name: $('recordName').value }) });
  if (!res.ok) return toast(res.error);
  $('recordName').value = '';
  toast('Recorder opening — click through the site, then close the browser.');
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
    const body = { run: $('shareRun').value || 'latest', test: $('shareTest').value, i: Number($('pdfSnap').value) };
    if (capturedFrame) { body.imageData = capturedFrame.dataURL; body.caption = 'Captured video frame at ' + capturedFrame.time.toFixed(1) + 's'; body.time = capturedFrame.time; }
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
