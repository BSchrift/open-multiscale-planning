// Attachments' bytes kept on this device, in IndexedDB, which the page has on the web, in the Mac app and on iPhone: a
// photo added here until it has uploaded, and any file once it has downloaded, so each is fetched once per device.

import type { FileStore } from './types';

const DB = 'multiscale-attachments';
const STORE = 'files';

let opened: Promise<IDBDatabase> | null = null;
const open = () =>
  (opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opened = null;
      reject(request.error);
    };
  }));

async function run<T>(mode: IDBTransactionMode, act: (files: IDBObjectStore) => IDBRequest): Promise<T> {
  const tx = (await open()).transaction(STORE, mode);
  const request = act(tx.objectStore(STORE));
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(request.result as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const indexedDbFiles: FileStore = {
  get: async (id) => (await run<Blob | undefined>('readonly', (files) => files.get(id))) ?? null,
  put: async (id, file) => void (await run('readwrite', (files) => files.put(file, id))),
  remove: async (id) => void (await run('readwrite', (files) => files.delete(id))),
  clear: async () => void (await run('readwrite', (files) => files.clear())),
};
