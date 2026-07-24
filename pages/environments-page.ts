// pages/environments-page.ts — the /environments page BODY (P2, plans/platform.md §11 P2):
// a server-rendered skeleton of grain form primitives (`.field`/`.card`/`.card-grid`/`.btn`/
// `.table`) that a thin client module (pages/environments.js) fills in and wires up, mirroring
// pages/settings-page.ts's Environments panel. This is a NEW, scoped surface over the DB
// `environment` table (pages/environments-api.ts's /api/environments/* routes) — the existing
// /settings page's Environments panel (over the flat-file-only /api/envs) is untouched.
export function environmentsBody(): string {
  return `<div class="environments-page">
  <header class="board" style="margin-bottom:0">
    <h1 class="masthead">Environments</h1>
    <p class="lede">Shared test environments — visible per Private/Team/Company, tracked with an
      owner and an audit trail. Every change here also syncs to <code>config/urls.json</code>, so
      the test runner keeps resolving base URLs exactly as before.</p>
  </header>
  <div id="envNotice" class="callout" data-status="strong" hidden></div>

  <section class="card" data-pad="md">
    <div class="section-head"><span>Your environments</span></div>
    <div id="envList" class="card-grid"><p class="cat-intro">Loading…</p></div>
  </section>

  <section class="card" data-pad="md">
    <div class="section-head"><span>Add an environment</span></div>
    <form id="addEnvForm" class="gr-form-row">
      <label class="field" data-size="sm">
        <span class="field__label">Name</span>
        <input class="field__input" id="newEnvName" name="name" placeholder="staging" required>
      </label>
      <label class="field" data-size="sm">
        <span class="field__label">URL</span>
        <input class="field__input" id="newEnvUrl" name="baseURL" type="url" placeholder="https://staging.example.com" required>
      </label>
      <label class="field" data-size="sm">
        <span class="field__label">Visibility</span>
        <select class="field__input" id="newEnvVisibility">
          <option value="company" selected>Company (everyone)</option>
          <option value="team">Team</option>
          <option value="private">Private (only me)</option>
        </select>
      </label>
      <label class="field" data-size="sm" id="newEnvTeamField" hidden>
        <span class="field__label">Team id</span>
        <input class="field__input" id="newEnvTeamId" placeholder="team id">
      </label>
      <label class="gr-check-row">
        <input type="checkbox" id="newEnvDefault"> Make default
      </label>
      <button class="btn" type="submit">Add environment</button>
    </form>
    <details class="gr-details">
      <summary>Login form (optional)</summary>
      <p class="cat-intro">How this environment's login form works. Leave blank to inherit the
        shared form set in Settings → Environments.</p>
      <div id="newEnvLoginFields" class="gr-login-fields"></div>
    </details>
  </section>
</div>
<script src="/environments.js" defer></script>`;
}
