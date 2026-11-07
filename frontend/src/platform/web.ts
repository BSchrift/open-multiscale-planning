// The browser build: the web app on the environment's zone, `vite dev` and Playwright screens. Its database and sign-in
// live in IndexedDB between reloads.
// shortcut: reminders are in-memory, so the web app never notifies; use the Notifications API if it should.

import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { openDb } from '../core/db';
import { deepLinks, memoryLifecycle, memoryNotifications } from './memory';
import { sqlJsDriver } from './sqljs-driver';
import type { Platform } from './types';

const STORE = 'files';
const KEY = 'multiscale.sqlite';

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('multiscale-dev', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadFile(): Promise<Uint8Array | undefined> {
  try {
    const store = await openStore();
    return await new Promise((resolve, reject) => {
      const request = store.transaction(STORE).objectStore(STORE).get(KEY);
      request.onsuccess = () => resolve(request.result as Uint8Array | undefined);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return undefined;
  }
}

async function saveFile(bytes: Uint8Array): Promise<void> {
  try {
    const store = await openStore();
    store.transaction(STORE, 'readwrite').objectStore(STORE).put(bytes, KEY);
  } catch {
    // Private windows can block IndexedDB; the app then simply starts empty on reload.
  }
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

/** Holds the database for this tab until it closes. False when another tab holds it. */
function holdDatabase(): Promise<boolean> {
  return new Promise((resolve) => {
    void navigator.locks.request('multiscale.db', { ifAvailable: true }, (lock) => {
      resolve(lock !== null);
      return lock ? new Promise<void>(() => {}) : undefined;
    });
  });
}

export async function createWebPlatform(): Promise<Platform> {
  const signInRedirectUri = `${location.origin}/auth/callback`;
  const links = deepLinks();
  // Never resolves in a tab that only carried a sign-in back, so it never opens the database the app's tab writes.
  if (relaySignIn({ redirectUri: signInRedirectUri, url: location.href, closeTab: () => window.close(), onLink: links.open })) return new Promise(() => {});
  // Each tab keeps the whole database in memory and saves all of it, so a second tab would overwrite the first's edits.
  if (!(await holdDatabase())) {
    throw Object.assign(new Error('Multiscale is open in another tab. Use that one, or close it and reload this one.'), { name: 'InAnotherTab' });
  }

  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const sqlite = new SQL.Database(await loadFile());
  const db = await openDb(sqlJsDriver(sqlite));

  let timer: ReturnType<typeof setTimeout> | undefined;
  db.subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(() => void saveFile(sqlite.export()), 200);
  });

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
