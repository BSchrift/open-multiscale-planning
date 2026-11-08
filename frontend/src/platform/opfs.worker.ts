// The web app's database: SQLite on the origin private file system (OPFS), so a change is on disk once it commits, and
// costs the same however long the history. Only a worker gets the synchronous file access SQLite needs, so the page
// (web.ts) sends it each statement by message. It uses SQLite's SyncAccessHandle pool VFS, which needs no cross-origin
// isolation headers, unlike its plain opfs VFS. The pool's files open in one worker at a time, and web.ts's lock across
// tabs keeps that to this one.

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Database, SAHPoolUtil, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import wasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url';
import type { SqlDriver, SqlValue } from '../core/db';
import { sqliteWasmDriver } from './sqlite-wasm-driver';
import { FILE, FILE_HASH, get, put, sha256 } from './web-file';

/** open answers false where this browser can't give SQLite synchronous access to OPFS, and nothing else is sent. */
export type OpfsCall = { op: 'open' } | { op: 'exec'; sql: string } | { op: 'all' | 'run'; sql: string; values: SqlValue[] } | { op: 'close' };
export type OpfsRequest = OpfsCall & { id: number };
/** Every request gets one, with its id. */
export type OpfsResponse = { id: number; result?: unknown; error?: { name: string; message: string } };

const NAME = '/multiscale.sqlite';

let sqlite3: Sqlite3Static;
let pool: SAHPoolUtil;
let db: Database;
let driver: SqlDriver;

/**
 * Safari before 16.4 has access handles whose methods are async, which the pool can't use, and Safari's private windows
 * have no OPFS at all.
 */
async function syncAccess(): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory();
    const name = `.multiscale-check-${crypto.randomUUID()}`;
    // The app is typed as a page, and a page has no sync access handles.
    const file = (await root.getFileHandle(name, { create: true })) as unknown as { createSyncAccessHandle(): Promise<{ close(): unknown }> };
    const closed = (await file.createSyncAccessHandle()).close();
    await closed;
    await root.removeEntry(name);
    return !(closed instanceof Promise);
  } catch {
    return false;
  }
}

/**
 * A reload can get here before the page it replaces has let go of the pool, so this tries for 3 seconds. Without
 * preserveOnInitFailure, a failed try deletes the pool, and every database in it.
 */
async function installPool(): Promise<SAHPoolUtil> {
  const options = { preserveOnInitFailure: true, forceReinitIfPreviouslyFailed: true };
  for (let tries = 1; ; tries++) {
    try {
      return await sqlite3.installOpfsSAHPoolVfs(options);
    } catch (err) {
      if (tries === 15) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function open(): Promise<boolean> {
  if (!(await syncAccess())) return false;
  // The bundler's URL for the WebAssembly, which the library would otherwise look for beside itself.
  sqlite3 = await (sqlite3InitModule as unknown as (module: { locateFile(): string }) => Promise<Sqlite3Static>)({ locateFile: () => wasmUrl });
  pool = await installPool();
  // The file a bundle from before OPFS kept, the first time, or when that bundle has changed it since this one's copy:
  // after a rollback and an update again. A failed import is tried again next time, since FILE_HASH is set only after.
  const file = await get<Uint8Array<ArrayBuffer>>(FILE).catch(() => undefined);
  if (file?.byteLength) {
    const hash = await sha256(file);
    if (!pool.getFileNames().includes(NAME) || hash !== (await get(FILE_HASH))) {
      // A journal an interrupted write left behind belongs to the database being replaced.
      pool.unlink(`${NAME}-journal`);
      await pool.importDb(NAME, file);
      await put({ [FILE_HASH]: hash });
    }
  }
  db = new pool.OpfsSAHPoolDb(NAME);
  driver = sqliteWasmDriver(db);
  copied = changes();
  return true;
}

// shortcut: every change is copied, as a whole file, to IndexedDB 200ms later, so the bundle before this one finds it
// after a rollback; that costs what each save did before OPFS, but in this worker rather than on the page. Drop the copy
// and the FILE_HASH check once no browser can go back to a bundle from before OPFS, and keep the first import of FILE
// for browsers that skip this release.
let copied = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let copying = Promise.resolve();
const changes = () => Number(db.changes(true));

function copySoon() {
  if (changes() === copied) return;
  clearTimeout(timer);
  timer = setTimeout(() => (copying = copying.then(copy)), 200);
}

async function copy() {
  // Never inside a transaction, when the file can hold pages that aren't committed.
  if (!sqlite3.capi.sqlite3_get_autocommit(db)) return copySoon();
  copied = changes();
  const bytes = pool.exportFile(NAME) as Uint8Array<ArrayBuffer>;
  try {
    await put({ [FILE]: bytes, [FILE_HASH]: await sha256(bytes) });
  } catch (err) {
    console.warn("Couldn't copy the database to IndexedDB", err);
  }
}

async function close() {
  clearTimeout(timer);
  await copying;
  if (changes() !== copied) await copy();
  await driver.close();
}

async function answer(call: OpfsCall): Promise<unknown> {
  switch (call.op) {
    case 'open':
      return open();
    case 'exec':
      return driver.exec(call.sql);
    case 'all':
      return driver.all(call.sql, call.values);
    case 'run':
      return driver.run(call.sql, call.values);
    case 'close':
      return close();
  }
}

// Typed as a page, as above: these are a worker's globals.
const scope = self as unknown as { onmessage: (event: MessageEvent<OpfsRequest>) => void; postMessage(response: OpfsResponse): void };

scope.onmessage = async ({ data }) => {
  try {
    const result = await answer(data);
    if (data.op !== 'open' && data.op !== 'close') copySoon();
    scope.postMessage({ id: data.id, result });
  } catch (err) {
    const { name, message } = err instanceof Error ? err : new Error(String(err));
    scope.postMessage({ id: data.id, error: { name, message } });
  }
};
