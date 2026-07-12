'use strict';
// pages/settings.js — the thin client module behind /settings (P2). Plain, dependency-free
// browser JS (no bundler, no TS) served as-is by server.ts, same pattern as interface/app.js's
// own /app.js route. Talks to the SAME /api/{envs,roles,creds,groups} endpoints interface/app.js
// uses, with the SAME request bodies (byte-compat is the P2 gate) — this file only changes how
// the results are RENDERED (grain markup instead of the old SPA's bespoke classes).
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cssEsc = (s) => String(s).replace(/["\\]/g, '\\$&');

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
    const n = $('settingsNotice');
    if (!n) return;
    n.textContent = 'Demo mode is read-only — environments, roles, and groups can’t be changed here.';
    n.hidden = false;
  }
  const api = (path, opts) =>
    fetch(path, opts).then((r) => r.json()).then((j) => {
      if (j && j.demo) { toast('Demo mode — this is read-only. Clone the repo to run it for real.'); showDemoBanner(); }
      return j;
    });

  let allEnvNames = [];
  let sharedLoginCache = {};

  // ---------------------------------------------------------------- login-form fields (4 each)
  const LOGIN_FORM_FIELDS = [
    { key: 'path', label: 'Login path', ph: '/login' },
    { key: 'username', label: 'Username field', ph: '#email' },
    { key: 'password', label: 'Password field', ph: '#password' },
    { key: 'submit', label: 'Submit button text', ph: 'Sign in' },
  ];
  function loginFieldsHtml(scope, values = {}, inherited = {}) {
    return `<div class="gr-login-fields">` + LOGIN_FORM_FIELDS.map((f) => {
      const ph = (inherited[f.key] && String(inherited[f.key])) || f.ph;
      return `<label class="field" data-size="sm"><span class="field__label">${esc(f.label)}</span>` +
        `<input class="field__input" data-lf="${esc(scope)}|${f.key}" value="${esc(values[f.key] || '')}" placeholder="${esc(ph)}"></label>`;
    }).join('') + `</div>`;
  }
  function readLoginFields(scope) {
    const out = {};
    for (const f of LOGIN_FORM_FIELDS) {
      const el = document.querySelector(`[data-lf="${cssEsc(scope)}|${f.key}"]`);
      if (el && el.value.trim()) out[f.key] = el.value.trim();
    }
    return out;
  }

  // ---------------------------------------------------------------------------- Environments
  async function loadEnvs() {
    const resp = await api('/api/envs').catch(() => ({ envs: [], sharedLogin: {} }));
    const envs = (resp && resp.envs) || [];
    sharedLoginCache = (resp && resp.sharedLogin) || {};
    allEnvNames = envs.map((e) => e.name);

    const wrap = $('envList');
    wrap.innerHTML = envs.length ? envs.map((e) => {
      const hasOwn = e.login && Object.keys(e.login).length;
      return `<div class="card" data-pad="sm">
        <div class="gr-card-head"><span class="rname mono">${esc(e.name)}</span>
          <button class="btn" data-size="sm" data-status="danger" data-envdel="${esc(e.name)}">Delete</button></div>
        <label class="field" data-size="sm"><span class="field__label">URL</span>
          <input class="field__input" data-envurl="${esc(e.name)}" value="${esc(e.baseURL)}"></label>
        <button class="btn" data-size="sm" data-envsave="${esc(e.name)}" style="margin-top:var(--space-2)">Save</button>
        <details class="gr-details">
          <summary>Login form ${hasOwn ? '<span class="badge" data-status="active">custom</span>' : '<span class="gr-card-meta">(inherits shared)</span>'}</summary>
          <p class="cat-intro">Leave blank to use the shared login form above.</p>
          ${loginFieldsHtml('env:' + e.name, e.login || {}, sharedLoginCache)}
        </details>
      </div>`;
    }).join('') : '<p class="cat-intro">No environments yet. Add one below.</p>';

    wrap.querySelectorAll('[data-envsave]').forEach((b) => (b.onclick = () => {
      const name = b.dataset.envsave;
      const url = document.querySelector(`[data-envurl="${cssEsc(name)}"]`).value;
      saveEnv(name, url, readLoginFields('env:' + name));
    }));
    wrap.querySelectorAll('[data-envdel]').forEach((b) => (b.onclick = () => {
      const name = b.dataset.envdel;
      if (confirm(`Remove environment "${name}"?`)) removeEnv(name);
    }));

    const sharedWrap = $('sharedLoginFields');
    if (sharedWrap) sharedWrap.innerHTML = loginFieldsHtml('shared', sharedLoginCache, {});
  }
  async function saveEnv(name, baseURL, login) {
    const body = { name, baseURL };
    if (login !== undefined) body.login = login; // {} clears the env's own override
    const r = await api('/api/envs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return toast(r.error || 'Could not save.');
    toast('Saved'); await refreshAll();
  }
  async function saveSharedLoginForm() {
    const login = readLoginFields('shared');
    const r = await api('/api/envs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shared: true, login }) });
    if (!r.ok) return toast(r.error || 'Could not save.');
    toast('Login form saved'); await refreshAll();
  }
  async function removeEnv(name) {
    const r = await api('/api/envs?name=' + encodeURIComponent(name), { method: 'DELETE' });
    if (!r.ok) return toast(r.error || 'Could not remove.');
    toast('Removed'); await refreshAll();
  }
  async function addEnv(name, baseURL) {
    const r = await api('/api/envs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, baseURL }) });
    if (!r.ok) return toast(r.error || 'Could not add environment.');
    toast('Environment added'); await refreshAll();
  }

  // --------------------------------------------------------------------------- Roles & logins
  async function loadRoles() {
    const [roles, envsResp] = await Promise.all([
      api('/api/roles').catch(() => []),
      api('/api/envs').catch(() => ({ envs: [] })),
    ]);
    allEnvNames = ((envsResp && envsResp.envs) || []).map((e) => e.name);

    const wrap = $('rolesList');
    if (!roles.length) {
      wrap.innerHTML = '<p class="cat-intro">No roles yet. Add one below (e.g. admin), pick its sites, then fill in each login.</p>';
      return;
    }
    wrap.innerHTML = roles.map((r) => {
      const isAll = r.envs === 'all';
      const mapped = new Set(isAll ? allEnvNames : r.envs);
      const sites = allEnvNames.map((env) => {
        const on = mapped.has(env);
        return `<label><input type="checkbox" data-rolesite="${esc(r.name)}|${esc(env)}" ${on ? 'checked' : ''}${isAll ? ' disabled' : ''}> ${esc(env)}</label>`;
      }).join('');
      const loginRows = (r.sites || []).map((s) => {
        const set = s.usernameSet && s.passwordSet;
        return `<div class="gr-login-row">
          <div class="gr-env-name">${esc(s.env)}</div>
          <label class="field" data-size="sm"><input class="field__input" placeholder="username" value="${esc(s.username || '')}" data-cu="${esc(r.name)}|${esc(s.env)}"></label>
          <label class="field" data-size="sm"><input class="field__input" type="password" placeholder="${set ? '•••••• (saved)' : 'password'}" data-cp="${esc(r.name)}|${esc(s.env)}"></label>
          <button class="btn" data-size="sm" data-csave="${esc(r.name)}|${esc(s.env)}">Save</button>
          <span class="badge" data-status="${set ? 'active' : ''}">${set ? 'saved' : 'missing'}</span>
        </div>`;
      }).join('');
      return `<div class="card" data-pad="sm">
        <div class="gr-card-head"><span class="rname">${esc(r.label || r.name)}</span> <span class="gr-card-meta">${esc(r.name)}</span>
          <button class="btn" data-size="sm" data-status="danger" data-roledel="${esc(r.name)}">Delete</button></div>
        <div class="gr-check-row"><label><input type="checkbox" data-roleall="${esc(r.name)}" ${isAll ? 'checked' : ''}> All sites</label>${sites}</div>
        <div>${loginRows || '<p class="cat-intro">Tick a site above to add its login.</p>'}</div>
      </div>`;
    }).join('');

    wrap.querySelectorAll('[data-csave]').forEach((b) => (b.onclick = () => saveCred(b.dataset.csave)));
    wrap.querySelectorAll('[data-roledel]').forEach((b) => (b.onclick = () => removeRole(b.dataset.roledel)));
    wrap.querySelectorAll('[data-roleall]').forEach((c) => (c.onchange = () => setRoleEnvs(c.dataset.roleall, c.checked ? 'all' : collectSites(c.dataset.roleall))));
    wrap.querySelectorAll('[data-rolesite]').forEach((c) => (c.onchange = () => setRoleEnvs(c.dataset.rolesite.split('|')[0], collectSites(c.dataset.rolesite.split('|')[0]))));
  }
  function collectSites(role) {
    return [...document.querySelectorAll(`[data-rolesite^="${cssEsc(role)}|"]`)].filter((c) => c.checked).map((c) => c.dataset.rolesite.split('|')[1]);
  }
  async function setRoleEnvs(name, envs) {
    const r = await api('/api/roles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, envs }) });
    if (!r.ok) return toast(r.error || 'Could not update role.');
    loadRoles();
  }
  async function addRole(name, label) {
    const r = await api('/api/roles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, label, envs: 'all' }) });
    if (!r.ok) return toast(r.error || 'Could not add role.');
    toast('Role added'); loadRoles();
  }
  async function removeRole(name) {
    if (!confirm(`Delete role "${name}"? Its saved logins in .env are left untouched.`)) return;
    const r = await api('/api/roles?name=' + encodeURIComponent(name), { method: 'DELETE' });
    if (!r.ok) return toast(r.error || 'Could not delete role.');
    toast('Role deleted'); loadRoles();
  }
  async function saveCred(key) {
    const [role, env] = key.split('|');
    const username = document.querySelector(`[data-cu="${cssEsc(key)}"]`).value;
    const password = document.querySelector(`[data-cp="${cssEsc(key)}"]`).value;
    if (!username && !password) return toast('Enter a username and/or password.');
    const r = await api('/api/creds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ env, role, username, password }) });
    if (!r.ok) return toast(r.error || 'Could not save login.');
    toast('Login saved'); loadRoles();
  }

  // ---------------------------------------------------------------------------- Site groups
  async function loadGroups() {
    const [groups, roles] = await Promise.all([
      api('/api/groups').catch(() => []),
      api('/api/roles').catch(() => []),
    ]);
    const wrap = $('groupsList');
    wrap.innerHTML = groups.length ? groups.map((g) =>
      `<div class="card" data-pad="sm">
        <div class="gr-card-head"><span class="rname">${esc(g.label || g.name)}</span>
          <button class="btn" data-size="sm" data-status="danger" data-groupdel="${esc(g.name)}">Delete</button></div>
        <p class="gr-card-meta">${esc(g.envs.join(', ')) || 'no sites'}${g.role ? ' · as ' + esc(g.role) : ''}${g.missing ? ' · some sites removed' : ''}</p>
      </div>`
    ).join('') : '<p class="cat-intro">No groups yet. Create one below to run several sites in one click.</p>';
    wrap.querySelectorAll('[data-groupdel]').forEach((b) => (b.onclick = () => removeGroup(b.dataset.groupdel)));

    const envWrap = $('newGroupEnvs');
    if (envWrap) envWrap.innerHTML = allEnvNames.map((e) => `<label><input type="checkbox" data-groupenv="${esc(e)}"> ${esc(e)}</label>`).join('');
    const roleSel = $('newGroupRole');
    if (roleSel) roleSel.innerHTML = `<option value="">Each test's own role</option>` + roles.map((r) => `<option value="${esc(r.name)}">${esc(r.label || r.name)}</option>`).join('');
  }
  async function addGroup(name, role) {
    const envs = [...document.querySelectorAll('[data-groupenv]')].filter((c) => c.checked).map((c) => c.dataset.groupenv);
    if (!envs.length) return toast('Tick at least one site for the group.');
    const r = await api('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, envs, role }) });
    if (!r.ok) return toast(r.error || 'Could not save group.');
    toast('Group saved'); loadGroups();
  }
  async function removeGroup(name) {
    if (!confirm(`Delete group "${name}"? (Sites and logins are untouched.)`)) return;
    const r = await api('/api/groups?name=' + encodeURIComponent(name), { method: 'DELETE' });
    if (!r.ok) return toast(r.error || 'Could not delete group.');
    toast('Group deleted'); loadGroups();
  }

  // -------------------------------------------------------------------------------- wiring
  async function refreshAll() {
    await loadRoles();
    await loadEnvs();
    await loadGroups();
  }

  function init() {
    $('addEnvForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('newEnvName').value.trim();
      const baseURL = $('newEnvUrl').value.trim();
      if (!name || !baseURL) return toast('Enter a name and a URL.');
      addEnv(name, baseURL);
      $('newEnvName').value = ''; $('newEnvUrl').value = '';
    });
    $('saveSharedLogin').addEventListener('click', saveSharedLoginForm);
    $('addRoleForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('newRoleName').value.trim();
      if (!name) return toast('Enter a role name (e.g. admin).');
      addRole(name, $('newRoleLabel').value.trim());
      $('newRoleName').value = ''; $('newRoleLabel').value = '';
    });
    $('addGroupForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('newGroupName').value.trim();
      if (!name) return toast('Enter a group name (e.g. non-prod).');
      addGroup(name, $('newGroupRole').value);
      $('newGroupName').value = '';
    });

    api('/api/state').then((s) => { if (s && s.demo) showDemoBanner(); }).catch(() => {});
    refreshAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
