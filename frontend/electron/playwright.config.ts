import { defineConfig } from '@playwright/test';

// One worker: the global shortcut belongs to whichever instance registered it first.
export default defineConfig({
  testDir: 'e2e',
  outputDir: '../test-results/electron',
  workers: 1,
  reporter: 'line',
  timeout: 60_000,
  use: { trace: 'retain-on-failure' },
});
