// pages/admin-page.ts — the /admin page BODY (P2, plans/platform.md §11): a server-rendered
// skeleton of grain primitives (`.card`/`.card-grid`/`.field`/`.btn`/`.badge`), same shape as
// pages/settings-page.ts, that the thin client module (pages/admin.js) fills in and wires up.
// No data is baked in here — everything shown comes from /api/admin/{users,teams} (pages/admin-api.ts).
//
// Superadmin-only surface: Users (roster + promote/demote superadmin), Teams (roster + create
// + per-team member add/remove), and a read-only Audit log (every write above -- plus any other
// P2 mutation -- already writes an auditLog row via lib/audit.ts; this panel just surfaces it).
// admin.js shows a plain "Superadmin only" message in place of these panels when a fetch comes
// back 403 (a non-superadmin should never normally reach this page, but the client-side check is
// a second line of defense to match server-side gating).
export function adminBody(): string {
  return `<div class="admin-page">
  <header class="board" style="margin-bottom:0">
    <h1 class="masthead">Admin</h1>
    <p class="lede">Superadmin-only: manage Greenroom user accounts and teams. Promoting a user
      to superadmin gives them full access to every environment, test, and account — grant it
      sparingly. Every change here is written to the audit log.</p>
  </header>
  <div id="adminNotice" class="callout" data-status="strong" hidden></div>

  <section class="card" data-pad="md">
    <div class="section-head"><span>Users</span></div>
    <div id="usersList" class="card-grid"><p class="cat-intro">Loading…</p></div>
  </section>

  <section class="card" data-pad="md">
    <div class="section-head"><span>Teams</span></div>
    <div id="teamsList" class="card-grid"><p class="cat-intro">Loading…</p></div>
    <form id="addTeamForm" class="gr-form-row">
      <label class="field" data-size="sm">
        <span class="field__label">Team name</span>
        <input class="field__input" id="newTeamName" name="name" placeholder="QA" required>
      </label>
      <button class="btn" type="submit">Create team</button>
    </form>
  </section>

  <section class="card" data-pad="md">
    <div class="section-head"><span>Audit log</span></div>
    <div class="table-scroll">
      <table class="table">
        <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead>
        <tbody id="auditRows"><tr><td colspan="4" class="cat-intro">Loading…</td></tr></tbody>
      </table>
    </div>
  </section>
</div>
<script src="/admin.js" defer></script>`;
}
