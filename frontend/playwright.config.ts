import { defineConfig, devices } from '@playwright/test';

// Screens run against the browser build: its database is on OPFS in desktop Chromium, and in memory and IndexedDB in
// phone WebKit, whose ephemeral contexts have no OPFS. storage.spec.ts opens a profile on disk to reach OPFS in both.
// Each test gets a fresh browser context, so it starts from an empty, first-run app.
// E2E_PORT gives a run its own dev server, so runs side by side don't share one.
const port = Number(process.env.E2E_PORT) || 5183;
export default defineConfig({
  testDir: 'e2e',
  // Those sign in to a backend, check a deployment or need two builds, and run from their own configs.
  testIgnore: ['**/e2e/stack/**', '**/e2e/deployed/**', '**/e2e/compat/**'],
  fullyParallel: true,
  // CI also writes an HTML report, which it keeps when a run fails.
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 1000 } } },
    { name: 'phone', use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
  ],
});
