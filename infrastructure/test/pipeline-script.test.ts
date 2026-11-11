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

// aws answers get-parameter from $PARAMS, a folder of files named like the parameter with / as _, the live feed from
// $PARAMS/feed, and the record of a checked Mac app on the downloads host from $PARAMS/checked.
function sandbox() {
  const s = sandboxRepo('pipeline.sh');
  s.stub('aws', `echo "aws AWS_PROFILE=$AWS_PROFILE $*" >> "$LOG"
case "$*" in
  *get-parameter*) name="$(echo "$*" | sed -E 's/.*--name ([^ ]+).*/\\1/' | tr / _)"; [ -f "$PARAMS/$name" ] && cat "$PARAMS/$name" || exit 254;;
  *start-pipeline-execution*) echo exec-1;;
  *get-pipeline-state*) [ -f "$PARAMS/promote" ] && cat "$PARAMS/promote" || printf 'None\tNone\n';;
  *get-pipeline-execution*) echo abc1234;;
  *list-state-machines*) echo arn:aws:states:us-west-2:111111111111:stateMachine:Promotion03C22B74-abc;;
  *list-executions*) echo arn:aws:states:us-west-2:111111111111:execution:Promotion03C22B74-abc:run-1;;
  *describe-stacks*) echo '${stackOutputs}';;
  *"s3api head-object"*"--key mac/manifest.json"*) [ -f "$PARAMS/checked" ] || exit 254;;
  *"s3api head-object"*) [ -f "$PARAMS/inbox/manifest.json" ] || exit 254;;
  *--recursive*) cp "$PARAMS/inbox/"* "$(echo "$*" | awk '{print $4}')/";;
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
  const logArgs = (name: string) => `import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.LOG, '${name} ' + process.argv.slice(2).join(' ') + ' ENV=' + process.env.ENV + ' SEVENZIP=' + process.env.SEVENZIP + ' MAC_TEAM_ID=' + process.env.MAC_TEAM_ID + '\\n');\n`;
  writeFileSync(join(s.root, 'frontend/scripts/electron-compile.mjs'), `${logArgs('electron-compile')}import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('dist-electron', { recursive: true });\nwriteFileSync('dist-electron/main.cjs', process.env.ENV);\n`);
  writeFileSync(join(s.root, 'frontend/scripts/mac-inbox.ts'), `${logArgs('mac-inbox')}process.exit(process.env.VERIFY_FAILS ? 1 : 0);\n`);
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

  it('stops the run waiting in its window before prod, and says which commit', () => {
    const s = sandbox();
    writeFileSync(join(s.params, 'promote'), 'exec-7\tInProgress\n');
    const r = s.run(['stop']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /aws AWS_PROFILE=ms-control codepipeline stop-pipeline-execution --pipeline-name Multiscale --pipeline-execution-id exec-7 --abandon/);
    assert.match(r.stdout, /Stopped run exec-7, at abc1234, before prod/);
    // And its window, so the email's Promote now link no longer promotes anything.
    assert.match(s.log(), /stepfunctions list-executions --state-machine-arn arn:aws:states:us-west-2:111111111111:stateMachine:Promotion03C22B74-abc --status-filter RUNNING/);
    assert.match(s.log(), /stepfunctions stop-execution --execution-arn arn:aws:states:us-west-2:111111111111:execution:Promotion03C22B74-abc:run-1/);
  });

  it('stops nothing when no run is waiting before prod', () => {
    for (const promote of [null, 'exec-7\tSucceeded\n']) {
      const s = sandbox();
      if (promote) writeFileSync(join(s.params, 'promote'), promote);
      const r = s.run(['stop']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /No run is waiting to go to prod/);
      assert.doesNotMatch(s.log(), /stop-pipeline-execution|stop-execution/);
    }
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
    // And each one's Mac main process, which a Mac app from GitHub Actions must hold.
    for (const env of ['staging', 'prod']) assert.equal(readFileSync(join(s.root, `mac/${env}/dist-electron/main.cjs`), 'utf8'), env);
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

  // The Build output for both environments, as the MacApp step reads it, and GitHub Actions' upload in the inbox.
  const COMMIT = 'c0ffee'.padEnd(40, '0');
  const macStep = (s: ReturnType<typeof sandbox>, { built = { electron: 'e2', ios: 'i1' }, inbox = true } = {}) => {
    const builtDir = join(s.root, 'built');
    for (const env of ['staging', 'prod']) {
      mkdirSync(join(builtDir, `web/${env}`), { recursive: true });
      writeFileSync(join(builtDir, `web/${env}/version.json`), JSON.stringify({ version: '0.1.0-abc', build: 1, shell: built }));
    }
    if (inbox) {
      mkdirSync(join(s.params, 'inbox'));
      writeFileSync(join(s.params, 'inbox/manifest.json'), JSON.stringify({ files: { 'Multiscale.dmg': { sha256: 'f'.repeat(64) } } }));
      writeFileSync(join(s.params, 'inbox/Multiscale.dmg'), 'disk image');
    }
    return { CODEBUILD_SRC_DIR_Built: builtDir, COMMIT, MAC_INBOX_BUCKET: 'inbox-bucket', MAC_TEAM_ID: 'ABCDE12345', MAC_WAIT_SECONDS: '600', SEVENZIP: '/bin/true' };
  };

  it("checks no Mac app when every feed can take this build's and the downloads host serves one the pipeline checked", () => {
    const s = configured();
    writeFileSync(join(s.params, 'feed'), feedWith(shell));
    writeFileSync(join(s.params, 'checked'), '');
    const r = s.run(['mac'], macStep(s, { built: shell, inbox: false }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /aws AWS_PROFILE=ms-staging s3api head-object --bucket bucket --key mac\/manifest\.json/);
    assert.doesNotMatch(s.log(), /head-object --bucket inbox-bucket|mac-inbox/);
    assert.equal(readFileSync(join(s.root, 'mac-checked/checked.txt'), 'utf8'), 'staging: no new Mac app needed\nprod: no new Mac app needed\n');
  });

  it("waits for GitHub Actions' Mac app of this commit, checks it against the Build output, and hands on what passed", () => {
    const s = configured();
    writeFileSync(join(s.params, 'feed'), feedWith(shell));
    const r = s.run(['mac'], macStep(s));
    assert.equal(r.status, 0, r.stderr);
    for (const env of ['staging', 'prod']) {
      // As the pipeline's own role, which may only read the inbox.
      assert.match(s.log(), new RegExp(`aws AWS_PROFILE= s3api head-object --bucket inbox-bucket --key inbox/${COMMIT}/${env}/manifest\\.json`));
      assert.match(s.log(), new RegExp(`mac-inbox verify ${env} ${COMMIT} \\S+ ${s.root}/built/web/${env} ${s.root}/built/mac/${env}/dist-electron ENV=undefined SEVENZIP=/bin/true MAC_TEAM_ID=ABCDE12345`));
      assert.equal(readFileSync(join(s.root, `mac-checked/${env}/Multiscale.dmg`), 'utf8'), 'disk image');
    }
  });

  it("checks this commit's Mac app when the downloads host serves none the pipeline checked, though the feed can take the build", () => {
    const s = configured();
    writeFileSync(join(s.params, 'feed'), feedWith(shell));
    const r = s.run(['mac'], macStep(s, { built: shell }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /staging's downloads host serves no Mac app the pipeline checked/);
    for (const env of ['staging', 'prod']) {
      assert.match(s.log(), new RegExp(`mac-inbox verify ${env} ${COMMIT} `));
      assert.equal(readFileSync(join(s.root, `mac-checked/${env}/Multiscale.dmg`), 'utf8'), 'disk image');
    }
  });

  it('stops the run, saying what to do, when no Mac app arrives in time', () => {
    const s = configured();
    writeFileSync(join(s.params, 'feed'), feedWith(shell));
    const r = s.run(['mac'], { ...macStep(s, { inbox: false }), MAC_WAIT_SECONDS: '0' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`No Mac app for staging at ${COMMIT} reached the inbox in time`));
    assert.match(r.stderr, new RegExp(`gh workflow run mac-release\\.yml -f commit=${COMMIT}`));
    assert.doesNotMatch(s.log(), /mac-inbox/);
  });

  it('stops the run, handing on nothing, when a Mac app fails its checks', () => {
    const s = configured();
    writeFileSync(join(s.params, 'feed'), feedWith(shell));
    const r = s.run(['mac'], { ...macStep(s), VERIFY_FAILS: '1' });
    assert.notEqual(r.status, 0);
    assert.throws(() => readFileSync(join(s.root, 'mac-checked/staging/Multiscale.dmg')));
  });

  // A release step's artifacts, with the MacApp step's output beside them.
  const withMac = (s: ReturnType<typeof sandbox>, built: object, dmg: boolean) => {
    const mac = join(s.root, 'mac-apps');
    mkdirSync(join(mac, 'staging'), { recursive: true });
    if (dmg) {
      writeFileSync(join(mac, 'staging/Multiscale.dmg'), 'disk image');
      writeFileSync(join(mac, 'staging/manifest.json'), '{}');
    }
    return { ...artifacts(s, built), CODEBUILD_SRC_DIR_MacApps: mac };
  };

  it('publishes the checked Mac app to the downloads host, then the feed that needs it', () => {
    const s = configured();
    writeFileSync(join(s.params, 'feed'), feedWith(shell));
    const r = s.run(['release-staging'], withMac(s, { electron: 'e2', ios: 'i1' }, true));
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /aws AWS_PROFILE=ms-staging s3 cp \S+\/mac-apps\/staging\/Multiscale\.dmg s3:\/\/bucket\/downloads\/Multiscale\.dmg --cache-control public, max-age=300 --content-type application\/x-apple-diskimage\n(.*\n)*.*s3:\/\/bucket\/release\/release\.json/);
    // And then which checked app the downloads host serves, so later runs need no new one until the feed does.
    assert.match(s.log(), /s3:\/\/bucket\/downloads\/Multiscale\.dmg (.*\n)*.*s3 cp \S+\/mac-apps\/staging\/manifest\.json s3:\/\/bucket\/mac\/manifest\.json/);
  });

  it('publishes a checked Mac app when the feed can take the build too, as when the downloads host had none the pipeline checked', () => {
    const s = configured();
    writeFileSync(join(s.params, 'feed'), feedWith(shell));
    const r = s.run(['release-staging'], withMac(s, shell, true));
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /s3:\/\/bucket\/downloads\/Multiscale\.dmg/);
    assert.match(s.log(), /s3:\/\/bucket\/mac\/manifest\.json/);
    assert.match(s.log(), /s3:\/\/bucket\/release\/release\.json/);
  });

  it('publishes nothing when the build needs a new Mac app and the run checked none', () => {
    const s = configured();
    writeFileSync(join(s.params, 'feed'), feedWith(shell));
    const r = s.run(['release-staging'], withMac(s, { electron: 'e2', ios: 'i1' }, false));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /needs a newer Mac app than staging's feed, but this run checked none/);
    // Nothing uploaded: the only call to the bucket reads the live feed.
    assert.doesNotMatch(s.log(), /(cp|sync) \/\S+ s3:\/\/bucket\//);
    assert.doesNotMatch(s.log(), /test-deployed/);
  });

  it('still leaves the feed for the Mac when the build needs a new iPhone app, after publishing the Mac app', () => {
    const s = configured();
    writeFileSync(join(s.params, 'feed'), feedWith(shell));
    const r = s.run(['release-staging'], withMac(s, { electron: 'e2', ios: 'i2' }, true));
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /s3:\/\/bucket\/downloads\/Multiscale\.dmg/);
    assert.match(r.stderr, /needs a newer iPhone app than staging's feed, so the feed stays as it is/);
    assert.doesNotMatch(s.log(), /s3:\/\/bucket\/release\/(files|release\.json) --/);
  });

  it('publishes no Mac app when the feed can take the build as it is', () => {
    const s = configured();
    writeFileSync(join(s.params, 'feed'), feedWith(shell));
    const r = s.run(['release-staging'], withMac(s, shell, false));
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(s.log(), /downloads/);
    assert.match(s.log(), /s3:\/\/bucket\/release\/release\.json/);
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
