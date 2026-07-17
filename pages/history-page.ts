// pages/history-page.ts — the /history page BODY (P5): a server-rendered skeleton of grain
// primitives that a thin client module (pages/history.js) fills in. No data is baked in here —
// the page shows exactly what the frozen SPA's #/history page showed, from the SAME endpoints
// (GET /api/runs for the list, GET /api/pdf-data on "Report this"), rendered as grain rows.
//
// Ported from interface/app.js refreshRuns/renderRuns (~677-706) + index.html #/history
// (~136-149): a text filter over env/result, one row per saved run (env · timestamp · a
// pass/fail badge), an "Open report ↗" link to the archived Playwright report at /runs/<id>/,
// and — on failed runs only — a "Report this" button that hands off to /bug with the run + its
// first failed test preselected (the separate-page replacement for the SPA's pendingShare global).
export function historyBody(): string {
  return `<div class="history-page">
  <header class="board" style="margin-bottom:0">
    <h1 class="masthead">History</h1>
    <p class="lede">Every past run is saved on this computer. Open any to review it.</p>
  </header>
  <div id="historyNotice" class="callout" data-status="strong" hidden></div>

  <section class="card" data-pad="md">
    <label class="field" data-size="sm">
      <span class="field__label">Filter</span>
      <input class="field__input" id="historySearch" type="search" placeholder="Filter by environment or result…" autocomplete="off">
    </label>
    <ul class="gr-rows" id="historyList" style="margin-top:var(--space-3)"></ul>
    <p class="cat-intro" id="historyEmpty" hidden>No runs yet. <a href="/run">Run your first check</a> to start building history.</p>
  </section>
</div>
<script src="/history.js" defer></script>`;
}
