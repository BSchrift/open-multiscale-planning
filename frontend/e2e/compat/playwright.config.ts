import { defineConfig, devices } from '@playwright/test';
import { target } from '../stack/target';

// The last release's web bundle and this checkout's, as scripts/test-compat.sh built them, served from one origin by
// serve.mjs, signing in to the backend the stack specs use. Tests share that server and backend, so they run one at a
// time. The server's port reaches the tests as COMPAT_WEB_PORT.
const { webPort } = target();

export default defineConfig({
  testDir: '.',
  outputDir: '../../test-results/compat',
  workers: 1,
  // CI also writes an HTML report, which it keeps when a run fails.
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  timeout: 120_000,
  use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 1000 }, trace: 'retain-on-failure' },
  webServer: {
    command: `node serve.mjs ${webPort}`,
    wait: { stdout: /Serving at http:\/\/localhost:(?<compat_web_port>\d+)/ },
    reuseExistingServer: false,
  },
});
