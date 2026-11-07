import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { sandboxRepo } from './sandbox.ts';

const outputs = { Region: 'us-east-2', ApiLogGroup: 'apilogs', CalendarLogGroup: 'calendarlogs', MetricNamespace: 'Multiscale/staging' };

// Each aws stub prints a count per call. $COUNT_FILE lets a stub start returning results partway through.
const AWS_ALL_GOOD = `echo "aws $* with AWS_PROFILE=$AWS_PROFILE AWS_REGION=$AWS_REGION" >> "$LOG"; echo 1`;

function sandbox(awsBody = AWS_ALL_GOOD, integrationBody = 'echo "integration ENV=$ENV SMOKE=$SMOKE AWS_PROFILE=$AWS_PROFILE" >> "$LOG"') {
  const s = sandboxRepo('smoke.sh');
  for (const env of ['staging', 'prod']) writeFileSync(join(s.config, `${env}.outputs.json`), JSON.stringify(outputs));
  writeFileSync(join(s.root, 'scripts/integration.sh'), `#!/bin/sh\n${integrationBody}\n`, { mode: 0o755 });
  s.stub('aws', awsBody);
  s.stub('sleep', ':');
  const run = (env: Record<string, string> = {}) =>
    spawnSync('bash', [join(s.root, 'scripts/smoke.sh')], { encoding: 'utf8', env: { ...s.env, COUNT_FILE: join(s.root, 'count'), ...env } });
  return { ...s, run };
}

describe('scripts/smoke.sh', () => {
  it('runs the wiring subset against staging by default, then checks logs and the metric', () => {
    const s = sandbox();
    const r = s.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /integration ENV=staging SMOKE=1/);
    assert.match(s.log(), /aws logs filter-log-events .*--log-group-name apilogs/);
    assert.match(s.log(), /aws cloudwatch get-metric-statistics .*--namespace Multiscale\/staging .*--metric-name SyncRecordsMerged/);
    assert.match(s.log(), /--region us-east-2/);
  });

  it("signs in with the profile and region from the environment's file, for the suite too", () => {
    const s = sandbox();
    assert.equal(s.run().status, 0);
    assert.match(s.log(), /integration .*AWS_PROFILE=ms-staging/);
    assert.match(s.log(), /aws logs .* with AWS_PROFILE=ms-staging AWS_REGION=us-east-2$/m);
  });

  it('never runs against control, which serves nothing', () => {
    const s = sandbox();
    const r = s.run({ ENV: 'control' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /staging or prod/);
    assert.equal(s.log(), '');
  });

  it('names the missing config file and the example to copy', () => {
    const s = sandbox();
    rmSync(join(s.config, 'staging.yaml'));
    const r = s.run();
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(join(s.config, 'staging.yaml')), r.stderr);
    assert.ok(r.stderr.includes(join(s.root, 'config/staging.example.yaml')), r.stderr);
    assert.equal(s.log(), '');
  });

  it('refuses ENV=local, since there is no local deployment, rather than checking staging', () => {
    const s = sandbox();
    const r = s.run({ ENV: 'local' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not local/);
    assert.equal(s.log(), '');
  });

  it('refuses prod without CONFIRM_PROD=yes', () => {
    const s = sandbox();
    const r = s.run({ ENV: 'prod' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /CONFIRM_PROD=yes/);
    assert.equal(s.log(), '');
    assert.equal(s.run({ ENV: 'prod', CONFIRM_PROD: 'yes' }).status, 0);
  });

  it('says to deploy first when there are no outputs', () => {
    const s = sandbox();
    rmSync(join(s.config, 'staging.outputs.json'));
    const r = s.run();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /make deploy/);
    assert.ok(r.stderr.includes(join(s.config, 'staging.outputs.json')), r.stderr);
  });

  it('fails when the subset fails, without checking anything else', () => {
    const s = sandbox(AWS_ALL_GOOD, 'exit 3');
    assert.notEqual(s.run().status, 0);
    assert.doesNotMatch(s.log(), /aws /);
  });

  it('waits for a log line that arrives late', () => {
    const s = sandbox(`n=$(cat "$COUNT_FILE" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$COUNT_FILE"; if [ $n -lt 4 ]; then echo 0; else echo 1; fi`);
    assert.equal(s.run().status, 0);
  });

  it('fails when the API log group never receives a line', () => {
    const s = sandbox(`case "$*" in *apilogs*) echo 0;; *) echo 1;; esac`);
    const r = s.run();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /apilogs/);
  });

  it('does not mistake an aws error for a line arriving', () => {
    const s = sandbox('exit 254');
    assert.notEqual(s.run().status, 0);
  });

  it('asks aws for one aggregated answer, since text output prints one line per page', () => {
    const s = sandbox();
    s.run();
    assert.match(s.log(), /filter-log-events .*--max-items 1 .*--output json/);
    // AWS CLI 2.38 and later take --limit as --no-paginate, which refuses --max-items.
    assert.doesNotMatch(s.log(), /filter-log-events .*--limit /);
  });

  it('fails when the metric never shows up', () => {
    const s = sandbox(`case "$*" in *get-metric-statistics*) echo 0;; *) echo 1;; esac`);
    const r = s.run();
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /SyncRecordsMerged/);
  });

  it('only warns when the worker has not run yet, since the schedule can take 30 minutes after a first deploy', () => {
    const s = sandbox(`case "$*" in *calendarlogs*) echo 0;; *) echo 1;; esac`);
    const r = s.run();
    assert.equal(r.status, 0);
    assert.match(r.stdout + r.stderr, /WARN.*calendar/i);
  });
});
