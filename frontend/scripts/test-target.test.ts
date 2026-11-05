import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, 'test-target.mjs');
const staging = `aws:
  account: "111111111111"
  region: us-west-2
  profile: multiscale-staging
integration:
  testUser: integration-test@example.com
  capabilities: [googleClient]
`;
const outputs = { ApiUrl: 'https://api.example.test', TestClientId: 'test-client', AppClientId: 'app-client', CognitoDomain: 'https://auth.example.test' };

/** A config folder and a stand-in aws CLI that logs how it was called and prints a password, or fails. */
function setup(files: Record<string, string>, aws = 'echo test-password') {
  const dir = mkdtempSync(join(tmpdir(), 'test-target-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const bin = join(dir, 'bin');
  spawnSync('mkdir', [bin]);
  writeFileSync(join(bin, 'aws'), `#!/bin/sh\necho "$AWS_PROFILE $AWS_REGION $*" >> "${dir}/aws.log"\n${aws}\n`);
  chmodSync(join(bin, 'aws'), 0o755);
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MULTISCALE_CONFIG_DIR: dir, LOCAL_API_URL: '', AWS_PROFILE: '', AWS_REGION: '', ...env },
      encoding: 'utf8',
    });
  const awsCalls = () => (existsSync(join(dir, 'aws.log')) ? readFileSync(join(dir, 'aws.log'), 'utf8').trim().split('\n') : []);
  return { dir, run, awsCalls };
}

describe('test-target', () => {
  it("signs a deployment's tests in as the YAML's test user, with its password from SSM through the env's profile", () => {
    const { run, awsCalls } = setup({ 'staging.yaml': staging, 'staging.outputs.json': JSON.stringify(outputs) });
    const result = run({ ENV: 'staging' });
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      env: 'staging',
      api_url: 'https://api.example.test',
      client_id: 'test-client',
      region: 'us-west-2',
      test_user: { username: 'integration-test@example.com', password: 'test-password' },
    });
    expect(awsCalls()).toEqual([
      'multiscale-staging us-west-2 ssm get-parameter --name /multiscale/staging/test-user-password --with-decryption --query Parameter.Value --output text',
    ]);
  });

  it('targets the local stack with its built-in client and no AWS', () => {
    const { run, awsCalls } = setup({});
    const result = run({ ENV: 'local', LOCAL_API_URL: 'http://127.0.0.1:55001' });
    expect(JSON.parse(result.stdout)).toEqual({ env: 'local', api_url: 'http://127.0.0.1:55001', client_id: 'local-client' });
    expect(awsCalls()).toEqual([]);
  });

  it('names a missing YAML in full and the example to copy, before calling AWS', () => {
    const { dir, run, awsCalls } = setup({ 'prod.outputs.json': JSON.stringify(outputs) });
    const result = run({ ENV: 'prod' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${dir}/prod.yaml is missing. Copy config/prod.example.yaml`);
    expect(awsCalls()).toEqual([]);
  });

  it('names missing outputs in full', () => {
    const { dir, run, awsCalls } = setup({ 'staging.yaml': staging });
    const result = run({ ENV: 'staging' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${dir}/staging.outputs.json is missing`);
    expect(awsCalls()).toEqual([]);
  });

  it.each([
    ['no test user', staging.replace(/  testUser: .*\n/, '')],
    ['no profile', staging.replace(/  profile: .*\n/, '')],
    ['a bad region', staging.replace('us-west-2', 'not a region')],
  ])('refuses YAML with %s', (_name, yaml) => {
    const { run, awsCalls } = setup({ 'staging.yaml': yaml, 'staging.outputs.json': JSON.stringify(outputs) });
    const result = run({ ENV: 'staging' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/staging\.yaml: (integration\.testUser|aws\.profile|aws\.region)/);
    expect(awsCalls()).toEqual([]);
  });

  it('fails, naming the parameter, when SSM has no password', () => {
    const { run } = setup({ 'staging.yaml': staging, 'staging.outputs.json': JSON.stringify(outputs) }, 'exit 254');
    const result = run({ ENV: 'staging' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('/multiscale/staging/test-user-password');
    expect(result.stdout).toBe('');
  });
});
