import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock, parseClock } from './clock';
import { getMeta, META } from './db';
import type { Db } from './db';
import { CALENDAR_ID, getRecord, transact } from './records';
import { SyncError, syncStatus, unsyncedChanges } from './sync';
import type { SyncSend } from './sync';
import { fakeSyncServer } from './sync-testing';
import { createSyncRunner, startAppSync } from './syncRunner';
import { memoryLifecycle } from '../platform/memory';
import { openTestDb } from '../platform/node-sqlite';
import { createTestPlatform } from '../platform/testing';

const NOW = '2026-11-02T15:00:00Z';
const SECOND = 1000;
const MINUTE = 60 * SECOND;

async function setup(sendImpl?: SyncSend) {
  const db = await openTestDb();
  const clock = fixedClock(NOW);
  const lifecycle = memoryLifecycle();
  const server = fakeSyncServer({ now: () => clock.now() });
  const send = vi.fn<SyncSend>(sendImpl ?? ((req) => server.send(req)));
  const runner = createSyncRunner({ db, clock, lifecycle, send });
  return { db, clock, lifecycle, server, send, runner };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const outboxCount = async (db: Db) => (await db.all('SELECT 1 FROM outbox')).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('when it syncs', () => {
  it('at launch', async () => {
    const t = await setup();
    t.runner.start();
    await flush();
    expect(t.send).toHaveBeenCalledTimes(1);
    t.runner.stop();
  });

  it('on returning to the foreground', async () => {
    const t = await setup();
    t.runner.start();
    await flush();
    t.lifecycle.foreground();
    await flush();
    expect(t.send).toHaveBeenCalledTimes(2);
    t.runner.stop();
  });

  it('2 seconds after the last edit', async () => {
    const t = await setup();
    t.runner.start();
    await flush();
    t.send.mockClear();

    await transact(t.db, t.clock, (w) => w.create('task', { kind: 'inbox', title: 'Write the report' }));
    await vi.advanceTimersByTimeAsync(1999);
    expect(t.send).not.toHaveBeenCalled();
    await transact(t.db, t.clock, (w) => w.create('task', { kind: 'inbox', title: 'Paint the fence' }));
    await vi.advanceTimersByTimeAsync(1999);
    expect(t.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.send.mock.calls[0]![0].changes).toHaveLength(2);
    t.runner.stop();
  });

  it('not because of changes that came from a sync', async () => {
    const t = await setup();
    t.runner.start();
    await flush();
    t.send.mockClear();
    t.db.notifyChanged({ types: ['task'], source: 'remote' });
    await vi.advanceTimersByTimeAsync(10 * SECOND);
    expect(t.send).not.toHaveBeenCalled();
    t.runner.stop();
  });

  it('every 5 minutes while open', async () => {
    const t = await setup();
    t.runner.start();
    await flush();
    t.send.mockClear();
    await vi.advanceTimersByTimeAsync(5 * MINUTE - 1);
    expect(t.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(t.send).toHaveBeenCalledTimes(2);
    t.runner.stop();
  });

  it('never after stop', async () => {
    const t = await setup();
    t.runner.start();
    await flush();
    await transact(t.db, t.clock, (w) => w.create('task', { kind: 'inbox', title: 'Paint the fence' }));
    t.runner.stop();
    t.send.mockClear();
    t.lifecycle.foreground();
    await transact(t.db, t.clock, (w) => w.create('task', { kind: 'inbox', title: 'Paint the gate' }));
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(t.send).not.toHaveBeenCalled();
  });

  it('runs one sync at a time, and once more for anything asked during it', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const t = await setup();
    t.send.mockImplementationOnce(async (req) => {
      await gate;
      return t.server.send(req);
    });
    const first = t.runner.syncNow();
    await flush();
    const second = t.runner.syncNow();
    const third = t.runner.syncNow();
    await flush();
    expect(t.send).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second, third]);
    expect(t.send).toHaveBeenCalledTimes(2);
  });
});

