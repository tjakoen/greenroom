'use strict';
// pages/admin.js — the thin client module behind /admin (P2). Plain, dependency-free browser JS
// (no bundler, no TS), same pattern as pages/settings.js: fetches /api/admin/{users,teams,audit}
// (pages/admin-api.ts), renders grain markup, wires the promote/demote toggle + create-team form
// + per-team member add/remove, and re-fetches on success. A 403 from any call (non-superadmin,
// or a stale session that lost superadmin) replaces both panels with a plain "Superadmin only"
// message instead of a confusing empty/broken UI. The Audit log panel is read-only (no writes of
// its own) and is re-fetched after every Users/Teams mutation so it reflects the action just taken.
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

  function showForbidden() {
    const n = $('adminNotice');
    if (n) {
      n.textContent = 'Superadmin only — you don’t have access to user and team management.';
      n.hidden = false;
    }
    $('usersList').innerHTML = '';
    $('teamsList').innerHTML = '';
    const teamForm = $('addTeamForm');
    if (teamForm) teamForm.hidden = true;
    const auditRows = $('auditRows');
    if (auditRows) auditRows.innerHTML = '<tr><td colspan="4" class="cat-intro">Superadmin only.</td></tr>';
  }

  // Fetches `path`, returns { status, data }. Never throws — network/parse failures come back
  // as status 0 with data null so callers can show a friendly error instead of an unhandled
  // rejection.
  async function api(path, opts) {
    try {
      const res = await fetch(path, opts);
      let data = null;
      try { data = await res.json(); } catch { /* no body / not JSON */ }
      return { status: res.status, data };
    } catch {
      return { status: 0, data: null };
    }
  }

  let usersCache = [];
  let teamsCache = [];

  // ------------------------------------------------------------------------------------ Users
  async function loadUsers() {
    const { status, data } = await api('/api/admin/users');
    if (status === 403) return showForbidden();
    if (!data || !data.ok) {
      $('usersList').innerHTML = `<p class="cat-intro">Could not load users${data && data.error ? ': ' + esc(data.error) : '.'}</p>`;
      return;
    }
    usersCache = data.users || [];
    renderUsers();
  }

  function teamNamesFor(teamIds) {
    if (!teamIds || !teamIds.length) return 'Unassigned';
    const names = teamIds.map((id) => {
      const t = teamsCache.find((tm) => tm.id === id);
      return t ? t.name : null;
    }).filter(Boolean);
    return names.length ? names.join(', ') : 'Unassigned';
  }

  function renderUsers() {
    const wrap = $('usersList');
    if (!usersCache.length) {
      wrap.innerHTML = '<p class="cat-intro">No users yet.</p>';
      return;
    }
    wrap.innerHTML = usersCache.map((u) => {
      const isSuper = !!u.isSuperadmin;
      return `<div class="card" data-pad="sm">
        <div class="gr-card-head">
          <span class="rname mono">${esc(u.email)}</span>
          <span class="badge" data-status="${isSuper ? 'active' : ''}">${isSuper ? 'superadmin' : 'user'}</span>
        </div>
        <p class="gr-card-meta">${esc(u.name || 'No name set')} · ${esc(teamNamesFor(u.teamIds))}</p>
        <button class="btn" data-size="sm" data-status="${isSuper ? 'danger' : ''}" data-roletoggle="${esc(u.id)}" data-makeadmin="${isSuper ? '0' : '1'}">
          ${isSuper ? 'Revoke superadmin' : 'Make superadmin'}
        </button>
      </div>`;
    }).join('');

    wrap.querySelectorAll('[data-roletoggle]').forEach((b) => (b.onclick = () => {
      const userId = b.dataset.roletoggle;
      const makeAdmin = b.dataset.makeadmin === '1';
      const label = makeAdmin ? 'Grant superadmin access to this user?' : 'Revoke superadmin access from this user?';
      if (!confirm(label)) return;
      setRole(userId, makeAdmin);
    }));
  }

  async function setRole(userId, makeAdmin) {
    const { status, data } = await api('/api/admin/users/role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, makeAdmin }),
    });
    if (status === 403) return showForbidden();
    if (!data || !data.ok) return toast((data && data.error) || 'Could not update role.');
    toast(makeAdmin ? 'Promoted to superadmin' : 'Superadmin revoked');
    await loadUsers();
    await loadAudit();
  }

  // ------------------------------------------------------------------------------------ Teams
  async function loadTeams() {
    const { status, data } = await api('/api/admin/teams');
    if (status === 403) return showForbidden();
    if (!data || !data.ok) {
      $('teamsList').innerHTML = `<p class="cat-intro">Could not load teams${data && data.error ? ': ' + esc(data.error) : '.'}</p>`;
      return;
    }
    teamsCache = data.teams || [];
    renderTeams();
    renderUsers(); // team names shown per-user depend on teamsCache
  }

  function renderTeams() {
    const wrap = $('teamsList');
    if (!teamsCache.length) {
      wrap.innerHTML = '<p class="cat-intro">No teams yet. Create one below.</p>';
      return;
    }
    wrap.innerHTML = teamsCache.map((t) => {
      const members = usersCache.filter((u) => (u.teamIds || []).includes(t.id));
      const nonMembers = usersCache.filter((u) => !(u.teamIds || []).includes(t.id));
      const memberRows = members.length
        ? members.map((u) => `<div class="gr-login-row">
            <div class="gr-env-name">${esc(u.email)}</div>
            <button class="btn" data-size="sm" data-status="danger" data-memberdel="${esc(t.id)}|${esc(u.id)}">Remove</button>
          </div>`).join('')
        : '<p class="cat-intro">No members yet.</p>';
      const addRow = nonMembers.length
        ? `<div class="gr-form-row">
            <select class="field__input" data-size="sm" data-teamadduser="${esc(t.id)}">
              ${nonMembers.map((u) => `<option value="${esc(u.id)}">${esc(u.email)}</option>`).join('')}
            </select>
            <button class="btn" data-size="sm" data-teamadd="${esc(t.id)}">Add member</button>
          </div>`
        : '<p class="cat-intro">Every user is already on this team.</p>';
      return `<div class="card" data-pad="sm">
        <div class="gr-card-head">
          <span class="rname">${esc(t.name)}</span>
          <span class="gr-card-meta">${t.memberCount} member${t.memberCount === 1 ? '' : 's'}</span>
        </div>
        <div>${memberRows}</div>
        ${addRow}
      </div>`;
    }).join('');

    wrap.querySelectorAll('[data-memberdel]').forEach((b) => (b.onclick = () => {
      const [teamId, userId] = b.dataset.memberdel.split('|');
      setMember(teamId, userId, false);
    }));
    wrap.querySelectorAll('[data-teamadd]').forEach((b) => (b.onclick = () => {
      const teamId = b.dataset.teamadd;
      const sel = wrap.querySelector(`[data-teamadduser="${cssEsc(teamId)}"]`);
      if (!sel || !sel.value) return toast('Pick a user to add.');
      setMember(teamId, sel.value, true);
    }));
  }

  async function setMember(teamId, userId, add) {
    const { status, data } = await api('/api/admin/teams/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, userId, add }),
    });
    if (status === 403) return showForbidden();
    if (!data || !data.ok) return toast((data && data.error) || 'Could not update team membership.');
    toast(add ? 'Member added' : 'Member removed');
    await Promise.all([loadUsers(), loadTeams()]);
    await loadAudit();
  }

  async function createTeam(name) {
    const { status, data } = await api('/api/admin/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (status === 403) return showForbidden();
    if (!data || !data.ok) return toast((data && data.error) || 'Could not create team.');
    toast('Team created');
    await loadTeams();
    await loadAudit();
  }

  // -------------------------------------------------------------------------------- Audit log
  function formatTimestamp(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value ?? '') : d.toLocaleString();
  }

  function renderAudit(rows) {
    const tbody = $('auditRows');
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="cat-intro">No audit entries yet.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r) => `<tr>
        <td class="mono">${esc(formatTimestamp(r.createdAt))}</td>
        <td>${esc(r.actor)}</td>
        <td class="mono">${esc(r.action)}</td>
        <td>${esc(r.entity)}${r.entityId ? ` <span class="cat-intro">${esc(r.entityId)}</span>` : ''}</td>
      </tr>`).join('');
  }

  async function loadAudit() {
    const tbody = $('auditRows');
    const { status, data } = await api('/api/admin/audit');
    if (status === 403) return showForbidden();
    if (!data || !data.ok) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="cat-intro">Could not load audit log${data && data.error ? ': ' + esc(data.error) : '.'}</td></tr>`;
      return;
    }
    renderAudit(data.audit || []);
  }

  // -------------------------------------------------------------------------------- wiring
  async function refreshAll() {
    await loadUsers();
    await loadTeams();
    await loadAudit();
  }

  function init() {
    const addTeamForm = $('addTeamForm');
    if (addTeamForm) {
      addTeamForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = $('newTeamName').value.trim();
        if (!name) return toast('Enter a team name.');
        createTeam(name);
        $('newTeamName').value = '';
      });
    }
    refreshAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
