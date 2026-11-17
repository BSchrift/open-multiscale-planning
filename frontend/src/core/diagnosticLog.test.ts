import { describe, expect, it, vi } from 'vitest';
import { setMeta, META } from './db';
import { fixedClock } from './clock';
import { transact } from './records';
import { createDiagnosticLog, diagnosticReport, MAX_LOG_AGE_DAYS, MAX_LOG_ENTRIES, scrub, watchErrors } from './diagnosticLog';
import type { KeptText } from './diagnosticLog';
import { openTestDb } from '../platform/node-sqlite';

const START = Date.parse('2026-11-16T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function memoryStore(): KeptText & { kept: Map<string, string> } {
  const kept = new Map<string, string>();
  return { kept, getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => void kept.set(key, value) };
}

function setup(store: KeptText | null = memoryStore()) {
  let now = START;
  const log = createDiagnosticLog({ store, now: () => now });
  return { log, store, advance: (ms: number) => (now += ms) };
}

/** A window and its document, enough for watchErrors, with a console that records what reached it. */
function page() {
  const target = new EventTarget() as EventTarget & { document: EventTarget & { visibilityState: string } };
  target.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const printed: unknown[][] = [];
  const out = { error: (...args: unknown[]) => void printed.push(args), warn: (...args: unknown[]) => void printed.push(args) };
  return { target, out, printed };
}

// Each looks like a real one, and none is.
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';
const SECRETS = [JWT, 'abc123refresh', 'oauthcode42', 'statevalue9', 'sessioncookie77', 'AKIDEXAMPLE', 'sig0123abcd', 'someone@example.com'];

describe('the log', () => {
  it('keeps each entry with its time, level and source, and an error with its stack', () => {
    const t = setup();
    const error = new TypeError('x is undefined');
    t.log.add('error', 'console', 'Save failed', error);
    t.log.add('info', 'sync', 'Synced, nothing new');
    expect(t.log.entries()).toEqual([
      { at: '2026-11-16T09:00:00.000Z', level: 'error', source: 'console', message: 'Save failed: TypeError: x is undefined', stack: error.stack },
      { at: '2026-11-16T09:00:00.000Z', level: 'info', source: 'sync', message: 'Synced, nothing new' },
    ]);
  });

  it('counts the same entry in a row as one, with when it last happened', () => {
    const t = setup();
    t.log.add('info', 'sync', 'Synced, nothing new');
    t.advance(5 * 60_000);
    t.log.add('info', 'sync', 'Synced, nothing new');
    expect(t.log.entries()).toEqual([
      { at: '2026-11-16T09:00:00.000Z', last: '2026-11-16T09:05:00.000Z', count: 2, level: 'info', source: 'sync', message: 'Synced, nothing new' },
    ]);
  });

  it(`keeps the newest ${MAX_LOG_ENTRIES} entries`, () => {
    const t = setup();
    for (let i = 0; i < MAX_LOG_ENTRIES + 5; i++) t.log.add('info', 'app', `entry ${i}`);
    const kept = t.log.entries();
    expect(kept).toHaveLength(MAX_LOG_ENTRIES);
    expect(kept[0]!.message).toBe('entry 5');
  });

  it(`drops entries older than ${MAX_LOG_AGE_DAYS} days`, () => {
    const t = setup();
    t.log.add('info', 'app', 'old');
    t.advance(MAX_LOG_AGE_DAYS * DAY - 1);
    t.log.add('info', 'app', 'recent');
    expect(t.log.entries().map((e) => e.message)).toEqual(['old', 'recent']);
    t.advance(2);
    expect(t.log.entries().map((e) => e.message)).toEqual(['recent']);
  });

  it('is still there after a restart, and starts empty from what it cannot read', () => {
    const store = memoryStore();
    const first = setup(store);
    first.log.add('warn', 'app', 'kept');
    first.log.save();
    expect(setup(store).log.entries().map((e) => e.message)).toEqual(['kept']);

    const [key] = [...store.kept.keys()];
    store.kept.set(key!, '{not json');
    expect(setup(store).log.entries()).toEqual([]);
    store.kept.set(key!, '[null, {"at": 1}, "text"]');
    expect(setup(store).log.entries()).toEqual([]);
  });

  it('saves a moment after an entry, not on every one', () => {
    vi.useFakeTimers();
    try {
      const store = memoryStore();
      const setItem = vi.spyOn(store, 'setItem');
      const t = setup(store);
      t.log.add('info', 'app', 'one');
      t.log.add('info', 'app', 'two');
      expect(setItem).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(setItem).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fits what it saves in the space a browser gives, dropping the oldest', () => {
    const store = memoryStore();
    let refused = 0;
    const tight: KeptText = {
      getItem: store.getItem,
      setItem: (key, value) => {
        if (value.length > 200_000) {
          refused++;
          throw new DOMException('full', 'QuotaExceededError');
        }
        store.setItem(key, value);
      },
    };
    const t = setup(tight);
    for (let i = 0; i < 500; i++) t.log.add('error', 'console', `failure ${i}`, Object.assign(new Error('boom'), { stack: `Error: boom ${i}\n${'    at frame\n'.repeat(200)}` }));
    t.log.save();
    expect(refused).toBeGreaterThan(0);
    const saved = setup(store).log.entries();
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.at(-1)!.message).toBe('failure 499: Error: boom');
  });

  it('works with nowhere to keep it, as in a private window', () => {
    const t = setup(null);
    t.log.add('info', 'app', 'here');
    t.log.save();
    expect(t.log.entries()).toHaveLength(1);
  });
});

