import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { sandboxRepo } from './sandbox.ts';

// aws answers get-parameter from $PARAMS, a folder of files named like the parameter with / as _.
function sandbox() {
  const s = sandboxRepo('pipeline.sh');
  s.stub('aws', `echo "aws AWS_PROFILE=$AWS_PROFILE $*" >> "$LOG"
case "$*" in
  *get-parameter*) name="$(echo "$*" | sed -E 's/.*--name ([^ ]+).*/\\1/' | tr / _)"; [ -f "$PARAMS/$name" ] && cat "$PARAMS/$name" || exit 254;;
  *start-pipeline-execution*) echo exec-1;;
esac`);
  for (const name of ['go', 'npx', 'npm', 'sleep']) s.stub(name, `echo "${name} $*" >> "$LOG"`);
  s.stub('git', `echo "git $*" >> "$LOG"; case "$*" in *rev-parse*) echo abc123;; esac`);
  for (const file of ['staging.release-key.pem', 'prod.release-key.pem']) writeFileSync(join(s.config, file), 'key\n');
  const params = join(s.root, 'params');
  spawnSync('mkdir', [params]);
  const param = (name: string, value: string) => writeFileSync(join(params, name.replaceAll('/', '_')), `${value}\n`);
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('bash', [join(s.root, 'scripts/pipeline.sh'), ...args], { encoding: 'utf8', env: { ...s.env, PARAMS: params, HOME: s.root, ...env } as NodeJS.ProcessEnv });
  return { ...s, run, param };
}

describe('scripts/pipeline.sh, from a Mac', () => {
  it("pauses and resumes main's releases with a parameter, signed in to the control account", () => {
    const s = sandbox();
    assert.equal(s.run(['pause']).status, 0);
    assert.match(s.log(), /aws AWS_PROFILE=ms-control ssm put-parameter --name \/multiscale\/pipeline\/paused --type String --overwrite --value true/);
    assert.equal(s.run(['resume']).status, 0);
    assert.match(s.log(), /--name \/multiscale\/pipeline\/paused --type String --overwrite --value false/);
  });

  it('starts a run by hand, which the pause lets through, at a commit and skipping the canary when asked', () => {
    const s = sandbox();
    const r = s.run(['run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /codepipeline start-pipeline-execution --name Multiscale --variables name=RUN,value=hand name=CANARY,value=on --query/);
    const skip = sandbox();
    assert.equal(skip.run(['run'], { COMMIT: 'abc123', CANARY: 'skip', ENV: 'prod' }).status, 0);
    assert.match(skip.log(), /name=CANARY,value=skip --source-revisions actionName=GitHub,revisionType=COMMIT_ID,revisionValue=abc123/);
  });

  it('refuses any other CANARY or ENV before calling AWS', () => {
    for (const env of [{ CANARY: 'off' }, { ENV: 'staging' }] as Record<string, string>[]) {
      const s = sandbox();
      assert.notEqual(s.run(['run'], env).status, 0);
      assert.doesNotMatch(s.log(), /^aws /m);
    }
  });

  it('uploads the config files and release keys as SecureStrings, or nothing when one is missing', () => {
    const s = sandbox();
    assert.equal(s.run(['config']).status, 0);
    for (const file of ['control.yaml', 'staging.yaml', 'prod.yaml', 'staging.release-key.pem', 'prod.release-key.pem']) {
      assert.match(s.log(), new RegExp(`ssm put-parameter --name /multiscale/pipeline/config/${file.replaceAll('.', '\\.')} --type SecureString --overwrite --value file://${s.config}/${file.replaceAll('.', '\\.')}`));
    }
    const missing = sandbox();
    rmSync(join(missing.config, 'prod.release-key.pem'));
    const r = missing.run(['config']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /prod\.release-key\.pem/);
    assert.doesNotMatch(missing.log(), /put-parameter/);
  });
});

describe('scripts/pipeline.sh, in CodeBuild', () => {
  const configured = () => {
    const s = sandbox();
    for (const file of ['control.yaml', 'staging.yaml', 'prod.yaml', 'staging.release-key.pem', 'prod.release-key.pem']) {
      s.param(`/multiscale/pipeline/config/${file}`, readFileSync(join(s.config, file), 'utf8'));
    }
    return s;
  };

  it('stops a run a main commit started while paused, before building anything', () => {
    const s = configured();
    s.param('/multiscale/pipeline/paused', 'true');
    const r = s.run(['build'], { RUN: 'auto', EXECUTION_ID: 'exec-9' });
    assert.notEqual(r.status, 0);
    assert.match(s.log(), /codepipeline stop-pipeline-execution --pipeline-name Multiscale --pipeline-execution-id exec-9 --abandon/);
    assert.doesNotMatch(s.log(), /go |cdk synth/);
  });

  it('builds a run started by hand while paused, once, for both environments', () => {
    const s = configured();
    s.param('/multiscale/pipeline/paused', 'true');
    const r = s.run(['build'], { RUN: 'hand', EXECUTION_ID: 'exec-9' });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(s.log(), /stop-pipeline-execution/);
    for (const name of ['api', 'calendar', 'retention', 'canary']) assert.match(s.log(), new RegExp(`go build .* \\./cmd/${name}`));
    assert.match(s.log(), /npx cdk synth --quiet -c deploy=staging -o cdk.out\/staging Multiscale-staging/);
    assert.match(s.log(), /npx cdk synth --quiet -c deploy=prod -o cdk.out\/prod Multiscale-prod/);
  });

  it("synthesizes prod with all traffic at once when the run skips the canary, and staging keeps its own", () => {
    const s = configured();
    assert.equal(s.run(['build'], { RUN: 'hand', CANARY: 'skip' }).status, 0);
    assert.match(s.log(), /cdk synth --quiet -c deploy=prod -c canary=skip -o cdk.out\/prod/);
    assert.match(s.log(), /cdk synth --quiet -c deploy=staging -o cdk.out\/staging/);
  });

  it('runs no nightly suites when main has not moved since the last one passed', () => {
    const s = configured();
    s.param('/multiscale/pipeline/nightly', 'abc123');
    const r = s.run(['nightly']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Nothing new on main/);
    assert.doesNotMatch(s.log(), /npm |npx /);
  });
});
