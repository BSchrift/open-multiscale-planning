import { defineConfig, devices } from '@playwright/test';
import { deployed } from './target';

// The web app as people get it: the production build, from its host, behind its security policy, signed in through the
// hosted sign-in page as the deployment's test user. Nothing local serves it. One worker, since the specs share that
// user, and each project signs in once.
const { url } = deployed();

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
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 1000 } } },
    { name: 'phone', use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
  ],
});
