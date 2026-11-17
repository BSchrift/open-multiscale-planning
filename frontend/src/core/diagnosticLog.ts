// What this device keeps about how the app ran, for Settings > Export diagnostic log: errors with their stacks,
// warnings, each sync and how it ended, and the page hiding, showing and going offline. It's kept on this device
// only, in the page's local storage, and never synced or sent: the newest MAX_LOG_ENTRIES entries from the last
// MAX_LOG_AGE_DAYS days. Telemetry (telemetry.ts) is the other side of this: every device's errors by type and
// place, never a message.
//
// Nothing secret or personal goes in. Sign-in tokens, cookies, auth headers, signed links and email addresses are
// scrubbed from every line, objects are logged by kind and never by their contents, and the app's own messages name
// records by id, never by what someone wrote in them.

import { getMeta, META } from './db';
import type { Sql } from './db';

export const MAX_LOG_ENTRIES = 2000;
export const MAX_LOG_AGE_DAYS = 7;
/** What local storage gets, well under the 5 MB or so a browser allows an origin. */
const MAX_SAVED_CHARS = 1_000_000;
const MAX_MESSAGE_CHARS = 1000;
const MAX_STACK_CHARS = 4000;
/** Entries come in bursts, so they're saved together a moment after, and at once as the page hides. */
const SAVE_DELAY_MS = 1000;
const KEY = 'multiscale.diagnostic-log';
const DAY_MS = 24 * 60 * 60 * 1000;

export type LogLevel = 'error' | 'warn' | 'info';

export interface LogEntry {
  at: string;
  level: LogLevel;
  /** Where it came from: window, promise or console for errors, sync, or app for the page's own comings and goings. */
  source: string;
  message: string;
  stack?: string;
  /** For the same entry several times in a row: how many, and the last time. */
  count?: number;
  last?: string;
}

/** What the export says about the build and the device, set once the platform is open. */
export interface LogAbout {
  app: { version?: string; build?: number; env: string };
  platform: string;
  database?: string;
  /** The app has no feature flags, so these are the optional parts this build has on. */
  features: Record<string, unknown>;
}

