// latest-mac.yml as the pipeline writes it and electron-updater reads it: the exact text, the records it refuses, and
// that electron-updater's own parser reads it back into what appUpdates.ts checks against the signed record.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { matchesRecord } from '../electron/appUpdates';
import type { UpdateInfo } from '../electron/appUpdates';
import type { AppRecord } from '../src/core/updates';
import { latestMacYml } from './latest-mac.mjs';

// electron-updater's parser and file resolver, which its generic provider runs on what the downloads host serves.
const { parseUpdateInfo, resolveFiles } = createRequire(import.meta.url)('electron-updater/out/providers/Provider') as {
  parseUpdateInfo(raw: string | null, channelFile: string, channelFileUrl: URL): UpdateInfo;
  resolveFiles(info: UpdateInfo, baseUrl: URL): { url: URL; info: { url: string; sha512: string; size?: number } }[];
};

const zip = Buffer.from('the zip of the app');
const record: AppRecord = {
  version: '0.1.1794769547',
  build: 1794769547,
  shell: 'e2',
  folder: 'mac/0.1.1794769547/',
  file: 'Multiscale.zip',
  sha512: createHash('sha512').update(zip).digest('base64'),
  size: zip.length,
};
const AT = new Date('2026-11-16T12:00:00Z');
const FOLDER = new URL('https://downloads.example.test/mac/0.1.1794769547/');
const read = (yml: string) => parseUpdateInfo(yml, 'latest-mac.yml', new URL('latest-mac.yml', FOLDER));

describe('latestMacYml', () => {
  it('says the version, and the zip with its SHA-512 and size, as electron-updater reads them', () => {
    expect(latestMacYml(record, AT)).toBe(
      `version: 0.1.1794769547\nfiles:\n  - url: Multiscale.zip\n    sha512: ${record.sha512}\n    size: ${zip.length}\npath: Multiscale.zip\nsha512: ${record.sha512}\nreleaseDate: '2026-11-16T12:00:00.000Z'\n`,
    );
  });

  it('refuses a record whose fields YAML could read as something else', () => {
    for (const bad of [{ version: '0.1' }, { version: '0.1.2: x' }, { file: 'Multiscale.zip\npath: other.zip' }, { file: 'app.dmg' }, { sha512: 'abc' }, { size: 0 }, { size: 1.5 }]) {
      expect(() => latestMacYml({ ...record, ...bad }, AT)).toThrow('is not an app record');
    }
  });

  it("reads back through electron-updater's parser as exactly the signed record, which appUpdates.ts requires", () => {
    const info = read(latestMacYml(record, AT));
    expect(matchesRecord(info, record)).toBe(true);
    // The zip electron-updater downloads is the record's file, in the record's folder.
    expect(resolveFiles(info, FOLDER).map((f) => f.url.href)).toEqual(['https://downloads.example.test/mac/0.1.1794769547/Multiscale.zip']);
  });

  it("matches no other record: another version, zip, SHA-512 or size", () => {
    const info = read(latestMacYml(record, AT));
    for (const other of [{ version: '0.1.1794769548' }, { file: 'Other.zip' }, { sha512: createHash('sha512').update('other').digest('base64') }, { size: zip.length + 1 }]) {
      expect(matchesRecord(info, { ...record, ...other })).toBe(false);
    }
  });

  // Prod's release of 2ea48ea switched its desktop feed to an app whose folder the downloads host didn't have: the
  // private bucket answers 403 with an XML error. electron-updater stops at the status (appUpdates.integration.test.ts);
  // even read as YAML, that body is a string, which matches no record.
  it("matches no record from the error the downloads host gives for a folder it doesn't have", () => {
    const denied = '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>';
    expect(matchesRecord(read(denied), record)).toBe(false);
  });
});
