// Checks on everything that crosses into the main process from a window or the OS.

import { resolve, sep } from 'node:path';
import type { SqlValue } from '../src/core/db';

/** The file a request to the app's own scheme means, or null if it would leave the app's folder. */
export function appFilePath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const path = resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`);
  return path.startsWith(root + sep) ? path : null;
}

/** Only web links go to the system browser: the OS would run a file: or custom-scheme URL. */
export function isWebUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

export function isDeepLink(url: string, scheme: string): boolean {
  return url.startsWith(`${scheme}://`);
}

const MAX_CAPTURE_LENGTH = 2000;

/** The task title to save from the capture field, or null if there's nothing usable. */
export function cleanCapture(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const title = text.replace(/\s*\n\s*/g, ' ').trim();
  return title && title.length <= MAX_CAPTURE_LENGTH ? title : null;
}

/** Only SQL on the app's own database: ATTACH and VACUUM INTO would let the page read or write any file the user can. */
export function isOwnDbSql(sql: unknown): sql is string {
  // All of VACUUM, since the schema name and comments can sit between it and INTO. The app never runs any of these.
  return typeof sql === 'string' && !/\b(attach|detach|vacuum)\b/i.test(sql);
}

export function isSqlValues(values: unknown): values is SqlValue[] {
  return Array.isArray(values) && values.every((v) => v === null || typeof v === 'string' || typeof v === 'number');
}

export function contentSecurityPolicy(backendOrigins: readonly string[]): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${backendOrigins.join(' ')}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}
