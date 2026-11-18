// Decides when to sync: at launch, on returning to the foreground, on coming back online, 2 seconds after an edit,
// every 5 minutes while open, and every 5 seconds for 2 minutes after Google's consent page opens. The result goes in
// the meta table, so Settings reads it with syncStatus like any other query, and it survives a restart. A failed sync changes nothing but that status: the outbox keeps everything for next time.
//
// There's no paused state to manage. Once a sign-in has expired the tokens are gone, so each trigger fails at once
// without any network traffic, and the next sync after signing in again carries on from the outbox.
//
// Before the first sync it fills in missing expiries and removes what has expired here, and after each sync it removes
// what has expired again (expiry.ts), after deleting what's left on notes that are gone (attachments.ts).
//
// On the Mac it also syncs when the computer wakes from sleep or its screen unlocks, so a laptop opened in the morning
// shows what changed overnight without waiting for a click on the window or the 5-minute timer.
//
// A sync refused because the account was deleted, on this device or another, erases this device's copy and signs it
// out, and Settings says so until someone signs in.

import { deleteAccount, exportData } from './account';
import type { AppConfig } from './appConfig';
import { sweepOrphans } from './attachments';
import { createAuth, tokenSubject } from './auth';
import type { Clock } from './clock';
import { nowInstant } from './dates';
import { getMeta, META, setMeta } from './db';
import type { Db } from './db';
import { backfillExpiry, expireLocal } from './expiry';
import { createFiles } from './files';
import { perf } from './perf';
import type { FileBytes, FilesApi } from './files';
import { CALENDAR_ID, getRecord, listRecords, rebaseClocks } from './records';
import type { Diagnostics } from './telemetry';
import { apiPost, apiRequest, createHttpSend, runSync, SyncError } from './sync';
import type { FetchFn, SyncErrorCode, SyncSend } from './sync';
import type { Reminder } from './types';
import type { Updater } from './updates';

const EDIT_DELAY_MS = 2000;
const PERIOD_MS = 5 * 60_000;
const CONNECT_POLL_MS = 5000;
const CONNECT_POLLS = 24;
const LEAVE_MS = 10_000;

async function recordFailure(db: Db, code: SyncErrorCode): Promise<void> {
  await setMeta(db, META.lastSyncError, code);
  db.notifyChanged({ source: 'remote' });
}

/** Binds this device's records to the first account that syncs them and refuses any other, so two accounts never mix. */
async function checkAccount(db: Db, account: string | null): Promise<void> {
  if (!account) return;
  const bound = await getMeta(db, META.account);
  if (!bound) await setMeta(db, META.account, account);
  else if (bound !== account) throw new SyncError('other_account');
}

