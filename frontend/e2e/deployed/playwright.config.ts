import { defineConfig, devices } from '@playwright/test';
import { deployed } from './target';

// The web app as people get it: the production build, from its host, behind its security policy, signed in through the
// hosted sign-in page as the deployment's test user. Nothing local serves it. One worker, since the specs share that
// user, and each project signs in once.
const { url, history } = deployed();
const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 1000 } };
const historyFiles = /\/history-(seed\.setup|journey\.spec)\.ts$/;

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
    { name: 'desktop', testIgnore: historyFiles, use: desktop },
    { name: 'phone', testIgnore: historyFiles, use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
    // Staging's history user, when test-deployed.sh names it: its five-year account seeded, then the desktop journey on
    // it, so a long history's slow reads meet the journey before prod's shared test user does.
    ...(history
      ? [
          { name: 'history-seed', testMatch: 'history-seed.setup.ts' },
          { name: 'history-journey', testMatch: 'history-journey.spec.ts', dependencies: ['history-seed'], use: desktop },
        ]
      : []),
  ],
});
