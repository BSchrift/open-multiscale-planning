import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { loadConfig } from '../lib/config.ts';
import { sandboxRepo } from './sandbox.ts';

// aws answers sts with $ACCOUNT, and keeps each SecureString it's given in $PARAMS, named like the parameter with / as _.
function sandbox() {
  const s = sandboxRepo('files-key.sh');
  const params = join(s.root, 'params');
  mkdirSync(params);
  s.stub('aws', `echo "aws AWS_PROFILE=$AWS_PROFILE $*" >> "$LOG"
case "$*" in
  *get-caller-identity*) echo "\${ACCOUNT:-210987654321}";;
  *put-parameter*)
    [ -z "$FAIL_PUT" ] || exit 254
    name="$(echo "$*" | sed -E 's/.*--name ([^ ]+).*/\\1/' | tr / _)"
    file="$(echo "$*" | sed -E 's/.*--value file:\\/\\/([^ ]+).*/\\1/')"
    cp "$file" "$PARAMS/$name";;
esac`);
  s.stub('npm', `echo "npm $*" >> "$LOG"`);
  const run = (env: Record<string, string> = {}) =>
    spawnSync('bash', [join(s.root, 'scripts/files-key.sh')], { encoding: 'utf8', env: { ...s.env, PARAMS: params, ...env } as NodeJS.ProcessEnv });
  const staging = () => parse(readFileSync(join(s.config, 'staging.yaml'), 'utf8'));
  const secret = (name: string) => readFileSync(join(params, `_multiscale_staging_files_${name}`), 'utf8');
  return { ...s, run, staging, secret };
}

const pair = (privatePem: string, publicPem: string) => {
  const signature = sign('sha256', Buffer.from('a link'), createPrivateKey(privatePem));
  return verify('sha256', Buffer.from('a link'), createPublicKey(publicPem), signature);
};

describe('scripts/files-key.sh', () => {
  it("writes the private key to SSM and its public half to staging.yaml, which then signs with it", () => {
    const s = sandbox();
    const r = s.run({ NAME: 'k1' });
    assert.equal(r.status, 0, r.stderr);
    // No --overwrite, so a key in use is never replaced.
    assert.match(s.log(), /aws AWS_PROFILE=ms-staging ssm put-parameter --name \/multiscale\/staging\/files\/k1 --type SecureString --value file:\/\/\S+private\.pem\n/);
    assert.doesNotMatch(s.log(), /--overwrite/);
    const { files } = s.staging();
    assert.equal(files.signWith, 'k1');
    assert.match(files.keys.k1, /^-----BEGIN PUBLIC KEY-----\n/);
    assert.match(s.secret('k1'), /^-----BEGIN PRIVATE KEY-----\n/);
    assert.ok(pair(s.secret('k1'), files.keys.k1));
    // What the stack reads takes it, and the key it made is gone from the disk.
    assert.equal(loadConfig('staging', s.config, true).config.files?.signWith, 'k1');
    const keyFile = s.log().match(/file:\/\/(\S+)/)![1];
    assert.ok(!existsSync(keyFile));
    assert.match(r.stdout, /make deploy ENV=staging/);
    assert.match(r.stdout, /make pipeline-config/);
  });

  it('adds a second key for a rotation, leaving the one the API signs with, and says how to finish it', () => {
    const s = sandbox();
    assert.equal(s.run({ NAME: 'k1' }).status, 0);
    const r = s.run({ NAME: 'k2' });
    assert.equal(r.status, 0, r.stderr);
    const { files } = s.staging();
    assert.deepEqual(Object.keys(files.keys), ['k1', 'k2']);
    assert.equal(files.signWith, 'k1');
    assert.ok(pair(s.secret('k2'), files.keys.k2));
    assert.match(r.stdout, /files\.signWith to k2/);
    assert.match(r.stdout, /aws ssm delete-parameter --name \/multiscale\/staging\/files\/k1/);
  });

  it("names the key by today's date unless NAME says, and signs in to prod only when asked", () => {
    const s = sandbox();
    const r = s.run({ ENV: 'prod' });
    assert.equal(r.status, 0, r.stderr);
    const name = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    assert.match(s.log(), new RegExp(`aws AWS_PROFILE=ms-prod ssm put-parameter --name /multiscale/prod/files/k${name} `));
    assert.equal(parse(readFileSync(join(s.config, 'prod.yaml'), 'utf8')).files.signWith, `k${name}`);
  });

  it('keeps the comments already in the file', () => {
    const s = sandbox();
    const path = join(s.config, 'staging.yaml');
    writeFileSync(path, `# My staging.\n${readFileSync(path, 'utf8')}`);
    assert.equal(s.run({ NAME: 'k1' }).status, 0);
    assert.match(readFileSync(path, 'utf8'), /^# My staging\.\n/);
  });

  it('refuses a name in use, a bad name, another environment and the wrong account, before writing anything', () => {
    const s = sandbox();
    assert.equal(s.run({ NAME: 'k1' }).status, 0);
    const before = readFileSync(join(s.config, 'staging.yaml'), 'utf8');
    for (const [env, says] of [
      [{ NAME: 'k1' }, /already/],
      [{ NAME: 'k 2' }, /letters, digits/],
      [{ NAME: 'k2', ENV: 'control' }, /ENV must be staging or prod/],
      [{ NAME: 'k2', ACCOUNT: '999999999999' }, /signed in to account 999999999999/],
    ] as const) {
      const r = s.run(env);
      assert.notEqual(r.status, 0, JSON.stringify(env));
      assert.match(r.stderr, says);
    }
    assert.equal(s.log().match(/put-parameter/g)?.length, 1);
    assert.equal(readFileSync(join(s.config, 'staging.yaml'), 'utf8'), before);
  });

  it('leaves the config as it was when SSM refuses the key', () => {
    const s = sandbox();
    const r = s.run({ NAME: 'k1', FAIL_PUT: '1' });
    assert.notEqual(r.status, 0);
    assert.equal(s.staging().files, undefined);
  });
});
