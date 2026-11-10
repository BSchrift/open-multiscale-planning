// Checks on everything that crosses into the main process from a window or the OS.

import { resolve, sep } from 'node:path';
import { captureTitle } from '../src/core/captureTitle';
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

/** What a link in the page may open outside the app: web pages, and mail from a description's mailto: link. */
export function isExternalUrl(url: unknown): url is string {
  if (isWebUrl(url)) return true;
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).protocol === 'mailto:';
  } catch {
    return false;
  }
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

/** The task title to save from the capture field, or null if there's nothing usable. */
export function cleanCapture(text: unknown): string | null {
  return typeof text === 'string' ? captureTitle(text) : null;
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
    // Attachments' photos show from this device's copy, as blob: URLs.
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${backendOrigins.join(' ')}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}
