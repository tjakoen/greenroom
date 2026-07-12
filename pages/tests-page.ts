// pages/tests-page.ts — the /tests page BODY (P3): a server-rendered skeleton of grain
// primitives (`.chips` chip-group, `.field__select` b-select, `.card`/`.field`/`.btn`/`.badge`)
// that a thin client module (pages/tests.js) fills in and wires up. No data is baked in here —
// everything the page shows comes from the SAME /api/{tests,recorded-inputs,apply-inputs,
// test-tags,test-meta,tests/rename,roles,record,state} endpoints interface/app.js already uses
// (byte-compat is the P3 gate: tests.js sends the identical request bodies).
//
// Reproduces the old Tests surface (interface/app.js ~405-675: loadTests, renderSmartFilters,
// renderTagFilters, filteredTests, renderTestGroups/testRow, toggleInputsEdit, toggleMetaEdit,
// updateRunSelected/toggleSelectAll/deleteSelected, runOne/runSelected/runByTag, renameTest,
// deleteTest; ~1476-1495: populateRecordRoles/recordTest). Uses the two new grain components
// this migration proposed: **chip-group** (`.chips`) for the smart filters, @tag filter bar, and
// env picker, and **b-select** (`.field__select`) for the Priority / input-generator / "Log in
// as" role dropdowns. The Run page is still the frozen SPA (P4) — Run/Run selected/Run by tag
// hand off to it rather than trying to trigger a run from here (see tests.js goRun()).
export function testsBody(): string {
  return `<div class="tests-page">
  <header class="board" style="margin-bottom:0">
    <h1 class="masthead">Tests</h1>
    <p class="lede">Your test library for one environment at a time — search, filter by @tag or
      smart filter, edit tags/priority/owner/notes, make recorded inputs dynamic, rename or
      delete a spec, and record a new one. Running still happens on the Run page.</p>
  </header>
  <div id="testsNotice" class="callout" data-status="strong" hidden></div>

  <section class="card" data-pad="md">
    <div class="section-head"><span>Environment</span></div>
    <fieldset class="chips" data-select="single" id="testsEnvPills"></fieldset>

    <div class="gr-form-row" style="margin-top:var(--space-4)">
      <label class="field" style="flex:1 1 100%">
        <span class="field__label">Search</span>
        <input class="field__input" id="testSearch" placeholder="Search title, file, tags, owner, group…">
      </label>
    </div>

    <div class="section-head"><span>Smart filters</span></div>
    <fieldset class="chips" data-select="single" id="smartFilters"></fieldset>

    <div class="section-head"><span>@tags</span></div>
    <fieldset class="chips" data-select="multi" id="tagFilters"></fieldset>
    <div class="gr-form-row">
      <button class="btn" data-size="sm" type="button" id="runTagBtn" disabled>Run by tag</button>
    </div>
  </section>

  <section class="card" data-pad="md">
    <div class="section-head">
      <span>Tests</span>
      <div class="gr-bulk-bar">
        <button class="btn" data-size="sm" type="button" id="selectAllBtn">Select all</button>
        <button class="btn" data-size="sm" type="button" id="runSelectedBtn" disabled>Run selected</button>
        <button class="btn" data-size="sm" data-status="danger" type="button" id="deleteSelectedBtn" disabled>Delete selected</button>
      </div>
    </div>
    <p id="testsEmpty" class="cat-intro" hidden>No tests match the current filters.</p>
    <div id="testGroups"></div>
  </section>

  <section class="card" data-pad="md">
    <div class="section-head"><span>Record a new test</span></div>
    <p class="cat-intro">Opens a browser window — click through the site, then close it to save the recording.</p>
    <form id="recordForm" class="gr-form-row">
      <label class="field" data-size="sm">
        <span class="field__label">Test name</span>
        <input class="field__input" id="recordName" placeholder="e.g. checkout-flow" required>
      </label>
      <label class="field" data-size="sm">
        <span class="field__label">Log in as</span>
        <select class="field__select" id="recordRole"><option value="">No login (public pages)</option></select>
      </label>
      <button class="btn" type="submit">Record</button>
    </form>
  </section>
</div>
<script src="/tests.js" defer></script>`;
}
