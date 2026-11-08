import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isHashed, shellHash, shellHashes, SHELL_SOURCES } from './shell-hash';

describe('shellHash', () => {
  const files = { 'electron/main.ts': 'main', 'electron/preload.ts': 'preload' };

  it('changes with native code and native package versions', () => {
    const base = shellHash(files, { electron: '45.2.1' });
    expect(shellHash({ ...files, 'electron/main.ts': 'changed' }, { electron: '45.2.1' })).not.toBe(base);
    expect(shellHash(files, { electron: '45.3.0' })).not.toBe(base);
    expect(shellHash({ 'electron/preload.ts': 'preload', 'electron/main.ts': 'main' }, { electron: '45.2.1' })).toBe(base);
  });

  it("ignores tests and other files the app doesn't ship", () => {
    const base = shellHash(files, {});
    const extra = {
      'electron/main.test.ts': 'x',
      'electron/e2e/sync.spec.ts': 'x',
      'ios/App/UITests/MultiscaleUITests.swift': 'x',
      'ios/harness/index.html': 'x',
      'electron/playwright.config.ts': 'x',
      'electron/node-sqlite-swap.ts': 'x',
      'ios/App/Config.example.xcconfig': 'x',
    };
    expect(shellHash({ ...files, ...extra }, {})).toBe(base);
  });

  it('changes the Mac app’s hash with the shared code its main process is built from', () => {
    const root = mkdtempSync(join(tmpdir(), 'multiscale-shell-'));
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write('package-lock.json', JSON.stringify({ packages: {} }));
    write('electron/main.ts', 'main');
    write('ios/App/App/AppDelegate.swift', 'app');
    for (const path of ['src/platform/shortcut.ts', 'src/core/captureTitle.ts']) write(path, 'one');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    const base = shellHashes(root);
    for (const path of ['src/platform/shortcut.ts', 'src/core/captureTitle.ts']) {
      write(path, 'two');
      const changed = shellHashes(root);
      expect(changed.electron).not.toBe(base.electron);
      expect(changed.ios).toBe(base.ios);
      write(path, 'one');
    }
  });

  // electron-compile.mjs checks what esbuild bundles against this, so a new import can't slip past the hash.
  it('says which files the hash covers', () => {
    expect(isHashed('electron', 'electron/main.ts')).toBe(true);
    expect(isHashed('electron', 'src/platform/shortcut.ts')).toBe(true);
    expect(isHashed('electron', 'src/core/captureTitle.ts')).toBe(true);
    expect(isHashed('electron', 'src/core/db.ts')).toBe(false);
    expect(isHashed('electron', 'electron/node-sqlite-swap.ts')).toBe(false);
    expect(isHashed('electron', 'electronic/main.ts')).toBe(false);
    expect(isHashed('ios', 'ios/App/App/AppDelegate.swift')).toBe(true);
    expect(isHashed('ios', 'ios/App/Config.example.xcconfig')).toBe(false);
  });

  it('picks native packages for each app', () => {
    expect(SHELL_SOURCES.electron.packages('better-sqlite3')).toBe(true);
    expect(SHELL_SOURCES.electron.packages('react')).toBe(false);
    expect(SHELL_SOURCES.ios.packages('@capacitor-community/sqlite')).toBe(true);
    expect(SHELL_SOURCES.ios.packages('@aparajita/capacitor-secure-storage')).toBe(true);
    expect(SHELL_SOURCES.ios.packages('electron')).toBe(false);
  });

  it('hashes this repo for both apps', () => {
    const hashes = shellHashes(`${import.meta.dirname}/..`);
    expect(hashes.electron).toMatch(/^[0-9a-f]{16}$/);
    expect(hashes.ios).toMatch(/^[0-9a-f]{16}$/);
    expect(hashes.electron).not.toBe(hashes.ios);
  });
});
