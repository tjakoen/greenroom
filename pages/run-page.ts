// pages/run-page.ts — the /run page BODY (P4): a server-rendered skeleton of grain primitives
// (chip-group env picker, b-select Tests/Run-as pickers, stat-tile/b-meter/status-list dashboard)
// that a thin client module (pages/run.js) fills in and wires up. No data is baked in here —
// everything the page shows comes from the SAME /api/{run,stop,stream,state,results,tests,roles,
// groups,creds} endpoints interface/app.js already uses (byte-compat is the P4 gate: run.js sends
// the identical /api/run body and consumes the identical /api/stream events).
//
// Reproduces the old Run surface (interface/app.js ~120-357, ~1245-1387, ~1442-1471): the
// multi-select env picker (readiness signalled by a monochrome glyph, not a colour dot), saved
// site-group one-click presets, the Tests-scope and Run-as pickers, Run/Stop + a monochrome status
// readout, and the live dashboard (4 stat tiles, a b-meter health bar, a single-env status-list or
// a multi-env test×env matrix table, and the raw output in a <details>).
import { IS_LOCAL } from "../lib/paths.ts";

// "Show the browser" is LOCAL-only: it opens a real Chromium window on the user's own screen, which
// a deployed (headless) instance has nowhere to put — same reason recording is local-only. Rendered
// out of the markup entirely in platform rather than disabled, so there's no dead control to explain.
// pages/run.js reads it defensively (missing element → plain headless run), so the two stay in step.
const HEADED_CHECK = IS_LOCAL
  ? `<label class="gr-check-inline">
        <input type="checkbox" id="headed"> Show the browser <span class="cat-intro">(watch it run, slower)</span>
      </label>`
  : "";

export function runBody(): string {
  return `<div class="run-page">
  <header class="board" style="margin-bottom:0">
    <h1 class="masthead">Run</h1>
    <p class="lede">Pick an environment and run the automated checks against your app.</p>
  </header>
  <div id="runNotice" class="callout" data-status="strong" hidden></div>

  <section class="card" data-pad="md">
    <div id="groupChips" class="gr-group-chips" hidden></div>

    <div class="section-head"><span>Environment</span></div>
    <fieldset class="chips" data-select="multi" id="runEnvPills"></fieldset>
    <p class="cat-intro" id="runEnvHint">Tip: pick more than one site to run everywhere at once.</p>

    <div class="gr-form-row">
      <label class="field" data-size="sm">
        <span class="field__label">Tests</span>
        <select class="field__select" id="runScope"></select>
      </label>
      <label class="field" data-size="sm">
        <span class="field__label">Run as</span>
        <select class="field__select" id="runRole"></select>
      </label>
      <label class="gr-check-inline">
        <input type="checkbox" id="light"> Faster run <span class="cat-intro">(less detail)</span>
      </label>
      ${HEADED_CHECK}
    </div>

    <div class="gr-form-row" style="margin-top:var(--space-5)">
      <button class="btn" data-variant="primary" data-size="lg" type="button" id="runBtn">Run tests</button>
      <button class="btn" type="button" id="stopBtn" disabled>Stop</button>
      <span class="gr-run-status" id="runStatus">Ready</span>
      <button class="btn" data-size="sm" type="button" id="reportBtn" style="margin-left:auto" disabled>Open full report ↗</button>
    </div>
  </section>

  <section class="card" data-pad="md" id="resultsCard" hidden>
    <div class="gr-stat-row" id="statTiles"></div>
    <div class="meter" role="meter" aria-label="Run health" id="healthBar"></div>
    <div class="gr-health-cap" id="healthCap"></div>
    <div class="gr-env-health" id="envHealth"></div>

    <div class="section-head" style="margin-top:var(--space-5)"><span>Checks</span></div>
    <div id="checklist"></div>

    <details class="gr-details">
      <summary>Technical details (raw output)</summary>
      <pre class="gr-output" id="output"></pre>
    </details>
  </section>
</div>
<script src="/run.js" defer></script>`;
}
