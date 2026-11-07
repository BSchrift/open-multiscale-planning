import { defineConfig } from '@playwright/test';

// One worker: the global shortcut belongs to whichever instance registered it first.
export default defineConfig({
  testDir: 'e2e',
  outputDir: '../test-results/electron',
  workers: 1,
  // CI also writes an HTML report, which it keeps when a run fails.
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  timeout: 60_000,
  use: { trace: 'retain-on-failure' },
});
