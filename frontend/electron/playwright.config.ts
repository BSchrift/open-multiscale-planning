import { defineConfig } from '@playwright/test';

// The browser's specs that import e2e/platform.ts run on the Mac app from here. Workers read this file too.
process.env.E2E_PLATFORM = 'mac';

// One worker: the global shortcut belongs to whichever instance registered it first.
export default defineConfig({
  outputDir: '../test-results/electron',
  workers: 1,
  // CI also writes an HTML report, which it keeps when a run fails: in frontend/playwright-report, where it looks.
  reporter: process.env.CI ? [['line'], ['html', { open: 'never', outputFolder: '../playwright-report' }]] : 'line',
  timeout: 60_000,
  use: { trace: 'retain-on-failure' },
  projects: [
    // The shell and what only the Mac app has: its windows, tray, shortcut, keychain and notifications.
    { name: 'mac', testDir: 'e2e' },
    // The browser's journeys, each from an empty first run through days and weeks of use, on the Mac app.
    { name: 'journeys', testDir: '../e2e/journeys' },
  ],
});
