import { defineConfig, devices } from '@playwright/test';
import { target } from './target';
import { join } from 'node:path';
import { assertInstalled } from '../../scripts/installed';

// A node_modules behind package-lock.json stops the run here, saying so, rather than failing tests as if the app had.
assertInstalled(join(import.meta.dirname, '../..'));

// The browser build signed in to a real backend, as two devices: each test opens its own browser contexts. They share
// one server and, locally, its clock, so they run one at a time. The dev server's port reaches the tests as
// STACK_WEB_PORT.
const { webPort } = target();

export default defineConfig({
  testDir: '.',
  outputDir: '../../test-results/stack',
  workers: 1,
  // CI also writes an HTML report, which it keeps when a run fails.
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  timeout: 90_000,
  use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 1000 }, trace: 'retain-on-failure' },
  projects: [
    { name: 'stack', testIgnore: 'history-journey.spec.ts' },
    // The deployed suite's journey on a five-year account waits as the deployed suite does, since its reads take seconds.
    { name: 'history', testMatch: 'history-journey.spec.ts', expect: { timeout: 15_000 } },
  ],
  webServer: {
    command: `npx vite --port ${webPort} --strictPort`,
    cwd: '../..',
    wait: { stdout: /Local:\s+http:\/\/localhost:(?<stack_web_port>\d+)/ },
    reuseExistingServer: false,
  },
});
