import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpdater } from './updates';
import type { DownloadedRelease, Manifest, NativeAppUpdates, NativeUpdates, Updater } from './updates';

const URL = 'https://release.example.test';
const manifest = (over: Partial<Manifest> = {}): Manifest => ({
  version: '0.2.0-bbbbbbb',
  build: 200,
  shell: { electron: 'shell-e', ios: 'shell-i' },
  files: [
    { path: 'index.html', sha256: 'aaa', size: 3 },
    { path: 'assets/app.js', sha256: 'bbb', size: 2 },
  ],
  ...over,
});

// The release host: each app's feed, which hold the same signed manifest, and the files they share.
function server(m: Manifest | null) {
  const bodies: Record<string, string> = { [`${URL}/files/aaa`]: '<p>', [`${URL}/files/bbb`]: 'js' };
  if (m) for (const feed of ['desktop', 'iphone']) bodies[`${URL}/${feed}/release.json`] = JSON.stringify({ manifest: JSON.stringify(m), signature: 'sig' });
  return vi.fn(async (url: string | URL | Request) => {
    const body = bodies[String(url)];
    return new Response(body ?? 'missing', { status: body === undefined ? 404 : 200 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function native(staged: number | null = null) {
  const installed: DownloadedRelease[] = [];
  const updates: NativeUpdates & { installed: DownloadedRelease[] } = {
    installed,
    install: vi.fn(async (release: DownloadedRelease) => void installed.push(release)),
    staged: vi.fn(async () => staged),
    apply: vi.fn(async () => undefined),
    ready: vi.fn(),
    rolledBack: vi.fn(async () => null),
  };
  return updates;
}

describe('createUpdater', () => {
  let updater: Updater | undefined;
  const start = (fetch: typeof globalThis.fetch, n: NativeUpdates, more: { platform?: 'electron' | 'ios'; onForeground?(l: () => void): () => void; now?: () => number } = {}) =>
    (updater = createUpdater({ url: URL, version: '0.1.0-aaaaaaa', build: 100, shell: 'shell-e', platform: 'electron', native: n, fetch, ...more }));

  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => {
    updater?.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('downloads a newer release and hands it to native code as signed', async () => {
    const n = native();
    const status = await start(server(manifest()), n).check();
    expect(status).toEqual({ state: 'ready', version: '0.2.0-bbbbbbb', build: 200 });
    expect(n.installed).toHaveLength(1);
    expect(n.installed[0]!.manifest).toBe(JSON.stringify(manifest()));
    expect(n.installed[0]!.signature).toBe('sig');
    expect(new TextDecoder().decode(n.installed[0]!.files['index.html'])).toBe('<p>');
    expect(new TextDecoder().decode(n.installed[0]!.files['assets/app.js'])).toBe('js');
  });

  it("reads its own app's feed, and the files from the store both feeds share", async () => {
    for (const [platform, feed] of [['electron', 'desktop'], ['ios', 'iphone']] as const) {
      const fetch = server(manifest({ shell: { electron: 'shell-e', ios: 'shell-e' } }));
      expect(await start(fetch, native(), { platform }).check()).toMatchObject({ state: 'ready' });
      expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([`${URL}/${feed}/release.json`, `${URL}/files/aaa`, `${URL}/files/bbb`]);
      updater?.stop();
    }
  });

  it('is current when the release is this build or older', async () => {
    const n = native();
    expect(await start(server(manifest({ build: 100 })), n).check()).toEqual({ state: 'current' });
    expect(n.install).not.toHaveBeenCalled();
  });

  it("asks for the new app when the release needs native code this app doesn't have", async () => {
    const n = native();
    expect(await start(server(manifest({ shell: { electron: 'newer', ios: 'shell-i' } })), n).check()).toEqual({ state: 'needs-app', version: '0.2.0-bbbbbbb', build: 200 });
    expect(n.install).not.toHaveBeenCalled();
  });

  it("checks each app's own native code", async () => {
    const n = native();
    const status = await start(server(manifest({ shell: { electron: 'other', ios: 'shell-e' } })), n, { platform: 'ios' }).check();
    expect(status.state).toBe('ready');
  });

  it("doesn't download a release that's already installed", async () => {
    const fetch = server(manifest());
    const n = native(200);
    expect((await start(fetch, n).check()).state).toBe('ready');
    expect(n.install).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails without installing when the feed or a file is missing, saying which', async () => {
    expect(await start(server(null), native()).check()).toEqual({ state: 'failed', failure: 'fetch' });
    updater!.stop();

    const n = native();
    const fetch = server(manifest({ files: [{ path: 'index.html', sha256: 'gone', size: 1 }] }));
    expect(await start(fetch, n).check()).toEqual({ state: 'failed', failure: 'download', build: 200 });
    expect(n.install).not.toHaveBeenCalled();
  });

  it("fails with native code's reason when it refuses the release", async () => {
    for (const [message, failure] of [
      ['[signature] The release signature does not match', 'signature'],
      // Electron's IPC wraps the main process's message.
      ["Error invoking remote method 'updates:install': Error: [rolled-back] Build 200 was rolled back on this device", 'rolled-back'],
      ['ENOSPC: no space left on device', 'install'],
    ]) {
      const refusing = native();
      refusing.install = vi.fn(async () => {
        throw new Error(message);
      });
      expect(await start(server(manifest()), refusing).check()).toEqual({ state: 'failed', failure, build: 200 });
      updater!.stop();
    }
  });

  it('passes on the build native code rolled back', async () => {
    const n = native();
    n.rolledBack = vi.fn(async () => 150);
    expect(await start(server(null), n).rolledBack()).toBe(150);
  });

  it('reports each change of status, and runs one check at a time', async () => {
    const fetch = server(manifest({ build: 50 }));
    const u = start(fetch, native());
    const seen: string[] = [];
    u.subscribe(() => seen.push(u.status().state));
    const [a, b] = [u.check(), u.check()];
    expect(a).toBe(b);
    await a;
    expect(seen).toEqual(['checking', 'current']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('checks soon after starting, then every six hours, and on coming back after an hour away', async () => {
    vi.useFakeTimers();
    const fetch = server(manifest({ build: 50 }));
    let foreground: () => void = () => undefined;
    let time = 1_800_000_000_000;
    start(fetch, native(), {
      now: () => time,
      onForeground: (listener) => {
        foreground = listener;
        return () => undefined;
      },
    });
    // Coming to the front before the first check, such as after a keychain prompt, waits for it.
    foreground();
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    time += 30 * 60_000;
    foreground();
    expect(fetch).toHaveBeenCalledTimes(1);
    time += 31 * 60_000;
    foreground();
    expect(fetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('applies through native code', async () => {
    const n = native();
    await start(server(manifest()), n).apply();
    expect(n.apply).toHaveBeenCalled();
  });
});

// The Mac app replacing itself (electron/appUpdates.ts), for a release whose signed manifest names the app that runs it.
describe('the Mac app updating itself', () => {
  const APP = { version: '0.1.200', build: 200, shell: 'newer', folder: 'mac/0.1.200/', file: 'Multiscale.zip', sha512: `${'A'.repeat(86)}==`, size: 9 };
  const newApp = (over: Partial<Manifest> = {}) => manifest({ shell: { electron: 'newer', ios: 'shell-i' }, app: APP, ...over });
  const DMG = 'https://downloads.example.test/Multiscale.dmg';
  const VERSIONED = 'https://downloads.example.test/mac/0.1.200/Multiscale.dmg';
  let updater: Updater | undefined;

  function appUpdates(over: Partial<NativeAppUpdates> = {}) {
    return {
      place: vi.fn(async () => null),
      staged: vi.fn(async () => null),
      download: vi.fn(async (_release: { manifest: string; signature: string }, progress: (percent: number) => void) => {
        progress(40);
        progress(100);
      }),
      install: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      move: vi.fn(async () => undefined),
      updated: vi.fn(async () => null),
      moved: vi.fn(async () => false),
      built: vi.fn(async () => 1762160000),
      ...over,
    } satisfies NativeAppUpdates;
  }
  const memory = () => {
    const kept = new Map<string, string>();
    return { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) };
  };
  const start = (m: Manifest, app: NativeAppUpdates | undefined, store = memory()) =>
    (updater = createUpdater({ url: URL, version: '0.1.0-aaaaaaa', build: 100, shell: 'shell-e', platform: 'electron', native: { ...native(), ...(app ? { app } : {}) }, fetch: server(m), download: DMG, store }));

  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => {
    updater?.stop();
    vi.restoreAllMocks();
  });

  it('hands the signed release to the app updater, reports the download with a percent, then the app ready', async () => {
    const app = appUpdates();
    const u = start(newApp(), app);
    const seen: unknown[] = [];
    u.subscribe(() => seen.push(u.status()));
    expect(await u.check()).toEqual({ state: 'app-ready', version: '0.2.0-bbbbbbb', build: 200, dmg: VERSIONED });
    expect(app.download).toHaveBeenCalledWith({ manifest: JSON.stringify(newApp()), signature: 'sig' }, expect.any(Function));
    expect(seen.filter((s) => (s as { state: string }).state === 'app-downloading').map((s) => (s as { percent: number }).percent)).toEqual([0, 40, 100]);
    // Ready stays ready: the next check finds it staged and downloads nothing.
    vi.mocked(app.staged).mockResolvedValue({ build: 200, interrupted: false });
    expect(await u.check()).toMatchObject({ state: 'app-ready' });
    expect(app.download).toHaveBeenCalledOnce();
  });

  it("asks for the disk image as now without an app updater, as on today's apps, or for a release that names no app", async () => {
    expect(await start(newApp(), undefined).check()).toEqual({ state: 'needs-app', version: '0.2.0-bbbbbbb', build: 200, dmg: VERSIONED });
    updater?.stop();
    const app = appUpdates();
    const { app: _, ...noApp } = newApp();
    expect(await start(noApp, app).check()).toEqual({ state: 'needs-app', version: '0.2.0-bbbbbbb', build: 200 });
    expect(app.download).not.toHaveBeenCalled();
  });

  it("says why the app can't update itself, and downloads nothing by itself then", async () => {
    for (const [kind, status] of [
      ['disk-image', { failure: 'read-only', place: 'disk-image' }],
      ['translocated', { failure: 'read-only', place: 'translocated' }],
      ['needs-admin', { failure: 'needs-admin' }],
      ['older', { failure: 'older-app' }],
    ] as const) {
      const app = appUpdates({ place: vi.fn(async () => ({ kind })) });
      expect(await start(newApp(), app).check()).toEqual({ state: 'failed', version: '0.2.0-bbbbbbb', build: 200, dmg: VERSIONED, ...status });
      expect(app.download).not.toHaveBeenCalled();
      updater?.stop();
    }
  });

  it('knows where the app runs from before there is an update, and when it was built', async () => {
    const u = start(manifest({ build: 100 }), appUpdates({ place: vi.fn(async () => ({ kind: 'disk-image' as const })) }));
    await vi.waitFor(() => expect(u.app?.place()).toEqual({ kind: 'disk-image' }));
    expect(u.app?.built()).toBe(1762160000);
  });

  it('maps each failure to its state, and offers the disk image after three failed downloads in a row', async () => {
    const failing = (message: string) => appUpdates({ download: vi.fn(async () => Promise.reject(new Error(message))) });
    expect(await start(newApp(), failing('[app-space] The disk is full')).check()).toMatchObject({ state: 'failed', failure: 'app-space' });
    updater?.stop();
    const u = start(newApp(), failing('net::ERR_INTERNET_DISCONNECTED'));
    expect(await u.check()).toMatchObject({ state: 'failed', failure: 'app-download', failures: 1 });
    await u.check();
    expect(await u.check()).toMatchObject({ state: 'failed', failure: 'app-download', failures: 3 });
  });

  it("doesn't download a build Squirrel refused again, across launches, until a newer build or Update the app", async () => {
    const store = memory();
    const app = appUpdates({ download: vi.fn(async () => Promise.reject(new Error('[app-signature] Code signature did not match'))) });
    expect(await start(newApp(), app, store).check()).toMatchObject({ state: 'failed', failure: 'app-signature' });
    updater?.stop();
    const again = appUpdates();
    expect(await start(newApp(), again, store).check()).toMatchObject({ state: 'failed', failure: 'app-signature', build: 200 });
    expect(again.download).not.toHaveBeenCalled();
    // Update the app is the person's say-so: it installs the build and forgets the refusal.
    await updater!.app!.install();
    expect(again.install).toHaveBeenCalledWith({ manifest: JSON.stringify(newApp()), signature: 'sig' });
    updater?.stop();
    const newer = appUpdates();
    expect(await start(newApp({ build: 201 }), newer, store).check()).toMatchObject({ state: 'app-ready', build: 201 });
  });

  it("says an update didn't install when a shutdown cut it short, and Restart to update tries again", async () => {
    const app = appUpdates({ staged: vi.fn(async () => ({ build: 200, interrupted: true })) });
    const u = start(newApp(), app);
    expect(await u.check()).toMatchObject({ state: 'failed', failure: 'app-install', build: 200 });
    expect(app.download).not.toHaveBeenCalled();
    await u.app!.restart();
    expect(app.restart).toHaveBeenCalled();
  });

  it('moves the app to Applications, and answers once that it was updated, to everyone who asks', async () => {
    const app = appUpdates({ updated: vi.fn(async () => ({ from: 100, to: 200 })) });
    const u = start(newApp(), app);
    await u.app!.move();
    expect(app.move).toHaveBeenCalled();
    expect(await u.app!.updated()).toEqual({ from: 100, to: 200 });
    expect(await u.app!.updated()).toEqual({ from: 100, to: 200 });
    expect(app.updated).toHaveBeenCalledOnce();
  });
});
