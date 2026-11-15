import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { afterMove, appUpdates, MOVED_FILE, setsLoginItem } from './appUpdates';
import type { UpdateInfo } from './appUpdates';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const releaseKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const APP = { version: '0.1.200', build: 200, shell: 'e2', folder: 'mac/0.1.200/', file: 'Multiscale.zip', sha512: `${'A'.repeat(86)}==`, size: 9 };
const ORIGIN = 'https://downloads.example.test';
const signed = (manifest: object, key: KeyObject = privateKey) => {
  const text = JSON.stringify(manifest);
  return { manifest: text, signature: sign(null, Buffer.from(text), key).toString('base64') };
};
const release = (over: object = {}, app: object = {}) => signed({ version: '0.2.0-b', build: 200, shell: { electron: 'e2', ios: 'i1' }, files: [], app: { ...APP, ...app }, ...over });
const yml = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({ version: APP.version, path: APP.file, sha512: APP.sha512, files: [{ url: APP.file, sha512: APP.sha512, size: APP.size }], ...over });

/** electron-updater as the main process drives it, which fails if anything sets channel. */
function fakeUpdater(found: UpdateInfo = yml()) {
  const calls: string[] = [];
  const progress = new EventEmitter();
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: false,
    allowPrerelease: false,
    set channel(_: string) {
      throw new Error('channel turns allowDowngrade on');
    },
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => ({ updateInfo: found })),
    downloadUpdate: vi.fn(async () => {
      calls.push('download');
      progress.emit('download-progress', { percent: 50 });
      return [];
    }),
    quitAndInstall: vi.fn(() => void calls.push('quitAndInstall')),
    on: (event: string, listener: (p: { percent: number }) => void) => progress.on(event, listener),
    calls,
    progress,
  };
  return updater;
}

function setup({ found, appPath = '/Applications/Multiscale.app', access = () => {}, build = 100, squirrel = 'staged' as 'staged' | Error } = {} as {
  found?: UpdateInfo; appPath?: string; access?: (path: string) => void; build?: number; squirrel?: 'staged' | Error;
}) {
  const updater = fakeUpdater(found);
  const squirrelEvents = new EventEmitter();
  updater.downloadUpdate.mockImplementation(async () => {
    updater.calls.push('download');
    updater.progress.emit('download-progress', { percent: 50 });
    queueMicrotask(() => (squirrel === 'staged' ? squirrelEvents.emit('update-downloaded') : squirrelEvents.emit('error', squirrel)));
    return [];
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'app-updates-'));
  const beforeQuit = vi.fn(() => void updater.calls.push('quitting'));
  const make = (b = build) => appUpdates({ updater, squirrel: squirrelEvents, info: { build: b, shell: { electron: 'e1' }, releaseKey }, downloadsOrigin: ORIGIN, appPath, dataDir, access: (path) => access(path), beforeQuit });
  return { updater, dataDir, beforeQuit, make, updates: make() };
}

