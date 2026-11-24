import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';
import { assertInstalled } from '../../scripts/installed';

// A node_modules behind package-lock.json stops the run here, saying so, rather than failing tests as if the app had.
assertInstalled(join(import.meta.dirname, '../..'));

// The performance runner (scripts/test-perf.sh, docs/performance.md): the browser's KPIs in desktop Chromium and in
// Chromium at a phone's size with its CPU slowed, and the Mac app's, against the builds PERF_TARGETS and
// PERF_MAC_TARGETS name. One worker, so nothing else runs beside a timing, with fixed window sizes and Chromium's
// background throttling off.
const quiet = ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

export default defineConfig({
  testDir: '.',
  outputDir: '../../test-results/perf/playwright',
  workers: 1,
  reporter: 'line',
  use: { trace: 'off', launchOptions: { args: quiet } },
  projects: [
    { name: 'web-desktop', testMatch: 'web.spec.ts', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 1000 }, launchOptions: { args: quiet } } },
    // Chromium, since only it can slow the CPU.
    { name: 'web-phone', testMatch: 'web.spec.ts', use: { ...devices['iPhone 13'], browserName: 'chromium', viewport: { width: 390, height: 844 }, launchOptions: { args: quiet } } },
    { name: 'mac', testMatch: 'mac.spec.ts' },
    // Two signed-in browsers through the local stack behind Toxiproxy: PERF_SYNC=1 in scripts/test-perf.sh.
    { name: 'sync', testMatch: 'sync.spec.ts', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 1000 }, launchOptions: { args: quiet } } },
  ],
});