describe('what Settings shows', () => {
  it('records the last sync time on success and clears any old error', async () => {
    const t = await setup();
    t.send.mockRejectedValueOnce(new SyncError('offline'));
    await t.runner.syncNow();
    expect(await syncStatus(t.db)).toEqual({ lastSyncAt: null, lastError: 'offline' });
    await t.runner.syncNow();
    expect(await syncStatus(t.db)).toEqual({ lastSyncAt: NOW, lastError: null });
  });

  it('keeps the last good time through a failure', async () => {
    const t = await setup();
    await t.runner.syncNow();
    t.clock.set('2026-11-02T16:00:00Z');
    t.send.mockRejectedValueOnce(new SyncError('clock_ahead'));
    await t.runner.syncNow();
    expect(await syncStatus(t.db)).toEqual({ lastSyncAt: NOW, lastError: 'clock_ahead' });
  });

  it('tells screens when the status changes, without counting as an edit', async () => {
    const t = await setup();
    const seen: string[] = [];
    t.db.subscribe((change) => seen.push(change.source));
    await t.runner.syncNow();
    expect(seen).toEqual(['remote']);
  });

  it('records an unexpected failure as a general error, and never rejects', async () => {
    const t = await setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    t.send.mockRejectedValueOnce(new Error('something odd'));
    await expect(t.runner.syncNow()).resolves.toBeUndefined();
    expect((await syncStatus(t.db)).lastError).toBe('error');
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe('a refused clock', () => {
  const DAY = 24 * 60 * MINUTE;

  /** This device's time is a year ahead of the server's, for its writes and its syncs alike. */
  async function ahead() {
    const db = await openTestDb();
    const clock = fixedClock(Date.parse(NOW) + 365 * DAY);
    const server = fakeSyncServer({ now: () => Date.parse(NOW) });
    const runner = createSyncRunner({ db, clock, lifecycle: memoryLifecycle(), send: (req) => server.send(req) });
    return { db, clock, server, runner };
  }

  it('keeps the outbox and shows the error', async () => {
    const t = await ahead();
    await transact(t.db, t.clock, (w) => w.create('task', { kind: 'inbox', title: 'Too far ahead' }));
    await t.runner.syncNow();
    expect((await syncStatus(t.db)).lastError).toBe('clock_ahead');
    expect(await outboxCount(t.db)).toBe(2);
  });

  it('once the time is set right, sends what was written while it was ahead, and what was written since', async () => {
    const t = await ahead();
    const early = await transact(t.db, t.clock, (w) => w.create('task', { kind: 'inbox', title: 'Written a year ahead' }));
    await t.runner.syncNow();
    t.clock.set(NOW);
    const later = await transact(t.db, t.clock, (w) => w.create('task', { kind: 'inbox', title: 'Written after the fix' }));
    await t.runner.syncNow();

    expect((await syncStatus(t.db)).lastError).toBeNull();
    expect(t.server.record(early)!.title!.v).toBe('Written a year ahead');
    expect(t.server.record(later)!.title!.v).toBe('Written after the fix');
    expect(await outboxCount(t.db)).toBe(0);
    const clocks = await t.db.all<{ clocks: string }>('SELECT clocks FROM records');
    const walls = clocks.flatMap((r) => Object.values(JSON.parse(r.clocks) as Record<string, string>)).map((c) => parseClock(c).wall);
    expect(Math.max(...walls, parseClock((await getMeta(t.db, META.clock))!).wall)).toBeLessThanOrEqual(Date.parse(NOW) + DAY);
  });

  it('a device whose time is days behind still edits after what it has seen, so its edit wins', async () => {
    const db = await openTestDb();
    const clock = fixedClock(Date.parse(NOW) - 3 * DAY);
    const server = fakeSyncServer({ now: () => Date.parse(NOW) });
    const runner = createSyncRunner({ db, clock, lifecycle: memoryLifecycle(), send: (req) => server.send(req) });
    const other = `${Date.parse(NOW) - MINUTE}-000000-other`;
    await server.send({ cursor: 0, changes: [{ type: 'task', id: 'shared', fields: { kind: { v: 'inbox', c: other }, title: { v: 'Paint the fence', c: other } } }] });
    await runner.syncNow();
    await transact(db, clock, (w) => w.set('task', 'shared', { title: 'Paint the gate' }));
    await runner.syncNow();
    expect((await syncStatus(db)).lastError).toBeNull();
    expect(server.record('shared')!.title!.v).toBe('Paint the gate');
  });
});

describe('startAppSync', () => {
  const API = 'https://api.example.test';
  const AUTH = 'https://auth.example.test';

  async function app() {
    const platform = await createTestPlatform();
    const clock = fixedClock(NOW);
    const server = fakeSyncServer({ now: () => clock.now() });
    let accessToken = 'access-1';
    let refreshAllowed = true;
    let apiRequests = 0;
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      if (url === `${AUTH}/oauth2/token`) {
        if (new URLSearchParams(init.body as string).get('grant_type') === 'refresh_token' && !refreshAllowed) {
          return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
        }
        return new Response(JSON.stringify({ access_token: accessToken, refresh_token: 'refresh-1', expires_in: 3600 }));
      }
      apiRequests++;
      const authorized = (init.headers as Record<string, string>).authorization === `Bearer ${accessToken}`;
      if (!authorized) return new Response('{}', { status: 401 });
      if (url === `${API}/calendar/connect`) return new Response(JSON.stringify({ url: 'https://consent.example.test/?state=s' }));
      if (url === `${API}/calendar/refresh`) return new Response(null, { status: 204 });
      try {
        return new Response(JSON.stringify(await server.send(JSON.parse(init.body as string))));
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as SyncError).code }), { status: 400 });
      }
    });
    const sync = startAppSync(platform, clock, { env: 'local', apiUrl: API, authUrl: AUTH, authClientId: 'client-1' }, fetchFn);
    const finishSignIn = async () => {
      await sync.signIn();
      const state = new URL(platform.opened.at(-1)!).searchParams.get('state');
      platform.openDeepLink(`${platform.signInRedirectUri}?code=c&state=${state}`);
      await vi.advanceTimersByTimeAsync(0);
    };
    return {
      platform,
      clock,
      server,
      sync,
      finishSignIn,
      fetchFn,
      apiRequests: () => apiRequests,
      rotateAccessToken: (next: string) => (accessToken = next),
      refuseRefresh: () => (refreshAllowed = false),
    };
  }

  it('before sign-in, makes no requests, and local work carries on', async () => {
    const t = await app();
    await flush();
    await transact(t.platform.db, t.clock, (w) => w.create('task', { kind: 'inbox', title: 'Paint the fence' }));
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(t.fetchFn).not.toHaveBeenCalled();
    expect((await syncStatus(t.platform.db)).lastError).toBe('sign_in_expired');
    expect(await outboxCount(t.platform.db)).toBe(2);
    t.sync.stop();
  });

  it('signing in through the deep link syncs straight away and clears the prompt', async () => {
    const t = await app();
    await flush();
    const id = await transact(t.platform.db, t.clock, (w) => w.create('task', { kind: 'inbox', title: 'Paint the fence' }));
    await t.finishSignIn();
    expect(t.server.record(id)!.title!.v).toBe('Paint the fence');
    expect(await syncStatus(t.platform.db)).toEqual({ lastSyncAt: NOW, lastError: null });
    t.sync.stop();
  });

  it('a failed sign-in shows as an error rather than vanishing', async () => {
    const t = await app();
    await flush();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    t.platform.openDeepLink(`${t.platform.signInRedirectUri}?code=c&state=forged`);
    await flush();
    expect((await syncStatus(t.platform.db)).lastError).toBe('sign_in_failed');
    expect(log).toHaveBeenCalled();
    log.mockRestore();
    t.sync.stop();
  });

  it('other deep links are left alone', async () => {
    const t = await app();
    await flush();
    t.platform.openDeepLink('multiscale://capture');
    await flush();
    expect(t.fetchFn).not.toHaveBeenCalled();
    t.sync.stop();
  });

  it('an expired sign-in pauses sync without blocking; signing in again sends what built up', async () => {
    const t = await app();
    await t.finishSignIn();
    t.refuseRefresh();
    t.rotateAccessToken('access-2');
    const id = await transact(t.platform.db, t.clock, (w) => w.create('task', { kind: 'inbox', title: 'Written while expired' }));
    await vi.advanceTimersByTimeAsync(2 * SECOND);

    expect((await syncStatus(t.platform.db)).lastError).toBe('sign_in_expired');
    expect((await syncStatus(t.platform.db)).lastSyncAt).toBe(NOW);
    expect(await outboxCount(t.platform.db)).toBe(2);
    expect(await getRecord(t.platform.db, 'task', id)).toBeDefined();

    // Paused: no more traffic, however many triggers fire.
    const before = t.fetchFn.mock.calls.length;
    t.platform.lifecycle.foreground();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(t.fetchFn).toHaveBeenCalledTimes(before);

    await t.finishSignIn();
    expect(t.server.record(id)!.title!.v).toBe('Written while expired');
    expect(await outboxCount(t.platform.db)).toBe(0);
    expect((await syncStatus(t.platform.db)).lastError).toBeNull();
    t.sync.stop();
  });

  it('signing out keeps local work and shows the prompt', async () => {
    const t = await app();
    await t.finishSignIn();
    await transact(t.platform.db, t.clock, (w) => w.create('task', { kind: 'inbox', title: 'Paint the fence' }));
    await t.sync.signOut();
    expect((await syncStatus(t.platform.db)).lastError).toBe('sign_in_expired');
    expect(await outboxCount(t.platform.db)).toBe(2);
    // The refresh token is revoked and the browser's sign-in session ended too, so the next sign-in asks again.
    expect(t.fetchFn.mock.calls.map(([url]) => url)).toContain(`${AUTH}/oauth2/revoke`);
    expect(t.platform.opened.at(-1)).toMatch(new RegExp(`^${AUTH}/logout\\?`));
    // The browser coming back from that isn't taken for a failed sign-in.
    t.platform.openDeepLink(t.platform.signInRedirectUri);
    await vi.advanceTimersByTimeAsync(0);
    expect((await syncStatus(t.platform.db)).lastError).toBe('sign_in_expired');
    t.sync.stop();
  });

  it('connecting a calendar opens its consent page in the browser', async () => {
    const t = await app();
    await t.finishSignIn();
    await t.sync.connectCalendar();
    expect(t.platform.opened.at(-1)).toBe('https://consent.example.test/?state=s');
    t.sync.stop();
  });

  it('after opening the consent page, syncs every 5 seconds for 2 minutes', async () => {
    const t = await app();
    await t.finishSignIn();
    await t.sync.connectCalendar();
    const before = t.server.requests.length;
    await vi.advanceTimersByTimeAsync(15 * SECOND);
    expect(t.server.requests.length).toBe(before + 3);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(t.server.requests.length).toBe(before + 24);
    // Short of the 5-minute sync.
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(t.server.requests.length).toBe(before + 24);
    t.sync.stop();
  });

  it('stops syncing that often once the connection and its calendars are here', async () => {
    const t = await app();
    await t.finishSignIn();
    await t.sync.connectCalendar();
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    await transact(t.platform.db, t.clock, async (w) => {
      await w.create('calendar', { connected: true }, CALENDAR_ID);
      await w.create('calendar_source', { google_id: 'cal-a', name: 'Work', mode: 'block' });
    });
    const before = t.server.requests.length;
    await vi.advanceTimersByTimeAsync(MINUTE);
    // Only the sync for that edit.
    expect(t.server.requests.length).toBe(before + 1);
    t.sync.stop();
  });

  it('refreshing calendars asks the server, then syncs to bring their events', async () => {
    const t = await app();
    await t.finishSignIn();
    const before = t.apiRequests();
    await t.sync.refreshCalendar();
    expect(t.fetchFn).toHaveBeenCalledWith(`${API}/calendar/refresh`, expect.objectContaining({ method: 'POST' }));
    expect(t.apiRequests()).toBe(before + 2);
    t.sync.stop();
  });

  it('calendar requests refresh an expired token once, like sync', async () => {
    const t = await app();
    await t.finishSignIn();
    t.rotateAccessToken('access-2');
    await t.sync.connectCalendar();
    expect(t.platform.opened.at(-1)).toBe('https://consent.example.test/?state=s');
    t.sync.stop();
  });

  it('calendar requests before sign-in fail as signed out and send nothing', async () => {
    const t = await app();
    await flush();
    await expect(t.sync.connectCalendar()).rejects.toMatchObject({ code: 'sign_in_expired' });
    await expect(t.sync.refreshCalendar()).rejects.toMatchObject({ code: 'sign_in_expired' });
    expect(t.fetchFn).not.toHaveBeenCalled();
    t.sync.stop();
  });

  describe('signing in as another account than the one this device’s data belongs to', () => {
    /**
     * One device, with a capture shared from another app still waiting, and two accounts with a server each. Access
     * tokens carry the user in their sub claim and ID tokens the email, as the identity provider's do.
     */
    async function twoAccounts() {
      const shares = [{ id: 'share-1', text: 'Buy flour' }];
      const platform = Object.assign(await createTestPlatform(), {
        shareImport: {
          peek: async () => [...shares],
          remove: async (ids: string[]) => void shares.splice(0, shares.length, ...shares.filter((s) => !ids.includes(s.id))),
        },
      });
      const clock = fixedClock(NOW);
      const servers = { a: fakeSyncServer({ now: () => clock.now() }), b: fakeSyncServer({ now: () => clock.now() }) };
      const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
      const token = (who: 'a' | 'b') => jwt({ sub: `user-${who}` });
      let next: 'a' | 'b' = 'a';
      const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
        if (url === `${AUTH}/oauth2/token`) {
          const id = jwt({ sub: `user-${next}`, email: `${next}@example.com` });
          return new Response(JSON.stringify({ access_token: token(next), id_token: id, refresh_token: `r-${next}`, expires_in: 3600 }));
        }
        const auth = (init.headers as Record<string, string>).authorization;
        const who = auth === `Bearer ${token('a')}` ? 'a' : auth === `Bearer ${token('b')}` ? 'b' : null;
        if (!who) return new Response('{}', { status: 401 });
        return new Response(JSON.stringify(await servers[who].send(JSON.parse(init.body as string))));
      });
      const sync = startAppSync(platform, clock, { env: 'local', apiUrl: API, authUrl: AUTH, authClientId: 'client-1' }, fetchFn);
      const signInAs = async (who: 'a' | 'b') => {
        next = who;
        await sync.signIn();
        const state = new URL(platform.opened.at(-1)!).searchParams.get('state');
        platform.openDeepLink(`${platform.signInRedirectUri}?code=c&state=${state}`);
        await flush();
      };
      await flush();
      return { platform, db: platform.db, clock, servers, sync, signInAs, fetchFn, shares };
    }

    /** The device's data is a's, one task synced and one written while signed out, and b signs in. */
    async function askedToSwitch() {
      const t = await twoAccounts();
      await t.signInAs('a');
      const synced = await transact(t.db, t.clock, (w) => w.create('task', { kind: 'inbox', title: 'Write the report' }));
      await t.sync.syncNow();
      expect(t.servers.a.record(synced)!.title!.v).toBe('Write the report');

      const other = '1793631600000-000000-other';
      await t.servers.b.send({ cursor: 0, changes: [{ type: 'task', id: 'theirs', fields: { kind: { v: 'inbox', c: other }, title: { v: 'Paint the fence', c: other } } }] });
      await t.sync.signOut();
      const unsynced = await transact(t.db, t.clock, (w) => w.create('task', { kind: 'inbox', title: 'Learn to bake bread' }));
      await t.platform.notifications.replaceAll([{ id: 'r1', kind: 'block_start', block_id: 'b1', at: NOW, title: 'Write the report', actions: [] }]);
      const cursor = await getMeta(t.db, META.cursor);
      t.servers.b.requests.length = 0;
      await t.signInAs('b');
      return { ...t, synced, unsynced, cursor };
    }

    const titles = async (db: Db) => (await db.all<{ title: string }>("SELECT json_extract(data, '$.title') AS title FROM records")).map((r) => r.title).sort();

    it('syncs nothing before the choice, which names the account signing in and the changes that would be lost', async () => {
      const t = await askedToSwitch();
      expect((await syncStatus(t.db)).lastError).toBe('other_account');
      expect(await t.sync.email()).toBe('b@example.com');
      expect(await unsyncedChanges(t.db)).toBe(1);

      // However many triggers fire meanwhile.
      t.platform.lifecycle.foreground();
      await transact(t.db, t.clock, (w) => w.set('task', t.unsynced, { title: 'Learn to bake rye bread' }));
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(t.servers.b.requests).toEqual([]);
      expect(t.servers.b.values()).toEqual({ theirs: { kind: 'inbox', title: 'Paint the fence' } });
      expect(await titles(t.db)).toEqual(['Learn to bake rye bread', 'Write the report']);
      expect(await getMeta(t.db, META.cursor)).toBe(t.cursor);
      expect(await getMeta(t.db, META.account)).toBe('user-a');
      expect(await unsyncedChanges(t.db)).toBe(1);
      t.sync.stop();
    });

    it("Cancel signs that account out as Sign out does and keeps everything, still the old account's", async () => {
      const t = await askedToSwitch();
      await t.sync.signOut();
      const revoked = t.fetchFn.mock.calls.filter(([url]) => url === `${AUTH}/oauth2/revoke`).map(([, init]) => new URLSearchParams(init.body as string).get('token'));
      expect(revoked).toEqual(['r-a', 'r-b']);
      expect((await syncStatus(t.db)).lastError).toBe('sign_in_expired');
      expect(await getMeta(t.db, META.account)).toBe('user-a');
      expect(await titles(t.db)).toEqual(['Learn to bake bread', 'Write the report']);
      expect(t.shares).toHaveLength(1);

      await t.signInAs('a');
      expect((await syncStatus(t.db)).lastError).toBeNull();
      expect(Object.values(t.servers.a.values()).map((r) => r.title).sort()).toEqual(['Learn to bake bread', 'Write the report']);
      expect(t.servers.b.requests).toEqual([]);
      t.sync.stop();
    });

    it("Erase and sign in leaves nothing of the old account on the device, and brings the new one's", async () => {
      const t = await askedToSwitch();
      const device = await getMeta(t.db, META.deviceId);
      await t.sync.eraseAndSignIn();
      await flush();

      expect(await titles(t.db)).toEqual(['Paint the fence']);
      expect(await getRecord(t.db, 'task', t.synced)).toBeUndefined();
      expect(await getRecord(t.db, 'task', t.unsynced)).toBeUndefined();
      expect(await unsyncedChanges(t.db)).toBe(0);
      expect(t.shares).toEqual([]);
      expect(await t.platform.notifications.scheduled()).toEqual([]);
      expect(await getMeta(t.db, META.account)).toBe('user-b');
      expect(await getMeta(t.db, META.deviceId)).toBe(device);
      expect(await syncStatus(t.db)).toEqual({ lastSyncAt: NOW, lastError: null });
      // Nothing of a's went to b, and a keeps what it had.
      expect(t.servers.b.requests.flatMap((r) => r.changes)).toEqual([]);
      expect(Object.values(t.servers.a.values()).map((r) => r.title)).toEqual(['Write the report']);

      // From now on this device is b's.
      const id = await transact(t.db, t.clock, (w) => w.create('task', { kind: 'inbox', title: 'Learn to bake bread' }));
      await t.sync.syncNow();
      expect(t.servers.b.record(id)!.title!.v).toBe('Learn to bake bread');
      t.sync.stop();
    });

    it('Erase waits for a sync under way, so nothing it read of the old data can reach the new account', async () => {
      const t = await askedToSwitch();
      // A sync reads the old outbox, then waits on the token store before its request's account check.
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const read = t.platform.tokens.get;
      vi.spyOn(t.platform.tokens, 'get').mockImplementationOnce(async (key) => {
        await gate;
        return read(key);
      });
      const syncing = t.sync.syncNow();
      await flush();
      const erasing = t.sync.eraseAndSignIn();
      await flush();
      release();
      await Promise.all([syncing, erasing]);
      await flush();

      expect(t.servers.b.requests.flatMap((r) => r.changes)).toEqual([]);
      expect(await titles(t.db)).toEqual(['Paint the fence']);
      t.sync.stop();
    });

    it('a device that has never synced has nothing to ask about, and becomes the account that signs in', async () => {
      const t = await twoAccounts();
      const id = await transact(t.db, t.clock, (w) => w.create('task', { kind: 'inbox', title: 'Write the report' }));
      await t.signInAs('b');
      expect((await syncStatus(t.db)).lastError).toBeNull();
      expect(await getMeta(t.db, META.account)).toBe('user-b');
      expect(t.servers.b.record(id)!.title!.v).toBe('Write the report');
      t.sync.stop();
    });
  });

  it('stop ends the deep link listener too', async () => {
    const t = await app();
    await flush();
    t.sync.stop();
    await t.sync.signIn();
    const state = new URL(t.platform.opened.at(-1)!).searchParams.get('state');
    t.platform.openDeepLink(`${t.platform.signInRedirectUri}?code=c&state=${state}`);
    await flush();
    expect(t.fetchFn).not.toHaveBeenCalled();
    expect(await getMeta(t.platform.db, META.cursor)).toBeNull();
  });
});