describe('scrub', () => {
  it('takes out sign-in tokens, cookies, auth headers, signed links and email addresses', () => {
    const text = [
      `Authorization: Bearer ${JWT}`,
      `fetch failed for /oauth2/token?code=oauthcode42&state=statevalue9`,
      `{"access_token":"${JWT}","refresh_token":"abc123refresh"}`,
      `cookie: session=sessioncookie77; theme=dark`,
      `https://files.example/x?X-Amz-Credential=AKIDEXAMPLE&X-Amz-Signature=sig0123abcd`,
      `signed in as someone@example.com`,
    ].join('\n');
    const clean = scrub(text);
    for (const secret of SECRETS) expect(clean).not.toContain(secret);
    expect(clean).toContain('fetch failed for /oauth2/token?code=');
  });

  it('leaves stacks readable', () => {
    const stack = 'TypeError: x is undefined\n    at render (app://-/assets/index-Cc.js:1:4321)\nonClick@capacitor://localhost/assets/index.js:2:10';
    expect(scrub(stack)).toBe(stack);
  });

  it("takes out the start of text that couldn't be parsed, which can be what someone wrote", () => {
    expect(scrub(`Unexpected token 'B', "Buy milk a"... is not valid JSON`)).not.toContain('Buy milk');
  });
});

describe('watchErrors', () => {
  it('keeps uncaught errors and rejections with their stacks, and what the app prints as errors and warnings', () => {
    const t = setup();
    const p = page();
    const stop = watchErrors(t.log, p.target, p.out);
    const thrown = new TypeError('x is undefined');
    p.target.dispatchEvent(Object.assign(new Event('error'), { error: thrown, message: 'Uncaught TypeError: x is undefined', filename: 'app://-/assets/index.js', lineno: 1, colno: 99 }));
    p.target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new RangeError('too far') }));
    p.out.error('Sync failed', new Error('socket closed'));
    p.out.warn('Update check failed', 404);
    stop();
    p.out.error('after stop');

    expect(t.log.entries().map(({ level, source, message }) => ({ level, source, message }))).toEqual([
      { level: 'error', source: 'window', message: 'TypeError: x is undefined' },
      { level: 'error', source: 'promise', message: 'RangeError: too far' },
      { level: 'error', source: 'console', message: 'Sync failed: Error: socket closed' },
      { level: 'warn', source: 'console', message: 'Update check failed 404' },
    ]);
    expect(t.log.entries()[0]!.stack).toBe(thrown.stack);
    // The console still prints everything, after stop too.
    expect(p.printed.map((args) => args[0])).toEqual(['Sync failed', 'Update check failed', 'after stop']);
  });

  it('keeps where an error without a stack was thrown', () => {
    const t = setup();
    const p = page();
    watchErrors(t.log, p.target, p.out);
    p.target.dispatchEvent(Object.assign(new Event('error'), { message: 'Script error.', filename: 'app://-/assets/index.js', lineno: 3, colno: 7 }));
    expect(t.log.entries()).toEqual([{ at: '2026-11-16T09:00:00.000Z', level: 'error', source: 'window', message: 'Script error. at app://-/assets/index.js:3:7' }]);
  });

  it("never keeps an object's contents, which can be what someone wrote", () => {
    const t = setup();
    const p = page();
    watchErrors(t.log, p.target, p.out);
    p.out.error('Save failed', { title: 'Buy milk', notes: 'For the cake' });
    p.target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: { title: 'Buy milk' } }));
    expect(JSON.stringify(t.log.entries())).not.toContain('milk');
    expect(t.log.entries().map((e) => e.message)).toEqual(['Save failed [object]', 'Unhandled rejection: [object]']);
  });

  it('never fails the code that printed, whatever it printed', () => {
    const t = setup();
    const p = page();
    watchErrors(t.log, p.target, p.out);
    expect(() => p.out.error('Odd', { message: Object.create(null), stack: '' })).not.toThrow();
    expect(p.printed).toHaveLength(1);
  });

  it('scrubs tokens from messages and stacks', () => {
    const t = setup();
    const p = page();
    watchErrors(t.log, p.target, p.out);
    const error = new Error(`401 for Bearer ${JWT}`);
    error.stack = `Error: 401\n    at send (https://app.example/assets/index.js?code=oauthcode42:1:2)`;
    p.out.error('Sign-in failed', error);
    const kept = JSON.stringify(t.log.entries());
    expect(kept).not.toContain(JWT);
    expect(kept).not.toContain('oauthcode42');
  });

  it('notes the page hidden and shown, and the connection lost and back, and saves as the page hides', () => {
    const store = memoryStore();
    const t = setup(store);
    const p = page();
    watchErrors(t.log, p.target, p.out);
    p.target.dispatchEvent(new Event('offline'));
    p.target.dispatchEvent(new Event('online'));
    p.target.document.visibilityState = 'hidden';
    p.target.document.dispatchEvent(new Event('visibilitychange'));
    expect(store.kept.size).toBe(1);
    p.target.document.visibilityState = 'visible';
    p.target.document.dispatchEvent(new Event('visibilitychange'));
    expect(t.log.entries().map((e) => `${e.source}: ${e.message}`)).toEqual(['app: Offline', 'app: Back online', 'app: Hidden', 'app: Shown']);
  });
});

