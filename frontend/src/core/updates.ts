// Over-the-air updates of the web bundle. The page checks its app's feed, release.json under desktop/ or iphone/, and
// downloads the files it lists from the store both feeds share; native code checks the signature and every file before
// installing, and picks when the app switches over. Each feed moves on its own (docs/releasing.md). A release that needs
// new native code needs a new app: on a Mac that can replace itself, the main process checks the signed release and
// downloads the app it names, which installs when Multiscale quits; elsewhere the person installs it.

/** The Mac app a release names as the one that runs it (scripts/mac-inbox.ts appRecord). */
export interface AppRecord {
  version: string;
  build: number;
  shell: string;
  /** On the downloads host, such as mac/0.1.1794000000/. */
  folder: string;
  file: string;
  sha512: string;
  size: number;
}

/** release.json's manifest. scripts/sign-release.mjs writes it and the native installers read it. */
export interface Manifest {
  version: string;
  build: number;
  shell: Record<string, string>;
  files: { path: string; sha256: string; size: number }[];
  app?: AppRecord;
}

/** Why the Mac app can't replace itself where it is: a disk image or a temporary copy, an administrator's app, or an
 * older app than this Mac has run, which someone went back to. */
export interface AppPlace {
  kind: 'disk-image' | 'translocated' | 'needs-admin' | 'older';
}

/** A signed release as the main process checks it. */
export interface SignedRelease {
  manifest: string;
  signature: string;
}

/** What the Mac's main process offers to replace the app itself (electron/appUpdates.ts). */
export interface NativeAppUpdates {
  /** Why the app can't replace itself where it is, or null when it can. */
  place(): Promise<AppPlace | null>;
  /** The app update staged to install, and whether it should have installed already, as when a shutdown cut it short. */
  staged(): Promise<{ build: number; interrupted: boolean } | null>;
  /**
   * Checks the signed release and the app it names, then downloads that app quietly and stages it to install when
   * Multiscale quits. Throws with a code in brackets, such as [app-signature], when anything fails.
   */
  download(release: SignedRelease, progress: (percent: number) => void): Promise<void>;
  /** Update the app: the same, asking macOS for an administrator's password if it must, then installs and restarts. */
  install(release: SignedRelease): Promise<void>;
  /** Quits and installs the staged app, then opens it again. */
  restart(): Promise<void>;
  /** Moves the app to Applications and opens it from there. */
  move(): Promise<void>;
  /** On the first launch of an updated app, the app builds before and after, and whether it reopens on Settings. It answers once. */
  updated(): Promise<{ from: number; to: number; settings?: boolean } | null>;
  /** On the first launch after a move to Applications. It answers once. */
  moved(): Promise<boolean>;
  /** When this app was built: its build, the commit time. */
  built(): Promise<number>;
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
  /** On a Mac app that can replace itself. */
  app?: NativeAppUpdates;
}

export type UpdateStatus =
  | { state: 'idle' | 'checking' | 'current' }
  /** Downloaded: it runs from the next launch, or now on apply. */
  | { state: 'ready'; version: string; build: number }
  /** The release needs newer native code than this app has, and the person must replace the app: dmg is its disk image. */
  | { state: 'needs-app'; version: string; build: number; dmg?: string }
  /** The Mac app downloading the app the release names, quietly. */
  | { state: 'app-downloading'; version: string; build: number; percent: number; dmg?: string }
  /** That app is staged: it installs when Multiscale quits or the Mac restarts, or now on restart. */
  | { state: 'app-ready'; version: string; build: number; dmg?: string }
  /**
   * failure is fetch when release.json couldn't be read, download when one of its files couldn't, and otherwise why
   * native code refused the release, such as signature or rolled-back. Native code puts that code in brackets in its
   * error. For a new Mac app: app-download (failures says how many in a row), app-space, app-signature or app-mismatch
   * (it didn't check out, and isn't downloaded again), app-install (a staged app didn't install), or why the app can't
   * replace itself: read-only (place says where it runs), needs-admin or older-app.
   */
  | { state: 'failed'; failure: string; build?: number; version?: string; place?: 'disk-image' | 'translocated'; failures?: number; dmg?: string };

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
  /** The Mac app replacing itself, where it can. */
  readonly app?: {
    /** Why the app can't replace itself where it is, once known, or null. */
    place(): AppPlace | null;
    /** When this app was built, once known. */
    built(): number | null;
    restart(): Promise<void>;
    /** Update the app, for the release the last check found: the person's say-so, so a refused build is tried again. */
    install(): Promise<void>;
    move(): Promise<void>;
    /** The app builds before and after an update, on its first launch. Every caller gets the same answer. */
    updated(): Promise<{ from: number; to: number; settings?: boolean } | null>;
    /** Whether the app was just moved to Applications. Every caller gets the same answer. */
    moved(): Promise<boolean>;
  };
  stop(): void;
}

