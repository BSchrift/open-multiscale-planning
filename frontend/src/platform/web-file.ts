// The browser build's IndexedDB store, which the page and the OPFS worker (opfs.worker.ts) both open. It holds sign-in,
// and the database file: where a browser without OPFS keeps its data, and the copy kept for a bundle from before OPFS.

export const STORE = 'files';
/** The whole database file. Bundles from before OPFS read only this. */
export const FILE = 'multiscale.sqlite';
/** The SHA-256 of FILE as this bundle last wrote or imported it. Any other value means an older bundle wrote FILE since. */
export const FILE_HASH = 'multiscale.sqlite.sha256';

export function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('multiscale-dev', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function get<T>(key: string): Promise<T | undefined> {
  const files = (await openStore()).transaction(STORE).objectStore(STORE);
  return new Promise((resolve, reject) => {
    const request = files.get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

/** Writes every value in one transaction, and resolves once it has committed. */
export async function put(values: Record<string, unknown>): Promise<void> {
  const tx = (await openStore()).transaction(STORE, 'readwrite');
  for (const [key, value] of Object.entries(values)) tx.objectStore(STORE).put(value, key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
