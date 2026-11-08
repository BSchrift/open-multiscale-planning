import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { sandboxRepo } from './sandbox.ts';

function sandbox() {
  const s = sandboxRepo('test-retention.sh');
  s.stub('node', 'echo "node $*" >> "$LOG"; echo \'{"env":"staging"}\'');
  s.stub('npx', 'echo "npx $* ENV=$ENV RETENTION_DEPLOYED=$RETENTION_DEPLOYED MULTISCALE_TARGET=$MULTISCALE_TARGET" >> "$LOG"');
  const run = (env: Record<string, string> = {}) =>
    spawnSync('bash', [join(s.root, 'scripts/test-retention.sh')], { encoding: 'utf8', env: { ...s.env, ...env } as NodeJS.ProcessEnv });
  return { ...s, run };
}

describe('scripts/test-retention.sh', () => {
  it("runs the app's retention suite against staging, one file, as the test user", () => {
    const s = sandbox();
    const r = s.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /node scripts\/test-target\.mjs/);
    assert.match(s.log(), /npx vitest run --maxWorkers=1 --project node src\/core\/retention\.stack\.test\.ts ENV=staging RETENTION_DEPLOYED=1 MULTISCALE_TARGET=\{"env":"staging"\}/);
  });

  it('reuses the test user make test-deployed already read', () => {
    const s = sandbox();
    assert.equal(s.run({ MULTISCALE_TARGET: '{"env":"staging","given":true}' }).status, 0);
    assert.doesNotMatch(s.log(), /test-target/);
    assert.match(s.log(), /"given":true/);
  });

  for (const env of ['prod', 'local']) {
    it(`refuses ${env}, before reading anything`, () => {
      const s = sandbox();
      const r = s.run({ ENV: env, CONFIRM_PROD: 'yes' });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /staging only/);
      assert.equal(s.log(), '');
    });
  }
});
