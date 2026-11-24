import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertInstalled, notInstalled } from './installed';

/** A frontend folder with this lockfile, and node_modules holding these packages at these versions. */
function checkout(locked: Record<string, object>, installed: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'installed-'));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages: { '': { name: 'frontend' }, ...locked } }));
  for (const [path, version] of Object.entries(installed)) {
    mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(join(dir, path, 'package.json'), JSON.stringify({ version }));
  }
  return dir;
}

describe("node_modules against the lockfile, checked before the tests run", () => {
  it('names each package missing or at another version, nested ones by their own name', () => {
    const dir = checkout(
      {
        'node_modules/react': { version: '19.2.0' },
        'node_modules/@capacitor/haptics': { version: '8.0.2' },
        'node_modules/vite': { version: '7.1.0' },
        'node_modules/vite/node_modules/esbuild': { version: '0.25.0' },
      },
      { 'node_modules/react': '19.2.0', 'node_modules/vite': '7.0.0', 'node_modules/vite/node_modules/esbuild': '0.25.0' },
    );
    expect(notInstalled(dir)).toEqual(['@capacitor/haptics (missing, wants 8.0.2)', 'vite (7.0.0, wants 7.1.0)']);
    expect(() => assertInstalled(dir)).toThrow(/doesn't match package-lock\.json: @capacitor\/haptics \(missing, wants 8\.0\.2\), vite .*Run npm ci in frontend/);
  });

  it("passes over what npm leaves out on some machines, and the repo's own linked package", () => {
    const dir = checkout(
      {
        'node_modules/fsevents': { version: '2.3.3', optional: true },
        'node_modules/@rollup/rollup-linux-x64-gnu': { version: '4.50.0', dev: true, optional: true },
        'node_modules/dmg-license': { version: '1.0.11', devOptional: true },
        'node_modules/@multiscale/config': { resolved: '../config', link: true },
      },
      {},
    );
    expect(notInstalled(dir)).toEqual([]);
    expect(() => assertInstalled(dir)).not.toThrow();
  });
});
