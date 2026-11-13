// Bundled by history.ts and evaluated in the app's page: times Today, Week and Done on the database the app itself reads.

import type { ElectronBridge } from '../../electron/bridge';
import { createDb } from '../../src/core/db';
import type { SqlDriver } from '../../src/core/db';
import type { OpfsCall, OpfsResponse } from '../../src/platform/opfs.worker';
import { timeHistoryQueries } from '../../src/platform/history-checks';
import type { HistoryPage } from './history';

/**
 * The web app's database, through the worker that holds it on OPFS (src/platform/opfs.worker.ts), which web.spec.ts
 * keeps as the app starts it. Each statement goes there and back as the app's do, with ids below 0, which the app's
 * own requests never use.
 */
function appDatabase(): SqlDriver {
  const worker = (window as unknown as { historyWorker?: Worker }).historyWorker;
  if (!worker) throw new Error('The web app started no database worker, so its database is not on OPFS');
  let next = -1;
  const call = <T>(request: OpfsCall) =>
    new Promise<T>((resolve, reject) => {
      const id = next--;
      const answer = ({ data }: MessageEvent<OpfsResponse>) => {
        if (data.id !== id) return;
        worker.removeEventListener('message', answer);
        if (data.error) reject(new Error(data.error.message));
        else resolve(data.result as T);
      };
      worker.addEventListener('message', answer);
      worker.postMessage({ ...request, id });
    });
  return {
    exec: (sql) => call({ op: 'exec', sql }),
    all: (sql, values) => call({ op: 'all', sql, values }),
    run: (sql, values) => call({ op: 'run', sql, values }),
    close: async () => undefined,
  };
}

const history: HistoryPage['multiscaleHistory'] = {
  web: () => timeHistoryQueries(createDb(appDatabase())),
  // The same bridge the app's Db wraps, so each statement crosses to the main process as the app's do.
  electron: () => timeHistoryQueries(createDb({ ...(window.multiscaleElectron as ElectronBridge).db, close: async () => undefined })),
};
Object.assign(globalThis, { multiscaleHistory: history });
