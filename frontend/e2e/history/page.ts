// Bundled by history.ts and evaluated in the app's page: times Today and Week on the database the app itself reads.

import initSqlJs from 'sql.js';
import type { ElectronBridge } from '../../electron/bridge';
import { createDb } from '../../src/core/db';
import { timeHistoryQueries } from '../../src/platform/history-checks';
import { sqlJsDriver } from '../../src/platform/sqljs-driver';
import type { HistoryPage } from './history';

/** The database file the web app last saved, from where src/platform/web.ts keeps it. */
function savedDatabase(): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('multiscale-dev', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const get = open.result.transaction('files').objectStore('files').get('multiscale.sqlite');
      get.onerror = () => reject(get.error);
      get.onsuccess = () => (get.result ? resolve(get.result as Uint8Array) : reject(new Error('The web app has saved no database')));
    };
  });
}

const history: HistoryPage['multiscaleHistory'] = {
  async web(wasmBase64) {
    const SQL = await initSqlJs({ wasmBinary: Uint8Array.from(atob(wasmBase64), (c) => c.charCodeAt(0)).buffer });
    return timeHistoryQueries(createDb(sqlJsDriver(new SQL.Database(await savedDatabase()))));
  },
  // The same bridge the app's Db wraps, so each statement crosses to the main process as the app's do.
  electron: () => timeHistoryQueries(createDb({ ...(window.multiscaleElectron as ElectronBridge).db, close: async () => undefined })),
};
Object.assign(globalThis, { multiscaleHistory: history });
