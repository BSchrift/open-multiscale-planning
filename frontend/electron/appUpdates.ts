// The Mac app replacing itself (docs/releasing.md). The page finds a release that needs new native code and hands its
// signed release here. This checks it as it checks a web bundle, with the release key inside the app, then checks the
// app it names: a newer build, for that native code, which this Mac hasn't gone back from, in a place the app can
// replace itself. Only then does electron-updater read latest-mac.yml from the record's folder on the downloads host
// built into the app, which must say exactly what the signed record does before anything downloads. electron-updater
// downloads the zip and checks its SHA-512, and Squirrel.Mac checks the new app's signature against this one's Team ID
// and bundle id, then stages it to install when Multiscale quits or the Mac restarts.

import { createPublicKey, verify } from 'node:crypto';
import { constants, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppPlace, AppRecord, Manifest, SignedRelease } from '../src/core/updates';

/** The parts of electron-updater's autoUpdater this uses. channel is left alone: setting it turns allowDowngrade on. */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  setFeedURL(options: { provider: 'generic'; url: string; useMultipleRangeRequest: boolean }): void;
  checkForUpdates(): Promise<{ updateInfo: UpdateInfo } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
}
/** latest-mac.yml, as electron-updater reads it. */
export interface UpdateInfo {
  version: string;
  path?: string;
  sha512?: string;
  files: { url: string; sha512: string; size?: number }[];
}
/** Electron's own autoUpdater, which is Squirrel.Mac: it says when an app is staged, or why it refused one. */
export interface Squirrel {
  once(event: 'update-downloaded' | 'error', listener: (error?: Error) => void): unknown;
  removeListener(event: 'update-downloaded' | 'error', listener: (error?: Error) => void): unknown;
}

/** version.json inside the app: the release key and this app's own build and native code. */
export interface AppInfo {
  build: number;
  shell: { electron: string };
  releaseKey?: string;
}

/** Refused, with why as a code in brackets, which the page reports (src/core/updates.ts). */
const refused = (code: string, message: string) => new Error(`[${code}] ${message}`);
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const CODES: Record<AppPlace['kind'], string> = { 'disk-image': 'read-only', translocated: 'read-only', 'needs-admin': 'needs-admin', older: 'older-app' };

/** Squirrel's and the file system's errors, as the page names them. */
function codeOf(error: unknown): string {
  const text = String((error as Error)?.message ?? error);
  if (/^\[[a-z-]+\]/.test(text)) return /^\[([a-z-]+)\]/.exec(text)![1]!;
  if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC' || /ENOSPC|no space/i.test(text)) return 'app-space';
  if (/code signature|did not pass validation|designated requirement|code requirement/i.test(text)) return 'app-signature';
  if (/sha512 checksum mismatch|ERR_CHECKSUM_MISMATCH/i.test(text)) return 'app-mismatch';
  return 'app-download';
}

