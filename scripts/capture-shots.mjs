// Capture Greenroom's own UI screenshots for the features page (docs/shots/).
// Run against a DEMO-mode server so the shots show seeded, safe, populated data:
//
//   GREENROOM_DEMO=1 PORT=4399 node interface/server.js &
//   node scripts/capture-shots.mjs
//
// Re-run whenever the UI changes. Screenshots are deterministic at a fixed
// viewport. Uses Playwright (already a dev dependency); no new packages.
import { chromium } from '@playwright/test';

const BASE = process.env.SHOTS_BASE || 'http://localhost:4399';
// decodeURIComponent so a repo path containing spaces isn't left %20-encoded.
const OUT = decodeURIComponent(new URL('../docs/shots/', import.meta.url).pathname);

const PAGES = [
  { hash: 'run', file: 'run-dashboard.png' },
  { hash: 'run', file: 'matrix.png' }, // the run dashboard renders a test × environment matrix
  { hash: 'settings', file: 'roles.png' },
  { hash: 'tests', file: 'tests.png' },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
for (const { hash, file } of PAGES) {
  await page.goto(`${BASE}/#/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: OUT + file });
  console.log('captured', file);
}
await browser.close();
