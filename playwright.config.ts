import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import { getEnv, getEnvName, getSelectedEnvs, baseURLof } from './config/environments';

// Gate A (plans/platform.md §6): each run gets its own output dir instead of the three shared,
// overwritten-each-run paths (playwright-report/, test-results/, test-results/results.json).
// lib/runner.ts sets GR_RUN_DIR to an absolute per-run dir before spawning; unset (hand-run
// `npx playwright test`) falls back to today's defaults so nothing breaks outside the app.
const RUN_DIR = process.env.GR_RUN_DIR;
// The html reporter's outputFolder (RUN_DIR) and the tests' outputDir must NOT nest — Playwright's
// html reporter recursively clears its ENTIRE outputFolder tree when it writes the report, which
// destroys anything written under it during the run (snapshots, our pdf-record.json, per-test
// trace.zip/video.webm) even if the reporter's own json output survives (it's written after the
// clear). Confirmed by hand: nesting outputDir under RUN_DIR silently wiped every per-test folder.
// So the live results dir is a SIBLING of RUN_DIR, not a child — lib/records.ts's archiveRun
// renames both into place (index.html at the final dir's root, results/ as its sibling-turned-
// child) once Playwright has completely finished and can no longer touch either.
const RESULTS_DIR = RUN_DIR ? `${RUN_DIR}-results` : undefined;

// Custom test options this project defines (see tests/helpers/fixtures.ts).
// `envName` tells each project which environment/site it runs against.
type GrOptions = { envName: string };

// Load optional .env (URLs overrides etc). roles.json holds logins, not this.
dotenv.config();

const env = getEnv();

// FULL CAPTURE by default: every test records a trace (per-step screenshots +
// the browser's console & network + the step list), a video, and a screenshot.
// Open a test in the report and click the trace to get:
//   right pane  = the steps Playwright took
//   top         = a screenshot per step (filmstrip)
//   bottom tabs = Console + Network of the browser
// Set CAPTURE=light for faster runs that only keep artifacts on failure.
const light = process.env.CAPTURE === 'light';

export default defineConfig<GrOptions>({
  testDir: './tests',
  // Producers run one env at a time via the npm scripts; no cross-env bleed.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  // Gate A: per-run snapshots/videos/traces land under <RUN_DIR>-results/<test>/ (a SIBLING of
  // RUN_DIR — see RESULTS_DIR above) instead of the shared test-results/; archiveRun renames it to
  // <finalDest>/results so records.ts's collectRecords still just walks a "results" subfolder.
  outputDir: RESULTS_DIR,
  // html = the rich report; list = live stdout the app parses into a checklist;
  // json = per-test results the app's Tests library + readable run view read.
  reporter: [
    ['html', { open: 'never', outputFolder: RUN_DIR ?? 'playwright-report' }],
    ['list'],
    ['json', { outputFile: RESULTS_DIR ? join(RESULTS_DIR, 'results.json') : 'test-results/results.json' }],
  ],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: env.baseURL,
    trace: light ? 'on-first-retry' : 'on',
    screenshot: light ? 'only-on-failure' : 'on',
    video: light ? 'retain-on-failure' : 'on',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  // One project per selected env (TEST_ENVS) for simultaneous multi-env runs;
  // the single-env path (TEST_ENV / default) yields exactly one project.
  // envName tells the login fixture which environment's account to use, and the
  // `chromium (<env>)` name is parsed by the app to attribute results per env.
  projects: getSelectedEnvs().map((env) => ({
    name: `chromium (${env})`,
    use: { ...devices['Desktop Chrome'], baseURL: baseURLof(env), envName: env },
  })),
});
