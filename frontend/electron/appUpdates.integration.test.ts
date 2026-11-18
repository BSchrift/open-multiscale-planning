// The Mac app replacing itself with the real updater, as far as code that isn't macOS's goes. The pipeline's own signed
// feed (sign-release.mjs) and latest-mac.yml (latest-mac.mjs), and app-update.yml as electron-builder writes it from
// identity.ts, served over HTTP as the downloads host serves them. electron-updater's own MacUpdater reads them and
// downloads the zip, appUpdates.ts checks each step, and a stand-in for Squirrel.Mac fetches the zip from MacUpdater as
// Squirrel does. Squirrel's signature check and the install itself need macOS: the staging update check
// (scripts/mac-update-check.sh) covers those, and electron/e2e/updates.spec.ts the app around this.

import { createHash, generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { accessSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { ClientRequest, IncomingMessage, RequestOptions, Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppRecord } from '../src/core/updates';
import { latestMacYml } from '../scripts/latest-mac.mjs';
import { writeRelease } from '../scripts/sign-release.mjs';
import { appUpdates } from './appUpdates';
import type { Squirrel, Updater } from './appUpdates';
import { appIdentity, builderConfig } from './identity';

/** Electron's autoUpdater on a Mac, which is Squirrel.Mac: it asks the feed URL for the zip's address, then fetches it. */
class SquirrelStandIn extends EventEmitter {
  feed: { url: string; headers?: Record<string, string> } | null = null;
  /** The zip Squirrel would check and stage. */
  received: Buffer | null = null;
  installs = 0;
  setFeedURL(feed: { url: string; headers?: Record<string, string> }) {
    this.feed = feed;
  }
  checkForUpdates() {
    void (async () => {
      try {
        const { url } = (await (await fetch(this.feed!.url, { headers: this.feed!.headers })).json()) as { url: string };
        this.received = Buffer.from(await (await fetch(url)).arrayBuffer());
        this.emit('update-downloaded');
      } catch (error) {
        this.emit('error', error);
      }
    })();
  }
  quitAndInstall() {
    this.installs++;
  }
}

// MacUpdater takes require('electron').autoUpdater as it's made: each updater gets the stand-in made for it.
const fromUpdater = createRequire(createRequire(import.meta.url).resolve('electron-updater'));
let squirrel = new SquirrelStandIn();
const electronPath = fromUpdater.resolve('electron');
fromUpdater.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    get autoUpdater() {
      return squirrel;
    },
  },
} as unknown as NodeJS.Module;
const { MacUpdater } = fromUpdater('./MacUpdater') as { MacUpdater: new (options: null, app: object) => Updater & { httpExecutor: unknown; logger: unknown; _testOnlyOptions: unknown } };
const runtime = fromUpdater('builder-util-runtime') as {
  HttpExecutor: new () => { doDownload(options: object, config: object, redirects: number): void };
  configureRequestOptions(options: object): void;
  configureRequestUrl(url: URL, options: object): void;
};

/** electron-updater's HTTP over Node's http rather than Electron's net, which only exists in Electron. */
class NodeHttpExecutor extends runtime.HttpExecutor {
  createRequest(options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest {
    return request(options, callback);
  }
  download(url: URL, destination: string, options: { headers?: object; cancellationToken: { createPromise<T>(run: (resolve: (v: T) => void, reject: (e: Error) => void, onCancel: (c: () => void) => void) => void): Promise<T> } }) {
    return options.cancellationToken.createPromise<string>((resolve, reject, onCancel) => {
      const requestOptions = { headers: options.headers || undefined, redirect: 'manual' };
      runtime.configureRequestUrl(url, requestOptions);
      runtime.configureRequestOptions(requestOptions);
      this.doDownload(requestOptions, { destination, options, onCancel, callback: (error: Error | null) => (error == null ? resolve(destination) : reject(error)), responseHandler: null }, 0);
    });
  }
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const releaseKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
const zip = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251));
const record: AppRecord = {
  version: '0.1.200',
  build: 200,
  shell: 'e2',
  folder: 'mac/0.1.200/',
  file: 'Multiscale.zip',
  sha512: createHash('sha512').update(zip).digest('base64'),
  size: zip.length,
};

// The downloads host: a folder per app, as the release publishes it. A key it doesn't have answers 403, as the private
// bucket does.
let host: Record<string, Buffer | string> = {};
const asked: string[] = [];
let server: Server;
let origin = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    // electron-updater adds a query to each request so no cache answers it, which the bucket ignores.
    const path = new URL(req.url!, origin).pathname;
    asked.push(path);
    const body = host[path];
    if (body === undefined) return void res.writeHead(403, { 'content-type': 'application/xml' }).end('<Error><Code>AccessDenied</Code></Error>');
    res.writeHead(200, { 'content-length': Buffer.byteLength(body) }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** The signed release a pipeline run makes for a build whose manifest names the app. */
function signedRelease(root: string) {
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'version.json'), JSON.stringify({ version: '0.1.0-next', build: 200, shell: { electron: 'e2', ios: 'i1' }, releaseKey }));
  writeFileSync(join(dist, 'index.html'), '<!doctype html>');
  writeRelease(dist, privateKey.export({ type: 'pkcs8', format: 'pem' }), join(root, 'signed'), record);
  return JSON.parse(readFileSync(join(root, 'signed/release.json'), 'utf8')) as { manifest: string; signature: string };
}

