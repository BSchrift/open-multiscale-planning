import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { sandboxRepo } from './sandbox.ts';

const stackOutputs = JSON.stringify([
  { OutputKey: 'ApiUrl', OutputValue: 'https://api.example.net' },
  { OutputKey: 'CognitoDomain', OutputValue: 'https://auth.example.net' },
  { OutputKey: 'AppClientId', OutputValue: 'client' },
  { OutputKey: 'ReleaseBucket', OutputValue: 'bucket' },
]);
const shell = { electron: 'e1', ios: 'i1' };
const feedWith = (s: object) => JSON.stringify({ manifest: JSON.stringify({ version: 'old', build: 0, shell: s, files: [] }), signature: 'x' });

// aws answers get-parameter from $PARAMS, a folder of files named like the parameter with / as _, and the live feed
// from $PARAMS/feed.
function sandbox() {
  const s = sandboxRepo('pipeline.sh');
  s.stub('aws', `echo "aws AWS_PROFILE=$AWS_PROFILE $*" >> "$LOG"
case "$*" in
  *get-parameter*) name="$(echo "$*" | sed -E 's/.*--name ([^ ]+).*/\\1/' | tr / _)"; [ -f "$PARAMS/$name" ] && cat "$PARAMS/$name" || exit 254;;
  *start-pipeline-execution*) echo exec-1;;
  *describe-stacks*) echo '${stackOutputs}';;
  *"s3 cp s3://"*) [ -f "$PARAMS/feed" ] && cat "$PARAMS/feed" || exit 1;;
esac`);
  for (const name of ['go', 'npx', 'npm', 'sleep']) s.stub(name, `echo "${name} $*" >> "$LOG"`);
  s.stub('git', `echo "git $*" >> "$LOG"; case "$*" in *rev-parse*) echo abc123;; esac`);
  for (const env of ['staging', 'prod']) {
    writeFileSync(join(s.config, `${env}.release-key.pem`), generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
  }
  // What the steps call beyond this script.
  mkdirSync(join(s.root, 'frontend/scripts'), { recursive: true });
  writeFileSync(join(s.root, 'frontend/scripts/sign-release.mjs'), '// the signer\n');
  writeFileSync(join(s.root, 'scripts/test-deployed.sh'), '#!/bin/sh\necho "test-deployed ENV=$ENV EXPECT_VERSION=$EXPECT_VERSION SKIP_IOS=$SKIP_IOS SKIP_HISTORY=$SKIP_HISTORY SKIP_RETENTION=$SKIP_RETENTION" >> "$LOG"\n');
  chmodSync(join(s.root, 'scripts/test-deployed.sh'), 0o755);
  const params = join(s.root, 'params');
  mkdirSync(params);
  const param = (name: string, value: string) => writeFileSync(join(params, name.replaceAll('/', '_')), `${value}\n`);
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('bash', [join(s.root, 'scripts/pipeline.sh'), ...args], { encoding: 'utf8', env: { ...s.env, PARAMS: params, HOME: s.root, ...env } as NodeJS.ProcessEnv });
  return { ...s, run, param, params };
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
    assert.match(s.log(), /codepipeline start-pipeline-execution --name Multiscale --variables name=RUN,value=hand name=CANARY,value=on name=ALARMS,value=on --query/);
    const skip = sandbox();
    assert.equal(skip.run(['run'], { COMMIT: 'abc123', CANARY: 'skip', ENV: 'prod' }).status, 0);
    assert.match(skip.log(), /name=CANARY,value=skip name=ALARMS,value=on --source-revisions actionName=GitHub,revisionType=COMMIT_ID,revisionValue=abc123/);
  });

  it('starts a run with the release alarms off when asked', () => {
    const s = sandbox();
    const r = s.run(['run'], { ALARMS: 'off' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /--variables name=RUN,value=hand name=CANARY,value=on name=ALARMS,value=off/);
    assert.match(r.stdout, /with the release alarms off/);
  });

  it('refuses any other CANARY, ALARMS or ENV before calling AWS', () => {
    for (const env of [{ CANARY: 'off' }, { ALARMS: 'no' }, { ENV: 'staging' }] as Record<string, string>[]) {
      const s = sandbox();
      assert.notEqual(s.run(['run'], env).status, 0);
      assert.doesNotMatch(s.log(), /^aws /m);
    }
  });

  it("uploads the config files where the steps read them, and each release key only where the signing step does", () => {
    const s = sandbox();
    const r = s.run(['config']);
    assert.equal(r.status, 0, r.stderr);
    for (const file of ['control.yaml', 'staging.yaml', 'prod.yaml']) {
      assert.match(s.log(), new RegExp(`put-parameter --name /multiscale/pipeline/config/${file.replaceAll('.', '\\.')} --type SecureString --overwrite`));
    }
    for (const env of ['staging', 'prod']) {
      // The public half, for the web build, and the key, encrypted with the key only the signing step may decrypt with.
      assert.match(s.log(), new RegExp(`put-parameter --name /multiscale/pipeline/config/${env}\\.release-key\\.pub --type String --overwrite --value [A-Za-z0-9+/]{43}=`));
      assert.match(s.log(), new RegExp(`delete-parameter --name /multiscale/pipeline/signing/${env}\\.release-key\\.pem\\n.*put-parameter --name /multiscale/pipeline/signing/${env}\\.release-key\\.pem --type SecureString --key-id alias/multiscale-release-signing --value file://`));
    }
    assert.doesNotMatch(s.log(), /config\/\w+\.release-key\.pem/);
  });

  it('uploads nothing when a file is missing', () => {
    const s = sandbox();
    rmSync(join(s.config, 'prod.release-key.pem'));
    const r = s.run(['config']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /prod\.release-key\.pem/);
    assert.doesNotMatch(s.log(), /put-parameter/);
  });
});

