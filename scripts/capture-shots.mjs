// Capture Greenroom's own UI screenshots for the features page (docs/shots/).
// Run against a DEMO-mode server so the shots show seeded, safe, populated data:
//
//   GREENROOM_DEMO=1 PORT=4399 bun server.ts &
//   node scripts/capture-shots.mjs
//
// Re-run whenever the UI changes. Screenshots are deterministic at a fixed
// viewport. Uses Playwright (already a dev dependency); no new packages.
//
// NOTE: these are REAL routes (/run, /tests, …), not the old SPA's `/#/run` hash
// routes — the P6 cutover deleted `interface/` and every page became a GRAIN
// route. Capturing hash routes silently produced shots of whatever `/` served.
import { chromium } from '@playwright/test';

const BASE = process.env.SHOTS_BASE || 'http://localhost:4399';
// decodeURIComponent so a repo path containing spaces isn't left %20-encoded.
const OUT = decodeURIComponent(new URL('../docs/shots/', import.meta.url).pathname);

// One entry per distinct shot. `path` must differ per file — two entries pointing
// at the same route is how docs/shots/matrix.png ended up byte-identical to
// run-dashboard.png (audit 2026-07-30).
// `prepare` runs before the screenshot, for shots that need a UI state a bare
// page load doesn't reach (the test × environment matrix only renders once more
// than one environment is selected).
const PAGES = [
  { path: '/run', file: 'run-dashboard.png' },
  {
    path: '/run',
    file: 'matrix.png',
    prepare: async (page) => {
      // the seeded "non-prod" group selects demo + demo2, which flips the
      // results view from a checklist to the matrix table
      const group = page.locator('text=NON-PROD').first();
      if (!(await group.count())) throw new Error('no saved group chip — cannot reach the matrix');
      await group.click();
      const table = page.locator('.table').first();
      await table.waitFor({ timeout: 5000 });
      // the matrix sits below the fold at this viewport; frame it, not the header
      await table.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
    },
  },
  { path: '/settings', file: 'roles.png' },
  { path: '/tests', file: 'tests.png' },
  { path: '/editor', file: 'editor.png' },
];

// Two shots may share a route only when at least one reaches a distinct state via
// `prepare`; without that they would be byte-identical (the bug this replaced).
const plain = new Set();
for (const { path, file, prepare } of PAGES) {
  if (!prepare) {
    if (plain.has(path)) throw new Error(`two unprepared shots share ${path} — they would be identical`);
    plain.add(path);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// First visit shows a modal welcome dialog, which both covers the UI and swallows clicks
// (it silently broke the matrix shot's group-chip click). Set the same flag its own script
// checks, so every shot is of the normal, returning-visitor state.
await page.goto(`${BASE}/run`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { try { localStorage.setItem('gr_welcomed', '1'); } catch {} });

for (const { path, file, prepare } of PAGES) {
  const res = await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  if (!res || !res.ok()) throw new Error(`${path} returned ${res ? res.status() : 'no response'}`);
  await page.waitForTimeout(1200); // let the page's own fetches settle
  const modal = page.locator('#gr-welcome:not([hidden])');
  if (await modal.count()) throw new Error(`${path}: welcome modal still showing — it would cover the shot`);
  if (prepare) await prepare(page);
  await page.screenshot({ path: OUT + file });
  console.log('captured', file, '<-', path, prepare ? '(prepared)' : '');
}
await browser.close();