/** An installed app: built 100, with native code e1, in a folder it can replace, and its updater as main.ts makes it. */
function installed({ updateConfig = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'app-updates-'));
  squirrel = new SquirrelStandIn();
  // As electron-builder writes Contents/Resources/app-update.yml from identity.ts's publish setting.
  const publish = builderConfig('staging', appIdentity('staging'), origin).publish!;
  const configPath = join(root, 'Resources/app-update.yml');
  mkdirSync(join(root, 'Resources'), { recursive: true });
  if (updateConfig) writeFileSync(configPath, `provider: ${publish.provider}\nurl: ${publish.url}\nupdaterCacheDirName: multiscale-updater\n`);
  const updater = new MacUpdater(null, {
    version: '0.1.100',
    name: 'Multiscale Staging',
    isPackaged: true,
    appUpdateConfigPath: configPath,
    userDataPath: join(root, 'data'),
    baseCachePath: join(root, 'cache'),
    whenReady: () => Promise.resolve(),
    quit: () => {},
    relaunch: () => {},
    onQuit: () => {},
  });
  updater.httpExecutor = new NodeHttpExecutor();
  updater.logger = null;
  // electron-updater reads latest-<platform>.yml for the platform it runs on, and CI runs on Linux: read it as a Mac does.
  updater._testOnlyOptions = { platform: 'darwin', isUseDifferentialDownload: false };
  const appPath = join(root, 'Applications/Multiscale Staging.app');
  mkdirSync(appPath, { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  let quitting = false;
  const app = appUpdates({
    updater,
    squirrel: squirrel as unknown as Squirrel,
    info: { build: 100, shell: { electron: 'e1' }, releaseKey },
    downloadsOrigin: origin,
    appPath,
    dataDir: join(root, 'data'),
    access: accessSync,
    beforeQuit: () => (quitting = true),
  });
  return { app, release: signedRelease(root), root, quitting: () => quitting };
}

beforeEach(() => {
  asked.length = 0;
  host = { '/mac/0.1.200/latest-mac.yml': latestMacYml(record), '/mac/0.1.200/Multiscale.zip': zip };
});

describe("the Mac app's own update, with electron-updater", () => {
  it("reads the pipeline's latest-mac.yml, downloads and checks the zip, hands it to Squirrel, and installs on Restart", async () => {
    const { app, release, root, quitting } = installed();
    const progress: number[] = [];
    await app.download(release, (p) => progress.push(p));
    expect(asked).toEqual(['/mac/0.1.200/latest-mac.yml', '/mac/0.1.200/Multiscale.zip']);
    // Squirrel got the very zip the record names, from MacUpdater's own server.
    expect(squirrel.received?.equals(zip)).toBe(true);
    expect(squirrel.feed?.headers?.Authorization).toMatch(/^Basic /);
    expect(await app.staged()).toEqual({ build: 200, interrupted: false });
    expect(JSON.parse(readFileSync(join(root, 'data/staged-app.json'), 'utf8'))).toEqual({ build: 200, from: 100 });
    // Restart to update: Squirrel installs it as the app quits, and opens it again.
    app.restart();
    expect(quitting()).toBe(true);
    expect(squirrel.installs).toBe(1);
  });

  // Prod's desktop feed named app 0.1.1794769547, which its downloads host didn't have (pipeline.sh publish).
  it("fails as a download that's tried again when the record's folder isn't on the downloads host", async () => {
    host = {};
    const { app, release } = installed();
    await expect(app.download(release, () => {})).rejects.toThrow(/^\[app-download\] .*403/);
    expect(squirrel.received).toBeNull();
    expect(await app.staged()).toBeNull();
  });

  it("refuses a latest-mac.yml that says another zip than the signed record, before downloading anything", async () => {
    host['/mac/0.1.200/latest-mac.yml'] = latestMacYml({ ...record, size: record.size + 1 });
    const { app, release } = installed();
    await expect(app.download(release, () => {})).rejects.toThrow(/^\[app-mismatch\] latest-mac\.yml doesn't match the signed app record/);
    expect(asked).toEqual(['/mac/0.1.200/latest-mac.yml']);
  });

  it("refuses a zip whose SHA-512 isn't the record's, and hands Squirrel nothing", async () => {
    host['/mac/0.1.200/Multiscale.zip'] = Buffer.from(zip).fill(0, 0, 10);
    const { app, release } = installed();
    await expect(app.download(release, () => {})).rejects.toThrow(/^\[app-mismatch\]/);
    expect(squirrel.received).toBeNull();
  });

  // Every app built before identity.ts named the downloads host: electron-builder wrote no app-update.yml into them.
  it("can't download without app-update.yml, which electron-updater reads before it downloads", async () => {
    const { app, release } = installed({ updateConfig: false });
    await expect(app.download(release, () => {})).rejects.toThrow(/^\[app-download\] .*ENOENT.*app-update\.yml/);
    expect(squirrel.received).toBeNull();
  });
});
