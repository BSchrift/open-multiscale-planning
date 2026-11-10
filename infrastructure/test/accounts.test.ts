import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { sandboxRepo } from './sandbox.ts';

// ListUsers answers with how many users have the email: $EXISTING, else none.
const AWS = `echo "aws AWS_PROFILE=$AWS_PROFILE AWS_REGION=$AWS_REGION $*" >> "$LOG"
case "$*" in
  *sts\\ get-caller-identity*) echo "\${SIGNED_IN:-210987654321}" ;;
  *list-users*) echo "\${EXISTING:-0}" ;;
esac`;

function sandbox() {
  const s = sandboxRepo('accounts.sh');
  for (const env of ['staging', 'prod']) writeFileSync(join(s.config, `${env}.outputs.json`), JSON.stringify({ UserPoolId: `us-east-2_${env}pool` }));
  s.stub('aws', AWS);
  const run = (command: string, env: Record<string, string> = {}) =>
    spawnSync('bash', [join(s.root, 'scripts/accounts.sh'), command], { encoding: 'utf8', env: { ...s.env, ...env } });
  return { ...s, run };
}

describe('scripts/accounts.sh tester', () => {
  it("makes a prod account, and lets Cognito email the tester a temporary password", () => {
    const s = sandbox();
    const r = s.run('tester', { EMAIL: 'tester@example.org' });
    assert.equal(r.status, 0, r.stderr);
    const create = s.log().split('\n').find((line) => line.includes('admin-create-user'));
    assert.ok(create, s.log());
    assert.match(create, /AWS_PROFILE=ms-prod AWS_REGION=us-east-2 .*--user-pool-id us-east-2_prodpool --username tester@example.org/);
    assert.match(create, /Name=email,Value=tester@example.org Name=email_verified,Value=true/);
    // Cognito sends its invitation by SMS unless told otherwise, and sends none with --message-action SUPPRESS.
    assert.match(create, /--desired-delivery-mediums EMAIL/);
    assert.doesNotMatch(create, /--message-action/);
    assert.doesNotMatch(s.log(), /admin-set-user-password|ssm/);
    assert.match(r.stdout, /tester@example\.org/);
    assert.match(r.stdout, /temporary password/);
  });

  it('takes ENV=staging for staging’s pool and profile', () => {
    const s = sandbox();
    assert.equal(s.run('tester', { EMAIL: 'tester@example.org', ENV: 'staging' }).status, 0);
    assert.match(s.log(), /AWS_PROFILE=ms-staging .*admin-create-user --user-pool-id us-east-2_stagingpool/);
  });

  it('refuses an email that already has an account, looking it up in lower case', () => {
    const s = sandbox();
    const r = s.run('tester', { EMAIL: 'Tester@Example.org', EXISTING: '1' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /tester@example\.org already has an account on prod/);
    assert.match(s.log(), /list-users --user-pool-id us-east-2_prodpool --filter email = "tester@example.org"/);
    assert.doesNotMatch(s.log(), /admin-create-user/);
  });

  it('needs an email, and stops before calling AWS without one', () => {
    const s = sandbox();
    for (const EMAIL of ['', 'not an email', 'a@b']) {
      const r = s.run('tester', { EMAIL });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /make tester EMAIL=/);
    }
    assert.equal(s.log(), '');
  });

  it('stops when the profile is signed in to another account', () => {
    const s = sandbox();
    const r = s.run('tester', { EMAIL: 'tester@example.org', SIGNED_IN: '111111111111' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /signed in to account 111111111111/);
    assert.doesNotMatch(s.log(), /cognito-idp/);
  });
});

describe('scripts/accounts.sh review', () => {
  it('makes the prod account Beta App Review signs in with, and prints only its email and where the password is', () => {
    const s = sandbox();
    const r = s.run('review', { EMAIL: 'review@example.org' });
    assert.equal(r.status, 0, r.stderr);
    const log = s.log();
    const password = /--value (\S+)/.exec(log)?.[1];
    assert.ok(password, log);
    assert.match(log, /AWS_PROFILE=ms-prod .*ssm put-parameter --type SecureString --overwrite --name \/multiscale\/prod\/review-user-password --value /);
    assert.match(log, /admin-create-user --user-pool-id us-east-2_prodpool --username review@example.org .*--message-action SUPPRESS/);
    assert.match(log, new RegExp(`admin-set-user-password --user-pool-id us-east-2_prodpool --username review@example.org --password ${password.replace(/[^\w]/g, '\\$&')} --permanent`));
    // Upper and lower case, a digit and a symbol, as the pool's password policy asks.
    assert.match(password, /[a-z]/);
    assert.match(password, /[A-Z]/);
    assert.match(password, /\d/);
    assert.match(password, /[^\w]/);
    assert.ok(password.length >= 12);
    assert.equal(r.stdout, 'Email: review@example.org\nPassword: in SSM at /multiscale/prod/review-user-password\n');
    assert.ok(!r.stderr.includes(password));
  });

  it('stores the password before the account exists, so a password set is never lost', () => {
    const s = sandbox();
    assert.equal(s.run('review', { EMAIL: 'review@example.org' }).status, 0);
    const log = s.log();
    assert.ok(log.indexOf('ssm put-parameter') < log.indexOf('admin-create-user'));
    assert.ok(log.indexOf('admin-create-user') < log.indexOf('admin-set-user-password'));
  });

  it('refuses an email that already has an account, and any environment but prod', () => {
    const s = sandbox();
    const taken = s.run('review', { EMAIL: 'review@example.org', EXISTING: '1' });
    assert.notEqual(taken.status, 0);
    assert.match(taken.stderr, /already has an account/);
    assert.doesNotMatch(s.log(), /ssm|admin-create-user/);
    const staging = s.run('review', { EMAIL: 'review@example.org', ENV: 'staging' });
    assert.notEqual(staging.status, 0);
    assert.match(staging.stderr, /prod only/);
  });
});
