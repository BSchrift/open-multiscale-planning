import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { sandboxRepo } from './sandbox.ts';

const shell = { electron: 'e1', ios: 'i1' };

// release.sh with the build and the packing stubbed: vite writes a dist whose version.json has `built`'s shell, and
// aws answers the live feed with `live`, or nothing when it's null.
function sandbox({ built = shell, live = shell as object | null } = {}) {
  const s = sandboxRepo('release.sh');
  mkdirSync(join(s.root, 'frontend/scripts'), { recursive: true });
  writeFileSync(join(s.root, 'frontend/scripts/release-files.ts'), `import { mkdirSync, writeFileSync } from 'node:fs';
const [command, , , out] = process.argv.slice(2);
if (command === 'pack') { mkdirSync(out + '/files', { recursive: true }); writeFileSync(out + '/release.json', '{}'); }
if (command === 'key') writeFileSync(process.argv[3], 'made');
`);
  const version = JSON.stringify({ version: '0.1.0-abc', build: 1, shell: built });
  s.stub('npx', `echo "npx $*" >> "$LOG"; mkdir -p dist; echo '${version}' > dist/version.json`);
  s.stub('npm', 'echo "npm $*" >> "$LOG"');
  s.stub('git', 'exit 0');
  const feed = live ? JSON.stringify({ manifest: JSON.stringify({ version: 'old', build: 0, shell: live, files: [] }), signature: 'x' }) : '';
  s.stub('aws', `echo "aws $*" >> "$LOG"
case "$*" in
  *get-caller-identity*) echo 210987654321;;
  *"s3 cp s3://"*release.json" -"*) [ -n '${feed}' ] && echo '${feed}' || exit 1;;
esac`);
  writeFileSync(join(s.config, 'staging.outputs.json'), JSON.stringify({ ReleaseBucket: 'bucket' }));
  writeFileSync(join(s.config, 'staging.release-key.pem'), 'key');
  const run = (env: Record<string, string> = {}) =>
    spawnSync('bash', [join(s.root, 'scripts/release.sh')], { encoding: 'utf8', env: { ...s.env, MULTISCALE_BUILD_LOCK: '1', SKIP_TESTS: '1', ...env } as NodeJS.ProcessEnv });
  return { ...s, run };
}

describe('scripts/release.sh with SKIP_MAC_APP=1, as the pipeline runs it', () => {
  it('builds and uploads the web app and the feed, and no Mac app', () => {
    const s = sandbox();
    const r = s.run({ SKIP_MAC_APP: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(s.log(), /npx vite build/);
    assert.doesNotMatch(s.log(), /electron:build|Multiscale\.dmg/);
    assert.match(s.log(), /aws s3 sync \S+ s3:\/\/bucket\/release\/files/);
    assert.match(s.log(), /aws s3 cp \S+release\.json s3:\/\/bucket\/release\/release\.json/);
    assert.match(s.log(), /aws s3 sync dist\/assets s3:\/\/bucket\/web\/assets/);
  });

  for (const [why, live] of [['needs a newer app than the feed', { electron: 'e2', ios: 'i1' }], ['there is no feed yet', null]] as const) {
    it(`leaves the feed for the Mac's release when the build ${why}, and still uploads the web app`, () => {
      const s = sandbox({ live });
      const r = s.run({ SKIP_MAC_APP: '1' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /make release ENV=staging/);
      assert.doesNotMatch(s.log(), /s3:\/\/bucket\/release\/(files|release\.json) --/);
      assert.match(s.log(), /s3:\/\/bucket\/web/);
    });
  }

  it('never makes a signing key, since a new one signs a feed no installed app takes', () => {
    const s = sandbox();
    rmSync(join(s.config, 'staging.release-key.pem'));
    const r = s.run({ SKIP_MAC_APP: '1' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /staging\.release-key\.pem/);
    assert.doesNotMatch(s.log(), /npx|s3 /);
  });
});
