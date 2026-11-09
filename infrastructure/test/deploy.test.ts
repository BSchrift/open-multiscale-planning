import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { configFiles, sandboxRepo } from './sandbox.ts';

const outputs = {
  ApiUrl: 'https://abc.execute-api.us-east-2.amazonaws.com',
  Region: 'us-east-2',
  UserPoolId: 'us-east-2_abc',
  AppClientId: 'appclient',
  TestClientId: 'testclient',
  CognitoDomain: 'https://multiscale-x.auth.us-east-2.amazoncognito.com',
  ApiLogGroup: 'apilogs',
  CalendarLogGroup: 'calendarlogs',
  MetricNamespace: 'Multiscale/staging',
  GoogleRedirectUri: 'https://abc.execute-api.us-east-2.amazonaws.com/calendar/callback',
  AlarmTopicArn: 'arn:aws:sns:us-east-2:210987654321:t',
  TableName: 'table',
};

function sandbox(stubs: Record<string, string> = {}, files = configFiles()) {
  const s = sandboxRepo('deploy.sh', files);
  const defaults: Record<string, string> = {
    go: `echo "go GOOS=$GOOS GOARCH=$GOARCH CGO=$CGO_ENABLED $*" >> "$LOG"
while [ $# -gt 0 ]; do if [ "$1" = -o ]; then mkdir -p "$(dirname "$2")"; : > "$2"; fi; shift; done`,
    npx: `echo "npx $*" >> "$LOG"; echo "npx with AWS_PROFILE=$AWS_PROFILE AWS_REGION=$AWS_REGION" >> "$LOG"
stack=""; for a in "$@"; do case "$a" in Multiscale-*) stack="$a";; esac; done
while [ $# -gt 0 ]; do if [ "$1" = --outputs-file ]; then printf '{"%s":%s}' "$stack" "$OUTPUTS" > "$2"; fi; shift; done`,
    npm: 'echo "npm $*" >> "$LOG"',
    aws: `echo "aws AWS_PROFILE=$AWS_PROFILE AWS_REGION=$AWS_REGION $*" >> "$LOG"; echo "\${SIGNED_IN:-210987654321}"`,
    git: `case "$*" in *rev-parse*) echo abc123;; *status*) printf '%s' "$DIRTY";; *) exit 1;; esac`,
  };
  for (const [name, body] of Object.entries({ ...defaults, ...stubs })) s.stub(name, body);
  const run = (env: Record<string, string | undefined> = {}, cwd?: string) =>
    spawnSync('bash', [join(s.root, 'scripts/deploy.sh')], { cwd, encoding: 'utf8', env: { ...s.env, OUTPUTS: JSON.stringify(outputs), ...env } as NodeJS.ProcessEnv });
  return { ...s, run, file: (name: string) => join(s.config, name) };
}

