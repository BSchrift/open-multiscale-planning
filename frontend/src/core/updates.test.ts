import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpdater } from './updates';
import type { DownloadedRelease, Manifest, NativeUpdates, Updater } from './updates';

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

function server(m: Manifest | null) {
  const bodies: Record<string, string> = { [`${URL}/files/aaa`]: '<p>', [`${URL}/files/bbb`]: 'js' };
  if (m) bodies[`${URL}/release.json`] = JSON.stringify({ manifest: JSON.stringify(m), signature: 'sig' });
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
    expect(status).toEqual({ state: 'ready', version: '0.2.0-bbbbbbb' });
    expect(n.installed).toHaveLength(1);
    expect(n.installed[0]!.manifest).toBe(JSON.stringify(manifest()));
    expect(n.installed[0]!.signature).toBe('sig');
    expect(new TextDecoder().decode(n.installed[0]!.files['index.html'])).toBe('<p>');
    expect(new TextDecoder().decode(n.installed[0]!.files['assets/app.js'])).toBe('js');
  });

  it('is current when the release is this build or older', async () => {
    const n = native();
    expect(await start(server(manifest({ build: 100 })), n).check()).toEqual({ state: 'current' });
    expect(n.install).not.toHaveBeenCalled();
  });

  it("asks for the new app when the release needs native code this app doesn't have", async () => {
    const n = native();
    expect(await start(server(manifest({ shell: { electron: 'newer', ios: 'shell-i' } })), n).check()).toEqual({ state: 'needs-app', version: '0.2.0-bbbbbbb' });
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

  it('fails without installing when the feed or a file is missing, or native code refuses it', async () => {
    expect(await start(server(null), native()).check()).toEqual({ state: 'failed' });
    updater!.stop();

    const n = native();
    const fetch = server(manifest({ files: [{ path: 'index.html', sha256: 'gone', size: 1 }] }));
    expect(await start(fetch, n).check()).toEqual({ state: 'failed' });
    expect(n.install).not.toHaveBeenCalled();
    updater!.stop();

    const refusing = native();
    refusing.install = vi.fn(async () => {
      throw new Error('Bad signature');
    });
    expect(await start(server(manifest()), refusing).check()).toEqual({ state: 'failed' });
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
    let time = 0;
    start(fetch, native(), {
      now: () => time,
      onForeground: (listener) => {
        foreground = listener;
        return () => undefined;
      },
    });
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    time = 30 * 60_000;
    foreground();
    expect(fetch).toHaveBeenCalledTimes(1);
    time = 61 * 60_000;
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
