import { envs } from '@multiscale/config';
import { expect, it, vi } from 'vitest';

it("builds the environment's settings from config/env into the app", async () => {
  vi.stubEnv('ENV', '');
  vi.stubEnv('LOCAL_API_URL', '');
  const { default: viteConfig } = await import('../vite.config');
  expect(JSON.parse(viteConfig.define!.__APP_CONFIG__ as string)).toMatchObject({ env: 'local', settings: envs.local });
});
