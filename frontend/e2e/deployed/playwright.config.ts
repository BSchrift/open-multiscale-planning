import { defineConfig, devices } from '@playwright/test';
import { deployed } from './target';
import { join } from 'node:path';
import { assertInstalled } from '../../scripts/installed';

// A node_modules behind package-lock.json stops the run here, saying so, rather than failing tests as if the app had.
assertInstalled(join(import.meta.dirname, '../..'));

// The web app as people get it: the production build, from its host, behind its security policy, signed in through the
// hosted sign-in page as the deployment's test user. Nothing local serves it. One worker, since the specs share that
// user, and each project signs in once.
const { url, history } = deployed();
const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 1000 } };
const historySeed = /\/history-seed\.setup\.ts$/;

export default defineConfig({
  testDir: '.',
  outputDir: '../../test-results/deployed',
  workers: 1,
  // A line for each test as it ends, with how long it took. CodeBuild keeps only the log, and a long history's steps
  // that are slowing down show there before they run out of time.
  reporter: 'list',
  timeout: 120_000,
  // A screen reads the shared test user's whole history again after each change. On prod's, on 15 November, Week showed
  // a one off just added only once Playwright's 5 seconds had run out: the snapshot taken as they did already had it.
  expect: { timeout: 15_000 },
  use: { baseURL: url, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', testIgnore: historySeed, use: desktop },
    { name: 'phone', testIgnore: historySeed, use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
    // Staging's history user, when test-deployed.sh names it: its five-year account seeded, then a desktop browser of it,
    // so a long first sync, the large database it leaves, and the journey on it meet what prod's shared test user's long
    // history holds before prod does. Staging's own test user holds next to nothing, since its periods are minutes.
    ...(history
      ? [
          { name: 'history-seed', testMatch: 'history-seed.setup.ts' },
          { name: 'history', testMatch: 'web.spec.ts', dependencies: ['history-seed'], use: desktop },
        ]
      : []),
  ],
});
