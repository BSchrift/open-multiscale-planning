import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { sandboxRepo } from './sandbox.ts';

const stackOutputs = JSON.stringify([
  { OutputKey: 'ApiUrl', OutputValue: 'https://api.example.net' },
  { OutputKey: 'CognitoDomain', OutputValue: 'https://auth.example.net' },
  { OutputKey: 'AppClientId', OutputValue: 'client' },
  { OutputKey: 'ReleaseBucket', OutputValue: 'bucket' },
  { OutputKey: 'WebUrl', OutputValue: 'https://web.example.net' },
  { OutputKey: 'ReleaseUrl', OutputValue: 'https://release.example.net' },
  { OutputKey: 'ReleaseAlarms', OutputValue: 'Api5xxRate-1,LambdaErrors-2' },
]);
const shell = { electron: 'e1', ios: 'i1' };
const feedWith = (s: object) => JSON.stringify({ manifest: JSON.stringify({ version: 'old', build: 0, shell: s, files: [] }), signature: 'x' });

// aws answers get-parameter from $PARAMS, a folder of files named like the parameter with / as _, and s3 from a folder
// per bucket under $PARAMS/s3 (fake-s3.ts), the record of a checked Mac app on a downloads host included.
const fakeS3 = join(import.meta.dirname, 'fake-s3.ts');
function sandbox() {
  const s = sandboxRepo('pipeline.sh');
  s.stub('aws', `echo "aws AWS_PROFILE=$AWS_PROFILE $*" >> "$LOG"
case "$*" in
  *get-parameter*) name="$(echo "$*" | sed -E 's/.*--name ([^ ]+).*/\\1/' | tr / _)"; [ -f "$PARAMS/$name" ] && cat "$PARAMS/$name" || exit 254;;
  *start-pipeline-execution*) echo exec-1;;
  *get-pipeline-state*) cat "$PARAMS/state.json" 2>/dev/null || echo '{"stageStates":[]}';;
  *get-pipeline-execution*) echo abc1234;;
  *"sts get-caller-identity"*) echo "\${ACCOUNT:-210987654321}";;
  *list-state-machines*) echo arn:aws:states:us-west-2:111111111111:stateMachine:Promotion03C22B74-abc;;
  *list-executions*) echo arn:aws:states:us-west-2:111111111111:execution:Promotion03C22B74-abc:run-1;;
  *describe-stacks*) [ -n "$OLD_STACK" ] && echo '${stackOutputs.replace(/,\s*\{[^}]*ReleaseAlarms[^}]*\}/, '')}' || echo '${stackOutputs}';;
  *"cloudwatch describe-alarms"*) cat "$PARAMS/alarming" 2>/dev/null || true;;
  *"s3api head-object"*) [ -f "$PARAMS/s3/$(echo "$*" | sed -E 's|.*--bucket ([^ ]+) --key ([^ ]+).*|\\1/\\2|')" ] || exit 254;;
  "s3 "*) exec node ${fakeS3} "$@";;
esac`);
  for (const name of ['go', 'npx', 'npm', 'sleep', 'apt-get']) s.stub(name, `echo "${name} $*" >> "$LOG"`);
  s.stub('xvfb-run', 'shift; exec "$@"');
  // The hosts serve what the bucket holds: web/ on the web host and release/ on the release host, or $STALE_HOST's old copy.
  s.stub('curl', `echo "curl $*" >> "$LOG"
url="$(printf '%s\\n' "$@" | grep '^https://')"
case "$url" in
  https://web.example.net/*) key="web/\${url#https://web.example.net/}";;
  https://release.example.net/*) key="release/\${url#https://release.example.net/}";;
esac
[ -n "$STALE_HOST" ] && case "$url" in "$STALE_HOST"*) echo '{"version":"stale"}'; exit 0;; esac
cat "$PARAMS/s3/bucket/$key" 2>/dev/null || exit 22`);
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
  writeFileSync(join(s.root, 'scripts/test-deployed.sh'), '#!/bin/sh\necho "test-deployed ENV=$ENV EXPECT_VERSION=$EXPECT_VERSION EXPECT_FEEDS=$EXPECT_FEEDS SKIP_IOS=$SKIP_IOS SKIP_HISTORY=$SKIP_HISTORY SKIP_RETENTION=$SKIP_RETENTION FEEDS_ONLY=$FEEDS_ONLY DEPLOYED_BEFORE_PUBLISH=$DEPLOYED_BEFORE_PUBLISH" >> "$LOG"\n');
  chmodSync(join(s.root, 'scripts/test-deployed.sh'), 0o755);
  const params = join(s.root, 'params');
  mkdirSync(params);
  const param = (name: string, value: string) => writeFileSync(join(params, name.replaceAll('/', '_')), `${value}\n`);
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('bash', [join(s.root, 'scripts/pipeline.sh'), ...args], { encoding: 'utf8', env: { ...s.env, PARAMS: params, HOME: s.root, ...env } as NodeJS.ProcessEnv });
  // What a bucket holds, as s3://<bucket>/<key>.
  const object = (url: string) => join(params, 's3', url.slice('s3://'.length));
  const put = (url: string, value: string) => {
    mkdirSync(dirname(object(url)), { recursive: true });
    writeFileSync(object(url), value);
  };
  const get = (url: string) => (existsSync(object(url)) ? readFileSync(object(url), 'utf8') : null);
  return { ...s, run, param, params, put, get };
}

