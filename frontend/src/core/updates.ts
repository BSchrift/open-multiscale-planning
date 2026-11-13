// Over-the-air updates of the web bundle. The page checks its app's feed, release.json under desktop/ or iphone/, and
// downloads the files it lists from the store both feeds share; native code checks the signature and every file before
// installing, and picks when the app switches over. Each feed moves on its own (docs/releasing.md).

/** release.json's manifest. scripts/sign-release.mjs writes it and the native installers read it. */
export interface Manifest {
  version: string;
  build: number;
  shell: Record<string, string>;
  files: { path: string; sha256: string; size: number }[];
}

/** A release the page downloaded, for native code to check and install. */
export interface DownloadedRelease {
  /** The manifest exactly as signed. */
  manifest: string;
  /** Base64 Ed25519 signature of the manifest. */
  signature: string;
  files: Record<string, Uint8Array>;
}

/** What native code offers. Electron's main process and the iOS app each implement it. */
export interface NativeUpdates {
  /** Checks the signature, the native code and every file, then installs the bundle for the next load. Throws if any fail. */
  install(release: DownloadedRelease): Promise<void>;
  /** The build of the newest installed bundle newer than the one running, or null. */
  staged(): Promise<number | null>;
  /** Reloads into the newest installed bundle. */
  apply(): Promise<void>;
  /** This bundle started and drew the app. A new bundle that never says so is rolled back. */
  ready(): void;
  /** The build this run of the app rolled back, if any. It answers once, so the bundle loaded next can report it. */
  rolledBack(): Promise<number | null>;
}

export type UpdateStatus =
  | { state: 'idle' | 'checking' | 'current' }
  /** Downloaded: it runs from the next launch, or now on apply. */
  | { state: 'ready'; version: string; build: number }
  /** The release needs newer native code than this app has, so the app itself must be replaced. */
  | { state: 'needs-app'; version: string; build: number }
  /**
   * failure is fetch when release.json couldn't be read, download when one of its files couldn't, and otherwise why
   * native code refused the release, such as signature or rolled-back. Native code puts that code in brackets in its
   * error.
   */
  | { state: 'failed'; failure: string; build?: number };

export interface Updater {
  /** The running bundle's version. */
  readonly version: string;
  /** The Mac app's disk image, for an update that needs the app replaced. */
  readonly download?: string;
  status(): UpdateStatus;
  subscribe(listener: () => void): () => void;
  check(): Promise<UpdateStatus>;
  apply(): Promise<void>;
  /** The build native code rolled back before this page loaded, if any. It answers once. */
  rolledBack(): Promise<number | null>;
  stop(): void;
}

/** Each app's feed on the release host. Bundles from before these read the shared release.json at its root. */
const FEEDS = { electron: 'desktop', ios: 'iphone' } as const;
const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
const RECHECK_AFTER_MS = 60 * 60_000;

export function createUpdater(deps: {
  url: string;
  version: string;
  download?: string;
  build: number;
  /** This app's native code, from the running bundle's config. */
  shell: string;
  platform: 'electron' | 'ios';
  native: NativeUpdates;
  onForeground?(listener: () => void): () => void;
  fetch?: typeof fetch;
  now?: () => number;
}): Updater {
  const get = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  let status: UpdateStatus = { state: 'idle' };
  let running: Promise<UpdateStatus> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: UpdateStatus) => {
    status = next;
    for (const listener of listeners) listener();
    return next;
  };
  const fetchOk = async (url: string, init?: RequestInit) => {
    const response = await get(url, init);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response;
  };

  async function run(): Promise<UpdateStatus> {
    set({ state: 'checking' });
    // How far the check got, for saying why it failed.
    let failure = 'fetch';
    let build: number | undefined;
    try {
      const release = (await (await fetchOk(`${deps.url}/${FEEDS[deps.platform]}/release.json`, { cache: 'no-store' })).json()) as { manifest: string; signature: string };
      const manifest = JSON.parse(release.manifest) as Manifest;
      if (manifest.build <= deps.build) return set({ state: 'current' });
      build = manifest.build;
      if (manifest.shell[deps.platform] !== deps.shell) return set({ state: 'needs-app', version: manifest.version, build });
      failure = 'install';
      if ((await deps.native.staged()) !== build) {
        failure = 'download';
        const files = await Promise.all(
          manifest.files.map(async (f) => [f.path, new Uint8Array(await (await fetchOk(`${deps.url}/files/${f.sha256}`)).arrayBuffer())] as const),
        );
        failure = 'install';
        await deps.native.install({ manifest: release.manifest, signature: release.signature, files: Object.fromEntries(files) });
      }
      return set({ state: 'ready', version: manifest.version, build });
    } catch (error) {
      console.warn('Update check failed', error);
      if (failure === 'install') failure = /\[([a-z-]+)\]/.exec(String(error))?.[1] ?? 'install';
      return set({ state: 'failed', failure, ...(build ? { build } : {}) });
    }
  }

  // Counted from launch, so coming to the front before the first check doesn't add one.
  let lastCheck = now();
  const check = () => {
    lastCheck = now();
    running ??= run().finally(() => (running = null));
    return running;
  };
  const first = setTimeout(() => void check(), FIRST_CHECK_MS);
  const period = setInterval(() => void check(), CHECK_EVERY_MS);
  // A phone's timers stop while it's in the background, so coming back after a while is a good moment to look again.
  const stopForeground = deps.onForeground?.(() => {
    if (now() - lastCheck >= RECHECK_AFTER_MS) void check();
  });
  return {
    version: deps.version,
    ...(deps.download ? { download: deps.download } : {}),
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    check,
    apply: () => deps.native.apply(),
    rolledBack: () => deps.native.rolledBack(),
    stop() {
      clearTimeout(first);
      clearInterval(period);
      stopForeground?.();
    },
  };
}
