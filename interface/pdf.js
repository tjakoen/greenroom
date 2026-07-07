// Builds a one-page PDF report for a chosen snapshot: the screenshot + the
// browser info + the console/network for that test. Rendered with the Chromium
// that Playwright already installed (no extra dependency).
const fs = require('fs');
const { chromium } = require('@playwright/test');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function buildHtml(record, snapshotIndex, opts = {}) {
  const snap = record.snapshots[snapshotIndex] || record.snapshots[record.snapshots.length - 1] || {};
  // A captured video frame (data URL) wins over a pre-saved snapshot.
  let imgData = opts.imageData || '';
  let snapLabel = opts.caption || `${snap.title || '(untitled)'} — ${snap.url || ''}`;
  if (!imgData) {
    try {
      imgData = 'data:image/png;base64,' + fs.readFileSync(snap.file).toString('base64');
    } catch {
      imgData = '';
    }
  }

  const statusColor = record.status === 'passed' ? '#16a34a' : record.status === 'failed' ? '#dc2626' : '#d97706';
  const when = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const dur = record.durationMs ? `${(record.durationMs / 1000).toFixed(1)}s` : '—';

  const infoRows = [
    ['Test', record.title],
    ['Result', record.status],
    ['Environment', record.env],
    ['Snapshot', snapLabel],
    ['Site', record.baseURL],
    ['Browser', record.browser],
    ['User agent', record.userAgent],
    ['Viewport', record.viewport ? `${record.viewport.width} × ${record.viewport.height}` : '—'],
    ['Duration', dur],
    ['Generated', when],
  ];

  const errorBlock = record.error
    ? `<div class="err"><h2>Error</h2><pre>${esc(record.error)}</pre></div>`
    : '';

  // When a video frame was captured at a specific moment, spotlight the browser
  // logs from around that time (±3s) so the page + its logs line up.
  let momentBlock = '';
  if (typeof opts.time === 'number' && (record.consoleTimed?.length || record.networkTimed?.length)) {
    const win = 3000;
    const at = opts.time * 1000;
    const near = (arr) => (arr || []).filter((e) => Math.abs(e.t - at) <= win).map((e) => `${(e.t / 1000).toFixed(1)}s  ${e.line}`);
    const c = near(record.consoleTimed);
    const n = near(record.networkTimed);
    momentBlock =
      `<div class="moment"><h2>Logs around ${opts.time.toFixed(1)}s (this moment ±3s)</h2>` +
      (c.length ? `<pre>${esc(c.join('\n'))}</pre>` : '<p class="muted">No console output in this window.</p>') +
      (n.length ? `<pre>${esc(n.join('\n'))}</pre>` : '<p class="muted">No network issues in this window.</p>') +
      '</div>';
  }

  const consoleBlock = record.console?.length
    ? `<h2>Console (${record.console.length})</h2><pre>${esc(record.console.join('\n'))}</pre>`
    : '<h2>Console</h2><p class="muted">Nothing logged.</p>';

  const networkBlock = record.network?.length
    ? `<h2>Network issues (${record.network.length})</h2><pre>${esc(record.network.join('\n'))}</pre>`
    : '<h2>Network issues</h2><p class="muted">No failed or error responses.</p>';

  const journey = record.snapshots
    .map((s) => `<li>${s.index === snap.index ? '<strong>' : ''}${esc(s.title || s.url)}${s.index === snap.index ? ' — this snapshot</strong>' : ''}</li>`)
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { font: 12px/1.5 -apple-system, Segoe UI, sans-serif; color: #111; margin: 0; padding: 28px 32px; }
    header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 16px; }
    header h1 { font-size: 16px; margin: 0; }
    header .brand { font-size: 11px; color: #666; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; color: #fff; font-weight: 700; font-size: 11px; background: ${statusColor}; text-transform: uppercase; }
    .shot { border: 1px solid #ddd; border-radius: 6px; overflow: hidden; margin: 0 0 18px; }
    .shot img { width: 100%; display: block; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
    td { border-bottom: 1px solid #eee; padding: 5px 6px; vertical-align: top; }
    td.k { color: #666; width: 130px; white-space: nowrap; }
    td.v { word-break: break-word; }
    h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #444; margin: 16px 0 6px; }
    pre { background: #f6f6f7; border: 1px solid #eee; border-radius: 6px; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; font: 10px/1.5 ui-monospace, Menlo, monospace; }
    .muted { color: #999; }
    .err pre { background: #fef2f2; border-color: #fecaca; }
    .moment { border: 1px solid #dbeafe; background: #f5f9ff; border-radius: 6px; padding: 4px 12px 10px; margin: 12px 0; }
    .moment h2 { color: #1d4ed8; }
    ul.journey { margin: 4px 0 0; padding-left: 18px; }
    ul.journey li { margin: 1px 0; }
  </style></head><body>
    <header>
      <h1>Test Snapshot Report</h1>
      <span class="brand">Greenroom</span>
    </header>
    <p><span class="badge">${esc(record.status)}</span></p>
    ${imgData ? `<div class="shot"><img src="${imgData}"></div>` : '<p class="muted">(screenshot unavailable)</p>'}
    <table>${infoRows.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td class="v">${esc(v)}</td></tr>`).join('')}</table>
    ${errorBlock}
    ${momentBlock}
    <h2>Pages visited</h2><ul class="journey">${journey}</ul>
    ${consoleBlock}
    ${networkBlock}
  </body></html>`;
}

async function buildPdf(record, snapshotIndex, opts = {}) {
  const html = buildHtml(record, snapshotIndex, opts);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
    });
  } finally {
    await browser.close();
  }
}

module.exports = { buildPdf, buildHtml };
