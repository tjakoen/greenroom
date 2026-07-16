// pages/report-bug-page.ts — the /bug page BODY (P5): a server-rendered skeleton of grain
// primitives that a thin client module (pages/bug.js) fills in. Reproduces the frozen SPA's
// #/share surface (interface/index.html ~151-226, interface/app.js ~710-964) over the SAME
// endpoints: run/test pickers (GET /api/runs + /api/pdf-data), a markdown summary card
// (/api/bug-summary) with the full console/network logs in <details>, and the single-moment PDF
// card — a screenshot scrubber (/api/pdf-image) with the console+network for the interval since
// the previous screenshot (/api/moment, windowed client-side), a full-recording <details>
// (/api/video, Range/206), and PDF / bug-bundle / ffmpeg-gated clip export (POST /api/pdf,
// /api/bug-bundle, /api/video-clip). The preselected run/test come from the URL query (the
// History "Report this" hand-off), replacing the SPA's in-page pendingShare global.
//
// Toggle elements start with inline display:none (not the hidden attribute) so bug.js's ported
// style.display show/hide logic works verbatim.
export function reportBugBody(): string {
  return `<div class="bug-page">
  <header class="board" style="margin-bottom:0">
    <h1 class="masthead">Report a bug</h1>
    <p class="lede">Pick a failed run and test, confirm the captured evidence, and hand developers a one-click bundle or a single-moment PDF.</p>
  </header>
  <div id="bugNotice" class="callout" data-status="strong" hidden></div>

  <section class="card" data-pad="md">
    <div class="gr-form-row">
      <label class="field" data-size="sm">
        <span class="field__label">Run</span>
        <select class="field__select" id="shareRun"></select>
      </label>
      <label class="field" data-size="sm">
        <span class="field__label">Test</span>
        <select class="field__select" id="shareTest"></select>
      </label>
    </div>
    <p class="cat-intro" id="shareEmpty" style="display:none">No runs captured yet. <a href="/run">Run a check</a> first, then come back to report a failure.</p>
  </section>

  <section class="card" data-pad="md" id="shareBody" style="display:none">
    <div class="section-head"><span>Summary</span></div>
    <div class="gr-md" id="shareSummary"></div>

    <details class="gr-details" id="topConsoleDetails">
      <summary>Console (<span id="topConsoleCount">0</span>)</summary>
      <div class="gr-logs" id="topConsoleLogs"></div>
    </details>
    <details class="gr-details" id="topNetworkDetails">
      <summary>Network (<span id="topNetworkCount">0</span>)</summary>
      <div class="gr-logs" id="topNetworkLogs"></div>
    </details>

    <div class="gr-panel-actions" style="margin-top:var(--space-3)">
      <button class="btn" data-size="sm" type="button" id="copySummaryBtn">Copy summary</button>
      <button class="btn" data-variant="primary" data-size="sm" type="button" id="bundleBtn">Download bug bundle (.zip)</button>
    </div>
  </section>

  <section class="card" data-pad="md" id="pdfCard" style="display:none">
    <div class="gr-card-head">
      <div>
        <div class="section-head"><span>Export a single-moment PDF</span></div>
        <p class="cat-intro">Step through the screenshots the test captured. The console &amp; network for that step (since the previous screenshot) are shown below, so you can confirm the error is captured before you export a one-page PDF.</p>
      </div>
      <div class="segmented" id="pdfLayoutToggle">
        <button type="button" data-layout="full">Full width</button>
        <button type="button" data-layout="half">Half width</button>
      </div>
    </div>

    <div id="pdfLayoutWrap" class="gr-pdf-wrap">
      <div class="gr-pdf-media">
        <div class="gr-preview" id="pdfPreview"></div>
        <div class="gr-scrubber">
          <button class="btn" data-size="sm" type="button" id="snapPrev" title="Previous screenshot">‹</button>
          <input type="range" id="snapRange" min="0" max="0" value="0" aria-label="Screenshot">
          <button class="btn" data-size="sm" type="button" id="snapNext" title="Next screenshot">›</button>
          <span class="gr-scrub-time" id="snapLabel"></span>
        </div>
      </div>
      <div class="gr-moment-cols" id="momentLogs"></div>
    </div>

    <details class="gr-details" id="pdfVideoDetails" style="margin-top:var(--space-4);display:none">
      <summary>Full screen recording</summary>
      <video id="pdfVideo" class="gr-video" controls preload="auto" playsinline muted></video>
      <div class="gr-form-row" style="margin-top:var(--space-3)">
        <button class="btn" data-size="sm" type="button" id="downloadVideoBtn">Download full video (.webm)</button>
        <button class="btn" data-size="sm" type="button" id="downloadClipBtn">Download clip (this step)</button>
        <button class="btn" data-size="sm" type="button" id="downloadFailClipBtn" style="display:none">Download clip near failure</button>
      </div>
      <p class="cat-intro" id="clipNote" style="display:none;margin-top:var(--space-2)">Clip export needs ffmpeg. Playwright normally installs one automatically — none was found, so only the full video can be downloaded.</p>
    </details>

    <div class="gr-form-row" style="margin-top:var(--space-4)">
      <button class="btn" data-variant="primary" type="button" id="pdfBtn" disabled>Download PDF</button>
      <button class="btn" type="button" id="bundleBtn2">Download bug bundle (.zip)</button>
    </div>
  </section>
</div>
<script src="/bug.js" defer></script>`;
}
