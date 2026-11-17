// Checks on everything that crosses into the main process from a window or the OS.

import { resolve, sep } from 'node:path';
import { captureTitle } from '../src/core/captureTitle';
import type { SqlValue } from '../src/core/db';
import type { NativeMenuItem } from '../src/platform/types';

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

const MENU_ITEMS = 40;
const MENU_TEXT = 200;
const isText = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= MENU_TEXT;

/**
 * A menu the page asks macOS to draw, or null if it's anything but labelled choices and separators, with one level of
 * submenu: nothing that could carry a role, an accelerator or a click of its own into the main process.
 */
export function menuItems(items: unknown, depth = 0): NativeMenuItem[] | null {
  if (!Array.isArray(items) || items.length === 0 || items.length > MENU_ITEMS) return null;
  const out: NativeMenuItem[] = [];
  for (const item of items as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const keys = Object.keys(item);
    const { type, id, label, submenu } = item as Record<string, unknown>;
    if (type === 'separator' && keys.length === 1) {
      out.push({ type: 'separator' });
      continue;
    }
    if (!isText(id) || !isText(label) || keys.some((k) => k !== 'id' && k !== 'label' && k !== 'submenu')) return null;
    if (submenu === undefined) {
      out.push({ id, label });
      continue;
    }
    const inner = depth === 0 ? menuItems(submenu, 1) : null;
    if (!inner) return null;
    out.push({ id, label, submenu: inner });
  }
  return out;
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