// A release bucket with versions kept, each surface serving 0.1.0-ccc, and the history that got them there. 0.1.0-ios
// needs a newer iPhone app.
const feedOf = (version: string, build: number, s: object = shell) => JSON.stringify({ manifest: JSON.stringify({ version, build, shell: s, files: [] }), signature: 'x' });
function kept(s: ReturnType<typeof sandbox>) {
  const versions: [string, number, object][] = [['0.1.0-aaa', 1, shell], ['0.1.0-bbb', 2, shell], ['0.1.0-ccc', 3, shell], ['0.1.0-ios', 4, { electron: 'e1', ios: 'i2' }]];
  for (const [version, build, sh] of versions) {
    s.put(`s3://bucket/versions/${version}/web/version.json`, JSON.stringify({ version, build, shell: sh }));
    s.put(`s3://bucket/versions/${version}/web/index.html`, `<html>${version}</html>`);
    s.put(`s3://bucket/versions/${version}/release.json`, feedOf(version, build, sh));
  }
  s.put('s3://bucket/web/version.json', JSON.stringify({ version: '0.1.0-ccc', build: 3, shell }));
  s.put('s3://bucket/web/index.html', '<html>0.1.0-ccc</html>');
  for (const feed of ['desktop/release.json', 'iphone/release.json', 'release.json']) s.put(`s3://bucket/release/${feed}`, feedOf('0.1.0-ccc', 3));
  const line = (version: string, day: number) => ({ version, build: Number(version.at(-1) === 'a' ? 1 : version.at(-1) === 'b' ? 2 : 3), at: `2026-11-0${day}T10:00:00Z` });
  s.put('s3://bucket/state/history.json', JSON.stringify({
    web: [line('0.1.0-aaa', 1), line('0.1.0-bbb', 2), line('0.1.0-ccc', 3)],
    desktop: [line('0.1.0-bbb', 2), line('0.1.0-ccc', 3)],
    iphone: [line('0.1.0-ccc', 3)],
    shared: [line('0.1.0-bbb', 2), line('0.1.0-ccc', 3)],
  }));
}
const served = (s: ReturnType<typeof sandbox>, key: string) => {
  const r = JSON.parse(s.get(`s3://bucket/${key}`)!) as { version?: string; manifest?: string };
  return r.manifest ? (JSON.parse(r.manifest) as { version: string }).version : r.version;
};

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
    assert.match(s.log(), /codepipeline start-pipeline-execution --name Multiscale --variables name=RUN,value=hand name=CANARY,value=on name=ALARMS,value=on name=BAKES,value=on --query/);
    const skip = sandbox();
    assert.equal(skip.run(['run'], { COMMIT: 'abc123', CANARY: 'skip', ENV: 'prod' }).status, 0);
    assert.match(skip.log(), /name=CANARY,value=skip name=ALARMS,value=on name=BAKES,value=on --source-revisions actionName=GitHub,revisionType=COMMIT_ID,revisionValue=abc123/);
  });

  // The pipeline as get-pipeline-state shows it: a run in each stage named, and what its actions are doing.
  const stateWith = (stages: { name: string; run?: string; status?: string; acting?: string; inbound?: string }[]) => JSON.stringify({
    stageStates: stages.map(({ name, run, status = 'InProgress', acting, inbound }) => ({
      stageName: name,
      ...(inbound ? { inboundExecution: { pipelineExecutionId: inbound, status: 'InProgress' } } : {}),
      ...(run ? { latestExecution: { pipelineExecutionId: run, status } } : {}),
      actionStates: acting ? [{ actionName: acting, latestExecution: { status: 'InProgress' } }] : [],
    })),
  });

  it('stops every run that is waiting, in the window, a bake or for a stage, says which commit, and leaves one at work', () => {
    const s = sandbox();
    writeFileSync(join(s.config, 'prod.outputs.json'), JSON.stringify({ ReleaseBucket: 'bucket' }));
    kept(s);
    writeFileSync(join(s.params, 'state.json'), stateWith([
      { name: 'Promote', run: 'exec-7', acting: 'Wait' },
      { name: 'Prod', run: 'exec-8', acting: 'Deploy' },
      { name: 'Web', run: 'exec-6', acting: 'Bake' },
      { name: 'Desktop', run: 'exec-4', status: 'Succeeded', inbound: 'exec-5' },
    ]));
    const r = s.run(['stop']);
    assert.equal(r.status, 0, r.stderr);
    for (const id of ['exec-7', 'exec-6', 'exec-5']) {
      assert.match(s.log(), new RegExp(`aws AWS_PROFILE=ms-control codepipeline stop-pipeline-execution --pipeline-name Multiscale --pipeline-execution-id ${id} --abandon`));
    }
    assert.doesNotMatch(s.log(), /--pipeline-execution-id exec-[48] --abandon/);
    assert.match(r.stdout, /Stopped run exec-7, at abc1234, in its window before prod/);
    assert.match(r.stdout, /Stopped run exec-5, at abc1234, waiting for the Desktop stage/);
    assert.match(r.stdout, /Run exec-8, at abc1234, is at work in the Prod stage, so it goes on/);
    // A stop keeps what a surface has, so it says how to go back, reading prod's bucket as prod's profile.
    assert.match(r.stdout, /Stopped run exec-6, at abc1234, in the Web stage's bake\. prod's web keeps 0\.1\.0-ccc; to go back: make release-surface ENV=prod SURFACE=web VERSION=0\.1\.0-bbb/);
    assert.match(s.log(), /aws AWS_PROFILE=ms-prod s3 cp s3:\/\/bucket\/state\/history\.json -/);
    // And the window's own wait, so the email's Promote now link no longer promotes anything.
    assert.match(s.log(), /stepfunctions list-executions --state-machine-arn arn:aws:states:us-west-2:111111111111:stateMachine:Promotion03C22B74-abc --status-filter RUNNING/);
    assert.match(s.log(), /stepfunctions stop-execution --execution-arn arn:aws:states:us-west-2:111111111111:execution:Promotion03C22B74-abc:run-1/);
  });

  it('stops nothing when no run is waiting', () => {
    for (const state of [null, stateWith([{ name: 'Promote', run: 'exec-7', status: 'Succeeded' }])]) {
      const s = sandbox();
      if (state) writeFileSync(join(s.params, 'state.json'), state);
      const r = s.run(['stop']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /No run is waiting/);
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

  it("starts a run that doesn't wait out prod's bakes when asked", () => {
    const s = sandbox();
    const r = s.run(['run'], { BAKES: 'skip' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /name=ALARMS,value=on name=BAKES,value=skip/);
    assert.match(r.stdout, /without waiting out the bakes/);
  });

  it('refuses any other CANARY, ALARMS, BAKES or ENV before calling AWS', () => {
    for (const env of [{ CANARY: 'off' }, { ALARMS: 'no' }, { BAKES: 'off' }, { ENV: 'staging' }] as Record<string, string>[]) {
      const s = sandbox();
      assert.notEqual(s.run(['run'], env).status, 0);
      assert.doesNotMatch(s.log(), /^aws /m);
    }
  });

  // release-surface reads the environment's outputs, which make deploy writes on the Mac.
  const surfaces = () => {
    const s = sandbox();
    writeFileSync(join(s.config, 'staging.outputs.json'), JSON.stringify(Object.fromEntries((JSON.parse(stackOutputs) as { OutputKey: string; OutputValue: string }[]).map((o) => [o.OutputKey, o.OutputValue]))));
    kept(s);
    return s;
  };

  it('lists what each surface serves, its last versions and the versions kept, signed in to the environment', () => {
    const s = surfaces();
    const r = s.run(['release-surface'], { ENV: 'staging' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /aws AWS_PROFILE=ms-staging sts get-caller-identity/);
    for (const surface of ['web', 'desktop', 'iphone', 'shared']) assert.match(r.stdout, new RegExp(`^  ${surface} +0\\.1\\.0-ccc$`, 'm'));
    assert.match(r.stdout, /^  web +0\.1\.0-ccc 2026-11-03T10:00:00Z, 0\.1\.0-bbb 2026-11-02T10:00:00Z, 0\.1\.0-aaa 2026-11-01T10:00:00Z$/m);
    assert.match(r.stdout, /Versions kept, newest first:\n(  0\.1\.0-(aaa|bbb|ccc|ios) +uploaded \S+ \S+\n){4}/);
    assert.doesNotMatch(s.log(), /s3 cp s3:\/\/\S+ s3:\/\//);
  });

  it('switches web back to a version kept, and records it', () => {
    const s = surfaces();
    const r = s.run(['release-surface'], { ENV: 'staging', SURFACE: 'web', VERSION: '0.1.0-bbb' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.get('s3://bucket/web/index.html'), '<html>0.1.0-bbb</html>');
    assert.equal(served(s, 'web/version.json'), '0.1.0-bbb');
    assert.match(r.stdout, /Switched staging's web from 0\.1\.0-ccc to 0\.1\.0-bbb/);
    assert.doesNotMatch(r.stdout, /further back/);
    assert.deepEqual((JSON.parse(s.get('s3://bucket/state/history.json')!) as Record<string, { version: string }[]>).web!.map((l) => l.version), ['0.1.0-aaa', '0.1.0-bbb', '0.1.0-ccc', '0.1.0-bbb']);
  });

  it('says so when web goes back further than the version before, which the compatibility test does not cover', () => {
    const s = surfaces();
    const r = s.run(['release-surface'], { ENV: 'staging', SURFACE: 'web', VERSION: '0.1.0-aaa' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /further back than the version before/);
    assert.equal(served(s, 'web/version.json'), '0.1.0-aaa');
  });

  it('switches only the feed named, the shared one included', () => {
    const s = surfaces();
    assert.equal(s.run(['release-surface'], { ENV: 'staging', SURFACE: 'desktop', VERSION: '0.1.0-bbb' }).status, 0);
    assert.equal(served(s, 'release/desktop/release.json'), '0.1.0-bbb');
    assert.equal(served(s, 'release/release.json'), '0.1.0-ccc');
    assert.equal(served(s, 'release/iphone/release.json'), '0.1.0-ccc');
    assert.equal(s.run(['release-surface'], { ENV: 'staging', SURFACE: 'shared', VERSION: '0.1.0-bbb' }).status, 0);
    assert.equal(served(s, 'release/release.json'), '0.1.0-bbb');
  });

  it("refuses a version not kept, or one the feed's apps couldn't take, and switches nothing", () => {
    for (const [surface, version, why] of [['web', '0.1.0-zzz', /keeps no version 0\.1\.0-zzz/], ['iphone', '0.1.0-ios', /other native code than the apps staging's iphone feed serves/], ['shared', '0.1.0-ios', /other native code than the apps staging's shared feed serves/]] as const) {
      const s = surfaces();
      const r = s.run(['release-surface'], { ENV: 'staging', SURFACE: surface, VERSION: version });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, why);
      assert.doesNotMatch(s.log(), /s3 cp s3:\/\/\S+ s3:\/\//);
    }
    // The Mac's native code is the same, and web runs none.
    for (const surface of ['desktop', 'web']) assert.equal(surfaces().run(['release-surface'], { ENV: 'staging', SURFACE: surface, VERSION: '0.1.0-ios' }).status, 0);
  });

  it('refuses another ENV or SURFACE, or a VERSION with no SURFACE, before calling AWS, and a profile signed in elsewhere', () => {
    for (const env of [{ ENV: 'dev' }, { ENV: 'staging', SURFACE: 'watch', VERSION: '0.1.0-bbb' }, { ENV: 'staging', VERSION: '0.1.0-bbb' }] as Record<string, string>[]) {
      const s = surfaces();
      assert.notEqual(s.run(['release-surface'], env).status, 0);
      assert.doesNotMatch(s.log(), /^aws /m);
    }
    const elsewhere = surfaces();
    const r = elsewhere.run(['release-surface'], { ENV: 'staging', SURFACE: 'web', VERSION: '0.1.0-bbb', ACCOUNT: '123456789012' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /signed in to account 123456789012/);
    assert.doesNotMatch(elsewhere.log(), /s3 /);
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

  // The Build output with an environment's web build, and the signing step's output, as CodeBuild hands them to a step.
  const VERSION = '0.1.0-abc';
  const release = JSON.stringify({ manifest: JSON.stringify({ version: VERSION, build: 1, shell, files: [{ path: 'index.html', sha256: 'a1' }] }), signature: 'x' });
  const artifacts = (s: ReturnType<typeof sandbox>, built: object = shell, env = 'staging') => {
    const builtDir = join(s.root, 'built');
    mkdirSync(join(builtDir, `web/${env}/assets`), { recursive: true });
    writeFileSync(join(builtDir, `web/${env}/version.json`), JSON.stringify({ version: VERSION, build: 1, shell: built }));
    writeFileSync(join(builtDir, `web/${env}/index.html`), '<html>new</html>');
    writeFileSync(join(builtDir, `web/${env}/assets/app-1234.js`), 'app');
    const signed = join(s.root, 'signed');
    mkdirSync(join(signed, 'files'), { recursive: true });
    writeFileSync(join(signed, 'release.json'), release);
    writeFileSync(join(signed, 'files/a1'), '<html>new</html>');
    return { CODEBUILD_SRC_DIR_Built: builtDir, [`CODEBUILD_SRC_DIR_Signed${env === 'staging' ? 'Staging' : 'Prod'}`]: signed };
  };
  const FEEDS = { desktop: 's3://bucket/release/desktop/release.json', iphone: 's3://bucket/release/iphone/release.json', shared: 's3://bucket/release/release.json' };
  const history = (s: ReturnType<typeof sandbox>) => JSON.parse(s.get('s3://bucket/state/history.json') ?? '{}') as Record<string, { version: string; build: number; at: string }[]>;

  it("uploads staging's version where no host serves it, switches the web app and every feed to it, then tests it", () => {
    const s = configured();
    s.put(FEEDS.shared, feedWith(shell));
    const r = s.run(['release-staging'], artifacts(s));
    assert.equal(r.status, 0, r.stderr);
    // The version, kept: its page, and its feed as signed.
    assert.equal(s.get(`s3://bucket/versions/${VERSION}/web/index.html`), '<html>new</html>');
    assert.equal(s.get(`s3://bucket/versions/${VERSION}/web/assets/app-1234.js`), null);
    assert.equal(s.get(`s3://bucket/versions/${VERSION}/release.json`), release);
    // The files both name by their contents, in the stores the hosts serve, cached for good.
    assert.equal(s.get('s3://bucket/web/assets/app-1234.js'), 'app');
    assert.equal(s.get('s3://bucket/release/files/a1'), '<html>new</html>');
    assert.match(s.log(), /aws AWS_PROFILE=ms-staging s3 sync \S+\/built\/web\/staging\/assets s3:\/\/bucket\/web\/assets --size-only --cache-control public, max-age=31536000, immutable\n/);
    assert.match(s.log(), /aws AWS_PROFILE=ms-staging s3 sync \S+\/signed\/files s3:\/\/bucket\/release\/files --size-only --cache-control public, max-age=31536000, immutable --content-type application\/octet-stream/);
    // With the headers each switch copies: the page checked on every load, and each feed for a minute.
    assert.match(s.log(), /s3 sync \S+\/built\/web\/staging s3:\/\/bucket\/versions\/0\.1\.0-abc\/web --exclude assets\/\* --cache-control no-cache/);
    assert.match(s.log(), /s3 cp \S+\/signed\/release\.json s3:\/\/bucket\/versions\/0\.1\.0-abc\/release\.json --cache-control public, max-age=60 --content-type application\/json/);
    // Then every surface switched to it, web's version.json last.
    assert.equal(s.get('s3://bucket/web/index.html'), '<html>new</html>');
    assert.match(s.log(), /s3 cp s3:\/\/bucket\/versions\/0\.1\.0-abc\/web\/ s3:\/\/bucket\/web\/ --recursive --exclude version\.json\n.*s3 cp s3:\/\/bucket\/versions\/0\.1\.0-abc\/web\/version\.json s3:\/\/bucket\/web\/version\.json\n/);
    for (const feed of Object.values(FEEDS)) assert.equal(s.get(feed), release);
    assert.deepEqual(Object.fromEntries(Object.entries(history(s)).map(([surface, lines]) => [surface, lines.map((l) => [l.version, l.build])])), {
      web: [[VERSION, 1]], desktop: [[VERSION, 1]], iphone: [[VERSION, 1]], shared: [[VERSION, 1]],
    });
    assert.match(history(s).web![0]!.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.match(s.log(), /test-deployed ENV=staging EXPECT_VERSION=0\.1\.0-abc EXPECT_FEEDS=desktop iphone shared SKIP_IOS=1 SKIP_HISTORY=1 SKIP_RETENTION=1/);
    // Each profile signs in as its account's release role.
    assert.match(readFileSync(join(s.root, '.aws/config'), 'utf8'), /\[profile ms-staging\]\nrole_arn = arn:aws:iam::210987654321:role\/multiscale-release\ncredential_source = EcsContainer/);
  });

  it("tells the prod Test step's suites the web app is still the one before this release", () => {
    const s = configured();
    const r = s.run(['test-prod'], {});
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /test-deployed ENV=prod .*DEPLOYED_BEFORE_PUBLISH=1/);
  });

  it('adds each switch to the history after the ones before', () => {
    const s = configured();
    s.put(FEEDS.shared, feedWith(shell));
    s.put('s3://bucket/state/history.json', JSON.stringify({ web: [{ version: '0.1.0-old', build: 0, at: '2026-11-01T00:00:00Z' }] }));
    assert.equal(s.run(['release-staging'], artifacts(s)).status, 0);
    assert.deepEqual(history(s).web!.map((l) => l.version), ['0.1.0-old', VERSION]);
  });

  for (const [why, live] of [['needs newer native code than the feeds serve', feedWith({ electron: 'e2', ios: 'i2' })], ['finds no feed yet', '']] as const) {
    it(`leaves the feeds for the Mac's release when the build ${why}, and still switches the web app`, () => {
      const s = configured();
      if (live) s.put(FEEDS.shared, live);
      const r = s.run(['release-staging'], artifacts(s));
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /needs a newer Mac and iPhone app than staging's feeds serve(.*\n)*.*make release ENV=staging/);
      assert.equal(s.get(FEEDS.desktop), null);
      assert.equal(s.get(FEEDS.iphone), null);
      assert.equal(s.get(FEEDS.shared), live || null);
      assert.equal(s.get('s3://bucket/web/index.html'), '<html>new</html>');
      assert.deepEqual(Object.keys(history(s)), ['web']);
      assert.match(s.log(), /EXPECT_FEEDS= SKIP_IOS/);
    });
  }

  it('compares each feed with its own app only, so the desktop feed goes on while the iPhone and shared feeds wait for an iPhone app', () => {
    const s = configured();
    s.put(FEEDS.shared, feedWith(shell));
    const r = s.run(['release-staging'], artifacts(s, { electron: 'e1', ios: 'i2' }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /needs a newer iPhone app than staging's feeds serve, so those feeds and the shared one stay as they are/);
    assert.equal(s.get(FEEDS.desktop), release);
    assert.equal(s.get(FEEDS.iphone), null);
    assert.equal(s.get(FEEDS.shared), feedWith(shell));
    assert.match(s.log(), /EXPECT_FEEDS=desktop SKIP_IOS/);
  });

  it("compares with a surface's own feed once it has one, and the shared feed follows when both can take the build", () => {
    const s = configured();
    // A Mac app out for e2, which the desktop feed took. The iPhone has no feed of its own yet, so it reads the shared one.
    s.put(FEEDS.desktop, feedWith({ electron: 'e2', ios: 'i1' }));
    s.put(FEEDS.shared, feedWith(shell));
    const r = s.run(['release-staging'], artifacts(s, { electron: 'e2', ios: 'i1' }));
    assert.equal(r.status, 0, r.stderr);
    for (const feed of Object.values(FEEDS)) assert.equal(s.get(feed), release);
    assert.doesNotMatch(s.log(), /downloads/);
  });

  it('uploads and switches for release.sh on a Mac, as the profile it signed in with, and refuses a version not uploaded', () => {
    const s = sandbox();
    writeFileSync(join(s.config, 'staging.outputs.json'), JSON.stringify({ ReleaseBucket: 'bucket' }));
    const a = artifacts(s);
    const mac = { AWS_PROFILE: 'ms-staging' };
    const up = s.run(['upload', 'staging', join(a.CODEBUILD_SRC_DIR_Built!, 'web/staging'), a.CODEBUILD_SRC_DIR_SignedStaging!], mac);
    assert.equal(up.status, 0, up.stderr);
    assert.equal(up.stdout, `${VERSION}\n`);
    assert.equal(s.get('s3://bucket/web/index.html'), null);
    for (const surface of ['web', 'desktop', 'iphone', 'shared']) assert.equal(s.run(['switch', 'staging', surface, VERSION], mac).status, 0);
    assert.equal(s.get('s3://bucket/web/index.html'), '<html>new</html>');
    for (const feed of Object.values(FEEDS)) assert.equal(s.get(feed), release);
    assert.match(s.log(), /aws AWS_PROFILE=ms-staging s3 cp s3:\/\/bucket\/versions\/0\.1\.0-abc\/release\.json s3:\/\/bucket\/release\/iphone\/release\.json/);
    const missing = s.run(['switch', 'staging', 'web', '0.1.0-zzz'], mac);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /staging has no version 0\.1\.0-zzz uploaded/);
    assert.notEqual(s.run(['switch', 'staging', 'watch', VERSION], mac).status, 0);
    assert.deepEqual(history(s).web!.map((l) => l.version), [VERSION]);
  });

  it('turns the release alarms off for both environments when the run asks, and only then', () => {
    const s = configured();
    assert.equal(s.run(['build'], { RUN: 'hand', ALARMS: 'off' }).status, 0);
    assert.match(s.log(), /cdk synth --quiet -c deploy=staging -c alarms=off -o cdk.out\/staging/);
    assert.match(s.log(), /cdk synth --quiet -c deploy=prod -c alarms=off -o cdk.out\/prod/);
    const next = configured();
    assert.equal(next.run(['build'], { RUN: 'hand' }).status, 0);
    assert.doesNotMatch(next.log(), /alarms=off/);
  });

  it("records what a prod release skipped beside its commit once the iPhone has it, for the release tag's note", () => {
    const s = configured();
    assert.equal(s.run(['release-iphone'], { ...released(s, []), COMMIT: 'abc123', CANARY: 'skip', ALARMS: 'off', BAKES: 'skip' }).status, 0);
    assert.match(s.log(), /put-parameter --name \/multiscale\/pipeline\/released --type String --overwrite --value abc123 Canary skipped\. Release alarms off\. Bakes skipped\./);
    const plain = configured();
    assert.equal(plain.run(['release-iphone'], { ...released(plain, []), COMMIT: 'abc123' }).status, 0);
    assert.match(plain.log(), /--name \/multiscale\/pipeline\/released --type String --overwrite --value abc123\n/);
  });

  it("uploads prod's version in the Prod stage, and switches nothing", () => {
    const s = configured();
    kept(s);
    const r = s.run(['upload-prod'], artifacts(s, shell, 'prod'));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.get(`s3://bucket/versions/${VERSION}/release.json`), release);
    assert.match(s.log(), /aws AWS_PROFILE=ms-prod s3 cp \S+\/signed\/release\.json s3:\/\/bucket\/versions\/0\.1\.0-abc\/release\.json/);
    assert.equal(served(s, 'web/version.json'), '0.1.0-ccc');
    for (const feed of Object.values(FEEDS)) assert.equal(s.get(feed), feedOf('0.1.0-ccc', 3));
  });

  it('switches web alone in the Web stage, then runs its suites against that version', () => {
    const s = configured();
    const r = s.run(['release-web'], released(s, []));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(served(s, 'web/version.json'), VERSION);
    for (const feed of Object.values(FEEDS)) assert.equal(s.get(feed), feedOf('0.1.0-ccc', 3));
    assert.match(s.log(), /test-deployed ENV=prod EXPECT_VERSION=0\.1\.0-abc EXPECT_FEEDS= SKIP_IOS=1 .*FEEDS_ONLY= DEPLOYED_BEFORE_PUBLISH=\n/);
  });

  it('publishes a checked Mac app, then switches the desktop and shared feeds in the Desktop stage, and checks them', () => {
    const s = configured();
    const env = released(s, []);
    writeFileSync(join(env.CODEBUILD_SRC_DIR_Built!, 'web/prod/version.json'), JSON.stringify({ version: VERSION, build: 5, shell: { electron: 'e2', ios: 'i1' } }));
    mkdirSync(join(s.root, 'mac-apps/prod'), { recursive: true });
    writeFileSync(join(s.root, 'mac-apps/prod/Multiscale.dmg'), 'disk image');
    writeFileSync(join(s.root, 'mac-apps/prod/manifest.json'), '{}');
    const r = s.run(['release-desktop'], { ...env, CODEBUILD_SRC_DIR_MacApps: join(s.root, 'mac-apps') });
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /s3:\/\/bucket\/downloads\/Multiscale\.dmg(.*\n)*.*s3:\/\/bucket\/release\/desktop\/release\.json/);
    // With the record that the downloads host serves a checked app.
    assert.equal(s.get('s3://bucket/mac/manifest.json'), '{}');
    assert.equal(s.get(FEEDS.desktop), release);
    assert.equal(s.get(FEEDS.shared), release);
    assert.equal(s.get(FEEDS.iphone), feedOf('0.1.0-ccc', 3));
    assert.equal(served(s, 'web/version.json'), '0.1.0-ccc');
    assert.match(s.log(), /test-deployed ENV=prod EXPECT_VERSION=0\.1\.0-abc EXPECT_FEEDS=desktop shared .*FEEDS_ONLY=1/);
  });

  it('switches the desktop feed and holds the shared one when the build needs a new iPhone app', () => {
    const s = configured();
    const env = released(s, []);
    writeFileSync(join(env.CODEBUILD_SRC_DIR_Built!, 'web/prod/version.json'), JSON.stringify({ version: VERSION, build: 5, shell: { electron: 'e1', ios: 'i2' } }));
    const r = s.run(['release-desktop'], env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.get(FEEDS.desktop), release);
    assert.equal(s.get(FEEDS.shared), feedOf('0.1.0-ccc', 3));
    assert.match(r.stdout, /needs a newer iPhone app/);
    assert.match(s.log(), /EXPECT_FEEDS=desktop SKIP_IOS/);
  });

  it('switches the iPhone feed in the iPhone stage and checks it', () => {
    const s = configured();
    const r = s.run(['release-iphone'], { ...released(s, ['web', 'desktop', 'shared']), COMMIT: 'abc123' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.get(FEEDS.iphone), release);
    assert.match(s.log(), /test-deployed ENV=prod EXPECT_VERSION=0\.1\.0-abc EXPECT_FEEDS=iphone .*FEEDS_ONLY=1/);
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
      for (const env of ['staging', 'prod']) {
        s.put(`s3://inbox-bucket/inbox/${COMMIT}/${env}/manifest.json`, JSON.stringify({ files: { 'Multiscale.dmg': { sha256: 'f'.repeat(64) } } }));
        s.put(`s3://inbox-bucket/inbox/${COMMIT}/${env}/Multiscale.dmg`, 'disk image');
      }
    }
    return { CODEBUILD_SRC_DIR_Built: builtDir, COMMIT, MAC_INBOX_BUCKET: 'inbox-bucket', MAC_TEAM_ID: 'ABCDE12345', MAC_WAIT_SECONDS: '600', SEVENZIP: '/bin/true' };
  };

  it("checks no Mac app when every feed can take this build's and the downloads host serves one the pipeline checked", () => {
    const s = configured();
    s.put(FEEDS.shared, feedWith(shell));
    s.put('s3://bucket/mac/manifest.json', '{}');
    const r = s.run(['mac'], macStep(s, { built: shell, inbox: false }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /aws AWS_PROFILE=ms-staging s3api head-object --bucket bucket --key mac\/manifest\.json/);
    assert.doesNotMatch(s.log(), /head-object --bucket inbox-bucket|mac-inbox/);
    assert.equal(readFileSync(join(s.root, 'mac-checked/checked.txt'), 'utf8'), 'staging: no new Mac app needed\nprod: no new Mac app needed\n');
  });

  it('compares with the desktop feed once it has one, which a Mac app already out serves', () => {
    const s = configured();
    s.put(FEEDS.desktop, feedWith({ electron: 'e2', ios: 'i1' }));
    s.put(FEEDS.shared, feedWith(shell));
    s.put('s3://bucket/mac/manifest.json', '{}');
    const r = s.run(['mac'], macStep(s, { inbox: false }));
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(s.log(), /head-object --bucket inbox-bucket|mac-inbox/);
  });

  it("waits for GitHub Actions' Mac app of this commit, checks it against the Build output, and hands on what passed", () => {
    const s = configured();
    s.put(FEEDS.shared, feedWith(shell));
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
    s.put(FEEDS.shared, feedWith(shell));
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
    s.put(FEEDS.shared, feedWith(shell));
    const r = s.run(['mac'], { ...macStep(s, { inbox: false }), MAC_WAIT_SECONDS: '0' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`No Mac app for staging at ${COMMIT} reached the inbox in time`));
    assert.match(r.stderr, new RegExp(`gh workflow run mac-release\\.yml -f commit=${COMMIT}`));
    assert.doesNotMatch(s.log(), /mac-inbox/);
  });

  it("stops waiting before CodeBuild's own limit, however long the wait, and says how to retry the stage", () => {
    const s = configured();
    s.put(FEEDS.shared, feedWith(shell));
    const r = s.run(['mac'], { ...macStep(s, { inbox: false }), MAC_WAIT_SECONDS: '7200', CODEBUILD_LIMIT_SECONDS: '0', EXECUTION_ID: 'exec-1' });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /Waiting up to 0 minutes/);
    assert.match(r.stderr, /retry-stage-execution --pipeline-name Multiscale --stage-name Staging --pipeline-execution-id exec-1 --retry-mode FAILED_ACTIONS/);
  });

  it('stops the run, handing on nothing, when a Mac app fails its checks', () => {
    const s = configured();
    s.put(FEEDS.shared, feedWith(shell));
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

  it('publishes the checked Mac app to the downloads host, then the feeds that need it', () => {
    const s = configured();
    s.put(FEEDS.shared, feedWith(shell));
    const r = s.run(['release-staging'], withMac(s, { electron: 'e2', ios: 'i1' }, true));
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /aws AWS_PROFILE=ms-staging s3 cp \S+\/mac-apps\/staging\/Multiscale\.dmg s3:\/\/bucket\/downloads\/Multiscale\.dmg --cache-control public, max-age=300 --content-type application\/x-apple-diskimage\n(.*\n)*.*s3:\/\/bucket\/release\/desktop\/release\.json/);
    assert.equal(s.get('s3://bucket/downloads/Multiscale.dmg'), 'disk image');
    for (const feed of Object.values(FEEDS)) assert.equal(s.get(feed), release);
    // And then the record that the downloads host serves a checked app, so later runs need none until a feed does.
    assert.equal(s.get('s3://bucket/mac/manifest.json'), '{}');
  });

  it('publishes a checked Mac app when the feeds can take the build too, as when the downloads host had none the pipeline checked', () => {
    const s = configured();
    s.put(FEEDS.shared, feedWith(shell));
    const r = s.run(['release-staging'], withMac(s, shell, true));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.get('s3://bucket/downloads/Multiscale.dmg'), 'disk image');
    assert.equal(s.get('s3://bucket/mac/manifest.json'), '{}');
    for (const feed of Object.values(FEEDS)) assert.equal(s.get(feed), release);
  });

  it('publishes nothing when the build needs a new Mac app and the run checked none', () => {
    const s = configured();
    s.put(FEEDS.shared, feedWith(shell));
    const r = s.run(['release-staging'], withMac(s, { electron: 'e2', ios: 'i1' }, false));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /needs a newer Mac app than staging's desktop feed, but this run checked none/);
    // Nothing uploaded: the only calls to the bucket read the live feeds.
    assert.doesNotMatch(s.log(), /(cp|sync) \/\S+ s3:\/\/bucket\//);
    assert.equal(s.get(`s3://bucket/versions/${VERSION}/release.json`), null);
    assert.doesNotMatch(s.log(), /test-deployed/);
  });

  it('publishes the Mac app and switches the desktop feed when the build needs a new iPhone app too, which the iPhone and shared feeds wait for', () => {
    const s = configured();
    s.put(FEEDS.shared, feedWith(shell));
    const r = s.run(['release-staging'], withMac(s, { electron: 'e2', ios: 'i2' }, true));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(s.get('s3://bucket/downloads/Multiscale.dmg'), 'disk image');
    assert.match(r.stdout, /needs a newer iPhone app than staging's feeds serve, so those feeds and the shared one stay as they are/);
    assert.equal(s.get(FEEDS.desktop), release);
    assert.equal(s.get(FEEDS.iphone), null);
    assert.equal(s.get(FEEDS.shared), feedWith(shell));
  });

  it('publishes no Mac app when the feed can take the build as it is', () => {
    const s = configured();
    s.put(FEEDS.shared, feedWith(shell));
    const r = s.run(['release-staging'], withMac(s, shell, false));
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(s.log(), /downloads/);
    assert.equal(s.get(FEEDS.shared), release);
  });

  // The TestFlight review workflow's record, in the inbox, of the newest TestFlight build testers can install, which
  // Beta App Review approved for the Testers group, and its iPhone shell.
  const testflight = (s: ReturnType<typeof sandbox>, record: object) => s.put('s3://inbox-bucket/inbox/testflight/latest.json', JSON.stringify(record));
  const needsIphone = { electron: 'e1', ios: 'i2' };
  const out = { build: 1794000000, commit: COMMIT, shell: 'i2' };

  it("switches staging's iPhone and shared feeds to a build that needs a newer iPhone app once the newest TestFlight build testers can install has its native code", () => {
    const s = configured();
    s.put(FEEDS.shared, feedWith(shell));
    testflight(s, out);
    const r = s.run(['release-staging'], { ...artifacts(s, needsIphone), MAC_INBOX_BUCKET: 'inbox-bucket', COMMIT });
    assert.equal(r.status, 0, r.stderr);
    // As the pipeline's own role, which may only read the inbox.
    assert.match(s.log(), /aws AWS_PROFILE= s3 cp s3:\/\/inbox-bucket\/inbox\/testflight\/latest\.json -\n/);
    assert.match(r.stdout, /Testers can install TestFlight build 1794000000, which has this build's iPhone native code, so staging's iPhone feed takes it/);
    for (const feed of Object.values(FEEDS)) assert.equal(s.get(feed), release);
    assert.match(s.log(), new RegExp(`test-deployed ENV=staging EXPECT_VERSION=${VERSION} EXPECT_FEEDS=desktop iphone shared `));
  });

  it("moves prod's shared feed in the Desktop stage, and its iPhone feed in the iPhone stage, once the newest TestFlight build testers can install has the build's iPhone native code", () => {
    const s = configured();
    const env = released(s, ['web']);
    writeFileSync(join(env.CODEBUILD_SRC_DIR_Built!, 'web/prod/version.json'), JSON.stringify({ version: VERSION, build: 5, shell: needsIphone }));
    testflight(s, out);
    const desktop = s.run(['release-desktop'], { ...env, MAC_INBOX_BUCKET: 'inbox-bucket', COMMIT });
    assert.equal(desktop.status, 0, desktop.stderr);
    assert.equal(s.get(FEEDS.desktop), release);
    assert.equal(s.get(FEEDS.shared), release);
    assert.equal(s.get(FEEDS.iphone), feedOf('0.1.0-ccc', 3));
    assert.doesNotMatch(desktop.stdout, /Testers can install/);
    const iphone = s.run(['release-iphone'], { ...env, MAC_INBOX_BUCKET: 'inbox-bucket', COMMIT });
    assert.equal(iphone.status, 0, iphone.stderr);
    assert.match(s.log(), /aws AWS_PROFILE= s3 cp s3:\/\/inbox-bucket\/inbox\/testflight\/latest\.json -\n/);
    assert.match(iphone.stdout, /Testers can install TestFlight build 1794000000, which has this build's iPhone native code, so prod's iPhone feed takes it/);
    assert.equal(s.get(FEEDS.iphone), release);
    assert.match(s.log(), /test-deployed ENV=prod EXPECT_VERSION=0\.1\.0-abc EXPECT_FEEDS=iphone .*FEEDS_ONLY=1/);
  });

  for (const [why, record, inbox] of [
    ['no TestFlight build has been recorded', () => {}, 'inbox-bucket'],
    // As when an older build with it is still out but a newer one isn't: TestFlight updates testers to the newest.
    ['the newest TestFlight build testers can install has other native code', (s: ReturnType<typeof sandbox>) => testflight(s, { ...out, shell: 'i3' }), 'inbox-bucket'],
    ["the newest build's native code couldn't be told", (s: ReturnType<typeof sandbox>) => testflight(s, { ...out, commit: null, shell: null }), 'inbox-bucket'],
    ['testers can install no build', (s: ReturnType<typeof sandbox>) => testflight(s, { build: null, commit: null, shell: null }), 'inbox-bucket'],
    ['the record names no build', (s: ReturnType<typeof sandbox>) => testflight(s, { shell: 'i2' }), 'inbox-bucket'],
    ['the run has no inbox to read', (s: ReturnType<typeof sandbox>) => testflight(s, out), ''],
  ] as const) {
    it(`keeps the iPhone and shared feeds as they are for a build that needs a newer iPhone app when ${why}`, () => {
      const s = configured();
      s.put(FEEDS.shared, feedWith(shell));
      record(s);
      const r = s.run(['release-staging'], { ...artifacts(s, needsIphone), MAC_INBOX_BUCKET: inbox });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /needs a newer iPhone app than staging's feeds serve, so those feeds and the shared one stay as they are/);
      assert.match(r.stdout, /The first run once the newest TestFlight build testers can install has this native code switches the iPhone feed/);
      assert.doesNotMatch(r.stdout, /make release ENV=staging/);
      assert.equal(s.get(FEEDS.desktop), release);
      assert.equal(s.get(FEEDS.iphone), null);
      assert.equal(s.get(FEEDS.shared), feedWith(shell));
      assert.match(s.log(), /EXPECT_FEEDS=desktop SKIP_IOS/);
    });
  }

  it('switches the iPhone feed but not the shared one when the build also needs a Mac app the run has no way to check', () => {
    const s = configured();
    s.put(FEEDS.shared, feedWith(shell));
    testflight(s, out);
    const r = s.run(['release-staging'], { ...artifacts(s, { electron: 'e2', ios: 'i2' }), MAC_INBOX_BUCKET: 'inbox-bucket' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /needs a newer Mac app than staging's feeds serve(.*\n)*.*make release ENV=staging/);
    assert.equal(s.get(FEEDS.desktop), null);
    assert.equal(s.get(FEEDS.iphone), release);
    assert.equal(s.get(FEEDS.shared), feedWith(shell));
    assert.match(s.log(), /EXPECT_FEEDS= iphone SKIP_IOS/);
  });

  // Prod as a run's surface stage leaves it: the surfaces named switched from 0.1.0-ccc to this run's version.
  const released = (s: ReturnType<typeof sandbox>, surfaces: string[]) => {
    kept(s);
    const env = artifacts(s, shell, 'prod');
    s.put(`s3://bucket/versions/${VERSION}/web/version.json`, JSON.stringify({ version: VERSION, build: 5, shell }));
    s.put(`s3://bucket/versions/${VERSION}/release.json`, release);
    const h = JSON.parse(s.get('s3://bucket/state/history.json')!) as Record<string, object[]>;
    for (const surface of surfaces) {
      s.put(surface === 'web' ? 's3://bucket/web/version.json' : FEEDS[surface as keyof typeof FEEDS], surface === 'web' ? JSON.stringify({ version: VERSION, build: 5, shell }) : release);
      h[surface]!.push({ version: VERSION, build: 5, at: '2026-11-10T10:00:00Z' });
    }
    s.put('s3://bucket/state/history.json', JSON.stringify(h));
    return env;
  };

  it("passes a surface's bake when no release alarm is in ALARM, reading prod's alarms as its release role", () => {
    const s = configured();
    const r = s.run(['bake-check', 'web'], released(s, ['web']));
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /aws AWS_PROFILE=ms-prod cloudwatch describe-alarms --alarm-names Api5xxRate-1 LambdaErrors-2 --state-value ALARM --query MetricAlarms\[\]\.AlarmName --output text/);
    assert.match(r.stdout, /No release alarm is in ALARM after web's bake/);
    assert.equal(served(s, 'web/version.json'), VERSION);
  });

  it('switches web back to the version it served before this run, then stops the run, when a release alarm is in ALARM', () => {
    const s = configured();
    writeFileSync(join(s.params, 'alarming'), 'Api5xxRate-1\n');
    const r = s.run(['bake-check', 'web'], released(s, ['web']));
    assert.notEqual(r.status, 0);
    assert.equal(served(s, 'web/version.json'), '0.1.0-ccc');
    assert.equal(s.get('s3://bucket/web/index.html'), '<html>0.1.0-ccc</html>');
    assert.match(r.stdout, /Switched prod's web back from 0\.1\.0-abc to 0\.1\.0-ccc/);
    assert.match(r.stderr, /Api5xxRate-1 in ALARM after web's bake/);
    assert.deepEqual((JSON.parse(s.get('s3://bucket/state/history.json')!) as Record<string, { version: string }[]>).web!.slice(-2).map((l) => l.version), [VERSION, '0.1.0-ccc']);
  });

  it("switches the desktop and shared feeds back each to its own version before, leaving one this run didn't switch", () => {
    const s = configured();
    writeFileSync(join(s.params, 'alarming'), 'LambdaErrors-2\n');
    const r = s.run(['bake-check', 'desktop'], released(s, ['desktop']));
    assert.notEqual(r.status, 0);
    assert.equal(served(s, 'release/desktop/release.json'), '0.1.0-ccc');
    assert.equal(served(s, 'release/release.json'), '0.1.0-ccc');
    assert.match(r.stdout, /prod's shared serves 0\.1\.0-ccc, not this run's 0\.1\.0-abc, so it stays as it is/);
    assert.doesNotMatch(s.log(), /s3:\/\/bucket\/release\/release\.json --/);
  });

  it('reads the surface it baked from SURFACE, as the Check action sets it', () => {
    const s = configured();
    writeFileSync(join(s.params, 'alarming'), 'Api5xxRate-1\n');
    const r = s.run(['bake-check'], { ...released(s, ['web']), SURFACE: 'web' });
    assert.notEqual(r.status, 0);
    assert.equal(served(s, 'web/version.json'), '0.1.0-ccc');
  });

  it('only reports an alarm in ALARM when the run has the release alarms off', () => {
    const s = configured();
    writeFileSync(join(s.params, 'alarming'), 'Api5xxRate-1\n');
    const r = s.run(['bake-check', 'web'], { ...released(s, ['web']), ALARMS: 'off' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Api5xxRate-1 in ALARM after web's bake, but this run has the release alarms off, so it goes on/);
    assert.equal(served(s, 'web/version.json'), VERSION);
  });

  it("fails a bake check before prod's stack names its release alarms, and one for no surface", () => {
    const s = configured();
    const r = s.run(['bake-check', 'web'], { ...released(s, ['web']), OLD_STACK: '1' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no ReleaseAlarms output/);
    assert.notEqual(configured().run(['bake-check', 'iphone']).status, 0);
  });

  it('runs no nightly suites when main has not moved since the last one passed', () => {
    const s = configured();
    s.param('/multiscale/pipeline/nightly', 'abc123');
    const r = s.run(['nightly']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Nothing new on main/);
    assert.doesNotMatch(s.log(), /npm |npx /);
  });

  it("switches each of staging's surfaces back one version and forward again each night, checking what its host serves", () => {
    const s = configured();
    kept(s);
    const r = s.run(['nightly']);
    assert.equal(r.status, 0, r.stderr);
    for (const [surface, key, before] of [['web', 'web/version.json', '0.1.0-bbb'], ['desktop', 'release/desktop/release.json', '0.1.0-bbb']]) {
      assert.match(r.stdout, new RegExp(`Switched staging's ${surface} from 0\\.1\\.0-ccc to ${before}\\.\\n(.*\\n)*Switched staging's ${surface} from ${before} to 0\\.1\\.0-ccc\\.`));
      assert.equal(served(s, key), '0.1.0-ccc');
    }
    // As staging's release role, read back from each host.
    assert.match(s.log(), /aws AWS_PROFILE=ms-staging s3 cp s3:\/\/bucket\/versions\/0\.1\.0-bbb\/web\/ s3:\/\/bucket\/web\/ --recursive/);
    assert.match(s.log(), /curl -fsS --max-time 20 https:\/\/web\.example\.net\/version\.json/);
    assert.match(s.log(), /curl -fsS --max-time 20 https:\/\/release\.example\.net\/desktop\/release\.json/);
    // The iPhone has had no version before this one.
    assert.match(r.stdout, /iphone has no version before 0\.1\.0-ccc to go back to/);
    assert.equal(served(s, 'release/release.json'), '0.1.0-ccc');
    // Then the suites, against what it serves again.
    assert.match(s.log(), /test-deployed ENV=staging/);
  });

  it('fails the nightly run when a host keeps serving the old version, after switching that surface forward again', () => {
    const s = configured();
    kept(s);
    const r = s.run(['nightly'], { STALE_HOST: 'https://web.example.net' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /staging's web still doesn't serve 0\.1\.0-bbb/);
    assert.equal(served(s, 'web/version.json'), '0.1.0-ccc');
    assert.doesNotMatch(s.log(), /test-deployed/);
  });
});