describe('appUpdates', () => {
  it('never downloads by itself, never takes an older app, and never sets channel', () => {
    const { updater } = setup();
    expect([updater.autoDownload, updater.allowDowngrade, updater.allowPrerelease]).toEqual([false, false, false]);
  });

  it("downloads from the signed record's folder on the built-in downloads host, once latest-mac.yml matches the record", async () => {
    const { updater, updates } = setup();
    const progress = vi.fn();
    await updates.download(release(), progress);
    expect(updater.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: `${ORIGIN}/mac/0.1.200/`, useMultipleRangeRequest: false });
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledWith(50);
    expect(await updates.staged()).toEqual({ build: 200, interrupted: false });
    expect(updates.ready()).toBe(true);
  });

  it.each([
    ['another version', yml({ version: '0.1.201' })],
    ['another file', yml({ path: 'Other.zip' })],
    ['another SHA-512', yml({ sha512: `${'B'.repeat(86)}==`, files: [{ url: APP.file, sha512: `${'B'.repeat(86)}==`, size: APP.size }] })],
    ['another size', yml({ files: [{ url: APP.file, sha512: APP.sha512, size: 10 }] })],
  ])("downloads nothing when latest-mac.yml names %s than the record", async (_, found) => {
    const { updater, updates } = setup({ found });
    await expect(updates.download(release(), () => {})).rejects.toThrow('[app-mismatch]');
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("refuses a bad signature, a build that isn't newer, and an app for other native code, before asking the host", async () => {
    const { updater, updates } = setup();
    const other = generateKeyPairSync('ed25519').privateKey;
    for (const bad of [signed(JSON.parse(release().manifest), other), release({ build: 100 }), release({}, { build: 90 }), release({}, { shell: 'e3' }), release({}, { folder: '../x/' })]) {
      await expect(updates.download(bad, () => {})).rejects.toThrow('[app-mismatch]');
    }
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("names Squirrel's signature refusal, a full disk and a broken download as the page does", async () => {
    for (const [error, code] of [
      [new Error('Code signature at URL file:///x did not pass validation: code failed to satisfy specified code requirement(s)'), '[app-signature]'],
      [Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }), '[app-space]'],
      [new Error('net::ERR_CONNECTION_RESET'), '[app-download]'],
    ] as const) {
      await expect(setup({ squirrel: error }).updates.download(release(), () => {})).rejects.toThrow(code);
    }
  });

  it('counts a disk image or a temporary copy as read-only, but not a writable drive, and downloads nothing there', async () => {
    const erofs = () => {
      throw Object.assign(new Error('read-only'), { code: 'EROFS' });
    };
    expect(await setup({ appPath: '/private/var/folders/x/AppTranslocation/ABC/d/Multiscale.app' }).updates.place()).toEqual({ kind: 'translocated' });
    const disk = setup({ appPath: '/Volumes/Multiscale/Multiscale.app', access: erofs });
    expect(await disk.updates.place()).toEqual({ kind: 'disk-image' });
    await expect(disk.updates.download(release(), () => {})).rejects.toThrow('[read-only]');
    expect(await setup({ appPath: '/Volumes/External/Applications/Multiscale.app' }).updates.place()).toBeNull();
  });

  it("never arms install at quit or downloads by itself for an app the person can't replace, but updates it on request", async () => {
    const eacces = (path: string) => {
      if (path === '/Applications') throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    const admin = setup({ access: eacces });
    expect(await admin.updates.place()).toEqual({ kind: 'needs-admin' });
    expect(admin.updater.autoInstallOnAppQuit).toBe(false);
    await expect(admin.updates.download(release(), () => {})).rejects.toThrow('[needs-admin]');
    await admin.updates.install(release());
    expect(admin.updater.calls).toEqual(['download', 'quitting', 'quitAndInstall']);
  });

  it('sets quitting before Squirrel quits the app to install, since closing the window only hides it', () => {
    const { updater, updates } = setup();
    updates.restart();
    expect(updater.calls).toEqual(['quitting', 'quitAndInstall']);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('stays on an older app someone went back to, until they choose Update the app', async () => {
    const { make } = setup({ build: 300 });
    const older = make(100);
    expect(await older.place()).toEqual({ kind: 'older' });
    await expect(older.download(release(), () => {})).rejects.toThrow('[older-app]');
  });

  it('says an update cut short, and once that an update installed, with the builds before and after', async () => {
    const { updates, make } = setup();
    await updates.download(release(), () => {});
    // A shutdown before ShipIt finished: the same app starts again, with the update still staged.
    expect(await make(100).staged()).toEqual({ build: 200, interrupted: true });
    const installed = make(200);
    expect(await installed.updated()).toEqual({ from: 100, to: 200 });
    expect(await installed.updated()).toBeNull();
    expect(await installed.staged()).toBeNull();
  });
});

describe('the login item', () => {
  it('is never set from a disk image or a temporary copy, and is set again after a move', () => {
    expect(setsLoginItem({ packaged: true, firstRunDone: false, place: null })).toBe(true);
    for (const kind of ['disk-image', 'translocated'] as const) expect(setsLoginItem({ packaged: true, firstRunDone: false, place: { kind } })).toBe(false);
    expect(setsLoginItem({ packaged: true, firstRunDone: true, place: null })).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), 'moved-'));
    expect(afterMove(dir)).toBeNull();
    writeFileSync(join(dir, MOVED_FILE), JSON.stringify({ openAtLogin: true }));
    expect(afterMove(dir)).toEqual({ openAtLogin: true });
    expect(afterMove(dir)).toBeNull();
  });
});
