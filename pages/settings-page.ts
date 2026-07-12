// pages/settings-page.ts — the /settings page BODY (P2): a server-rendered skeleton of grain
// form primitives (`.field`/`.card`/`.card-grid`/`.btn`/`.table`) that a thin client module
// (pages/settings.js) fills in and wires up. No data is baked in here — everything the page
// shows comes from the SAME /api/{envs,roles,creds,groups} endpoints interface/app.js already
// uses (byte-compat is the P2 gate: settings.js sends the identical request bodies).
//
// Reproduces the old Settings surface (interface/app.js ~976-1220): Environments (+ shared/
// per-env login form), Roles & logins (saved username shown, password NEVER shown again —
// "•••••• (saved)"), and Site groups. Demo-mode write refusals ({ok:false,demo:true}) are
// surfaced by settings.js via the shared toast + a persistent banner (#settingsNotice).
export function settingsBody(): string {
  return `<div class="settings-page">
  <header class="board" style="margin-bottom:0">
    <h1 class="masthead">Settings</h1>
    <p class="lede">Environments, roles &amp; logins, and site groups. Logins are local-only —
      never committed, synced, or sent anywhere. Saved usernames are shown; passwords are never
      shown again.</p>
  </header>
  <div id="settingsNotice" class="callout" data-status="strong" hidden></div>

  <section class="card" data-pad="md">
    <div class="section-head"><span>Environments</span></div>
    <div id="envList" class="card-grid"><p class="cat-intro">Loading…</p></div>
    <form id="addEnvForm" class="gr-form-row">
      <label class="field" data-size="sm">
        <span class="field__label">Name</span>
        <input class="field__input" id="newEnvName" name="name" placeholder="staging" required>
      </label>
      <label class="field" data-size="sm">
        <span class="field__label">URL</span>
        <input class="field__input" id="newEnvUrl" name="baseURL" type="url" placeholder="https://staging.example.com" required>
      </label>
      <button class="btn" type="submit">Add environment</button>
    </form>
    <details class="gr-details">
      <summary>Shared login form</summary>
      <p class="cat-intro">How the login form works for every environment that doesn't override it below.</p>
      <div id="sharedLoginFields" class="gr-login-fields"></div>
      <button class="btn" data-size="sm" type="button" id="saveSharedLogin">Save login form</button>
    </details>
  </section>

  <section class="card" data-pad="md">
    <div class="section-head"><span>Roles &amp; logins</span></div>
    <div id="rolesList" class="card-grid"><p class="cat-intro">Loading…</p></div>
    <form id="addRoleForm" class="gr-form-row">
      <label class="field" data-size="sm">
        <span class="field__label">Role name</span>
        <input class="field__input" id="newRoleName" name="name" placeholder="admin" required>
      </label>
      <label class="field" data-size="sm">
        <span class="field__label">Label (optional)</span>
        <input class="field__input" id="newRoleLabel" name="label" placeholder="Admin">
      </label>
      <button class="btn" type="submit">Add role</button>
    </form>
  </section>

  <section class="card" data-pad="md">
    <div class="section-head"><span>Site groups</span></div>
    <p class="cat-intro">Run several sites in one click (e.g. every non-prod environment).</p>
    <div id="groupsList" class="card-grid"><p class="cat-intro">Loading…</p></div>
    <form id="addGroupForm" class="gr-form-row">
      <label class="field" data-size="sm">
        <span class="field__label">Group name</span>
        <input class="field__input" id="newGroupName" name="name" placeholder="non-prod" required>
      </label>
      <div class="field" data-size="sm">
        <span class="field__label">Sites</span>
        <div id="newGroupEnvs" class="gr-check-row"></div>
      </div>
      <label class="field" data-size="sm">
        <span class="field__label">Run as</span>
        <select class="field__input" id="newGroupRole"><option value="">Each test's own role</option></select>
      </label>
      <button class="btn" type="submit">Save group</button>
    </form>
  </section>
</div>
<script src="/settings.js" defer></script>`;
}