export function createSyncRunner(deps: {
  db: Db;
  clock: Clock;
  lifecycle: { onForeground(listener: () => void): () => void };
  /** Calls back when the connection comes back, so what was kept offline goes then, as Settings says it will. */
  onOnline?(listener: () => void): () => void;
  send: SyncSend;
  /** Runs after each sync that worked, such as uploading what the server now has the records for. Never stops a sync. */
  afterSync?(): Promise<void>;
  /** Calls back when the computer wakes from sleep or its screen unlocks. Only on the Mac. */
  onWake?(listener: () => void): () => void;
  /**
   * Once a sync finds an account deleted, the one the token named, signs out and erases this device's copy if it's that
   * account's. Resolves to whether it erased.
   */
  onAccountDeleted?(account: string | null): Promise<boolean>;
}) {
  const { db, clock, lifecycle, send } = deps;
  let running: Promise<void> | null = null;
  let again = false;
  let cleanup: (() => void) | null = null;
  let launched = false;

  /** Expiry never stops a sync: what it misses now, it does next time. */
  const expire = (work: () => Promise<unknown>) => work().catch((err: unknown) => console.error('Expiry failed', err));

  async function syncOnce(): Promise<void> {
    if (!launched) {
      launched = true;
      await expire(async () => {
        await backfillExpiry(db, clock);
        await expireLocal(db, clock);
      });
    }
    // sync.pull ends when a screen draws what this brought (ui/app/store.tsx), unless it brought nothing.
    perf.start('sync.pull');
    try {
      await rebaseClocks(db, clock);
      if ((await runSync(db, send)) === 0) perf.cancel('sync.pull');
      await db.transaction(async (tx) => {
        await setMeta(tx, META.lastSyncAt, nowInstant(clock));
        await tx.run('DELETE FROM meta WHERE key = :key', { key: META.lastSyncError });
      });
      db.notifyChanged({ source: 'remote' });
    } catch (err) {
      perf.cancel('sync.pull');
      if (!(err instanceof SyncError)) console.error('Sync failed', err);
      let code = err instanceof SyncError ? err.code : 'error';
      if (code === 'account_deleted' && deps.onAccountDeleted) {
        const erased = await deps.onAccountDeleted((err as SyncError).account).catch((e: unknown) => (console.error('Erasing a deleted account failed', e), true));
        // Another account's, signed in here and refused: this device's own account is still there, so it's only signed out.
        if (!erased) code = 'sign_in_expired';
      }
      // Signed out with its account deleted, it says so until someone signs in, rather than just signed out.
      if (code === 'sign_in_expired' && (await getMeta(db, META.lastSyncError).catch(() => null)) === 'account_deleted') return;
      await recordFailure(db, code).catch((e: unknown) => console.error('Could not record sync failure', e));
      return;
    }
    // Only once a pull has reached the end, so no note it brings can still be on its way.
    await expire(() => sweepOrphans(db, clock));
    await expire(() => expireLocal(db, clock));
    await deps.afterSync?.().catch((err: unknown) => console.error('After sync failed', err));
  }

  /** Runs a sync, or one more after the current one, so an edit made during a sync isn't left waiting. Never rejects. */
  function syncNow(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await syncOnce();
      } while (again);
      running = null;
    })();
    return running;
  }

  return {
    syncNow,
    start(): void {
      void syncNow();
      let editTimer: ReturnType<typeof setTimeout> | undefined;
      const period = setInterval(() => void syncNow(), PERIOD_MS);
      const stopForeground = lifecycle.onForeground(() => void syncNow());
      const stopOnline = deps.onOnline?.(() => void syncNow()) ?? (() => {});
      const stopChanges = db.subscribe((change) => {
        if (change.source !== 'local') return;
        // sync.push runs from the first change the next push carries.
        if (perf.pending('sync.push') === undefined) perf.start('sync.push');
        clearTimeout(editTimer);
        editTimer = setTimeout(() => void syncNow(), EDIT_DELAY_MS);
      });
      const stopWake = deps.onWake?.(() => void syncNow()) ?? (() => {});
      cleanup = () => {
        clearTimeout(editTimer);
        clearInterval(period);
        stopForeground();
        stopOnline();
        stopChanges();
        stopWake();
      };
    },
    stop(): void {
      cleanup?.();
      cleanup = null;
    },
  };
}

export type AppSync = ReturnType<typeof startAppSync>;

/** A PUT of a file to a granted link, by fetch, reporting it all sent at the end. */
const fetchPut =
  (fetchFn: FetchFn): FilesApi['put'] =>
  async (url, headers, body, progress) => {
    const res = await fetchFn(url, { method: 'PUT', headers, body });
    if (res.ok) progress(body.size);
    return res.status;
  };

/** A PUT of a file to a granted link, reporting the bytes sent as they go. Rejects when offline. */
const xhrPut: FilesApi['put'] = (url, headers, body, progress) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    // The browser sets Content-Length from the body itself; the signature already holds it.
    for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() !== 'content-length') xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => progress(event.loaded);
    xhr.onload = () => resolve(xhr.status);
    xhr.onerror = () => reject(new SyncError('offline'));
    xhr.ontimeout = () => reject(new SyncError('offline'));
    xhr.send(body);
  });