describe('scripts/pipeline.sh, in CodeBuild', () => {
  const configured = () => {
    const s = sandbox();
    for (const file of ['control.yaml', 'staging.yaml', 'prod.yaml']) s.param(`/multiscale/pipeline/config/${file}`, readFileSync(join(s.config, file), 'utf8'));
    for (const env of ['staging', 'prod']) s.param(`/multiscale/pipeline/config/${env}.release-key.pub`, 'cHVibGlj');
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

  it('builds a run started by hand while paused, once, for both environments, with no release key', () => {
    const s = configured();
    s.param('/multiscale/pipeline/paused', 'true');
    const r = s.run(['build'], { RUN: 'hand', EXECUTION_ID: 'exec-9' });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(s.log(), /stop-pipeline-execution/);
    for (const name of ['api', 'calendar', 'retention', 'canary']) assert.match(s.log(), new RegExp(`go build .* \\./cmd/${name}`));
    assert.match(s.log(), /npx cdk synth --quiet -c deploy=staging -o cdk.out\/staging Multiscale-staging/);
    assert.match(s.log(), /npx cdk synth --quiet -c deploy=prod -o cdk.out\/prod Multiscale-prod/);
    // Each environment's web build, from its stack's outputs and its key's public half, beside the script that signs it.
    for (const env of ['staging', 'prod']) assert.match(s.log(), new RegExp(`npx vite build --outDir ${s.root}/web/${env} --emptyOutDir`));
    assert.equal(readFileSync(join(s.root, 'web/sign-release.mjs'), 'utf8'), '// the signer\n');
    assert.doesNotMatch(s.log(), /signing\//);
    assert.equal(readFileSync(join(s.root, 'multiscale-config/prod.release-key.pub'), 'utf8'), 'cHVibGlj\n');
  });

  it("synthesizes prod with all traffic at once when the run skips the canary, and staging keeps its own", () => {
    const s = configured();
    assert.equal(s.run(['build'], { RUN: 'hand', CANARY: 'skip' }).status, 0);
    assert.match(s.log(), /cdk synth --quiet -c deploy=prod -c canary=skip -o cdk.out\/prod/);
    assert.match(s.log(), /cdk synth --quiet -c deploy=staging -o cdk.out\/staging/);
  });

  // The Build output with staging's web build, and the signing step's output, as CodeBuild hands them to a step.
  const artifacts = (s: ReturnType<typeof sandbox>, built: object = shell) => {
    const builtDir = join(s.root, 'built');
    mkdirSync(join(builtDir, 'web/staging/assets'), { recursive: true });
    writeFileSync(join(builtDir, 'web/staging/version.json'), JSON.stringify({ version: '0.1.0-abc', build: 1, shell: built }));
    const signed = join(s.root, 'signed');
    mkdirSync(join(signed, 'files'), { recursive: true });
    writeFileSync(join(signed, 'release.json'), '{}');
    return { CODEBUILD_SRC_DIR_Built: builtDir, CODEBUILD_SRC_DIR_SignedStaging: signed };
  };

  it("publishes staging's web build and its signed feed, as its release role, then tests that version", () => {
    const s = configured();
    writeFileSync(join(s.params, 'feed'), feedWith(shell));
    const r = s.run(['release-staging'], artifacts(s));
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /aws AWS_PROFILE=ms-staging s3 sync \S+\/signed\/files s3:\/\/bucket\/release\/files/);
    assert.match(s.log(), /aws AWS_PROFILE=ms-staging s3 cp \S+\/signed\/release\.json s3:\/\/bucket\/release\/release\.json/);
    assert.match(s.log(), /aws AWS_PROFILE=ms-staging s3 sync \S+\/built\/web\/staging s3:\/\/bucket\/web --exclude assets\/\*/);
    assert.match(s.log(), /test-deployed ENV=staging EXPECT_VERSION=0\.1\.0-abc SKIP_IOS=1 SKIP_HISTORY=1 SKIP_RETENTION=1/);
    // Each profile signs in as its account's release role.
    assert.match(readFileSync(join(s.root, '.aws/config'), 'utf8'), /\[profile ms-staging\]\nrole_arn = arn:aws:iam::210987654321:role\/multiscale-release\ncredential_source = EcsContainer/);
  });

  for (const [why, live] of [['needs newer native code than the feed', feedWith({ electron: 'e2', ios: 'i1' })], ['finds no feed yet', '']] as const) {
    it(`leaves the feed for the Mac's release when the build ${why}, and still publishes the web app`, () => {
      const s = configured();
      if (live) writeFileSync(join(s.params, 'feed'), live);
      const r = s.run(['release-staging'], artifacts(s));
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /make release ENV=staging/);
      assert.doesNotMatch(s.log(), /s3:\/\/bucket\/release\/(files|release\.json) --/);
      assert.match(s.log(), /s3:\/\/bucket\/web/);
    });
  }

  it('turns the release alarms off for both environments when the run asks, and only then', () => {
    const s = configured();
    assert.equal(s.run(['build'], { RUN: 'hand', ALARMS: 'off' }).status, 0);
    assert.match(s.log(), /cdk synth --quiet -c deploy=staging -c alarms=off -o cdk.out\/staging/);
    assert.match(s.log(), /cdk synth --quiet -c deploy=prod -c alarms=off -o cdk.out\/prod/);
    const next = configured();
    assert.equal(next.run(['build'], { RUN: 'hand' }).status, 0);
    assert.doesNotMatch(next.log(), /alarms=off/);
  });

  it("records what a prod release skipped beside its commit, for the release tag's note", () => {
    const s = configured();
    const builtDir = join(s.root, 'built');
    mkdirSync(join(builtDir, 'web/prod/assets'), { recursive: true });
    writeFileSync(join(builtDir, 'web/prod/version.json'), JSON.stringify({ version: '0.1.0-abc', build: 1, shell }));
    const signed = join(s.root, 'signed');
    mkdirSync(join(signed, 'files'), { recursive: true });
    writeFileSync(join(signed, 'release.json'), '{}');
    const env = { CODEBUILD_SRC_DIR_Built: builtDir, CODEBUILD_SRC_DIR_SignedProd: signed, COMMIT: 'abc123' };
    assert.equal(s.run(['release-prod'], { ...env, CANARY: 'skip', ALARMS: 'off' }).status, 0);
    assert.match(s.log(), /put-parameter --name \/multiscale\/pipeline\/released --type String --overwrite --value abc123 Canary skipped\. Release alarms off\./);
    const plain = configured();
    mkdirSync(join(plain.root, 'built/web/prod/assets'), { recursive: true });
    writeFileSync(join(plain.root, 'built/web/prod/version.json'), JSON.stringify({ version: '0.1.0-abc', build: 1, shell }));
    mkdirSync(join(plain.root, 'signed/files'), { recursive: true });
    writeFileSync(join(plain.root, 'signed/release.json'), '{}');
    assert.equal(plain.run(['release-prod'], { CODEBUILD_SRC_DIR_Built: join(plain.root, 'built'), CODEBUILD_SRC_DIR_SignedProd: join(plain.root, 'signed'), COMMIT: 'abc123' }).status, 0);
    assert.match(plain.log(), /--name \/multiscale\/pipeline\/released --type String --overwrite --value abc123\n/);
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