describe('diagnosticReport', () => {
  async function seeded() {
    const db = await openTestDb();
    const clock = fixedClock('2026-11-16T09:00:00Z');
    await transact(db, clock, async (w) => {
      await w.create('task', { kind: 'inbox', title: 'Buy milk', notes: 'For the cake' });
      await w.create('task', { kind: 'inbox', title: 'Call the bank' });
    });
    await setMeta(db, META.lastSyncAt, '2026-11-16T08:55:00Z');
    await setMeta(db, META.lastSyncError, 'offline');
    await setMeta(db, META.deviceId, 'device-1');
    return db;
  }

  it('has the app, the device, the sync state, the features on and the entries, and no task content', async () => {
    const db = await seeded();
    const t = setup();
    t.log.describe({
      app: { version: '0.1.0-abc1234', build: 1763283600, env: 'staging' },
      platform: 'ios',
      database: 'capacitor-sqlite',
      features: { overTheAirUpdates: true },
    });
    t.log.add('warn', 'sync', 'Sync failed: offline');
    const report = JSON.parse(await diagnosticReport(db, t.log, { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)' }));
    expect(report).toEqual({
      file: 'multiscale-diagnostic-log',
      exportedAt: '2026-11-16T09:00:00.000Z',
      app: { version: '0.1.0-abc1234', build: 1763283600, env: 'staging' },
      device: { platform: 'ios', database: 'capacitor-sqlite', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)', deviceId: 'device-1', schemaVersion: expect.any(Number) },
      sync: {
        lastSuccess: '2026-11-16T08:55:00Z',
        lastError: 'offline',
        signingIn: false,
        outbox: { records: 2, fields: expect.any(Number), byType: { task: 2 } },
        uploadsWaiting: 0,
      },
      records: { task: 2 },
      features: { overTheAirUpdates: true },
      limits: { entries: MAX_LOG_ENTRIES, days: MAX_LOG_AGE_DAYS },
      entries: [{ at: '2026-11-16T09:00:00.000Z', level: 'warn', source: 'sync', message: 'Sync failed: offline' }],
    });
    const text = JSON.stringify(report);
    for (const words of ['milk', 'cake', 'bank']) expect(text).not.toContain(words);
  });

  it('holds no token, cookie or auth header that reached the log', async () => {
    const db = await seeded();
    const t = setup();
    const p = page();
    watchErrors(t.log, p.target, p.out);
    p.out.error('Refresh failed', new Error(`{"refresh_token":"abc123refresh","id_token":"${JWT}"}`));
    p.out.warn(`Request failed: cookie: session=sessioncookie77\nAuthorization: Bearer ${JWT}`);
    p.target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('GET /oauth2/token?code=oauthcode42&state=statevalue9 failed for someone@example.com') }));
    p.out.error('Upload failed', 'https://files.example/x?X-Amz-Credential=AKIDEXAMPLE&X-Amz-Signature=sig0123abcd');
    const report = await diagnosticReport(db, t.log, { userAgent: 'test' });
    for (const secret of SECRETS) expect(report).not.toContain(secret);
    expect(JSON.parse(report).entries).toHaveLength(4);
  });
});
