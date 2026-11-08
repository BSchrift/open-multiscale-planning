import { defineConfig, devices } from '@playwright/test';

// The history-scale test (scripts/test-history.sh): seeds the five-year account, then times a new browser and a new Mac
// install of it. The web app is the production build in dist, which the Mac app loads too, served on HISTORY_WEB_PORT;
// a deployment's sign-in returns only to port 5199. One test at a time, with no traces, since the numbers are timings.
const port = Number(process.env.HISTORY_WEB_PORT) || 5199;

export default defineConfig({
  testDir: '.',
  outputDir: '../../test-results/history/playwright',
  workers: 1,
  reporter: 'line',
  timeout: 30 * 60_000,
  use: { trace: 'off' },
  projects: [
    { name: 'seed', testMatch: 'seed.setup.ts' },
    {
      name: 'web',
      testMatch: 'web.spec.ts',
      dependencies: ['seed'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 1000 }, baseURL: `http://localhost:${port}` },
    },
    { name: 'mac', testMatch: 'mac.spec.ts', dependencies: ['seed'] },
  ],
  webServer: {
    command: `npx vite preview --port ${port} --strictPort`,
    cwd: '../..',
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
  },
});