describe('scripts/deploy.sh', () => {
  it('deploys staging by default', () => {
    const s = sandbox();
    const r = s.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /npx cdk deploy Multiscale-staging /);
    assert.match(s.log(), /-c deploy=staging/);
    assert.doesNotMatch(s.log(), /Multiscale-prod/);
  });

  it('refuses ENV=local, since there is no local deployment, rather than deploying staging', () => {
    const s = sandbox();
    const r = s.run({ ENV: 'local' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not local/);
    assert.equal(s.log(), '');
  });

  it('deploys prod only when asked', () => {
    const s = sandbox();
    assert.equal(s.run({ ENV: 'prod' }).status, 0);
    assert.match(s.log(), /npx cdk deploy Multiscale-prod /);
    assert.ok(existsSync(s.file('prod.outputs.json')));
    assert.ok(!existsSync(s.file('staging.outputs.json')));
  });

  it('deploys control without building the Lambdas', () => {
    const s = sandbox();
    const r = s.run({ ENV: 'control', OUTPUTS: '{}' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /npx cdk deploy Multiscale-control -c deploy=control /);
    assert.doesNotMatch(s.log(), /^go /m);
    assert.deepEqual(JSON.parse(readFileSync(s.file('control.outputs.json'), 'utf8')), {});
    assert.ok(existsSync(s.file('control.deployed')));
  });

  it('rejects any other environment before doing anything', () => {
    const s = sandbox();
    const r = s.run({ ENV: 'dev' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /control, staging or prod/);
    assert.equal(s.log(), '');
  });

  it('stops before anything when the config is missing, naming the file and the example to copy', () => {
    const s = sandbox();
    rmSync(s.file('staging.yaml'));
    const r = s.run();
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(s.file('staging.yaml')), r.stderr);
    assert.ok(r.stderr.includes(join(s.root, 'config/staging.example.yaml')), r.stderr);
    assert.equal(s.log(), '');
  });

  it('stops before anything when the config still has example values', () => {
    const files = configFiles();
    files.staging.auth.cognitoDomainPrefix = 'multiscale-staging-change-me';
    const s = sandbox({}, files);
    const r = s.run();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /example values/);
    assert.equal(s.log(), '');
  });

  it('signs in with the profile and region from the environment file', () => {
    const s = sandbox();
    assert.equal(s.run().status, 0);
    assert.match(s.log(), /aws AWS_PROFILE=ms-staging AWS_REGION=us-east-2 sts get-caller-identity/);
    assert.match(s.log(), /npx with AWS_PROFILE=ms-staging AWS_REGION=us-east-2/);
  });

  it('refuses to touch anything when signed in to another account than the file names', () => {
    const s = sandbox();
    const r = s.run({ SIGNED_IN: '999999999999' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /999999999999/);
    assert.match(r.stderr, /210987654321/);
    assert.doesNotMatch(s.log(), /^(go|npx) /m);
  });

  it('works with each environment in its own account', () => {
    const accounts = { control: '210987654321', staging: '210987654322', prod: '210987654323' };
    for (const name of ['control', 'staging', 'prod'] as const) {
      const s = sandbox({}, configFiles(accounts));
      assert.equal(s.run({ ENV: name, SIGNED_IN: accounts[name], OUTPUTS: name === 'control' ? '{}' : JSON.stringify(outputs) }).status, 0, name);
      assert.notEqual(s.run({ ENV: name, SIGNED_IN: accounts[name === 'prod' ? 'staging' : 'prod'] }).status, 0, name);
    }
  });

  it('builds every Lambda for arm64 Linux with no cgo, from cmd/api, cmd/calendar and cmd/retention', () => {
    const s = sandbox();
    s.run();
    for (const name of ['api', 'calendar', 'retention']) {
      assert.match(s.log(), new RegExp(`go GOOS=linux GOARCH=arm64 CGO=0 build .*-o \\S*backend/dist/${name}/bootstrap \\./cmd/${name}`));
    }
  });

  it('ships each Lambda as its binary alone, clearing what an earlier deploy left beside it', () => {
    const s = sandbox();
    for (const name of ['api', 'calendar']) {
      mkdirSync(join(s.root, `backend/dist/${name}`), { recursive: true });
      writeFileSync(join(s.root, `backend/dist/${name}/config.yaml`), 'alarmEmail: me@example.net\n');
    }
    assert.equal(s.run({ ENV: 'prod' }).status, 0);
    for (const name of ['api', 'calendar']) assert.deepEqual(readdirSync(join(s.root, `backend/dist/${name}`)), ['bootstrap']);
  });

  it('checks the file with the strict Go loader first, and ships nothing it rejects', () => {
    const s = sandbox({
      go: `echo "go $* in $PWD with $MULTISCALE_CONFIG_DIR" >> "$LOG"
[ "$1" = run ] && { echo "prod.yaml: field bundleID not found in type config.App" >&2; exit 1; }; exit 0`,
    });
    const r = s.run({ ENV: 'prod' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /field bundleID not found/);
    assert.ok(s.log().includes(`go run ./cmd/check prod in ${join(s.root, 'config')} with ${s.config}`), s.log());
    assert.doesNotMatch(s.log(), /go build|cdk deploy/);
    assert.ok(!existsSync(s.file('prod.deployed')));
  });

  it('does not deploy when the build fails', () => {
    const s = sandbox({ go: 'exit 1' });
    assert.notEqual(s.run().status, 0);
    assert.doesNotMatch(s.log(), /cdk deploy/);
  });

  it('writes no outputs or record when the deploy fails', () => {
    const s = sandbox({ npx: 'exit 1' });
    assert.notEqual(s.run().status, 0);
    assert.ok(!existsSync(s.file('staging.outputs.json')));
    assert.ok(!existsSync(s.file('staging.deployed')));
  });

  it('writes the stack outputs into the config folder, and nothing into the repo', () => {
    const s = sandbox();
    assert.equal(s.run().status, 0);
    assert.deepEqual(JSON.parse(readFileSync(s.file('staging.outputs.json'), 'utf8')), outputs);
    assert.ok(!existsSync(join(s.root, 'frontend/app.config.staging.json')));
    assert.ok(!existsSync(join(s.root, 'infrastructure/config')));
  });

  it('fails when the stack did not output what the app needs', () => {
    const s = sandbox();
    const r = s.run({ OUTPUTS: '{"ApiUrl":"x"}' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /AppClientId|CognitoDomain/);
    assert.ok(!existsSync(s.file('staging.outputs.json')));
    assert.ok(!existsSync(s.file('staging.deployed')));
  });

  it('records the commit, whether the tree was dirty, and the time', () => {
    const s = sandbox();
    assert.equal(s.run().status, 0);
    const record = readFileSync(s.file('staging.deployed'), 'utf8');
    assert.match(record, /^commit: abc123$/m);
    assert.match(record, /^dirty: false$/m);
    assert.match(record, /^time: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m);
    assert.equal(s.run({ DIRTY: ' M backend/main.go' }).status, 0);
    assert.match(readFileSync(s.file('staging.deployed'), 'utf8'), /^dirty: true$/m);
  });

  it('uses the config folder in the repo when MULTISCALE_CONFIG_DIR is not set', () => {
    const s = sandbox();
    for (const name of ['control', 'staging']) cpSync(s.file(`${name}.yaml`), join(s.root, `config/${name}.yaml`));
    assert.equal(s.run({ MULTISCALE_CONFIG_DIR: undefined }).status, 0);
    assert.ok(existsSync(join(s.root, 'config/staging.outputs.json')));
    assert.ok(existsSync(join(s.root, 'config/staging.deployed')));
  });

  it('accepts a relative MULTISCALE_CONFIG_DIR', () => {
    const s = sandbox();
    const r = s.run({ MULTISCALE_CONFIG_DIR: basename(s.config) }, dirname(s.config));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(s.file('staging.outputs.json')));
  });
});
