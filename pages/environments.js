'use strict';
// pages/environments.js — the thin client module behind /environments (P2). Plain,
// dependency-free browser JS (no bundler, no TS), served as-is by server.ts, same pattern as
// pages/settings.js. Talks to the NEW scoped /api/environments/* routes (pages/environments-api.ts)
// — a DB-backed, owner/team/visibility-scoped surface, distinct from the old flat-file-only
// /api/envs the /settings page still uses.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cssEsc = (s) => String(s).replace(/["\\]/g, '\\$&');

  function toast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('is-show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('is-show'), 2600);
  }
  function notice(msg) {
    const n = $('envNotice');
    if (!n) return;
    n.textContent = msg;
    n.hidden = false;
  }

  // A 401 means the session gate rejected us (shouldn't normally reach this page unauthenticated,
  // but fetches can race a session expiring) — bounce to /login same as a page nav would. A 403
  // is a scope violation (not your environment to write) — surface it as a toast, don't redirect.
  async function api(path, opts) {
    const r = await fetch(path, opts);
    if (r.status === 401) {
      window.location.href = '/login';
      return null;
    }
    let body = null;
    try { body = await r.json(); } catch { /* no body */ }
    if (r.status === 403) {
      toast((body && body.error) || "You don't have permission to change that environment.");
      return body || { ok: false, error: 'forbidden' };
    }
    if (!r.ok && body && body.ok === undefined) {
      // Bare error shapes ({error:"..."}) from method/404 guards, not the {ok:false,...} convention.
      return { ok: false, error: body.error || `Request failed (${r.status})` };
    }
    return body;
  }

  const LOGIN_FORM_FIELDS = [
    { key: 'path', label: 'Login path', ph: '/login' },
    { key: 'username', label: 'Username field', ph: '#email' },
    { key: 'password', label: 'Password field', ph: '#password' },
    { key: 'submit', label: 'Submit button text', ph: 'Sign in' },
  ];
  function loginFieldsHtml(scope, values = {}) {
    return LOGIN_FORM_FIELDS.map((f) =>
      `<label class="field" data-size="sm"><span class="field__label">${esc(f.label)}</span>` +
      `<input class="field__input" data-lf="${esc(scope)}|${f.key}" value="${esc(values[f.key] || '')}" placeholder="${esc(f.ph)}"></label>`
    ).join('');
  }
  function readLoginFields(scope) {
    const out = {};
    for (const f of LOGIN_FORM_FIELDS) {
      const el = document.querySelector(`[data-lf="${cssEsc(scope)}|${f.key}"]`);
      if (el && el.value.trim()) out[f.key] = el.value.trim();
    }
    return out;
  }

  const VISIBILITY_LABEL = { company: 'Company', team: 'Team', private: 'Private' };

  async function loadEnvs() {
    const list = await api('/api/environments').catch(() => null);
    const wrap = $('envList');
    if (!wrap) return;
    if (!Array.isArray(list)) {
      wrap.innerHTML = '<p class="cat-intro">Could not load environments.</p>';
      return;
    }
    if (!list.length) {
      wrap.innerHTML = '<p class="cat-intro">No environments yet. Add one below.</p>';
      return;
    }
    wrap.innerHTML = list.map((e) => `<div class="card" data-pad="sm" data-env-id="${esc(e.id)}">
      <div class="gr-card-head">
        <span class="rname mono">${esc(e.name)}</span>
        ${e.isDefault ? '<span class="badge" data-status="active">default</span>' : ''}
        <span class="badge">${esc(VISIBILITY_LABEL[e.visibility] || e.visibility)}</span>
        <button class="btn" data-size="sm" data-status="danger" data-envdel="${esc(e.id)}">Delete</button>
      </div>
      <label class="field" data-size="sm"><span class="field__label">URL</span>
        <input class="field__input" data-envurl="${esc(e.id)}" value="${esc(e.baseURL)}"></label>
      <label class="field" data-size="sm"><span class="field__label">Visibility</span>
        <select class="field__input" data-envvis="${esc(e.id)}">
          <option value="company" ${e.visibility === 'company' ? 'selected' : ''}>Company (everyone)</option>
          <option value="team" ${e.visibility === 'team' ? 'selected' : ''}>Team</option>
          <option value="private" ${e.visibility === 'private' ? 'selected' : ''}>Private (only me)</option>
        </select></label>
      <label class="gr-check-row">
        <input type="checkbox" data-envdefault="${esc(e.id)}" ${e.isDefault ? 'checked' : ''}> Default environment
      </label>
      <button class="btn" data-size="sm" data-envsave="${esc(e.id)}" style="margin-top:var(--space-2)">Save</button>
      <details class="gr-details">
        <summary>Login form</summary>
        <div class="gr-login-fields">${loginFieldsHtml('env:' + e.id, e.loginForm || {})}</div>
      </details>
    </div>`).join('');

    wrap.querySelectorAll('[data-envsave]').forEach((b) => (b.onclick = () => {
      const id = b.dataset.envsave;
      const baseURL = document.querySelector(`[data-envurl="${cssEsc(id)}"]`).value;
      const visibility = document.querySelector(`[data-envvis="${cssEsc(id)}"]`).value;
      const isDefault = document.querySelector(`[data-envdefault="${cssEsc(id)}"]`).checked;
      const loginForm = readLoginFields('env:' + id);
      updateEnv(id, { baseURL, visibility, isDefault, loginForm });
    }));
    wrap.querySelectorAll('[data-envdel]').forEach((b) => (b.onclick = () => {
      const id = b.dataset.envdel;
      const name = b.closest('[data-env-id]')?.querySelector('.rname')?.textContent || 'this environment';
      if (confirm(`Remove environment "${name}"? The test runner will no longer see it.`)) removeEnv(id);
    }));
  }

  async function addEnv(name, baseURL, visibility, teamId, isDefault, loginForm) {
    const body = { name, baseURL, visibility, isDefault };
    if (visibility === 'team' && teamId) body.teamId = teamId;
    if (Object.keys(loginForm).length) body.loginForm = loginForm;
    const r = await api('/api/environments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r || !r.ok) return toast((r && r.error) || 'Could not add environment.');
    if (r.warning) notice(r.warning);
    toast('Environment added');
    await loadEnvs();
  }
  async function updateEnv(id, patch) {
    const r = await api('/api/environments/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...patch }),
    });
    if (!r || !r.ok) return toast((r && r.error) || 'Could not save.');
    if (r.warning) notice(r.warning);
    toast('Saved');
    await loadEnvs();
  }
  async function removeEnv(id) {
    const r = await api('/api/environments/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
    if (!r || !r.ok) return toast((r && r.error) || 'Could not remove.');
    toast('Removed');
    await loadEnvs();
  }

  function init() {
    const visSel = $('newEnvVisibility');
    const teamField = $('newEnvTeamField');
    if (visSel && teamField) {
      visSel.addEventListener('change', () => { teamField.hidden = visSel.value !== 'team'; });
    }
    const loginWrap = $('newEnvLoginFields');
    if (loginWrap) loginWrap.innerHTML = loginFieldsHtml('new', {});

    $('addEnvForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('newEnvName').value.trim();
      const baseURL = $('newEnvUrl').value.trim();
      if (!name || !baseURL) return toast('Enter a name and a URL.');
      const visibility = $('newEnvVisibility').value;
      const teamId = $('newEnvTeamId').value.trim();
      const isDefault = $('newEnvDefault').checked;
      const loginForm = readLoginFields('new');
      addEnv(name, baseURL, visibility, teamId, isDefault, loginForm);
      $('newEnvName').value = '';
      $('newEnvUrl').value = '';
      $('newEnvTeamId').value = '';
      $('newEnvDefault').checked = false;
    });

    loadEnvs();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
