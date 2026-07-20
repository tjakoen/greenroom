'use strict';
// pages/accounts.js — the thin client module behind /accounts (P2). Plain, dependency-free
// browser JS (no bundler, no TS), served as-is by server.ts, same pattern as pages/settings.js and
// pages/environments.js. Talks to the scoped /api/accounts/* routes (pages/accounts-api.ts) for
// the credential list/create/update/delete, and to /api/environments (pages/environments-api.ts —
// the new DB-backed, scoped environment list, NOT the flat-file-only /api/envs) to populate the
// environment picker: a credential's `envId` is meant to reference that same `environment.id`, so
// the picker must offer real environment ids, which only /api/environments returns.
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
    const n = $('accountsNotice');
    if (!n) return;
    n.textContent = msg;
    n.hidden = false;
  }

  // Same convention as pages/environments.js: a 401 means the session gate rejected us (or a
  // fetch raced an expiring session) — bounce to /login. A 403 is a scope violation (not your
  // account to write) — toast it, don't redirect. Bare {error} shapes (405/404/401 guards) get
  // normalized into the {ok:false,error} shape every caller below already checks for.
  async function api(path, opts) {
    const r = await fetch(path, opts);
    if (r.status === 401) {
      window.location.href = '/login';
      return null;
    }
    let body = null;
    try { body = await r.json(); } catch { /* no body */ }
    if (r.status === 403) {
      toast((body && body.error) || "You don't have permission to change that account.");
      return body || { ok: false, error: 'forbidden' };
    }
    if (!r.ok && body && body.ok === undefined) {
      return { ok: false, error: body.error || `Request failed (${r.status})` };
    }
    return body;
  }

  const VISIBILITY_LABEL = { company: 'Company', team: 'Team', private: 'Private' };

  let envById = {};

  function envOptionsHtml(selectedId) {
    const opts = ['<option value="">Any / not tied to one</option>'];
    for (const env of Object.values(envById)) {
      opts.push(`<option value="${esc(env.id)}" ${env.id === selectedId ? 'selected' : ''}>${esc(env.name)}</option>`);
    }
    return opts.join('');
  }

  async function loadEnvs() {
    const list = await api('/api/environments').catch(() => null);
    envById = {};
    if (Array.isArray(list)) for (const e of list) envById[e.id] = e;
    const picker = $('newAccountEnv');
    if (picker) picker.innerHTML = envOptionsHtml('');
  }

  async function loadAccounts() {
    const list = await api('/api/accounts').catch(() => null);
    const wrap = $('accountsList');
    if (!wrap) return;
    if (!Array.isArray(list)) {
      wrap.innerHTML = '<p class="cat-intro">Could not load accounts.</p>';
      return;
    }
    if (!list.length) {
      wrap.innerHTML = '<p class="cat-intro">No accounts yet. Add one below.</p>';
      return;
    }
    wrap.innerHTML = list.map((a) => {
      const envName = a.envId && envById[a.envId] ? envById[a.envId].name : 'Any / not tied to one';
      return `<div class="card" data-pad="sm" data-account-id="${esc(a.id)}">
      <div class="gr-card-head">
        <span class="rname mono">${esc(a.label)}</span>
        <span class="badge" ${a.visibility === 'company' ? 'data-status="active"' : ''}>${esc(VISIBILITY_LABEL[a.visibility] || a.visibility)}</span>
        <button class="btn" data-size="sm" data-status="danger" data-acctdel="${esc(a.id)}">Delete</button>
      </div>
      <label class="field" data-size="sm"><span class="field__label">Username</span>
        <input class="field__input" data-acctuser="${esc(a.id)}" value="${esc(a.username)}"></label>
      <label class="field" data-size="sm"><span class="field__label">Password</span>
        <input class="field__input" type="password" data-acctpass="${esc(a.id)}" placeholder="•••••• (saved)"></label>
      <label class="field" data-size="sm"><span class="field__label">Environment</span>
        <select class="field__input" data-acctenv="${esc(a.id)}">${envOptionsHtml(a.envId || '')}</select></label>
      <label class="field" data-size="sm"><span class="field__label">Visibility</span>
        <select class="field__input" data-acctvis="${esc(a.id)}">
          <option value="company" ${a.visibility === 'company' ? 'selected' : ''}>Company (everyone)</option>
          <option value="team" ${a.visibility === 'team' ? 'selected' : ''}>Team</option>
          <option value="private" ${a.visibility === 'private' ? 'selected' : ''}>Private (only me)</option>
        </select></label>
      <p class="gr-card-meta">Currently: ${esc(envName)}</p>
      <button class="btn" data-size="sm" data-acctsave="${esc(a.id)}" style="margin-top:var(--space-2)">Save</button>
    </div>`;
    }).join('');

    wrap.querySelectorAll('[data-acctsave]').forEach((b) => (b.onclick = () => {
      const id = b.dataset.acctsave;
      const username = document.querySelector(`[data-acctuser="${cssEsc(id)}"]`).value.trim();
      const password = document.querySelector(`[data-acctpass="${cssEsc(id)}"]`).value;
      const envId = document.querySelector(`[data-acctenv="${cssEsc(id)}"]`).value;
      const visibility = document.querySelector(`[data-acctvis="${cssEsc(id)}"]`).value;
      const patch = { username, envId, visibility };
      if (password) patch.password = password; // omit entirely — an empty field must never overwrite a saved one
      updateAccount(id, patch);
    }));
    wrap.querySelectorAll('[data-acctdel]').forEach((b) => (b.onclick = () => {
      const id = b.dataset.acctdel;
      const label = b.closest('[data-account-id]')?.querySelector('.rname')?.textContent || 'this account';
      if (confirm(`Remove account "${label}"? This cannot be undone.`)) removeAccount(id);
    }));
  }

  async function addAccount(label, username, password, envId, visibility, teamId) {
    const body = { label, username, password, visibility };
    if (envId) body.envId = envId;
    if (visibility === 'team' && teamId) body.teamId = teamId;
    const r = await api('/api/accounts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r || !r.ok) return toast((r && r.error) || 'Could not add account.');
    toast('Account added');
    await loadAccounts();
  }
  async function updateAccount(id, patch) {
    const r = await api('/api/accounts/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...patch }),
    });
    if (!r || !r.ok) return toast((r && r.error) || 'Could not save.');
    toast('Saved');
    await loadAccounts();
  }
  async function removeAccount(id) {
    const r = await api('/api/accounts/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
    if (!r || !r.ok) return toast((r && r.error) || 'Could not remove.');
    toast('Removed');
    await loadAccounts();
  }

  function init() {
    const visSel = $('newAccountVisibility');
    const teamField = $('newAccountTeamField');
    if (visSel && teamField) {
      visSel.addEventListener('change', () => { teamField.hidden = visSel.value !== 'team'; });
    }

    $('addAccountForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const label = $('newAccountLabel').value.trim();
      const username = $('newAccountUsername').value.trim();
      const password = $('newAccountPassword').value;
      if (!label || !username || !password) return toast('Enter a label, username, and password.');
      const envId = $('newAccountEnv').value;
      const visibility = $('newAccountVisibility').value;
      const teamId = $('newAccountTeamId').value.trim();
      addAccount(label, username, password, envId, visibility, teamId);
      $('newAccountLabel').value = '';
      $('newAccountUsername').value = '';
      $('newAccountPassword').value = '';
      $('newAccountTeamId').value = '';
    });

    loadEnvs().then(loadAccounts);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