/** Sign-in and sync for the running app, on whatever device it's on. Settings and first-run setup use this. */
export function startAppSync(
  platform: {
    db: Db;
    tokens: Parameters<typeof createAuth>[0]['tokens'];
    lifecycle: { onForeground(listener: () => void): () => void; onLeave?(listener: () => void): () => void };
    openExternal(url: string): Promise<void>;
    signInRedirectUri: string;
    onDeepLink(listener: (url: string) => void): () => void;
    onWake?(listener: () => void): () => void;
    notifications: { replaceAll(reminders: readonly Reminder[]): Promise<void> };
    shareImport?: { peek(): Promise<{ id: string }[]>; remove(ids: string[]): Promise<void> };
    files: FileBytes & { clear(): Promise<void> };
    kind?: string;
    diagnostics?: Diagnostics;
  },
  clock: Clock,
  config: AppConfig,
  /**
   * updates is the app's updater, whose checks telemetry reports. forget erases what screens keep on this device, such as
   * a plan in progress, when the account it belongs to is deleted.
   */
  options: { fetch?: FetchFn; updates?: Updater; forget?: () => void } = {},
) {
  // WebKit refuses a request started while the page unloads, before the next page shows, and logs it as an error the
  // page can't catch ("due to access control checks"). So none starts then: each fails as offline, as one the unload
  // cancels does. Not every start of an unload ends in one, as with a link that downloads, so it lasts LEAVE_MS.
  let leaving: ReturnType<typeof setTimeout> | undefined;
  const stopLeave = platform.lifecycle.onLeave?.(() => {
    clearTimeout(leaving);
    leaving = setTimeout(() => (leaving = undefined), LEAVE_MS);
  });
  const whileHere =
    <A extends unknown[], R>(request: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      leaving === undefined ? request(...args) : Promise.reject(new SyncError('offline'));
  // Wrapped because the browser's fetch fails when called as a method of another object.
  const fetchFn: FetchFn = whileHere(options.fetch ?? ((url, init) => fetch(url, init)));
  const auth = createAuth({
    authUrl: config.authUrl,
    clientId: config.authClientId,
    redirectUri: platform.signInRedirectUri,
    clock,
    tokens: platform.tokens,
    openExternal: (url) => platform.openExternal(url),
    fetch: fetchFn,
    accountGone: async (token) => {
      const res = await fetchFn(`${config.apiUrl}/account/status`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
      return res.ok && ((await res.json().catch(() => null)) as { deleted?: unknown } | null)?.deleted === true;
    },
  });
  const api = { apiUrl: config.apiUrl, auth, fetch: fetchFn };
  const httpSend = createHttpSend(api);
  // Before every request, since signing out and in can change the account between syncs.
  const send: SyncSend = async (request) => {
    await checkAccount(platform.db, tokenSubject(await auth.accessToken()));
    return httpSend(request);
  };
  const filesApi: FilesApi = {
    usage: () => apiRequest(api, 'GET', '/files/usage'),
    grantUpload: (id) => apiPost(api, '/files/upload', { id }),
    grantDownloads: (ids) => apiPost(api, '/files/download', { ids }),
    // The page's own request where there is one, for the progress a row shows; fetch, with no progress, elsewhere.
    put: options.fetch || typeof XMLHttpRequest === 'undefined' ? fetchPut(fetchFn) : whileHere(xhrPut),
    get: async (url) => {
      const res = await fetchFn(url, {});
      if (!res.ok) throw new SyncError('error');
      return res.blob();
    },
  };
  const files = createFiles({ db: platform.db, clock, store: platform.files, api: filesApi });
  // The page's online event, which browsers, Electron and iPhone's web view all fire. Tests of this file run without one.
  const onOnline = (listener: () => void) => {
    if (typeof window === 'undefined') return () => {};
    window.addEventListener('online', listener);
    return () => window.removeEventListener('online', listener);
  };
  /** Erases this device's copy of the account it holds: records, outbox, sync state, files, shared text and reminders. */
  const eraseLocal = async (account: string | null) => {
    const { db } = platform;
    await db.transaction(async (tx) => {
      await tx.run('DELETE FROM records');
      await tx.run('DELETE FROM outbox');
      await tx.run('DELETE FROM meta WHERE key NOT IN (:schema, :minApp, :device)', {
        schema: META.schemaVersion,
        minApp: META.minAppSchema,
        device: META.deviceId,
      });
      if (account) await setMeta(tx, META.account, account);
    });
    db.notifyChanged({ source: 'remote' });
    await platform.files.clear();
    const share = platform.shareImport;
    if (share) await share.remove((await share.peek()).map((item) => item.id));
    // shortcut: notifications already showing stay in Notification Center until dismissed, and do nothing when
    // tapped; remove delivered ones too if that matters.
    await platform.notifications.replaceAll([]);
  };
  /**
   * A deleted account: signed out, and nothing of it left here. Only the account this device's data belongs to is erased;
   * another's, as of a sign-in here that sync refused, leaves the data alone.
   */
  const eraseDeleted = async (account: string | null): Promise<boolean> => {
    await auth.expire();
    if (!account || account !== (await getMeta(platform.db, META.account))) return false;
    await eraseLocal(null);
    options.forget?.();
    return true;
  };
  // An export's link is only ever to the files host: https, except the local stack's stand-in.
  const filesBase = config.filesUrl ?? `${config.apiUrl}/edge`;
  const isFilesLink = (url: string) => url.startsWith(`${filesBase}/`) && (url.startsWith('https://') || config.env === 'local');
  const runner = createSyncRunner({
    db: platform.db,
    clock,
    lifecycle: platform.lifecycle,
    onOnline,
    send,
    afterSync: () => files.run(),
    onWake: platform.onWake,
    onAccountDeleted: eraseDeleted,
  });
  const calendarPost = async (path: string) => {
    const res = await apiPost(api, path);
    if (!res.ok) throw new SyncError('error');
    return res;
  };
  const signingIn = async (on: boolean) => {
    if (on) await setMeta(platform.db, META.signingIn, '1');
    else await platform.db.run('DELETE FROM meta WHERE key = :key', { key: META.signingIn });
    platform.db.notifyChanged({ source: 'remote' });
  };
  // One an app closed during would otherwise show as under way for good.
  void signingIn(false);
  const stopLinks = platform.onDeepLink((url) => {
    // A callback with a code is under way until its first sync lands, which brings the account's data.
    const callback = url.startsWith(`${platform.signInRedirectUri}?`);
    void (async () => {
      if (callback) await signingIn(true);
      try {
        if (await auth.handleRedirect(url)) await runner.syncNow();
      } catch (err) {
        console.error('Sign-in failed', err);
        await recordFailure(platform.db, 'sign_in_failed');
      } finally {
        if (callback) await signingIn(false);
      }
    })();
  });
  // The connection, then the calendars Google has, arrive by sync, so look often while the person is on Google's page.
  let connectPoll: ReturnType<typeof setInterval> | undefined;
  const pollForConnection = () => {
    clearInterval(connectPoll);
    let left = CONNECT_POLLS;
    connectPoll = setInterval(async () => {
      const connected = (await getRecord(platform.db, 'calendar', CALENDAR_ID))?.connected;
      if (left-- <= 0 || (connected && (await listRecords(platform.db, 'calendar_source')).length)) clearInterval(connectPoll);
      else void runner.syncNow();
    }, CONNECT_POLL_MS);
  };
  runner.start();
  // How the app runs, for finding problems on real devices: loaded after startup, so the OTel SDK never delays it. Only
  // in a page: tests of this file run without one.
  let telemetry: { stop(): void } | undefined;
  let stopped = false;
  if (typeof window !== 'undefined') {
    void Promise.all([getMeta(platform.db, META.deviceId), import('./telemetry')])
      .then(async ([device, { startTelemetry }]) => {
        if (stopped) return;
        const started = await startTelemetry({
          url: `${config.apiUrl}/v1/logs`,
          headers: async () => ({ authorization: `Bearer ${await auth.accessToken()}` }),
          now: () => clock.now(),
          resource: {
            'service.name': 'multiscale-app',
            ...(config.version ? { 'service.version': config.version } : {}),
            'os.name': platform.kind ?? 'web',
            'app.platform': platform.kind === 'ios' ? 'mobile' : platform.kind === 'electron' ? 'desktop' : 'web',
            'deployment.environment.name': config.env,
            'session.id': crypto.randomUUID(),
            ...(device ? { 'device.id': device } : {}),
          },
          ...(platform.diagnostics ? { diagnostics: platform.diagnostics } : {}),
          ...(options.updates ? { updates: options.updates } : {}),
          screen: () => document.documentElement.dataset.screen,
          target: window,
        });
        if (stopped) started.stop();
        else telemetry = started;
      })
      // Its module fails to load when the page unloads first, which is no fault.
      .catch((err: unknown) => {
        if (leaving === undefined) console.error('Telemetry did not start', err);
      });
  }
  const accountRequest = (method: 'GET' | 'POST', path: string, body?: unknown) => apiRequest(api, method, path, body);
  return {
    /** again asks the person to sign in even if the browser still is, as deleting the account needs. */
    signIn: (options?: { again?: boolean }) => auth.signIn(options),
    /** When the person last signed in, in epoch milliseconds, or null when signed out. */
    signedInAt: () => auth.signedInAt(),
    /** Signs this device out, and shows the sign-in prompt. Local data and the outbox stay, and stay this account's. */
    async signOut(): Promise<void> {
      await auth.signOut();
      await runner.syncNow();
    },
    /** The signed-in account's email, for asking before its sign-in erases another account's data here. */
    email: () => auth.email(),
    /**
     * For a sign-in refused as another account's: erases this device's data, which is the other account's, makes the
     * device the signed-in account's, and syncs to bring its data. Throws, erasing nothing, if no one is signed in.
     */
    async eraseAndSignIn(): Promise<void> {
      const account = tokenSubject(await auth.accessToken());
      if (!account) throw new SyncError('error');
      // A sync that read the old data before the erase must not send it once the device is this account's. So none
      // starts, and any under way finishes first, refused like every sync since this sign-in.
      runner.stop();
      try {
        await runner.syncNow();
        // The other account's photos and files too.
        await eraseLocal(account);
      } finally {
        // Syncs straight away, which brings the signed-in account's data.
        runner.start();
      }
    },
    syncNow: runner.syncNow,
    /** The link to an export of everything the account has, once the server has built it. Throws ExportError or SyncError. */
    exportData: () => exportData({ request: accountRequest, wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), isFilesLink }),
    /**
     * The account Delete would delete: whether the sign-in is the account this device's data belongs to, and then its
     * email. Signed in again as another, it's not, nothing may be deleted here, and the other account isn't named.
     */
    async deletionTarget(): Promise<{ sameAccount: boolean; email: string | null }> {
      const account = await getMeta(platform.db, META.account);
      const signedIn = await auth.accessToken().then(tokenSubject, () => null);
      const sameAccount = !!account && signedIn === account;
      return { sameAccount, email: sameAccount ? await auth.email() : null };
    },
    /**
     * Deletes the account this device's data belongs to, once the person has typed DELETE, then erases this device's copy
     * and signs it out. Resolves to 'sign_in_again' when their sign-in is too old for it, and 'wrong_account' when it's
     * another account's, changing nothing either way. Throws SyncError.
     */
    async deleteAccount(): Promise<'deleted' | 'sign_in_again' | 'wrong_account'> {
      const account = await getMeta(platform.db, META.account);
      if (!account || tokenSubject(await auth.accessToken()) !== account) return 'wrong_account';
      const answer = await deleteAccount(accountRequest, account);
      if (answer !== 'deleting') return answer;
      // The next sync is refused as deleted, which erases this device's copy. It runs after any sync under way, so
      // nothing that one pulls comes back after the erase.
      await runner.syncNow();
      if ((await getMeta(platform.db, META.lastSyncError)) !== 'account_deleted') {
        await eraseDeleted(account);
        await recordFailure(platform.db, 'account_deleted');
      }
      return 'deleted';
    },
    /** Attachments' uploads and downloads, through the API. */
    files,
    /** Opens Google's consent page in the browser. The connection arrives in the calendar record by sync. */
    async connectCalendar(): Promise<void> {
      const body = (await (await calendarPost('/calendar/connect')).json().catch(() => null)) as { url?: unknown } | null;
      // Only a web page: a link to another app's scheme from a bad response must not be opened.
      if (typeof body?.url !== 'string' || !/^https?:\/\//.test(body.url)) throw new SyncError('error');
      await platform.openExternal(body.url);
      pollForConnection();
    },
    /** Ends the Google connection, then syncs to bring back the calendar record that says so. Throws SyncError. */
    async disconnectCalendar(): Promise<void> {
      clearInterval(connectPoll);
      await calendarPost('/calendar/disconnect');
      await runner.syncNow();
    },
    /** Asks the server to read calendars now, then syncs to bring back what it found. Throws SyncError. */
    async refreshCalendar(): Promise<void> {
      await calendarPost('/calendar/refresh');
      await runner.syncNow();
    },
    stop(): void {
      stopped = true;
      telemetry?.stop();
      clearInterval(connectPoll);
      stopLinks();
      stopLeave?.();
      clearTimeout(leaving);
      runner.stop();
    },
  };
}
