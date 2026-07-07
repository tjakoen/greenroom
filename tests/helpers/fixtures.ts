import { test as base, expect } from '@playwright/test';
import * as fs from 'fs';

/**
 * Extended `test` that, for every test, records:
 *  - the browser CONSOLE and NETWORK (attached to the HTML report), and
 *  - a **snapshot** (screenshot + url + title) each time a page finishes loading,
 *    plus a final one — so the app can offer a "pick a snapshot → export PDF".
 *
 * Import from here instead of '@playwright/test':
 *   import { test, expect } from '../helpers/fixtures';
 *
 * The snapshot data + browser info are written to `pdf-record.json` in each
 * test's output folder; the interface reads those to build a PDF report.
 */
export const test = base.extend<{ captureLogs: void }>({
  captureLogs: [
    async ({ page }, use, testInfo) => {
      const consoleLines: string[] = [];
      const networkLines: string[] = [];
      // Same lines tagged with a millisecond offset from test start, so the app can
      // show "what the browser logged around this video moment" when a frame is
      // captured. t=0 ≈ when the page opened ≈ start of the recorded video (approx).
      const consoleTimed: Array<{ t: number; line: string }> = [];
      const networkTimed: Array<{ t: number; line: string }> = [];
      const t0 = Date.now();
      const now = () => Date.now() - t0;
      const snapshots: Array<{ index: number; url: string; title: string; file: string; final?: boolean }> = [];
      let snapIdx = 0;
      let busy = false;

      const pushConsole = (line: string) => { consoleLines.push(line); consoleTimed.push({ t: now(), line }); };
      const pushNetwork = (line: string) => { networkLines.push(line); networkTimed.push({ t: now(), line }); };
      page.on('console', (msg) => pushConsole(`[${msg.type()}] ${msg.text()}`));
      page.on('pageerror', (err) => pushConsole(`[pageerror] ${err.message}`));
      page.on('requestfailed', (req) => pushNetwork(`FAILED ${req.method()} ${req.url()} — ${req.failure()?.errorText ?? ''}`));
      page.on('response', (res) => {
        if (res.status() >= 400) pushNetwork(`${res.status()} ${res.request().method()} ${res.url()}`);
      });

      // One snapshot per fully-loaded page. Best-effort: never fail the test.
      page.on('load', async () => {
        if (busy || snapIdx >= 25) return;
        busy = true;
        try {
          const file = testInfo.outputPath(`snapshot-${snapIdx}.png`);
          await page.screenshot({ path: file, fullPage: false });
          snapshots.push({ index: snapIdx, url: page.url(), title: await page.title().catch(() => ''), file });
          snapIdx++;
        } catch {
          // page navigated/closed mid-shot — skip it
        } finally {
          busy = false;
        }
      });

      await use();

      // Final snapshot of wherever the test ended.
      try {
        const file = testInfo.outputPath(`snapshot-${snapIdx}.png`);
        await page.screenshot({ path: file, fullPage: false });
        snapshots.push({ index: snapIdx, url: page.url(), title: await page.title().catch(() => ''), file, final: true });
      } catch {
        /* ignore */
      }

      let userAgent = '';
      try {
        userAgent = await page.evaluate(() => navigator.userAgent);
      } catch {
        /* page may be closed */
      }

      if (consoleLines.length) {
        await testInfo.attach('console.log', { body: consoleLines.join('\n'), contentType: 'text/plain' });
      }
      if (networkLines.length) {
        await testInfo.attach('network.log', { body: networkLines.join('\n'), contentType: 'text/plain' });
      }

      // The record the interface reads to build a PDF.
      const record = {
        title: testInfo.titlePath.filter(Boolean).join(' › '),
        status: testInfo.status,
        env: process.env.TEST_ENV || '',
        project: testInfo.project.name,
        browser: testInfo.project.use?.browserName || 'chromium',
        userAgent,
        viewport: page.viewportSize(),
        baseURL: (testInfo.project.use as { baseURL?: string })?.baseURL || '',
        durationMs: testInfo.duration,
        error: testInfo.error?.message || '',
        snapshots,
        console: consoleLines,
        network: networkLines,
        consoleTimed,
        networkTimed,
      };
      try {
        fs.writeFileSync(testInfo.outputPath('pdf-record.json'), JSON.stringify(record, null, 2));
      } catch {
        /* ignore */
      }
    },
    { auto: true },
  ],
});

export { expect };
