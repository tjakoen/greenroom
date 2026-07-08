import { test as base, expect } from '@playwright/test';
import * as fs from 'fs';
import { login as doLogin } from './auth';

/**
 * Extended `test` that, for every test, records:
 *  - the browser CONSOLE and NETWORK (attached to the HTML report), and
 *  - a **snapshot** (screenshot + url + title) each time a page finishes loading,
 *    plus a final one — so the app can offer a "pick a snapshot → export PDF".
 *
 * Import from here instead of '@playwright/test':
 *   import { test, expect } from '../helpers/fixtures';
 *
 * Two extras it exposes:
 *  - `envName` — an option each Playwright project sets (`use: { envName }`) so a
 *    test knows which environment/site it is running against. In a simultaneous
 *    multi-environment run there's one project per env, each with its own envName.
 *  - `login` — a fixture bound to that envName: `await login('admin')` logs in
 *    with the correct per-environment account (no need to pass env by hand).
 *
 * The snapshot data + browser info are written to `pdf-record.json` in each
 * test's output folder; the interface reads those to build a PDF report.
 */
type GrFixtures = {
  captureLogs: void;
  /** The environment/site this test runs against; set per-project in playwright.config.ts. */
  envName: string;
  /** Log in as a role using this project's environment account. */
  login: (role: string) => Promise<void>;
};

export const test = base.extend<GrFixtures>({
  // Option: overridden per project via `use: { envName: '<env>' }`. Empty string
  // means "use the process-wide TEST_ENV" (the single-environment path).
  envName: ['', { option: true }],

  // Env-aware login. Passing '' as env makes auth/getUser fall back to TEST_ENV,
  // preserving the single-environment behaviour. GR_ROLE, when set by the Run page's
  // "Run as" override, replaces the role the test asked for — so the same flow can be
  // exercised as a different account (permission testing). Unset → each test keeps
  // its own role.
  login: async ({ page, envName }, use) => {
    await use((role: string) => doLogin(page, process.env.GR_ROLE || role, envName || undefined));
  },

  captureLogs: [
    async ({ page, envName }, use, testInfo) => {
      const consoleLines: string[] = [];
      const networkLines: string[] = [];
      // Same lines tagged with a millisecond offset from test start, so the app can
      // show "what the browser logged around this screenshot". t=0 ≈ when the
      // fixture started ≈ start of the recording (approx).
      const consoleTimed: Array<{ t: number; line: string }> = [];
      const networkTimed: Array<{ t: number; line: string }> = []; // network *issues* only (4xx/5xx/failed)
      // Every network request (not only failures), so the app can show the actual
      // traffic around a moment — method, status, url, resource type.
      const requests: Array<{ t: number; method: string; status: number; url: string; type: string; failed?: string }> = [];
      const t0 = Date.now();
      const now = () => Date.now() - t0;
      const snapshots: Array<{ index: number; t: number; url: string; title: string; file: string; final?: boolean }> = [];
      let snapIdx = 0;
      let busy = false;

      const pushConsole = (line: string) => { consoleLines.push(line); consoleTimed.push({ t: now(), line }); };
      const pushNetwork = (line: string) => { networkLines.push(line); networkTimed.push({ t: now(), line }); };
      const pushRequest = (r: { method: string; status: number; url: string; type: string; failed?: string }) => {
        if (requests.length < 3000) requests.push({ t: now(), ...r });
      };
      page.on('console', (msg) => pushConsole(`[${msg.type()}] ${msg.text()}`));
      page.on('pageerror', (err) => pushConsole(`[pageerror] ${err.message}`));
      page.on('response', (res) => {
        const req = res.request();
        pushRequest({ method: req.method(), status: res.status(), url: res.url(), type: req.resourceType() });
        if (res.status() >= 400) pushNetwork(`${res.status()} ${req.method()} ${res.url()}`);
      });
      page.on('requestfailed', (req) => {
        const errText = req.failure()?.errorText ?? '';
        pushRequest({ method: req.method(), status: 0, url: req.url(), type: req.resourceType(), failed: errText });
        pushNetwork(`FAILED ${req.method()} ${req.url()} — ${errText}`);
      });

      // Screenshots as a filmstrip — more than one per navigation. Best-effort,
      // never fails the test. `light` capture keeps only a few frames for speed.
      const light = process.env.CAPTURE === 'light';
      const CAP = light ? 8 : 60;
      async function snap(final = false): Promise<void> {
        if (busy || (!final && snapIdx >= CAP)) return;
        busy = true;
        try {
          const file = testInfo.outputPath(`snapshot-${snapIdx}.png`);
          await page.screenshot({ path: file, fullPage: false, timeout: 5000 });
          snapshots.push({ index: snapIdx, t: now(), url: page.url(), title: await page.title().catch(() => ''), file, ...(final ? { final: true } : {}) });
          snapIdx++;
        } catch {
          // navigating/closed mid-shot — skip it
        } finally {
          busy = false;
        }
      }
      page.on('load', () => { void snap(); });
      // SPA route changes (history.pushState) fire this without a full load.
      page.on('framenavigated', (f) => { if (f === page.mainFrame()) void snap(); });
      const filmstrip = light ? null : setInterval(() => { void snap(); }, 1000);

      // Snapshot shortly after a UI interaction (click / input / submit) so states
      // that don't trigger a navigation still get captured. Best-effort.
      if (!light) {
        try {
          await page.exposeFunction('__grSnap', () => { void snap(); });
          await page.addInitScript(() => {
            let tmr: any;
            const ping = () => (window as unknown as { __grSnap?: () => void }).__grSnap?.();
            const deb = () => { clearTimeout(tmr); tmr = setTimeout(ping, 250); };
            for (const ev of ['click', 'change', 'submit']) document.addEventListener(ev, deb, true);
          });
        } catch {
          /* instrumentation is best-effort — never break the test */
        }
      }

      await use();

      if (filmstrip) clearInterval(filmstrip);
      // Let any in-flight shot finish, then capture where the test ended.
      for (let i = 0; i < 20 && busy; i++) await new Promise((r) => setTimeout(r, 50));
      await snap(true);

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
        // Prefer the project's own env (set in a multi-env run); fall back to the
        // process-wide TEST_ENV for the single-environment path.
        env: envName || process.env.TEST_ENV || '',
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
        requests,
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
