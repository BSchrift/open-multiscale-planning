// Decides when to sync: at launch, on returning to the foreground, 2 seconds after an edit, every 5 minutes while
// open, and every 5 seconds for 2 minutes after Google's consent page opens. The result goes in the meta table, so Settings reads it with syncStatus like any other query, and it
// survives a restart. A failed sync changes nothing but that status: the outbox keeps everything for next time.
//
// There's no paused state to manage. Once a sign-in has expired the tokens are gone, so each trigger fails at once
// without any network traffic, and the next sync after signing in again carries on from the outbox.
//
// Before the first sync it fills in missing expiries and removes what has expired here, and after each sync it removes
// what has expired again (expiry.ts).

import type { AppConfig } from './appConfig';
import { createAuth, tokenSubject } from './auth';
import type { Clock } from './clock';
import { nowInstant } from './dates';
import { getMeta, META, setMeta } from './db';
import type { Db } from './db';
import { backfillExpiry, expireLocal } from './expiry';
import { CALENDAR_ID, getRecord, listRecords, rebaseClocks } from './records';
import type { Diagnostics } from './telemetry';
import { apiPost, createHttpSend, runSync, SyncError } from './sync';
import type { FetchFn, SyncErrorCode, SyncSend } from './sync';
import type { Reminder } from './types';
import type { Updater } from './updates';

const EDIT_DELAY_MS = 2000;
const PERIOD_MS = 5 * 60_000;
const CONNECT_POLL_MS = 5000;
const CONNECT_POLLS = 24;

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
  send: SyncSend;
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
    try {
      await rebaseClocks(db, clock);
      await runSync(db, send);
      await db.transaction(async (tx) => {
        await setMeta(tx, META.lastSyncAt, nowInstant(clock));
        await tx.run('DELETE FROM meta WHERE key = :key', { key: META.lastSyncError });
      });
      db.notifyChanged({ source: 'remote' });
    } catch (err) {
      if (!(err instanceof SyncError)) console.error('Sync failed', err);
      await recordFailure(db, err instanceof SyncError ? err.code : 'error').catch((e: unknown) => console.error('Could not record sync failure', e));
      return;
    }
    await expire(() => expireLocal(db, clock));
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
      const stopChanges = db.subscribe((change) => {
        if (change.source !== 'local') return;
        clearTimeout(editTimer);
        editTimer = setTimeout(() => void syncNow(), EDIT_DELAY_MS);
      });
      cleanup = () => {
        clearTimeout(editTimer);
        clearInterval(period);
        stopForeground();
        stopChanges();
      };
    },
    stop(): void {
      cleanup?.();
      cleanup = null;
    },
  };
}

export type AppSync = ReturnType<typeof startAppSync>;

/** Sign-in and sync for the running app, on whatever device it's on. Settings and first-run setup use this. */
export function startAppSync(
  platform: {
    db: Db;
    tokens: Parameters<typeof createAuth>[0]['tokens'];
    lifecycle: { onForeground(listener: () => void): () => void };
    openExternal(url: string): Promise<void>;
    signInRedirectUri: string;
    onDeepLink(listener: (url: string) => void): () => void;
    notifications: { replaceAll(reminders: readonly Reminder[]): Promise<void> };
    shareImport?: { peek(): Promise<{ id: string }[]>; remove(ids: string[]): Promise<void> };
    kind?: string;
    diagnostics?: Diagnostics;
  },
  clock: Clock,
  config: AppConfig,
  /** updates is the app's updater, whose checks telemetry reports. */
  options: { fetch?: FetchFn; updates?: Updater } = {},
) {
  // Wrapped because the browser's fetch fails when called as a method of another object.
  const fetchFn: FetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  const auth = createAuth({
    authUrl: config.authUrl,
    clientId: config.authClientId,
    redirectUri: platform.signInRedirectUri,
    clock,
    tokens: platform.tokens,
    openExternal: (url) => platform.openExternal(url),
    fetch: fetchFn,
  });
  const api = { apiUrl: config.apiUrl, auth, fetch: fetchFn };
  const httpSend = createHttpSend(api);
  // Before every request, since signing out and in can change the account between syncs.
  const send: SyncSend = async (request) => {
    await checkAccount(platform.db, tokenSubject(await auth.accessToken()));
    return httpSend(request);
  };
  const runner = createSyncRunner({ db: platform.db, clock, lifecycle: platform.lifecycle, send });
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
    void Promise.all([getMeta(platform.db, META.deviceId), import('./telemetry')]).then(async ([device, { startTelemetry }]) => {
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
    });
  }
  return {
    signIn: () => auth.signIn(),
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
      const { db } = platform;
      // A sync that read the old data before the erase must not send it once the device is this account's. So none
      // starts, and any under way finishes first, refused like every sync since this sign-in.
      runner.stop();
      try {
        await runner.syncNow();
        await db.transaction(async (tx) => {
          await tx.run('DELETE FROM records');
          await tx.run('DELETE FROM outbox');
          await tx.run('DELETE FROM meta WHERE key NOT IN (:schema, :minApp, :device)', {
            schema: META.schemaVersion,
            minApp: META.minAppSchema,
            device: META.deviceId,
          });
          await setMeta(tx, META.account, account);
        });
        db.notifyChanged({ source: 'remote' });
        const share = platform.shareImport;
        if (share) await share.remove((await share.peek()).map((item) => item.id));
        // shortcut: notifications already showing stay in Notification Center until dismissed, and do nothing when
        // tapped; remove delivered ones too if that matters.
        await platform.notifications.replaceAll([]);
      } finally {
        // Syncs straight away, which brings the signed-in account's data.
        runner.start();
      }
    },
    syncNow: runner.syncNow,
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
      runner.stop();
    },
  };
}
