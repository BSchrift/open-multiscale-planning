import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isHashed, macBuild, shellHash, shellHashes, SHELL_SOURCES } from './shell-hash';

describe('shellHash', () => {
  const files = { 'electron/main.ts': 'main', 'electron/preload.ts': 'preload' };

  it('changes with native code and native package versions', () => {
    const base = shellHash(files, { electron: '45.2.1' });
    expect(shellHash({ ...files, 'electron/main.ts': 'changed' }, { electron: '45.2.1' })).not.toBe(base);
    expect(shellHash(files, { electron: '45.3.0' })).not.toBe(base);
    expect(shellHash({ 'electron/preload.ts': 'preload', 'electron/main.ts': 'main' }, { electron: '45.2.1' })).toBe(base);
  });

  it('changes with the settings the Mac app’s main process is built with', () => {
    const build = macBuild({ apiUrl: 'https://api.example.test', authUrl: 'https://auth.example.test' }, { name: 'Multiscale', scheme: 'multiscale' });
    expect(build).toEqual({ name: 'Multiscale', scheme: 'multiscale', backendOrigins: ['https://api.example.test', 'https://auth.example.test'] });
    const base = shellHash(files, {}, build);
    expect(shellHash(files, {}, { ...build, backendOrigins: ['https://api.example.test', 'https://auth2.example.test'] })).not.toBe(base);
    expect(shellHash(files, {}, { ...build, scheme: 'multiscale-staging' })).not.toBe(base);
    expect(shellHash(files, {}, build)).toBe(base);
    expect(shellHash(files, {})).not.toBe(base);
    // Attachments' storage too, once the environment has it.
    expect(
      macBuild(
        { apiUrl: 'https://api.example.test', authUrl: 'https://auth.example.test', filesUrl: 'https://files.example.test', filesUploadUrl: 'https://bucket.example.test/u' },
        { name: 'Multiscale', scheme: 'multiscale' },
      ).backendOrigins,
    ).toEqual(['https://api.example.test', 'https://auth.example.test', 'https://files.example.test', 'https://bucket.example.test']);
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
    const build = { name: 'Multiscale', scheme: 'multiscale', backendOrigins: [] };
    const base = shellHashes(root, build);
    for (const path of ['src/platform/shortcut.ts', 'src/core/captureTitle.ts']) {
      write(path, 'two');
      const changed = shellHashes(root, build);
      expect(changed.electron).not.toBe(base.electron);
      expect(changed.ios).toBe(base.ios);
      write(path, 'one');
    }
    // The main process bakes the backend origins into the page's policy, so a bundle for others needs a new app.
    const moved = shellHashes(root, { ...build, backendOrigins: ['https://api.example.test'] });
    expect(moved.electron).not.toBe(base.electron);
    expect(moved.ios).toBe(base.ios);
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

  // A signature changes nothing a bundle can call, so installed apps keep taking bundles from builds signed another way,
  // such as ad hoc before a Developer ID, or on a contributor's Mac.
  it('leaves out how the Mac app is signed and notarized', () => {
    for (const path of ['scripts/mac-signing.ts', 'scripts/entitlements.mac.plist', 'scripts/electron-build.mjs']) expect(isHashed('electron', path), path).toBe(false);
  });

  // Uploading to TestFlight changes nothing a bundle can call, so a TestFlight build takes the same bundles as one from
  // Xcode. Its Info.plist is in ios/, and counts.
  it('leaves out how the iPhone app reaches TestFlight', () => {
    expect(isHashed('ios', 'scripts/testflight.ts')).toBe(false);
    expect(isHashed('ios', 'ios/App/App/Info.plist')).toBe(true);
  });

  it('picks native packages for each app', () => {
    expect(SHELL_SOURCES.electron.packages('better-sqlite3')).toBe(true);
    expect(SHELL_SOURCES.electron.packages('react')).toBe(false);
    expect(SHELL_SOURCES.ios.packages('@capacitor-community/sqlite')).toBe(true);
    expect(SHELL_SOURCES.ios.packages('@aparajita/capacitor-secure-storage')).toBe(true);
    expect(SHELL_SOURCES.ios.packages('electron')).toBe(false);
  });

  it('hashes this repo for both apps', () => {
    const hashes = shellHashes(`${import.meta.dirname}/..`, { name: 'Multiscale', scheme: 'multiscale', backendOrigins: [] });
    expect(hashes.electron).toMatch(/^[0-9a-f]{16}$/);
    expect(hashes.ios).toMatch(/^[0-9a-f]{16}$/);
    expect(hashes.electron).not.toBe(hashes.ios);
  });
});
