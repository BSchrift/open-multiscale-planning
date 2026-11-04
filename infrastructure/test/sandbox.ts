// A throwaway repo and config folder for the deploy and smoke script tests.

import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';

const repo = join(import.meta.dirname, '../..');

const ONE_ACCOUNT = { control: '210987654321', staging: '210987654321', prod: '210987654321' };
export function configFiles(accounts: Record<'control' | 'staging' | 'prod', string> = ONE_ACCOUNT) {
  const env = (name: 'staging' | 'prod', zone: string) => ({
    aws: { account: accounts[name], region: 'us-east-2', profile: `ms-${name}` },
    alarmEmail: 'me@example.net',
    auth: { cognitoDomainPrefix: `multiscale-${name}-abc`, signInCallbackUrls: ['multiscale://auth/callback'] },
    dns: { zone },
    integration: { testUser: 'test@example.net', capabilities: ['googleClient'] },
  });
  return {
    control: { aws: { account: accounts.control, region: 'us-west-2', profile: 'ms-control' }, dns: { domain: 'example.net', hostedZoneId: 'Z0PARENTZONE' } },
    staging: env('staging', 'staging.example.net'),
    prod: env('prod', 'app.example.net'),
  };
}

/** A throwaway repo whose infrastructure reads a throwaway config folder, with stubs on PATH so nothing can reach AWS. */
export function sandboxRepo(script: string, files = configFiles()) {
  const root = mkdtempSync(join(tmpdir(), 'repo-'));
  mkdirSync(join(root, 'scripts'));
  cpSync(join(repo, 'scripts', script), join(root, 'scripts', script));
  for (const dir of ['infrastructure/bin', 'infrastructure/lib', 'config', 'backend', 'frontend']) mkdirSync(join(root, dir), { recursive: true });
  cpSync(join(repo, 'infrastructure/bin'), join(root, 'infrastructure/bin'), { recursive: true });
  cpSync(join(repo, 'infrastructure/lib/config.ts'), join(root, 'infrastructure/lib/config.ts'));
  symlinkSync(join(repo, 'infrastructure/node_modules'), join(root, 'infrastructure/node_modules'));
  for (const name of ['control', 'staging', 'prod']) cpSync(join(repo, `config/${name}.example.yaml`), join(root, `config/${name}.example.yaml`));
  const config = mkdtempSync(join(tmpdir(), 'config-'));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(config, `${name}.yaml`), stringify(value));
  const bin = join(root, 'stub-bin');
  mkdirSync(bin);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const log = join(root, 'log');
  writeFileSync(log, '');
  return { root, config, stub, log: () => readFileSync(log, 'utf8'), env: { PATH: `${bin}:${process.env.PATH}`, LOG: log, MULTISCALE_CONFIG_DIR: config } };
}
