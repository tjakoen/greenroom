import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import { getEnv, getEnvName, getSelectedEnvs, baseURLof } from './config/environments';

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
  // html = the rich report; list = live stdout the app parses into a checklist;
  // json = per-test results the app's Tests library + readable run view read.
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
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
