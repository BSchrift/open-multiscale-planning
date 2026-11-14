// Shared by the offline specs: the screens the app loads on first use, cutting the connection, and checking work was
// saved before a reload reads it back.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import type { BrowserContext, Page, Request } from '@playwright/test';
import initSqlJs from 'sql.js';
import type { SqlJsStatic } from 'sql.js';

/** Every screen registry.tsx loads on first use, by the URL the dev server rewrites its import to. */
export const SCREEN_URLS = [...readFileSync(join(import.meta.dirname, '../src/ui/app/registry.tsx'), 'utf8').matchAll(/import\('\.\.\/screens\/([\w-]+)'\)/g)].map(
  ([, area]) => `/src/ui/screens/${area}/index.tsx`,
);

/**
 * Loads every screen's code now, as the app's own lazy imports would, so the page's module map has it and each screen
 * opens offline. It stands in for the app loading its screens in the background, which it doesn't do yet (the first test
 * in offline.spec.ts shows that), so the flows test the flows rather than that.
 * shortcut: once the app loads its screens itself, wait for its requests as that first test does, and drop this.
 */
export async function loadEveryScreen(page: Page): Promise<void> {
  await page.evaluate((urls) => Promise.all(urls.map((url) => import(url))), SCREEN_URLS);
}

export interface Offline {
  /** Every request the page made while offline. A signed-out app has nothing to fetch, so any is a hidden dependency. */
  requests: string[];
  /** Uncaught errors from going offline to the end of the test, the reload included. */
  errors: string[];
  /** Brings the connection back. */
  online(): Promise<void>;
}

export async function goOffline(page: Page, context: BrowserContext): Promise<Offline> {
  const requests: string[] = [];
  const errors: string[] = [];
  const onRequest = (request: Request) => requests.push(`${request.method()} ${request.url()}`);
  page.on('request', onRequest);
  page.on('pageerror', (error) => errors.push(error.message));
  await context.setOffline(true);
  return {
    requests,
    errors,
    online: async () => {
      page.off('request', onRequest);
      await context.setOffline(false);
    },
  };
}

let sqlJs: Promise<SqlJsStatic> | undefined;

type Fields = Record<string, unknown>;

/**
 * Records of a type as the database file the browser keeps in IndexedDB has them, which is what a reload reads on phone.
 * Phone WebKit keeps the database in memory and saves it there whole 200ms after a change, so a reload any sooner loses
 * the change; desktop Chromium's OPFS file is on disk as each change commits, and copied there as late.
 */
async function savedRecords(page: Page, type: string): Promise<Fields[]> {
  const base64 = await page.evaluate(async (url) => {
    const { get, FILE } = (await import(url)) as { get(key: string): Promise<Uint8Array | undefined>; FILE: string };
    const bytes = await get(FILE);
    if (!bytes) return null;
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  }, '/src/platform/web-file.ts');
  if (!base64) return [];
  const db = new (await (sqlJs ??= initSqlJs())).Database(Buffer.from(base64, 'base64'));
  try {
    const rows = db.exec('SELECT id, data FROM records WHERE type = ?', [type])[0]?.values ?? [];
    return rows.map(([id, data]) => ({ ...(JSON.parse(String(data)) as Fields), id }));
  } finally {
    db.close();
  }
}

/**
 * Waits until the saved database has the record with these fields, so a reload will find it. The record is the one with
 * that id, or for one made with an id of its own, the one that has every field in `which`.
 */
export async function expectSaved(page: Page, type: string, which: string | Fields, fields: Fields): Promise<void> {
  const matches = (r: Fields) => (typeof which === 'string' ? r.id === which : Object.entries(which).every(([k, v]) => r[k] === v));
  await expect.poll(async () => (await savedRecords(page, type)).find(matches), { message: `${type} ${JSON.stringify(which)} saved` }).toMatchObject(fields);
}

/** Back online, reloads: what shows then was saved, not only held by the page. */
export async function reloadOnline(page: Page, offline: Offline): Promise<void> {
  await offline.online();
  await page.reload();
}
