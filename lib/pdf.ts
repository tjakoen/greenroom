// lib/pdf.ts — Builds a one-page PDF report for a chosen snapshot: the screenshot + the
// browser info + the console/network for that test. Rendered with the Chromium
// that Playwright already installed (no extra dependency).
// Ported from interface/pdf.js.
import { readFileSync } from "node:fs";
// `chromium` is imported DYNAMICALLY at its one call site, not here. A static import pulls
// playwright-core into the module graph at build time, and playwright-core has optional deps
// (chromium-bidi) that cannot be resolved by a bundler, which makes `bun build --compile` fail
// outright. PDF export is a lazy, on-demand feature, so deferring the import costs nothing at
// runtime and keeps a standalone binary buildable. Same reasoning in lib/recorder.ts.

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c]);

// Playwright's error/console text carries ANSI colour codes (e.g. "\x1b[31m").
// Strip them so the PDF shows readable text, not "[2m…[39m" garbage.
const stripAnsi = (s: unknown): string => String(s ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const clean = (s: unknown): string => esc(stripAnsi(s));

export interface BuildPdfOpts {
  from?: number;
  to?: number;
}

export function buildHtml(record: any, snapshotIndex: number, opts: BuildPdfOpts = {}): string {
  const snap = record.snapshots[snapshotIndex] || record.snapshots[record.snapshots.length - 1] || {};
  const snapLabel = `${snap.title || "(untitled)"} — ${snap.url || ""}`;
  let imgData = "";
  try {
    imgData = "data:image/png;base64," + readFileSync(snap.file).toString("base64");
  } catch {
    imgData = "";
  }

  const statusColor = record.status === "passed" ? "#16a34a" : record.status === "failed" ? "#dc2626" : "#d97706";
  const when = new Date().toISOString().replace("T", " ").slice(0, 19);
  const dur = record.durationMs ? `${(record.durationMs / 1000).toFixed(1)}s` : "—";

  const infoRows = [
    ["Test", record.title],
    ["Result", record.status],
    ["Environment", record.env],
    ["Snapshot", snapLabel],
    ["Site", record.baseURL],
    ["Browser", record.browser],
    ["User agent", record.userAgent],
    ["Viewport", record.viewport ? `${record.viewport.width} × ${record.viewport.height}` : "—"],
    ["Duration", dur],
    ["Generated", when],
  ];

  const errorBlock = record.error
    ? `<div class="err"><h2>Error</h2><pre>${clean(record.error)}</pre></div>`
    : "";

  // A moment PDF is scoped to exactly [from, to] ms — the interval since the
  // previous screenshot, matching what the on-screen scrubber showed when the
  // user chose to export. No other console/network dump is included: this is
  // deliberately *only* that moment, not the whole test's logs (those live in
  // the bug bundle's console.txt/network.txt).
  let logsBlock: string;
  const hasInterval = typeof opts.from === "number" && typeof opts.to === "number";
  const hasTiming = (record.consoleTimed?.length || record.networkTimed?.length || record.requests?.length) > 0;
  if (hasInterval && hasTiming) {
    const within = (arr: any[]) => (arr || []).filter((e) => e.t >= (opts.from as number) && e.t <= (opts.to as number));
    const c = within(record.consoleTimed).map((e) => `${(e.t / 1000).toFixed(1)}s  ${e.line}`);
    const reqs = record.requests?.length ? within(record.requests) : null;
    const n = reqs
      ? reqs.map((e: any) => `${(e.t / 1000).toFixed(1)}s  ${e.status === 0 ? "ERR" : e.status} ${e.method} ${e.url}`)
      : within(record.networkTimed).map((e) => `${(e.t / 1000).toFixed(1)}s  ${e.line}`);
    logsBlock =
      `<h2>Console — this moment</h2>` +
      (c.length ? `<pre>${clean(c.join("\n"))}</pre>` : '<p class="muted">No console output in this window.</p>') +
      `<h2>Network — this moment${reqs ? ` (${n.length} request${n.length === 1 ? "" : "s"})` : " issues"}</h2>` +
      (n.length ? `<pre>${clean(n.join("\n"))}</pre>` : '<p class="muted">No network activity in this window.</p>');
  } else {
    // Older runs recorded before per-line timing existed — fall back to the
    // whole test's logs so the PDF still has something useful.
    logsBlock =
      (record.console?.length
        ? `<h2>Console (${record.console.length})</h2><pre>${clean(record.console.join("\n"))}</pre>`
        : '<h2>Console</h2><p class="muted">Nothing logged.</p>') +
      (record.network?.length
        ? `<h2>Network issues (${record.network.length})</h2><pre>${clean(record.network.join("\n"))}</pre>`
        : '<h2>Network issues</h2><p class="muted">No failed or error responses.</p>');
  }

  const journey = record.snapshots
    .map((s: any) => `<li>${s.index === snap.index ? "<strong>" : ""}${esc(s.title || s.url)}${s.index === snap.index ? " — this snapshot</strong>" : ""}</li>`)
    .join("");

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
    ul.journey { margin: 4px 0 0; padding-left: 18px; }
    ul.journey li { margin: 1px 0; }
  </style></head><body>
    <header>
      <h1>Test Snapshot Report</h1>
      <span class="brand">Greenroom</span>
    </header>
    <p><span class="badge">${esc(record.status)}</span></p>
    ${imgData ? `<div class="shot"><img src="${imgData}"></div>` : '<p class="muted">(screenshot unavailable)</p>'}
    <table>${infoRows.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td class="v">${esc(v)}</td></tr>`).join("")}</table>
    ${errorBlock}
    <h2>Pages visited</h2><ul class="journey">${journey}</ul>
    ${logsBlock}
  </body></html>`;
}

export async function buildPdf(record: any, snapshotIndex: number, opts: BuildPdfOpts = {}): Promise<Buffer> {
  const html = buildHtml(record, snapshotIndex, opts);
  // Dynamic on purpose — see the note where the static import used to be, at the top of this file.
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" },
    });
  } finally {
    await browser.close();
  }
}
