import { defineConfig, devices } from '@playwright/test';
import { deployed } from './target';

// The web app as people get it: the production build, from its host, behind its security policy, signed in through the
// hosted sign-in page as the deployment's test user, and on staging as its history user too. Nothing local serves it.
// One worker, since the specs share that user, and each project signs in once.
const { url, env } = deployed();
const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 1000 } };

export default defineConfig({
  testDir: '.',
  outputDir: '../../test-results/deployed',
  workers: 1,
  reporter: 'line',
  timeout: 120_000,
  // A screen reads the shared test user's whole history again after each change. On prod's, on 15 November, Week showed
  // a one off just added only once Playwright's 5 seconds had run out: the snapshot taken as they did already had it.
  expect: { timeout: 15_000 },
  use: { baseURL: url, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: desktop },
    { name: 'phone', use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
    // Staging only: a desktop browser of the history-scale test's five-year account, so the long first sync, and the
    // large database it leaves, are checked before prod. Staging's own test user holds next to nothing, since its
    // deleted period is minutes, while prod's held tens of thousands of records in November.
    ...(env === 'staging' ? [{ name: 'history', testMatch: 'web.spec.ts', use: desktop }] : []),
  ],
});
