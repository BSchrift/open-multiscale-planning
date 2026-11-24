import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envs } from '@multiscale/config';
import { expect, it, vi } from 'vitest';

it("builds the environment's settings from config/env into the app", async () => {
  vi.stubEnv('ENV', '');
  vi.stubEnv('LOCAL_API_URL', '');
  const { default: viteConfig } = await import('../vite.config');
  expect(JSON.parse(viteConfig.define!.__APP_CONFIG__ as string)).toMatchObject({ env: 'local', settings: envs.local });
});

// git abbreviates a commit to more characters as the clone's objects grow, so a build stamped with git's length changes
// as the repo does. The MacApp step builds a commit again, in another clone, at another time, to match GitHub Actions'.
it("stamps the version with the commit's first seven characters, however long git would abbreviate it", async () => {
  vi.resetModules();
  vi.stubEnv('ENV', '');
  vi.stubEnv('LOCAL_API_URL', '');
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'core.abbrev');
  vi.stubEnv('GIT_CONFIG_VALUE_0', '12');
  const { default: viteConfig } = await import('../vite.config');
  const frontend = join(import.meta.dirname, '..');
  const { version } = JSON.parse(readFileSync(join(frontend, 'package.json'), 'utf8')) as { version: string };
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: frontend, encoding: 'utf8' }).trim();
  expect(JSON.parse(viteConfig.define!.__APP_CONFIG__ as string)).toMatchObject({ version: `${version}-${commit.slice(0, 7)}` });
});