/** Whether an app here can't replace itself because it runs read-only: from a disk image, or a temporary copy macOS made. */
export function readOnlyPlace(appPath: string, access: (path: string, mode: number) => void): AppPlace | null {
  if (appPath.includes('/AppTranslocation/')) return { kind: 'translocated' };
  try {
    access(appPath, constants.W_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EROFS') return { kind: 'disk-image' };
  }
  return null;
}

export function appUpdates(deps: {
  updater: Updater;
  squirrel: Squirrel;
  info: AppInfo;
  /** The downloads host built into the app, such as https://downloads.example.net. */
  downloadsOrigin: string;
  /** The app bundle, such as /Applications/Multiscale.app. */
  appPath: string;
  /** The app's data folder, where it keeps the newest app build this Mac has run and the update it staged. */
  dataDir: string;
  access(path: string, mode: number): void;
  /** Sets quitting, so closing the window quits rather than hides, before Squirrel quits the app to install. */
  beforeQuit(): void;
}) {
  const { updater, info } = deps;
  const newestFile = join(deps.dataDir, 'newest-app.json');
  const stagedFile = join(deps.dataDir, 'staged-app.json');
  const read = <T>(file: string): T | null => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
      return null;
    }
  };

  // The newest app build this Mac has run, so an older one someone went back to stays put.
  const newest = read<{ build: number }>(newestFile)?.build ?? 0;
  if (info.build > newest) writeFileSync(newestFile, JSON.stringify({ build: info.build }));
  // An update staged in an earlier run either installed, and this is that app, or a shutdown cut it short.
  const stagedBefore = read<{ build: number; from: number }>(stagedFile);
  let updated: { from: number; to: number; settings?: boolean } | null = null;
  if (stagedBefore && stagedBefore.build <= info.build) {
    // Restart to update reopens where its button was.
    updated = { from: stagedBefore.from, to: info.build, ...(read<{ settings?: boolean }>(stagedFile)?.settings ? { settings: true } : {}) };
    rmSync(stagedFile, { force: true });
  }
  let stagedNow: number | null = null;

  /** Why this app can't replace itself where it is, or null when it can. */
  function place(): AppPlace | null {
    const readOnly = readOnlyPlace(deps.appPath, deps.access);
    if (readOnly) return readOnly;
    for (const path of [deps.appPath, dirname(deps.appPath)]) {
      try {
        deps.access(path, constants.W_OK);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EROFS') return { kind: 'disk-image' };
        return { kind: 'needs-admin' };
      }
    }
    return newest > info.build ? { kind: 'older' } : null;
  }

  // An app the person can't replace never installs at quit, so macOS never asks for a password at quit or log out.
  updater.autoDownload = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  updater.autoInstallOnAppQuit = place()?.kind !== 'needs-admin';

  /** The app a signed release names, once the release key, the build and the record check out. */
  function checked(release: SignedRelease): { manifest: Manifest; app: AppRecord } {
    if (!info.releaseKey) throw refused('app-mismatch', 'This build has no release key');
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(info.releaseKey, 'base64')]), format: 'der', type: 'spki' });
    if (typeof release?.manifest !== 'string' || typeof release.signature !== 'string' || !verify(null, Buffer.from(release.manifest), key, Buffer.from(release.signature, 'base64'))) {
      throw refused('app-mismatch', 'The release signature does not match');
    }
    const manifest = JSON.parse(release.manifest) as Manifest;
    const app = manifest.app;
    if (!app || manifest.build <= info.build || app.build <= info.build) throw refused('app-mismatch', `Build ${manifest.build} names no app newer than this one`);
    if (app.shell !== manifest.shell.electron) throw refused('app-mismatch', "The release names an app for other native code than its own");
    if (!/^\d+\.\d+\.\d+$/.test(app.version) || app.folder !== `mac/${app.version}/` || !/^[\w.-]+\.zip$/.test(app.file)) throw refused('app-mismatch', 'The app record is malformed');
    return { manifest, app };
  }

  /** latest-mac.yml must say exactly what the signed record does, before anything downloads. */
  function matches(found: UpdateInfo | undefined, app: AppRecord) {
    const file = found?.files?.length === 1 ? found.files[0] : undefined;
    return found?.version === app.version && found.path === app.file && found.sha512 === app.sha512 && file?.url === app.file && file.sha512 === app.sha512 && file.size === app.size;
  }

  async function fetchApp(release: SignedRelease, progress: (percent: number) => void) {
    const { app } = checked(release);
    updater.setFeedURL({ provider: 'generic', url: `${deps.downloadsOrigin}/${app.folder}`, useMultipleRangeRequest: false });
    const found = await updater.checkForUpdates().catch((error: unknown) => Promise.reject(refused('app-download', String(error))));
    if (!matches(found?.updateInfo, app)) throw refused('app-mismatch', "latest-mac.yml doesn't match the signed app record");
    updater.on('download-progress', (p) => progress(p.percent));
    // Squirrel checks the app's signature after electron-updater hands it over, and says when it's staged or why not.
    let done!: () => void;
    let fail!: (error?: Error) => void;
    const staged = new Promise<void>((resolve, reject) => ((done = resolve), (fail = reject)));
    const onError = (error?: Error) => fail(error);
    deps.squirrel.once('update-downloaded', () => done());
    deps.squirrel.once('error', onError);
    try {
      await updater.downloadUpdate();
      await staged;
    } catch (error) {
      throw refused(codeOf(error), String((error as Error)?.message ?? error));
    } finally {
      deps.squirrel.removeListener('error', onError);
    }
    stagedNow = app.build;
    writeFileSync(stagedFile, JSON.stringify({ build: app.build, from: info.build }));
  }

  return {
    place: async () => place(),
    async staged() {
      if (stagedNow) return { build: stagedNow, interrupted: false };
      // Staged in an earlier run and still newer than this app: it should have installed at quit.
      const before = read<{ build: number }>(stagedFile);
      return before && before.build > info.build ? { build: before.build, interrupted: true } : null;
    },
    async download(release: SignedRelease, progress: (percent: number) => void) {
      const where = place();
      if (where) throw refused(CODES[where.kind], `The app can't replace itself here: ${where.kind}`);
      await fetchApp(release, progress);
    },
    /** Update the app, on the person's say-so: from an older app too, and asking macOS for a password where it must. */
    async install(release: SignedRelease) {
      const where = place();
      if (where && where.kind !== 'needs-admin' && where.kind !== 'older') throw refused(CODES[where.kind], `The app can't replace itself here: ${where.kind}`);
      updater.autoInstallOnAppQuit = true;
      await fetchApp(release, () => undefined);
      this.restart();
    },
    restart() {
      const staged = read<object>(stagedFile);
      if (staged) writeFileSync(stagedFile, JSON.stringify({ ...staged, settings: true }));
      deps.beforeQuit();
      updater.quitAndInstall(false, true);
    },
    updated: async () => {
      const answer = updated;
      updated = null;
      return answer;
    },
    built: async () => info.build,
    /** Whether an app update is staged in this run, for the menu bar's Restart to update. */
    ready: () => stagedNow !== null,
  };
}

/** Whether a launch sets the login item: once, on a packaged app's first run, never from a disk image or temporary copy. */
export function setsLoginItem(app: { packaged: boolean; firstRunDone: boolean; place: AppPlace | null }): boolean {
  return app.packaged && !app.firstRunDone && app.place?.kind !== 'disk-image' && app.place?.kind !== 'translocated';
}

/** A file that says a move to Applications should set the login item again from the moved app, if it was set. */
export const MOVED_FILE = 'moved-to-applications.json';
export function afterMove(dataDir: string): { openAtLogin: boolean } | null {
  const file = join(dataDir, MOVED_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { openAtLogin: boolean };
  } catch {
    return { openAtLogin: false };
  } finally {
    rmSync(file, { force: true });
  }
}