/** Local storage, or a stand-in for it. */
export interface KeptText {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type DiagnosticLog = ReturnType<typeof createDiagnosticLog>;

const SECRETS: [RegExp, string][] = [
  // Sign-in tokens are JWTs: three base64url parts, the first always starting eyJ.
  [/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[token]'],
  [/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 [token]'],
  // A header quoted in a message, to the end of its line.
  [/\b(authorization|cookie|set-cookie|x-amz-security-token)(["']?\s*[:=]\s*)[^\n]*/gi, '$1$2[removed]'],
  // A link's sign-in code and tokens, and the signature and key of a signed link to attachments' storage.
  [/([?&#]|\b)((?:access_|refresh_|id_)?token|code|state|client_secret|password|x-amz-(?:credential|signature|security-token))=[^&#\s"']+/gi, '$1$2=[removed]'],
  [/"((?:access_|refresh_|id_)?token|client_secret|password)"\s*:\s*"[^"]*"/gi, '"$1":"[removed]"'],
  // Not a WebKit stack frame, such as onClick@index.js:1:2, which has a line number after it.
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b(?!:\d)/gi, '[email]'],
  // V8 quotes the start of text it couldn't parse as JSON, which can be what someone wrote.
  [/"[^"\n]*"(\.\.\.)? is not valid JSON/g, '"[text]" is not valid JSON'],
];

/** The text with anything secret or personal taken out. */
export function scrub(text: string): string {
  return SECRETS.reduce((clean, [pattern, replacement]) => clean.replace(pattern, replacement), text);
}

const isError = (value: unknown): value is { name?: unknown; message: unknown; stack?: unknown } =>
  value instanceof Error || (typeof value === 'object' && value !== null && 'message' in value && 'stack' in value);

/** One argument as a line says it. An object's contents can be what someone wrote, so only its kind. */
function describe(value: unknown): string {
  if (isError(value)) return `${typeof value.name === 'string' ? value.name : 'Error'}: ${String(value.message)}`;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) return Array.isArray(value) ? '[array]' : '[object]';
  return String(value);
}

export function createDiagnosticLog(deps: { store: KeptText | null; now(): number }) {
  const { store, now } = deps;
  let entries = load();
  let about: LogAbout | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function load(): LogEntry[] {
    try {
      const kept: unknown = JSON.parse(store?.getItem(KEY) ?? '[]');
      if (!Array.isArray(kept)) return [];
      return kept.filter((e): e is LogEntry => typeof e?.at === 'string' && typeof e.message === 'string');
    } catch {
      return [];
    }
  }

  /** Only the newest, and none older than the limit. */
  function trim(): void {
    const oldest = now() - MAX_LOG_AGE_DAYS * DAY_MS;
    const first = entries.findIndex((e) => Date.parse(e.last ?? e.at) >= oldest);
    entries = first === -1 ? [] : entries.slice(Math.max(first, entries.length - MAX_LOG_ENTRIES));
  }

  function save(): void {
    clearTimeout(timer);
    timer = undefined;
    if (!store) return;
    trim();
    let keep = entries;
    // shortcut: drops a tenth at a time until it fits; a log of mostly long stacks keeps fewer than MAX_LOG_ENTRIES.
    for (;;) {
      const text = JSON.stringify(keep);
      try {
        if (text.length <= MAX_SAVED_CHARS) return store.setItem(KEY, text);
      } catch {
        // Full, or storage refused: try with less.
      }
      if (keep.length === 0) return;
      keep = keep.slice(Math.ceil(keep.length / 10));
    }
  }

  return {
    add(level: LogLevel, source: string, message: string, error?: unknown): void {
      const at = new Date(now()).toISOString();
      const said = error === undefined ? message : message ? `${message}: ${describe(error)}` : describe(error);
      // Scrubbed before it's cut, so no part of a token is left at the end.
      const text = scrub(said).slice(0, MAX_MESSAGE_CHARS);
      const stack = isError(error) && typeof error.stack === 'string' ? scrub(error.stack).slice(0, MAX_STACK_CHARS) : undefined;
      const previous = entries.at(-1);
      if (previous && previous.level === level && previous.source === source && previous.message === text && previous.stack === stack) {
        previous.count = (previous.count ?? 1) + 1;
        previous.last = at;
      } else {
        entries.push({ at, level, source, message: text, ...(stack ? { stack } : {}) });
      }
      trim();
      timer ??= setTimeout(save, SAVE_DELAY_MS);
    },
    entries(): LogEntry[] {
      trim();
      return entries.map((e) => ({ ...e }));
    },
    save,
    describe(next: LogAbout): void {
      about = next;
    },
    about: () => about,
    now,
  };
}

/** Where the app keeps the log: the page's local storage, which a private window or a test may not have. */
function localStore(): KeptText | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The app's log, from the moment the page loads. */
export const diagnosticLog = createDiagnosticLog({ store: localStore(), now: () => Date.now() });

/**
 * The file Settings exports, as JSON: the build and the device, the sync state, the features on, and the log. It counts
 * records and what waits to sync by type, and holds nothing anyone wrote in them.
 */
export async function diagnosticReport(sql: Sql, log: DiagnosticLog, device: { userAgent: string }): Promise<string> {
  const about = log.about();
  const count = async (query: string) => (await sql.get<{ n: number }>(query))?.n ?? 0;
  const byType = (rows: { type: string; n: number }[]) => Object.fromEntries(rows.map(({ type, n }) => [type, n]));
  const waiting = await sql.all<{ type: string; n: number }>('SELECT type, COUNT(DISTINCT record_id) AS n FROM outbox GROUP BY type ORDER BY type');
  const report = {
    file: 'multiscale-diagnostic-log',
    exportedAt: new Date(log.now()).toISOString(),
    app: about?.app ?? null,
    device: {
      platform: about?.platform ?? null,
      database: about?.database ?? null,
      userAgent: scrub(device.userAgent),
      deviceId: await getMeta(sql, META.deviceId),
      schemaVersion: Number(await getMeta(sql, META.schemaVersion)),
    },
    sync: {
      lastSuccess: await getMeta(sql, META.lastSyncAt),
      lastError: await getMeta(sql, META.lastSyncError),
      signingIn: (await getMeta(sql, META.signingIn)) !== null,
      outbox: { records: waiting.reduce((sum, { n }) => sum + n, 0), fields: await count('SELECT COUNT(*) AS n FROM outbox'), byType: byType(waiting) },
      // Photos and files added here that haven't gone up yet (files.ts).
      uploadsWaiting: await count("SELECT COUNT(*) AS n FROM attachment WHERE kind IN ('photo', 'file') AND uploaded_at IS NULL AND deleted_at IS NULL"),
    },
    records: byType(await sql.all<{ type: string; n: number }>('SELECT type, COUNT(*) AS n FROM records GROUP BY type ORDER BY type')),
    features: about?.features ?? {},
    limits: { entries: MAX_LOG_ENTRIES, days: MAX_LOG_AGE_DAYS },
    entries: log.entries(),
  };
  return JSON.stringify(report, null, 2);
}

type Target = Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & {
  document?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { visibilityState: string };
};

/**
 * Keeps uncaught errors and rejections, everything the app prints with console.error and console.warn, which is how it
 * reports the errors it catches, and the page hiding, showing and going offline. Returns a function that stops it.
 */
export function watchErrors(log: DiagnosticLog, target: Target, out: Pick<Console, 'error' | 'warn'>): () => void {
  const onError = (event: Event) => {
    const { error, message, filename, lineno, colno } = event as ErrorEvent;
    // One with no error object, as from another origin's script, says only where it was.
    if (isError(error)) log.add('error', 'window', '', error);
    else log.add('error', 'window', filename ? `${message || 'Error'} at ${filename}:${lineno}:${colno}` : message || 'Error');
  };
  const onRejection = (event: Event) => {
    const { reason } = event as PromiseRejectionEvent;
    if (isError(reason)) log.add('error', 'promise', '', reason);
    else log.add('error', 'promise', `Unhandled rejection: ${describe(reason)}`);
  };
  const printed = (level: 'error' | 'warn') => {
    const print = out[level];
    out[level] = (...args: unknown[]) => {
      print.apply(out, args);
      // Whatever it was given, printing never fails the code that printed, which is often handling an error already.
      try {
        const error = args.find(isError);
        log.add(level, 'console', args.filter((arg) => arg !== error).map(describe).join(' '), error);
      } catch {
        // Something that can't be turned into text, such as an object with no prototype as its message.
      }
    };
    return () => void (out[level] = print);
  };
  const onOffline = () => log.add('info', 'app', 'Offline');
  const onOnline = () => log.add('info', 'app', 'Back online');
  const onVisibility = () => {
    const hidden = target.document?.visibilityState === 'hidden';
    log.add('info', 'app', hidden ? 'Hidden' : 'Shown');
    // The page may not come back: iOS can end an app in the background, and a tab can be closed.
    if (hidden) log.save();
  };
  const onPageHide = () => log.save();
  const listeners: [Target['document'] | Target | undefined, string, (event: Event) => void][] = [
    [target, 'error', onError],
    [target, 'unhandledrejection', onRejection],
    [target, 'offline', onOffline],
    [target, 'online', onOnline],
    [target, 'pagehide', onPageHide],
    [target.document, 'visibilitychange', onVisibility],
  ];
  for (const [on, name, listener] of listeners) on?.addEventListener(name, listener);
  const restore = [printed('error'), printed('warn')];
  return () => {
    for (const [on, name, listener] of listeners) on?.removeEventListener(name, listener);
    for (const undo of restore) undo();
  };
}
