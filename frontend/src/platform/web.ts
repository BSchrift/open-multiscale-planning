// The browser build: the web app on the environment's zone, `vite dev` and Playwright screens. Its database is SQLite on
// the origin private file system (OPFS), in a worker (opfs.worker.ts), so each change is on disk once it commits. Where
// the browser can't run that, as in Safari's private windows, it's sql.js in memory, saved whole to IndexedDB after each
// change, as every browser did before OPFS. Sign-in lives in IndexedDB.
// shortcut: reminders are in-memory, so the web app never notifies; use the Notifications API if it should.

import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { openDb } from '../core/db';
import type { SqlDriver } from '../core/db';
import { deepLinks, memoryLifecycle, memoryNotifications } from './memory';
import type { OpfsCall, OpfsResponse } from './opfs.worker';
import { sqlJsDriver } from './sqljs-driver';
import type { Platform } from './types';
import { FILE, get, openStore, put, STORE } from './web-file';

/** SQLite on OPFS, in its worker. Undefined where this browser can't run it. */
async function openOpfs(): Promise<SqlDriver | undefined> {
  if (typeof navigator.storage?.getDirectory !== 'function') return undefined;
  let worker: Worker;
  try {
    worker = new Worker(new URL('./opfs.worker.ts', import.meta.url), { type: 'module' });
  } catch (err) {
    console.warn('Keeping the database in IndexedDB:', err);
    return undefined;
  }
  const waiting = new Map<number, { resolve(result: unknown): void; reject(error: Error): void }>();
  let next = 0;
  let stopped: Error | undefined;
  worker.onmessage = ({ data }: MessageEvent<OpfsResponse>) => {
    const call = waiting.get(data.id);
    waiting.delete(data.id);
    if (data.error) call?.reject(Object.assign(new Error(data.error.message), { name: data.error.name }));
    else call?.resolve(data.result);
  };
  // The worker answers every request, failed or not, so this is one that didn't load or has crashed.
  worker.onerror = (event) => {
    stopped = new Error(`The database worker stopped: ${event.message}`);
    for (const call of waiting.values()) call.reject(stopped);
    waiting.clear();
  };
  const call = <T>(request: OpfsCall) =>
    new Promise<T>((resolve, reject) => {
      if (stopped) return reject(stopped);
      const id = next++;
      waiting.set(id, { resolve: resolve as (result: unknown) => void, reject });
      worker.postMessage({ ...request, id });
    });

  let opened = false;
  try {
    opened = await call<boolean>({ op: 'open' });
  } catch (err) {
    // One that couldn't open the database is a failure. One that never ran, such as a module worker this browser
    // can't load, leaves IndexedDB, which still has a copy (opfs.worker.ts).
    if (!stopped) throw err;
    console.warn('Keeping the database in IndexedDB:', stopped.message);
  }
  if (!opened) {
    worker.terminate();
    return undefined;
  }
  return {
    exec: (sql) => call({ op: 'exec', sql }),
    all: (sql, values) => call({ op: 'all', sql, values }),
    run: (sql, values) => call({ op: 'run', sql, values }),
    close: async () => {
      await call({ op: 'close' });
      worker.terminate();
    },
  };
}

/** sql.js in memory, from the file in IndexedDB, and saved back whole after each change. */
async function openInIndexedDb() {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  // Private windows can block IndexedDB; the app then simply starts empty on reload.
  const sqlite = new SQL.Database(await get<Uint8Array>(FILE).catch(() => undefined));
  const db = await openDb(sqlJsDriver(sqlite));

  // shortcut: a reload or a closed tab within 200ms of an edit loses it, since a browser drops a write started as the page
  // goes, and each save writes the whole file. Only browsers without OPFS take this path.
  let timer: ReturnType<typeof setTimeout> | undefined;
  db.subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(() => void put({ [FILE]: sqlite.export() }).catch(() => undefined), 200);
  });
  return db;
}

/**
 * Sign-in, beside the database rather than in localStorage, which erasing another account's data clears.
 * shortcut: a browser has no keychain, so any script on the page could read it. The host's security policy runs only the
 * app's own scripts. Move the refresh token to an HttpOnly cookie on the API if that's not enough.
 */
async function tokenRequest<T>(mode: IDBTransactionMode, op: (files: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const files = (await openStore()).transaction(STORE, mode).objectStore(STORE);
  return new Promise((resolve, reject) => {
    const request = op(files);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Sign-in returns in the tab openExternal opened, which has none of the app's memory. That tab hands its URL to the
 * app's tab over a same-origin channel and closes. True in that tab; anywhere else, links arrive through onLink.
 */
export function relaySignIn(tab: { redirectUri: string; url: string; closeTab(): void; onLink(url: string): void }): boolean {
  const channel = new BroadcastChannel('multiscale.sign-in');
  if (tab.url.split('?')[0] === tab.redirectUri) {
    channel.postMessage(tab.url);
    tab.closeTab();
    return true;
  }
  channel.onmessage = (event) => tab.onLink(String(event.data));
  return false;
}

/**
 * Holds the database for this tab until it closes. False when another tab still holds it after 3 seconds: a reload asks
 * before the page it replaces has let go.
 */
function holdDatabase(): Promise<boolean> {
  return new Promise((resolve) => {
    navigator.locks
      .request('multiscale.db', { signal: AbortSignal.timeout(3000) }, () => {
        resolve(true);
        return new Promise<void>(() => {});
      })
      .catch(() => resolve(false));
  });
}

export async function createWebPlatform(): Promise<Platform> {
  const signInRedirectUri = `${location.origin}/auth/callback`;
  const links = deepLinks();
  // Never resolves in a tab that only carried a sign-in back, so it never opens the database the app's tab writes.
  if (relaySignIn({ redirectUri: signInRedirectUri, url: location.href, closeTab: () => window.close(), onLink: links.open })) return new Promise(() => {});
  // OPFS's pool opens in one tab at a time, and without it each tab keeps the whole database in memory and saves all of
  // it, so a second tab would overwrite the first's edits.
  if (!(await holdDatabase())) {
    throw Object.assign(new Error('Multiscale is open in another tab. Use that one, or close it and reload this one.'), { name: 'InAnotherTab' });
  }

  const opfs = await openOpfs();
  const db = opfs ? await openDb(opfs) : await openInIndexedDb();

  const lifecycle = memoryLifecycle();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') lifecycle.foreground();
    else lifecycle.background();
  });

  return {
    kind: 'web',
    db,
    notifications: memoryNotifications(),
    tokens: {
      get: async (key) => ((await tokenRequest('readonly', (files) => files.get(`token:${key}`))) as string | undefined) ?? null,
      set: async (key, value) => void (await tokenRequest('readwrite', (files) => files.put(value, `token:${key}`))),
      remove: async (key) => void (await tokenRequest('readwrite', (files) => files.delete(`token:${key}`))),
    },
    lifecycle,
    openExternal: async (url) => void window.open(url, '_blank', 'noopener'),
    signInRedirectUri,
    onDeepLink: links.onDeepLink,
  };
}
