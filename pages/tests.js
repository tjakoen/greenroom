'use strict';
// pages/tests.js — the thin client module behind /tests (P3). Plain, dependency-free browser
// JS (no bundler, no TS) served as-is by server.ts, same pattern as pages/settings.js (P2) and
// interface/app.js's own /app.js route. Talks to the SAME /api/{tests,recorded-inputs,
// apply-inputs,test-tags,test-meta,tests/rename,roles,record,state} endpoints interface/app.js
// uses (~405-675, ~1476-1495), with the SAME request bodies (byte-compat is the P3 gate) — this
// file only changes how the results are RENDERED (grain markup, incl. the new chip-group +
// b-select components, instead of the old SPA's bespoke pill/select classes).
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cssEsc = (s) => String(s).replace(/["\\]/g, '\\$&');
  const fmtTime = (s) => (Number(s) || 0).toFixed(1) + 's';

  // Any write refused by demo mode comes back as { demo:true } — surface it once here (a toast,
  // same as the old UI) AND flip on the persistent banner, so every caller gets the friendly
  // read-only message without special-casing.
  function toast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('is-show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('is-show'), 2600);
  }
  function showDemoBanner() {
    const n = $('testsNotice');
    if (!n) return;
    n.textContent = 'Demo mode is read-only — tags, metadata, rename/delete and recording can’t be changed here.';
    n.hidden = false;
  }
  const api = (path, opts) =>
    fetch(path, opts).then((r) => r.json()).then((j) => {
      if (j && j.demo) { toast('Demo mode — this is read-only. Clone the repo to run it for real.'); showDemoBanner(); }
      return j;
    });

  // ---------------------------------------------------------------------------------- state
  let testsPayload = { tests: [], tags: [], groups: [] };
  let envsCache = [];
  let testsEnv = '';
  let activeTags = new Set();
  let activeSmart = 'all';
  let testSearchQ = '';
  let selectedKeys = new Set(); // `${file}::${title}`
  let collapsedGroups = new Set();

  const SMART = [
    { key: 'all', label: 'All' },
    { key: 'failing', label: 'Failing' },
    { key: 'never', label: 'Never run' },
    { key: 'flaky', label: 'Flaky' },
    { key: 'slowest', label: 'Slowest' },
  ];
  const INPUT_GENS = [
    { key: 'keep', label: 'Keep as recorded' },
    { key: 'email', label: 'Unique email' },
    { key: 'name', label: 'Random name' },
    { key: 'text', label: 'Random text' },
    { key: 'id', label: 'Unique id' },
    { key: 'phone', label: 'Random phone' },
    { key: 'password', label: 'Random password' },
  ];
  const tkey = (t) => `${t.file}::${t.title}`;

  // -------------------------------------------------------------------------- env + filters
  async function loadEnvs() {
    const s = await api('/api/state').catch(() => ({ envs: [] }));
    envsCache = (s && s.envs) || [];
    if (!testsEnv || !envsCache.includes(testsEnv)) testsEnv = envsCache[0] || '';
  }
  function renderEnvPills() {
    const wrap = $('testsEnvPills');
    wrap.innerHTML = envsCache.length
      ? envsCache.map((e) =>
          `<label class="chips__chip"><input type="radio" name="testsEnv" value="${esc(e)}" ${e === testsEnv ? 'checked' : ''}><span>${esc(e)}</span></label>`
        ).join('')
      : '<p class="cat-intro">No environments configured yet — add one in Settings.</p>';
  }
  function renderSmartFilters() {
    $('smartFilters').innerHTML = SMART.map((s) =>
      `<label class="chips__chip"><input type="radio" name="smart" value="${s.key}" ${activeSmart === s.key ? 'checked' : ''}><span>${esc(s.label)}</span></label>`
    ).join('');
  }
  function renderTagFilters() {
    const bar = $('tagFilters');
    bar.innerHTML = testsPayload.tags.length
      ? testsPayload.tags.map((t) =>
          `<label class="chips__chip"><input type="checkbox" name="tag" value="${esc(t)}" ${activeTags.has(t) ? 'checked' : ''}><span>${esc(t)}</span></label>`
        ).join('')
      : '<p class="cat-intro">No @tags yet — add e.g. <code>@smoke</code> to a test title to filter and run by tag.</p>';
    updateRunTag();
  }
  function updateRunTag() {
    const btn = $('runTagBtn');
    btn.disabled = activeTags.size === 0;
    btn.textContent = activeTags.size ? `Run ${[...activeTags].join(', ')}` : 'Run by tag';
  }

  // Filter semantics copied verbatim from interface/app.js filteredTests/groupName.
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
    return t.file.replace(/^tests\//, '');
  }

  // ------------------------------------------------------------------------------ groups/rows
  function renderTestGroups() {
    const tests = filteredTests();
    $('testsEmpty').hidden = tests.length > 0;
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
      head.className = 'gr-group-head' + (collapsed ? ' is-collapsed' : '');
      head.innerHTML =
        `<span class="gr-caret">▾</span><span class="gr-gname">${esc(gname)}</span><span class="gr-gcount">${items.length}</span>` +
        `<span class="gr-gstat">${pass ? `<span class="badge" data-status="active">${pass} passed</span>` : ''}${fail ? `<span class="badge">${fail} failed</span>` : ''}</span>`;
      head.onclick = () => { collapsed ? collapsedGroups.delete(gname) : collapsedGroups.add(gname); renderTestGroups(); };
      wrap.appendChild(head);
      if (collapsed) continue;
      const ul = document.createElement('ul');
      ul.className = 'gr-rows';
      for (const t of items) ul.appendChild(testRow(t));
      wrap.appendChild(ul);
    }
    updateRunSelected();
  }
  function testRow(t) {
    const k = tkey(t);
    const li = document.createElement('li');
    li.className = 'gr-row';
    const statusBadge = t.status === 'passed'
      ? '<span class="badge" data-status="active">passed</span>'
      : `<span class="badge">${esc(t.status || 'not run')}</span>`;
    const tagBadges = t.tags.map((tag) => `<span class="badge">${esc(tag)}</span>`).join('');
    const flakyBadge = t.flaky ? '<span class="badge">flaky</span>' : '';
    const prioBadge = t.priority ? `<span class="badge">${esc(t.priority)}</span>` : '';
    // No `scope` field on TestEntry — the old row's t.scope was effectively empty; omitted.
    const sub = [
      t.role ? 'runs as: ' + esc(t.role) : '',
      t.owner ? '👤 ' + esc(t.owner) : '',
      t.runCount ? `${t.runCount} run${t.runCount === 1 ? '' : 's'}` : '',
      t.durationMs ? fmtTime(t.durationMs / 1000) : '',
    ].filter(Boolean).join(' · ');
    li.innerHTML =
      `<input type="checkbox" class="gr-row-sel" data-key="${esc(k)}" ${selectedKeys.has(k) ? 'checked' : ''}>` +
      `<div class="gr-row-main"><div class="gr-row-title">${esc(t.cleanTitle)}</div>` +
      (tagBadges || flakyBadge ? `<div class="gr-row-tags">${tagBadges}${flakyBadge}</div>` : '') +
      (sub ? `<div class="gr-row-sub">${sub}</div>` : '') +
      `</div>${prioBadge}${statusBadge}` +
      `<div class="gr-row-actions">` +
      `<button class="btn" data-size="sm" data-run="${esc(k)}">Run</button>` +
      `<button class="btn" data-size="sm" data-inputs="${esc(t.file)}" title="Make inputs dynamic">⌗</button>` +
      `<button class="btn" data-size="sm" data-edit="${esc(k)}" title="Tag / priority / owner">🏷</button>` +
      `<button class="btn" data-size="sm" data-rename="${esc(t.file)}" title="Rename file">✎</button>` +
      `<button class="btn" data-size="sm" data-status="danger" data-del="${esc(t.file)}" title="Delete file">🗑</button>` +
      `</div>`;
    li.querySelector('.gr-row-sel').onchange = (e) => { e.target.checked ? selectedKeys.add(k) : selectedKeys.delete(k); updateRunSelected(); };
    li.querySelector('[data-run]').onclick = () => runOne(t);
    li.querySelector('[data-inputs]').onclick = () => toggleInputsEdit(li, t);
    li.querySelector('[data-edit]').onclick = () => toggleMetaEdit(li, t);
    li.querySelector('[data-rename]').onclick = () => renameTest(t.file);
    li.querySelector('[data-del]').onclick = () => deleteTest(t.file);
    return li;
  }

  // ---------------------------------------------------------- Make inputs dynamic (⌗ panel)
  async function toggleInputsEdit(li, t) {
    const existing = li.nextElementSibling;
    if (existing && existing.classList.contains('gr-panel')) { existing.remove(); return; }
    const data = await api('/api/recorded-inputs?file=' + encodeURIComponent(t.file)).catch(() => null);
    const panel = document.createElement('div');
    panel.className = 'gr-panel';
    if (!data || !data.ok || !data.inputs.length) {
      panel.innerHTML =
        '<p class="cat-intro">No filled inputs found in this test — nothing to make dynamic.</p>' +
        '<div class="gr-panel-actions"><button class="btn" data-size="sm" id="i-cancel">Close</button></div>';
      li.after(panel);
      panel.querySelector('#i-cancel').onclick = () => panel.remove();
      return;
    }
    const guess = (v) => (/@/.test(v) ? 'email' : /^\+?[\d ()-]{7,}$/.test(v) ? 'phone' : 'keep');
    const rows = data.inputs.map((inp) =>
      `<div class="gr-input-row">` +
      `<div class="gr-input-label"><span class="gr-card-meta">${esc(inp.label)}</span><span class="cat-intro">${esc(String(inp.value).slice(0, 40)) || '(empty)'}</span></div>` +
      `<label class="field" data-size="sm"><span class="field__label">Generator</span>` +
      `<select class="field__select" data-imline="${inp.line}">` +
      INPUT_GENS.map((g) => `<option value="${g.key}" ${guess(inp.value) === g.key ? 'selected' : ''}>${g.label}</option>`).join('') +
      `</select></label></div>`
    ).join('');
    panel.innerHTML =
      '<p class="cat-intro">Pick a generator for any field that must change each run (e.g. a signup email). "Keep as recorded" leaves it alone.</p>' +
      rows +
      '<div class="gr-panel-actions"><button class="btn" data-size="sm" id="i-cancel">Cancel</button><button class="btn" data-size="sm" id="i-apply">Apply</button></div>';
    li.after(panel);
    panel.querySelector('#i-cancel').onclick = () => panel.remove();
    panel.querySelector('#i-apply').onclick = async () => {
      const mappings = [...panel.querySelectorAll('[data-imline]')]
        .map((s) => ({ line: Number(s.dataset.imline), generator: s.value }))
        .filter((m) => m.generator !== 'keep');
      if (!mappings.length) return toast('Nothing to change — pick a generator first.');
      const r = await api('/api/apply-inputs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: t.file, mappings }) });
      if (!r.ok) return toast(r.error || 'Could not update inputs.');
      toast(`Updated ${r.changed} input${r.changed === 1 ? '' : 's'} to generate fresh data each run.`);
      panel.remove();
    };
  }

  // ---------------------------------------------------------- Tag / priority / owner (🏷 panel)
  function toggleMetaEdit(li, t) {
    const existing = li.nextElementSibling;
    if (existing && existing.classList.contains('gr-panel')) { existing.remove(); return; }
    const panel = document.createElement('div');
    panel.className = 'gr-panel';
    panel.innerHTML =
      `<div class="gr-form-row">` +
      `<label class="field" data-size="sm"><span class="field__label">Group</span><input class="field__input" id="m-group" value="${esc(t.group)}" placeholder="e.g. Auth"></label>` +
      `<label class="field" data-size="sm"><span class="field__label">Priority</span><select class="field__select" id="m-prio"><option value="">—</option>${['P1', 'P2', 'P3'].map((p) => `<option ${t.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>` +
      `<label class="field" data-size="sm"><span class="field__label">Owner</span><input class="field__input" id="m-owner" value="${esc(t.owner)}" placeholder="name"></label>` +
      `</div>` +
      `<label class="field"><span class="field__label">Tags</span><input class="field__input" id="m-tags" value="${esc((t.tags || []).join(' '))}" placeholder="@smoke @login"><span class="gr-card-meta">Space-separated. Live in the title; used by Run by tag.</span></label>` +
      `<label class="field"><span class="field__label">Notes</span><input class="field__input" id="m-notes" value="${esc(t.notes)}" placeholder="e.g. flaky on demo, needs data reset"></label>` +
      `<div class="gr-panel-actions"><button class="btn" data-size="sm" id="m-cancel">Cancel</button><button class="btn" data-size="sm" id="m-save">Save</button></div>`;
    li.after(panel);
    panel.querySelector('#m-cancel').onclick = () => panel.remove();
    panel.querySelector('#m-save').onclick = async () => {
      // Tags first — this can rewrite the test title in the file, so meta must be keyed to the
      // NEW title it returns.
      const tags = panel.querySelector('#m-tags').value.split(/[\s,]+/).filter(Boolean);
      const tr = await api('/api/test-tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: t.file, title: t.title, tags }) });
      if (!tr.ok) return toast(tr.error || 'Could not save tags.');
      const title = tr.title || t.title;
      const body = { file: t.file, title, group: panel.querySelector('#m-group').value, priority: panel.querySelector('#m-prio').value, owner: panel.querySelector('#m-owner').value, notes: panel.querySelector('#m-notes').value };
      const r = await api('/api/test-meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) return toast(r.error || 'Could not save.');
      toast('Saved'); await loadTests();
    };
  }

  // --------------------------------------------------------------------------------- bulk bar
  function updateRunSelected() {
    const n = selectedKeys.size;
    const runBtn = $('runSelectedBtn');
    runBtn.disabled = n === 0;
    runBtn.textContent = n ? `Run selected (${n})` : 'Run selected';
    // Delete acts on whole files; count the distinct files behind the selection.
    const delBtn = $('deleteSelectedBtn');
    const files = new Set(testsPayload.tests.filter((t) => selectedKeys.has(tkey(t))).map((t) => t.file));
    delBtn.disabled = files.size === 0;
    delBtn.textContent = files.size ? `Delete selected (${files.size})` : 'Delete selected';
    const selAll = $('selectAllBtn');
    const shown = filteredTests();
    const allOn = shown.length > 0 && shown.every((t) => selectedKeys.has(tkey(t)));
    selAll.textContent = allOn ? 'Clear all' : 'Select all';
  }
  // Toggle every currently-shown (filtered) test in/out of the selection.
  function toggleSelectAll() {
    const shown = filteredTests();
    const allOn = shown.length > 0 && shown.every((t) => selectedKeys.has(tkey(t)));
    for (const t of shown) allOn ? selectedKeys.delete(tkey(t)) : selectedKeys.add(tkey(t));
    renderTestGroups();
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

  // ------------------------------------------------------------------------------ Run handoff
  // The Run page is still the frozen SPA (P4 migrates it) — its SSE/run wiring lives in
  // interface/app.js, which this port must not touch. Teaching it to read a pre-picked scope
  // back out (env/files/grep) would mean editing that frozen file, which is off-limits for a
  // frontend-only P3 port. So the honest, simple seam: hand off to the frozen Run page and let
  // the user pick env + scope there — it already has its own env pills and a Tests-scope
  // dropdown for exactly this. No scope is stashed in sessionStorage since nothing on the other
  // side would read it back; that would be silent, misleading plumbing.
  function goRun() {
    location.href = '/#run';
  }
  async function runOne(_t) { goRun(); }
  async function runSelected() { if (!selectedKeys.size) return; goRun(); }
  async function runByTag() { if (!activeTags.size) return; goRun(); }

  // ------------------------------------------------------------------------- rename / delete
  async function renameTest(file) {
    const name = prompt('New file name (letters, numbers, dashes):');
    if (!name) return;
    const r = await api('/api/tests/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, name }) });
    if (!r.ok) return toast(r.error || 'Could not rename.');
    toast('Renamed'); loadTests();
  }
  async function deleteTest(file) {
    if (!confirm('Delete this test file? This cannot be undone.')) return;
    const r = await api('/api/tests?file=' + encodeURIComponent(file), { method: 'DELETE' });
    if (!r.ok) return toast(r.error || 'Could not delete.');
    toast('Deleted'); loadTests();
  }

  // --------------------------------------------------------------------------- record launcher
  // Fill the "Log in as" dropdown with the roles mapped to the Tests page's current env. Roles
  // missing a login for that env are shown but flagged, nudging the user to add it in Settings.
  async function populateRecordRoles() {
    const sel = $('recordRole');
    if (!sel) return;
    const roles = await api('/api/roles').catch(() => []);
    const forEnv = (roles || []).filter((r) => (r.sites || []).some((s) => s.env === testsEnv));
    const opts = ['<option value="">No login (public pages)</option>'];
    for (const r of forEnv) {
      const site = (r.sites || []).find((s) => s.env === testsEnv);
      const ready = site && site.usernameSet && site.passwordSet;
      opts.push(`<option value="${esc(r.name)}">${esc(r.label || r.name)}${ready ? '' : ' — no login set'}</option>`);
    }
    sel.innerHTML = opts.join('');
  }
  async function recordTest(name) {
    const sel = $('recordRole');
    const role = sel ? sel.value : '';
    const r = await api('/api/record', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ env: testsEnv, name, role: role || undefined }) });
    if (!r.ok) return toast(r.error || 'Could not start recording.');
    $('recordName').value = '';
    toast(role ? `Recorder opening — login as "${role}" will be added automatically.` : 'Recorder opening — click through the site, then close the browser.');
  }

  // -------------------------------------------------------------------------------- load/wire
  async function loadTests() {
    await loadEnvs();
    renderEnvPills();
    await populateRecordRoles();
    testsPayload = await api('/api/tests?env=' + encodeURIComponent(testsEnv)).catch(() => ({ tests: [], tags: [], groups: [] }));
    renderSmartFilters();
    renderTagFilters();
    renderTestGroups();
  }

  function init() {
    // Env change reloads the list AND the record role picker, and clears the selection.
    $('testsEnvPills').addEventListener('change', (e) => {
      if (e.target.name !== 'testsEnv') return;
      testsEnv = e.target.value;
      selectedKeys.clear();
      loadTests();
    });
    $('smartFilters').addEventListener('change', (e) => {
      if (e.target.name !== 'smart') return;
      activeSmart = e.target.value;
      renderTestGroups();
    });
    // Chip-group selection state is CSS-driven (:has(:checked)) — read the checked boxes back
    // as the source of truth rather than toggling a Set by hand.
    $('tagFilters').addEventListener('change', (e) => {
      if (e.target.name !== 'tag') return;
      activeTags = new Set([...document.querySelectorAll('#tagFilters input[name="tag"]:checked')].map((c) => c.value));
      updateRunTag();
      renderTestGroups();
    });
    $('testSearch').addEventListener('input', (e) => { testSearchQ = e.target.value; renderTestGroups(); });
    $('runTagBtn').addEventListener('click', runByTag);
    $('selectAllBtn').addEventListener('click', toggleSelectAll);
    $('runSelectedBtn').addEventListener('click', runSelected);
    $('deleteSelectedBtn').addEventListener('click', deleteSelected);
    $('recordForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('recordName').value.trim();
      if (!name) return toast('Enter a test name.');
      recordTest(name);
    });

    api('/api/state').then((s) => { if (s && s.demo) showDemoBanner(); }).catch(() => {});
    loadTests();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
