'use strict';
// pages/run.js — the thin client module behind /run (P4). Plain, dependency-free browser JS (no
// bundler, no TS) served as-is by server.ts, same pattern as pages/settings.js (P2) and
// pages/tests.js (P3). Talks to the SAME /api/{run,stop,stream,state,results,tests,roles,groups,
// creds} endpoints interface/app.js already uses, with the SAME request bodies and the SAME SSE
// event shapes (byte-compat is the P4 gate) — this file only changes how the results are RENDERED
// (grain markup: chip-group env picker, stat-tile/b-meter/status-list dashboard, a plain table for
// the multi-env matrix) and drops every hue (statusMark's glyphs carry the pass/fail signal, and
// env login-readiness is a filled/hollow glyph + tooltip, never a green/amber dot).
//
// Ported from interface/app.js: the state model (~141-163), renderChecklist (~165-229),
// seedChecklist/fillChecklistTotals (~231-257), parseLine (~260-275, VERBATIM), populateRunRoles
// (~281-297), startRun (~299-313), populateRunScope/resolveRunScope (~319-357, VERBATIM incl.
// escRe), appendLine (~359-366), the env picker + saved site groups (~109-117, ~1245-1301),
// setStatus (~120-134), the SSE wiring (~1322-1357) and reconcileResults/showLastRun
// (~1442-1471). Report-a-bug is still the frozen SPA (P5) — a failed row's "Report this" hands
// off to it (`location.href = '/#bug'`) rather than wiring goToShare here.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtTime = (s) => (Number(s) || 0).toFixed(1) + 's';
  // Playwright's own error text (from the JSON results, not the live process stream) can carry
  // raw terminal colour codes — strip before it ever reaches the DOM.
  const stripAnsi = (s) => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '');

  function toast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('is-show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('is-show'), 2600);
  }
  function showDemoBanner() {
    const n = $('runNotice');
    if (!n) return;
    n.textContent = 'Demo mode is read-only — you can’t start or stop a run here.';
    n.hidden = false;
  }
  const api = (path, opts) =>
    fetch(path, opts).then((r) => r.json()).then((j) => {
      if (j && j.demo) { toast('Demo mode — this is read-only. Clone the repo to run it for real.'); showDemoBanner(); }
      return j;
    });

  // ---------------------------------------------------------------------------------- state
  let envsCache = [];
  let credsCache = []; // env login-readiness, for the chip glyph
  let groupsCache = []; // saved site groups (named env presets)
  let rolesCache = [];
  let running = false;

  // Run-page environment selection is MULTI-select: pick one env (today's flow) or several to
  // run the same tests against all of them at once. Each selected env becomes a column in the
  // results matrix.
  let selectedEnvs = new Set();
  const runEnvList = () => [...selectedEnvs];
  let runRole = ''; // "Run as" override; '' = each test keeps its own role
  let roleByTitle = {}; // test title -> baked-in login role (for the checklist "runs as")

  // The live results model: title -> Map(env -> { status, time }). With one env this renders as
  // the familiar flat status-list; with several, as a test x env matrix table.
  let matrix = new Map();
  let matrixCols = []; // env column order for the current view
  function cellRow(title) {
    let row = matrix.get(title);
    if (!row) { row = new Map(); matrix.set(title, row); }
    return row;
  }
  const cleanTitle = (t) => String(t).replace(/\s*@[\w-]+/g, '').trim();
  // The pass/fail/running/waiting glyph carries the signal on its own — no colour.
  const statusMark = (status) => (status === 'passed' ? '✓' : status === 'failed' ? '✕' : status === 'running' ? '◐' : '○');
  // The login shown next to a checklist item: the "Run as" override if set, else the role baked
  // into that test. Blank for tests that don't log in.
  function roleLabel(title) {
    const r = runRole || roleByTitle[title];
    return r ? ` <span class="cat-intro">as ${esc(r)}${runRole ? ' (override)' : ''}</span>` : '';
  }
  // A failed row's "Report this" hands off to the frozen bug page — Report-a-bug is still the
  // frozen SPA until P5, so this never wires goToShare.
  function reportThis() {
    location.href = '/#bug';
  }

  // ------------------------------------------------------------------------------ dashboard
  function renderChecklist() {
    const card = $('resultsCard');
    if (!matrix.size) { card.hidden = true; return; }
    card.hidden = false;
    const cols = matrixCols.length ? matrixCols : [''];
    // Tally every cell (test x env) for the overall tiles, and per-env for the health line.
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
      `<div class="stat" data-tone="ok"><span class="stat__value">${pass}</span><span class="stat__label">Passed</span></div>` +
      `<div class="stat" data-tone="bad"><span class="stat__value">${fail}</span><span class="stat__label">Failed</span></div>` +
      `<div class="stat" data-tone="muted"><span class="stat__value">${pending}</span><span class="stat__label">Pending</span></div>` +
      `<div class="stat"><span class="stat__value">${total}</span><span class="stat__label">Total</span></div>`;
    $('healthBar').innerHTML =
      `<span class="meter__seg" data-tone="ok" style="--seg:${pct(pass)}%"></span>` +
      `<span class="meter__seg" data-tone="bad" style="--seg:${pct(fail)}%"></span>` +
      `<span class="meter__seg" data-tone="pending" style="--seg:${pct(pending)}%"></span>`;
    const done = pass + fail;
    $('healthCap').innerHTML =
      `<span><b>${done ? Math.round((pass / done) * 100) : 0}%</b> healthy</span><span>${pass}/${total} passing${fail ? ` · ${fail} failing` : ''}</span>`;
    // Per-env health line only when running against more than one environment.
    $('envHealth').innerHTML = cols.length > 1
      ? cols.map((e) => {
          const p = per.get(e); const d = p.pass + p.fail;
          return `<span class="gr-eh-item"><span class="gr-eh-name">${esc(e)}</span> <b>${d ? Math.round((p.pass / d) * 100) : 0}%</b> <span class="cat-intro">${p.pass}/${p.pass + p.fail + p.pending}</span></span>`;
        }).join('')
      : '';

    const mount = $('checklist');
    mount.innerHTML = '';
    if (cols.length > 1) {
      // Multi-env: a plain grain table (rows = tests, cols = envs, cells = the same monochrome
      // mark as the single-env status-list, wrapped in a badge for a consistent cell affordance).
      const scroll = document.createElement('div');
      scroll.className = 'table-scroll';
      const table = document.createElement('table');
      table.className = 'table';
      table.innerHTML =
        `<thead><tr><th>Test</th>${cols.map((e) => `<th>${esc(e)}</th>`).join('')}<th></th></tr></thead><tbody></tbody>`;
      const tbody = table.querySelector('tbody');
      for (const [title, row] of matrix) {
        const failed = cols.some((env) => (row.get(env) || {}).status === 'failed');
        const cells = cols.map((env) => {
          const s = row.get(env) || {};
          return `<td><span class="badge" title="${esc(env)}${s.time ? ' · ' + s.time : ''}">${statusMark(s.status)}</span></td>`;
        }).join('');
        const tr = document.createElement('tr');
        tr.innerHTML =
          `<td>${esc(cleanTitle(title))}${roleLabel(title)}</td>${cells}` +
          `<td>${failed ? `<button class="btn" data-size="sm" type="button" data-report="1">Report this</button>` : ''}</td>`;
        if (failed) tr.querySelector('[data-report]').onclick = reportThis;
        tbody.appendChild(tr);
      }
      scroll.appendChild(table);
      mount.appendChild(scroll);
    } else {
      const ul = document.createElement('ul');
      ul.className = 'status-list';
      const env = cols[0];
      for (const [title, row] of matrix) {
        const s = row.get(env) || {};
        const li = document.createElement('li');
        li.className = 'status-list__item';
        if (!s.status || s.status === 'waiting') li.dataset.state = 'waiting';
        if (s.status === 'running') li.dataset.commit = 'pending';
        li.innerHTML =
          `<span class="status-list__mark">${statusMark(s.status)}</span>` +
          `<span class="status-list__title">${esc(cleanTitle(title))}${roleLabel(title)}</span>` +
          `<span class="status-list__meta">${esc(s.time || '')}</span>` +
          (s.status === 'failed' ? `<button class="btn" data-size="sm" type="button" data-report="1">Report this</button>` : '');
        if (s.status === 'failed') li.querySelector('[data-report]').onclick = reportThis;
        ul.appendChild(li);
      }
      mount.appendChild(ul);
    }
  }
  // seed: array of titles to pre-list as "waiting"; null -> every test for the env.
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
  // Like seedChecklist, but never clears an existing cell — used to restore the correct total
  // (and roles) for a run already in progress (reconnect/refresh) without discarding any pass/
  // fail already parsed from the replayed buffer.
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
  // Parse a Playwright "list" reporter line into a matrix cell update. In a multi-env run each
  // line is prefixed with "[chromium (<env>)]" — keyed the cell by that env. Ported VERBATIM —
  // the regexes + matrixCols handling are load-bearing (the "chromium (<env>)" name format is a
  // documented contract, config/environments.ts + playwright.config.ts).
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

  // ---------------------------------------------------------------------------- run controls
  // Fill the "Run as" dropdown: a default ("each test's own role") plus every role that has a
  // login on ALL currently-selected environments (so an override can actually authenticate
  // everywhere the run targets).
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

  // Run-page test scope: the tests behind the "Tests" dropdown, so a Run can be limited to a
  // group or tag instead of everything. Ported VERBATIM.
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
  // Turn the current "Tests" dropdown choice into startRun scope (files/grep/seed). Groups are
  // sidecar metadata (not in the title, so not greppable) -> resolve to the specs + a grep of
  // their titles, like "Run selected". Tags live in the title -> a plain --grep does it.
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

  // ------------------------------------------------------------------------------- env picker
  // Run-page pills are a MULTI-select chip-group. Env login-readiness (from /api/creds) is
  // signalled with a filled/hollow glyph + tooltip — monochrome, never a green/amber dot.
  function renderRunEnvPills() {
    const wrap = $('runEnvPills');
    wrap.innerHTML = envsCache.length
      ? envsCache.map((env) => {
          const ready = credsCache.some((c) => c.env === env && c.usernameSet && c.passwordSet);
          const titleAttr = ready ? '' : ` title="No login set — add one in Settings"`;
          return `<label class="chips__chip"${titleAttr}><input type="checkbox" name="runEnv" value="${esc(env)}" ${selectedEnvs.has(env) ? 'checked' : ''}>` +
            `<span>${ready ? '●' : '○'} ${esc(env)}</span></label>`;
        }).join('')
      : '<p class="cat-intro">No environments configured yet — add one in Settings.</p>';
    const n = selectedEnvs.size;
    const btn = $('runBtn');
    if (btn && !running) btn.textContent = n > 1 ? `Run on ${n} sites` : 'Run tests';
    const hint = $('runEnvHint');
    if (hint) hint.textContent = n > 1 ? `Same tests will run against all ${n} selected sites at once.` : 'Tip: pick more than one site to run everywhere at once.';
    populateRunRoles(); // available override roles depend on which envs are selected
    renderGroupChips(); // reflect whether the current selection matches a saved group
  }

  // One-click actions for saved site groups: selecting a group ticks its envs (and applies its
  // pinned role, if any). These are ACTIONS, not a form control, so plain buttons with
  // aria-pressed for "matches current selection" — not a chip-group. Hidden when no group is
  // usable (has at least one env).
  function renderGroupChips() {
    const c = $('groupChips');
    if (!c) return;
    const usable = groupsCache.filter((g) => (g.envs || []).length);
    if (!usable.length) { c.hidden = true; c.innerHTML = ''; return; }
    c.hidden = false;
    c.innerHTML = usable.map((g) => {
      const active = g.envs.length === selectedEnvs.size && g.envs.every((e) => selectedEnvs.has(e));
      const titleAttr = g.role ? ` title="Runs as ${esc(g.role)}"` : '';
      return `<button class="btn" data-size="sm" type="button" aria-pressed="${active}" data-group="${esc(g.name)}"${titleAttr}>${esc(g.label || g.name)}</button>`;
    }).join('');
    c.querySelectorAll('[data-group]').forEach((b) => {
      b.onclick = () => applyGroup(usable.find((g) => g.name === b.dataset.group));
    });
  }
  function applyGroup(g) {
    if (!g) return;
    const valid = g.envs.filter((e) => envsCache.includes(e));
    if (!valid.length) return toast('This group has no valid sites — edit it in Settings.');
    selectedEnvs = new Set(valid);
    runRole = g.role || '';
    renderRunEnvPills(); // also re-renders the group chips + role dropdown
    const sel = $('runRole');
    if (sel && runRole) sel.value = runRole; // honored if that role is usable on all envs
  }

  // ------------------------------------------------------------------------------ run status
  // The monochrome status readout — text only, no hue'd pill/dot. While running it wears
  // data-commit="pending" (the shared grain control-lifecycle idiom) for the dashed edge.
  function setStatus(status, env) {
    running = status === 'running';
    const el = $('runStatus');
    el.textContent = { idle: 'Ready', running: 'Running ' + (env || '') + '…', passed: 'All passed', failed: 'Some failed', stopped: 'Stopped' }[status] || 'Ready';
    if (running) el.setAttribute('data-commit', 'pending');
    else el.removeAttribute('data-commit');
    $('runBtn').disabled = running;
    const stopBtn = $('stopBtn');
    stopBtn.disabled = !running;
    if (!running) stopBtn.textContent = 'Stop'; // revert any "Stopping…" label once the run has actually ended
  }

  // Fold the authoritative per-(test, env) results back into the matrix once a run finishes
  // (the live list parse can miss lines under load).
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

  // -------------------------------------------------------------------------------- load/wire
  function init() {
    $('runEnvPills').addEventListener('change', (e) => {
      if (e.target.name !== 'runEnv') return;
      const checked = [...document.querySelectorAll('#runEnvPills input[name="runEnv"]:checked')].map((c) => c.value);
      if (!checked.length) { e.target.checked = true; return; } // a run needs at least one target
      selectedEnvs = new Set(checked);
      renderRunEnvPills();
    });
    $('runRole').addEventListener('change', (e) => { runRole = e.target.value; renderChecklist(); });
    $('runBtn').addEventListener('click', () => startRun(resolveRunScope()));
    $('stopBtn').addEventListener('click', () => {
      // Immediate feedback — otherwise the button gives no sign anything happened until the
      // process actually dies and the `done` event lands.
      const btn = $('stopBtn');
      btn.disabled = true;
      btn.textContent = 'Stopping…';
      fetch('/api/stop', { method: 'POST' });
    });
    $('reportBtn').addEventListener('click', () => window.open('/report/', '_blank'));

    (async () => {
      credsCache = await api('/api/creds').catch(() => []);
      const s = await api('/api/state').catch(() => ({ envs: [] }));
      if (s && s.demo) showDemoBanner();
      envsCache = s.envs || [];
      groupsCache = await api('/api/groups').catch(() => []); // for the saved-group action row
      const initialEnv = s.env && envsCache.includes(s.env) ? s.env : envsCache[0];
      selectedEnvs = new Set([initialEnv].filter(Boolean));
      renderRunEnvPills();
      setStatus(s.status, s.env);
      $('reportBtn').disabled = !s.reportExists;
      populateRunScope();
      showLastRun();

      // live stream — the server sends one `state` event right when the connection opens (both
      // on first load and on every auto-reconnect), then replays every buffered output line as
      // its own `line` event; there is no client-side replay to add on top.
      const streamEvents = new EventSource('/api/stream');
      streamEvents.addEventListener('state', (e) => {
        const st = JSON.parse(e.data);
        $('output').textContent = '';
        setStatus(st.status, st.env);
        $('reportBtn').disabled = !st.reportExists;
        if (st.status === 'running') {
          matrix = new Map(); // synchronous — before any buffered `line` events are processed
          matrixCols = (st.runEnvs && st.runEnvs.length) ? st.runEnvs : runEnvList();
          selectedEnvs = new Set(matrixCols);
          renderRunEnvPills();
          fillChecklistTotals(matrixCols[0]); // async: adds placeholders for tests not yet reported
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
        populateRunScope(); // a recording may have added a new test/group/tag
      });
    })();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
