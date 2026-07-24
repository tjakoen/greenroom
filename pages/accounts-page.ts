// pages/accounts-page.ts — the /accounts page BODY (P2, plans/platform.md §3/§4/§11): a
// server-rendered skeleton of grain form primitives (`.field`/`.card`/`.card-grid`/`.btn`/
// `.badge`) that a thin client module (pages/accounts.js) fills in and wires up, mirroring
// pages/settings-page.ts's Roles & logins panel and pages/environments-page.ts's layout. This is
// a NEW, scoped surface over the DB `credential` table (pages/accounts-api.ts's /api/accounts/*
// routes) — "Account" = a login ON THE APP UNDER TEST, not a Greenroom user.
export function accountsBody(): string {
  return `<div class="accounts-page">
  <header class="board" style="margin-bottom:0">
    <h1 class="masthead">Accounts</h1>
    <p class="lede">Test-target credentials — logins on the app under test, shared per
      Private/Team/Company and tracked with an owner and an audit trail. A saved username is
      shown; a saved password is never shown again.</p>
  </header>
  <div id="accountsNotice" class="callout" data-status="strong" hidden></div>
  <p class="callout" data-status="strong">Set a <strong>Role</strong> (e.g. <code>admin</code>)
    to hand this account to real test runs: a run resolves the matching
    <code>&lt;role&gt;</code>/environment credential from here (decrypted only in the test
    runner's own process — never written to disk) instead of <code>.env</code>. An account with
    no role is not handed off to any run yet.</p>

  <section class="card" data-pad="md">
    <div class="section-head"><span>Your accounts</span></div>
    <div id="accountsList" class="card-grid"><p class="cat-intro">Loading…</p></div>
  </section>

  <section class="card" data-pad="md">
    <div class="section-head"><span>Add an account</span></div>
    <form id="addAccountForm" class="gr-form-row">
      <label class="field" data-size="sm">
        <span class="field__label">Label</span>
        <input class="field__input" id="newAccountLabel" name="label" placeholder="QA admin" required>
      </label>
      <label class="field" data-size="sm">
        <span class="field__label">Username</span>
        <input class="field__input" id="newAccountUsername" name="username" placeholder="qa@example.com" required>
      </label>
      <label class="field" data-size="sm">
        <span class="field__label">Password</span>
        <input class="field__input" id="newAccountPassword" name="password" type="password" placeholder="password" required>
      </label>
      <label class="field" data-size="sm">
        <span class="field__label">Environment</span>
        <select class="field__input" id="newAccountEnv"><option value="">Any / not tied to one</option></select>
      </label>
      <label class="field" data-size="sm">
        <span class="field__label">Role</span>
        <input class="field__input" id="newAccountRole" name="role" placeholder="admin">
      </label>
      <label class="field" data-size="sm">
        <span class="field__label">Visibility</span>
        <select class="field__input" id="newAccountVisibility">
          <option value="company" selected>Company (everyone)</option>
          <option value="team">Team</option>
          <option value="private">Private (only me)</option>
        </select>
      </label>
      <label class="field" data-size="sm" id="newAccountTeamField" hidden>
        <span class="field__label">Team id</span>
        <input class="field__input" id="newAccountTeamId" placeholder="team id">
      </label>
      <button class="btn" type="submit">Add account</button>
    </form>
  </section>
</div>
<script src="/accounts.js" defer></script>`;
}
