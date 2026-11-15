import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const script = join(import.meta.dirname, '../../scripts/mac-update-check.sh');
const feed = JSON.stringify({ manifest: JSON.stringify({ app: { version: '0.1.5', build: 5, folder: 'mac/0.1.5/' } }), signature: 'x' });

/**
 * Runs the check up to its first download, with a curl on PATH that serves staging's desktop feed from the release host
 * and fails for anything else, as a missing disk image would. What it asked curl for is in the log.
 */
function check(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'mac-update-check-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'log');
  writeFileSync(log, '');
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
echo "curl $*" >> "${log}"
case "$*" in *https://release.example.net/desktop/release.json*) printf '%s\\n' '${feed}';; *) exit 22;; esac
`);
  chmodSync(join(bin, 'curl'), 0o755);
  const r = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, OUT: join(dir, 'out'), RELEASE_URL: 'https://release.example.net', DOWNLOADS_URL: 'https://downloads.example.net', ...env },
  });
  return { ...r, log: readFileSync(log, 'utf8') };
}

describe('scripts/mac-update-check.sh', () => {
  it('downloads the app to install from the downloads host', () => {
    for (const [previous, dmg] of [['', 'mac/0.1.5/Multiscale.dmg'], ['0.1.4', 'mac/0.1.4/Multiscale.dmg']]) {
      const r = check({ PREVIOUS: previous });
      assert.doesNotMatch(r.stderr, /unbound variable/);
      assert.match(r.log, new RegExp(`^curl .*https://downloads\\.example\\.net/${dmg}$`, 'm'), r.stderr);
    }
  });

  it('stops before reading the feed when a host is missing, and says which', () => {
    for (const missing of ['RELEASE_URL', 'DOWNLOADS_URL']) {
      const r = check({ [missing]: '' });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, new RegExp(`${missing} names`));
      assert.equal(r.log, '');
    }
  });
});
