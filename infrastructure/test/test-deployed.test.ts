import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { sandboxRepo } from './sandbox.ts';

// The other suites' scripts aren't in the sandbox, so any of them run would fail the run.
function sandbox() {
  const s = sandboxRepo('test-deployed.sh');
  writeFileSync(join(s.config, 'staging.outputs.json'), JSON.stringify({ WebUrl: 'https://web.example.net', ReleaseUrl: 'https://release.example.net' }));
  s.stub('node', `case "$1" in -e) exec "${process.execPath}" "$@" ;; *) echo "node $*" >> "$LOG"; echo '{"env":"staging"}' ;; esac`);
  s.stub('npx', 'echo "npx $* DEPLOYED_BEFORE_PUBLISH=$DEPLOYED_BEFORE_PUBLISH" >> "$LOG"; [ -z "$WEB_FAILS" ]');
  const run = (env: Record<string, string> = {}) =>
    spawnSync('bash', [join(s.root, 'scripts/test-deployed.sh')], { encoding: 'utf8', env: { ...s.env, ...env } as NodeJS.ProcessEnv });
  return { ...s, run };
}

describe('scripts/test-deployed.sh', () => {
  it("runs the web app suite alone when asked, as staging's release step does before it switches the web app", () => {
    const s = sandbox();
    const r = s.run({ WEB_ONLY: '1', DEPLOYED_BEFORE_PUBLISH: '1' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(s.log().match(/^npx .*/gm), ['npx playwright test -c e2e/deployed/playwright.config.ts DEPLOYED_BEFORE_PUBLISH=1']);
    assert.match(r.stdout, /staging: the web app suite passed\./);
  });

  it('fails when that suite fails, and runs nothing after it', () => {
    const s = sandbox();
    const r = s.run({ WEB_ONLY: '1', WEB_FAILS: '1' });
    assert.notEqual(r.status, 0);
    assert.equal(s.log().match(/^npx .*/gm)?.length, 1);
    assert.match(r.stderr, /staging: failed: web app/);
  });
});
