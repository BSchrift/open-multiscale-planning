import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

/** buildSettings for one environment, run as the build scripts run it. */
function settings(env: string, extra: Record<string, string>) {
  const script = `const { buildSettings } = await import('./scripts/electron-compile.mjs'); console.log(JSON.stringify(buildSettings('${env}')))`;
  // The trailing argument stands in for a script path, which the module checks before compiling on its own.
  return spawnSync(process.execPath, ['--input-type=module', '-e', script, 'test'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, LOCAL_API_URL: '', MULTISCALE_CONFIG_DIR: '', ...extra },
    encoding: 'utf8',
  });
}

it('builds the main process for the same local stack as the page, so its CSP lets the page reach it', () => {
  const run = settings('local', { LOCAL_API_URL: 'http://127.0.0.1:55001' });
  expect(run.stderr).not.toMatch(/Error/);
  expect(JSON.parse(run.stdout).config).toMatchObject({ apiUrl: 'http://127.0.0.1:55001', authUrl: 'http://127.0.0.1:55001/cognito' });
});

it("builds a deployed environment from its outputs and its YAML's bundle id, in MULTISCALE_CONFIG_DIR", () => {
  const dir = mkdtempSync(join(tmpdir(), 'multiscale-config-'));
  const outputs = { ApiUrl: 'https://api.example.test', CognitoDomain: 'https://auth.example.test', AppClientId: 'client-1' };
  writeFileSync(join(dir, 'staging.outputs.json'), JSON.stringify(outputs));
  writeFileSync(join(dir, 'staging.yaml'), 'app:\n  bundleId: com.example.planner\n');
  const run = settings('staging', { MULTISCALE_CONFIG_DIR: dir });
  expect(run.stderr).not.toMatch(/Error/);
  expect(JSON.parse(run.stdout)).toMatchObject({
    config: { env: 'staging', apiUrl: 'https://api.example.test', authClientId: 'client-1' },
    identity: { appId: 'com.example.planner.staging', scheme: 'multiscale-staging' },
  });
});

it('names the missing YAML in full', () => {
  const dir = mkdtempSync(join(tmpdir(), 'multiscale-config-'));
  writeFileSync(join(dir, 'prod.outputs.json'), JSON.stringify({ ApiUrl: 'https://a.example.test', CognitoDomain: 'https://b.example.test', AppClientId: 'c' }));
  const run = settings('prod', { MULTISCALE_CONFIG_DIR: dir });
  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain(`${dir}/prod.yaml is missing`);
});
