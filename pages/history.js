'use strict';
// pages/history.js — the thin client module behind /history (P5). Plain, dependency-free browser
// JS (no bundler, no TS), same pattern as pages/run.js (P4) and pages/tests.js (P3). Talks to the
// SAME endpoints interface/app.js's #/history used (GET /api/runs, GET /api/pdf-data), with the
// same run-object shape ({ id, when, env, result }); this file only changes how rows are RENDERED
// (grain .gr-rows / .badge, monochrome) and — since the app is now multi-page — hands off "Report
// this" to /bug via query params (run + first failed test) instead of the SPA's pendingShare global.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Monochrome, like the Run dashboard: the glyph carries the pass/fail signal, not a hue.
  const statusMark = (r) => (r === 'passed' ? '✓' : r === 'failed' ? '✕' : '○');

  function toast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('is-show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('is-show'), 2600);
  }
  const api = (path, opts) => fetch(path, opts).then((r) => r.json());

  let allRuns = [];

  function renderRuns() {
    const list = $('historyList');
    const q = ($('historySearch').value || '').trim().toLowerCase();
    const rows = allRuns.filter(
      (r) => !q || String(r.env || '').toLowerCase().includes(q) || String(r.result || '').toLowerCase().includes(q),
    );
    $('historyEmpty').hidden = allRuns.length > 0;
    list.innerHTML = rows
      .map((r) => {
        const id = encodeURIComponent(r.id);
        const failed = r.result === 'failed';
        const report = `/runs/${id}/`;
        return `<li class="gr-row" data-run="${esc(r.id)}">
          <div class="gr-row-main">
            <div class="gr-row-title">${esc(r.env || '(run)')}</div>
            <div class="gr-row-sub">${esc(r.when || '')}</div>
          </div>
          <span class="badge" title="${esc(r.result || '')}">${statusMark(r.result)} ${esc(r.result || '')}</span>
          <div class="gr-row-actions">
            ${failed ? `<button class="btn" data-size="sm" type="button" data-reportrun="${esc(r.id)}">Report this</button>` : ''}
            <a class="btn" data-size="sm" href="${report}" target="_blank" rel="noopener noreferrer">Open report ↗</a>
          </div>
        </li>`;
      })
      .join('');
    list.querySelectorAll('[data-reportrun]').forEach((btn) => {
      btn.onclick = () => reportRunFailure(btn.getAttribute('data-reportrun'));
    });
  }

  // "Report this" on a failed run: find its first failed test, then hand off to /bug with the run
  // + test preselected via query params (mirrors the SPA's reportRunFailure → goToShare, minus the
  // in-page pendingShare global — /bug reads run/test from its own URL on load).
  async function reportRunFailure(runId) {
    const data = await api('/api/pdf-data?run=' + encodeURIComponent(runId));
    const tests = Array.isArray(data) ? data : (data && data.records) || [];
    const failed = tests.find((t) => t.status === 'failed') || tests[0];
    const q = new URLSearchParams({ run: runId });
    if (failed) {
      q.set('test', failed.test);
      if (failed.title) q.set('title', failed.title);
    }
    location.href = '/bug?' + q.toString();
  }

  async function init() {
    $('historySearch').oninput = renderRuns;
    const runs = await api('/api/runs');
    allRuns = Array.isArray(runs) ? runs : (runs && runs.runs) || [];
    renderRuns();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