const PLACE_FAILURE = { 'disk-image': 'read-only', translocated: 'read-only', 'needs-admin': 'needs-admin', older: 'older-app' } as const;
/** Failures that mean the app itself is bad: that build isn't downloaded again. */
const REFUSED = ['app-signature', 'app-mismatch'];
const REFUSED_KEY = 'multiscale.updates.refused-app';

/** Each app's feed on the release host. */
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
  /** Where a refused app build is remembered across launches. */
  store?: Pick<Storage, 'getItem' | 'setItem'>;
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

  const app = deps.native.app;
  const store = deps.store ?? (typeof localStorage === 'undefined' ? undefined : localStorage);
  let place: AppPlace | null = null;
  let built: number | null = null;
  let downloadFailures = 0;
  let lastRelease: SignedRelease | null = null;
  let updated: Promise<{ from: number; to: number; settings?: boolean } | null> | undefined;
  let moved: Promise<boolean> | undefined;
  const refused = (): { build: number; failure: string } | null => {
    try {
      return JSON.parse(store?.getItem(REFUSED_KEY) ?? 'null') as { build: number; failure: string } | null;
    } catch {
      return null;
    }
  };
  const remember = (value: { build: number; failure: string } | null) => {
    try {
      store?.setItem(REFUSED_KEY, JSON.stringify(value));
    } catch {
      // Remembered for this run only.
    }
  };
  // The disk image of the app a release names, on the downloads host, for an app that can't replace itself.
  const dmgOf = (m: Manifest) => (deps.download && m.app && /^mac\/[\d.]+\/$/.test(m.app.folder) ? { dmg: new URL(`${m.app.folder}Multiscale.dmg`, deps.download).href } : {});

  /** A release that needs a new Mac app, on an app that can replace itself. */
  async function appUpdate(native: NativeAppUpdates, release: SignedRelease, m: Manifest): Promise<UpdateStatus> {
    const named = { version: m.version, build: m.build, ...dmgOf(m) };
    place = await native.place();
    if (place) return set({ state: 'failed', failure: PLACE_FAILURE[place.kind], ...named, ...(PLACE_FAILURE[place.kind] === 'read-only' ? { place: place.kind as 'disk-image' | 'translocated' } : {}) });
    const before = refused();
    if (before && before.build >= m.build) return set({ state: 'failed', failure: before.failure, ...named });
    const staged = await native.staged();
    if (staged?.build === m.build) return set(staged.interrupted ? { state: 'failed', failure: 'app-install', ...named } : { state: 'app-ready', ...named });
    set({ state: 'app-downloading', ...named, percent: 0 });
    try {
      await native.download(release, (percent) => set({ state: 'app-downloading', ...named, percent: Math.round(percent) }));
    } catch (error) {
      console.warn('App update failed', error);
      const code = /\[([a-z-]+)\]/.exec(String(error))?.[1] ?? '';
      const failure = ['app-space', ...REFUSED].includes(code) ? code : 'app-download';
      if (REFUSED.includes(failure)) remember({ build: m.build, failure });
      downloadFailures = failure === 'app-download' ? downloadFailures + 1 : 0;
      return set({ state: 'failed', failure, ...named, ...(failure === 'app-download' ? { failures: downloadFailures } : {}) });
    }
    downloadFailures = 0;
    return set({ state: 'app-ready', ...named });
  }

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
      if (manifest.shell[deps.platform] !== deps.shell) {
        if (!app || !manifest.app) return set({ state: 'needs-app', version: manifest.version, build, ...dmgOf(manifest) });
        lastRelease = { manifest: release.manifest, signature: release.signature };
        return await appUpdate(app, lastRelease, manifest);
      }
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
  // Where the app runs from shows before any update does, as running from a disk image keeps it from opening at login.
  const notify = () => listeners.forEach((listener) => listener());
  if (app) {
    void app.place().then((p) => ((place = p), notify()), () => undefined);
    void app.built().then((b) => ((built = b), notify()), () => undefined);
  }
  return {
    version: deps.version,
    ...(deps.download ? { download: deps.download } : {}),
    ...(app
      ? {
          app: {
            place: () => place,
            built: () => built,
            restart: () => app.restart(),
            async install() {
              if (!lastRelease) return;
              remember(null);
              await app.install(lastRelease);
            },
            async move() {
              await app.move();
              place = await app.place();
              notify();
            },
            updated: () => (updated ??= app.updated().catch(() => null)),
            moved: () => (moved ??= app.moved().catch(() => false)),
          },
        }
      : {}),
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
