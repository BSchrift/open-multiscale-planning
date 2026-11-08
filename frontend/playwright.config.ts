import { defineConfig, devices } from '@playwright/test';

// Screens run against the browser build with its in-memory database.
// Each test gets a fresh browser context, so it starts from an empty, first-run app.
// E2E_PORT gives a run its own dev server, so runs side by side don't share one.
const port = Number(process.env.E2E_PORT) || 5183;
export default defineConfig({
  testDir: 'e2e',
  // Those sign in to a backend, check a deployment, need two builds or a seeded five-year account, and run from their
  // own configs.
  testIgnore: ['**/e2e/stack/**', '**/e2e/deployed/**', '**/e2e/compat/**', '**/e2e/history/**'],
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
