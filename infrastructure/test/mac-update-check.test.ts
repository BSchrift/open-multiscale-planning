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

  // The apps from before electron-builder wrote app-update.yml into them can't download an update, so updating from one
  // would fail every run. As with no app passed before, the check then installs the new app and checks it starts.
  it("checks only that the new app installs when the app passed before can't update itself", () => {
    const dir = mkdtempSync(join(tmpdir(), 'mac-update-check-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'log');
    writeFileSync(log, '');
    const stub = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    // Each disk image holds the app it was downloaded from: 0.1.4's without app-update.yml, 0.1.5's with it.
    stub('curl', `case "$*" in *release.json*) printf '%s\\n' '${feed}';; *) out=""; prev=""; for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done; echo "$*" > "$out";; esac`);
    stub('hdiutil', `[ "$1" = attach ] || exit 0; app="$5/Multiscale Staging.app/Contents/Resources"; mkdir -p "$app"; grep -q 0.1.5 "$6" && touch "$app/app-update.yml"; exit 0`);
    stub('ditto', 'cp -R "$1" "$2"');
    stub('open', 'exit 0');
    // Waiting for the old app to stage an update takes up to 15 minutes, so a run that waits is cut short.
    const r = spawnSync('bash', [script], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, OUT: join(dir, 'out'), RELEASE_URL: 'https://release.example.net', DOWNLOADS_URL: 'https://downloads.example.net', PREVIOUS: '0.1.4' },
    });
    const calls = readFileSync(log, 'utf8');
    assert.match(r.stdout, /App 0\.1\.4 can't update itself, as it has no app-update\.yml, so this checks only that app 0\.1\.5 installs and starts\./, r.stderr);
    assert.match(calls, /^curl .*mac\/0\.1\.4\/Multiscale\.dmg\n(.*\n)*curl .*mac\/0\.1\.5\/Multiscale\.dmg$/m);
    // It never opened the old app to wait for an update it couldn't download.
    assert.doesNotMatch(calls, /^open .*\n(.*\n)*curl .*mac\/0\.1\.5\//m);
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
