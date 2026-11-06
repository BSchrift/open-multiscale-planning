import { describe, expect, it } from 'vitest';
import { shellHash, shellHashes, SHELL_SOURCES } from './shell-hash';

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
    };
    expect(shellHash({ ...files, ...extra }, {})).toBe(base);
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
