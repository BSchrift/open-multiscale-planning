// Retention end to end with the app's own client: one record of each kind written as the app writes it, then each
// period waited out, checking that a new device doesn't get what expired, that devices which had it removed it, that a
// device holding an old copy is reset, and that an old copy pushed late is dropped.
//
// Against cmd/local, from scripts/integration.sh, it moves the stack's clock and runs its cleanup. Against staging, from
// scripts/test-retention.sh (make test-retention, and make test-deployed), it waits out staging's minutes in real time
// while its cleanup runs, every few minutes as config/retention.yaml says: about 50 minutes. It signs in as the
// deployment's test user.

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadRetention } from '../../../config/retention';
import { createAuth } from './auth';
import type { Clock } from './clock';
import { fixedClock, formatClock, parseClock, systemClock } from './clock';
import { nowInstant, toInstant } from './dates';
import { expireLocal } from './expiry';
import { outcomeId, transact } from './records';
import { addPeriod, configureRetention } from './retention';
import type { Period, Retention } from './retention';
import { createHttpSend, runSync } from './sync';
import type { SyncSend } from './sync';
import { closeProject } from './tasks';
import type { RecordChange, RecordType } from './types';
import { memoryTokens } from '../platform/memory';
import { openTestDb } from '../platform/node-sqlite';

const LOCAL = process.env.INTEGRATION_API_URL;
// Set by scripts/test-retention.sh, with the deployment from scripts/test-target.mjs.
const DEPLOYED = process.env.RETENTION_DEPLOYED === '1' ? (JSON.parse(process.env.MULTISCALE_TARGET ?? '{}') as Target) : undefined;
const MINUTE = 60_000;

interface Target {
  env: string;
  api_url: string;
  client_id: string;
  region: string;
  test_user: { username: string; password: string };
}

type Stage = 'deleted' | 'scheduling' | 'closed' | 'never';

/** The deployment's test user, signed in by password through Cognito's public API, as the integration suite does. */
async function deployedSend(target: Target): Promise<SyncSend> {
  const res = await fetch(`https://cognito-idp.${target.region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
    body: JSON.stringify({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: target.client_id, AuthParameters: { USERNAME: target.test_user.username, PASSWORD: target.test_user.password } }),
  });
  const body = (await res.json()) as { AuthenticationResult?: { AccessToken?: string }; __type?: string };
  // Only Cognito's error type, so a password never reaches the output.
  const token = body.AuthenticationResult?.AccessToken;
  if (!token) throw new Error(`Cognito sign-in: ${res.status} ${body.__type ?? ''}`);
  return createHttpSend({ apiUrl: target.api_url, auth: { accessToken: async () => token, expire: async () => {} }, fetch: (url, init) => fetch(url, init) });
}

/** Someone new on cmd/local, signed in the way an app does, at the clock's time. */
async function localSend(api: string, username: string, clock: Clock): Promise<SyncSend> {
  let opened = '';
  const auth = createAuth({
    authUrl: `${api}/cognito`,
    clientId: 'local-client',
    redirectUri: 'multiscale-local://auth/callback',
    clock,
    tokens: memoryTokens(),
    openExternal: async (url) => void (opened = url),
    fetch: (url, init) => fetch(url, init),
  });
  await auth.signIn();
  const res = await fetch(`${opened}&username=${encodeURIComponent(username)}`, { redirect: 'manual' });
  if (!(await auth.handleRedirect(res.headers.get('location') ?? ''))) throw new Error('local sign-in failed');
  return createHttpSend({ apiUrl: api, auth, fetch: (url, init) => fetch(url, init) });
}

const local = async (path: string, body?: unknown) => {
  const res = await fetch(`${LOCAL}${path}`, { method: 'POST', body: body === undefined ? '' : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
};

describe.skipIf(!LOCAL && !DEPLOYED)('retention end to end', () => {
  const env = DEPLOYED ? DEPLOYED.env : 'local';
  const policy: Retention = loadRetention(env, { read: (path) => readFileSync(path, 'utf8'), parse });
  // How often the deployment's cleanup runs, which its waits are made of. Local runs it when asked.
  const minutes = (p: Period) => (p.days * 24 + p.hours) * 60 + p.minutes;
  const cleanupEvery = policy.cleanup ? minutes(policy.cleanup) * MINUTE : MINUTE;
  const start = Math.floor(Date.now() / 1000) * 1000;
  const clock: Clock & { set?(at: number): void } = DEPLOYED ? systemClock : fixedClock(start);
  const run = crypto.randomUUID().slice(0, 8);
  const id = (name: string) => `rt-${run}-${name}`;
  const kinds = new Map<string, { type: string; stage: Stage }>();
  let send: SyncSend;

  // A device: its own database, synced the way the app's runner does, removing what has expired after each sync.
  const device = async () => {
    const db = await openTestDb();
    return {
      db,
      sync: async () => {
        await runSync(db, (req) => send(req));
        await expireLocal(db, clock);
      },
      has: async () => new Set((await db.all<{ id: string }>('SELECT id FROM records')).map((r) => r.id)),
    };
  };
  type Device = Awaited<ReturnType<typeof device>>;
  let writer: Device;
  let regular: Device;
  let behind: Device;

  /** The counter now: a cursor above it writes nothing and is answered with it. */
  const counter = async () => (await send({ cursor: Number.MAX_SAFE_INTEGER, changes: [] })).cursor;

  /**
   * Moves time on past at. Locally that's the stack's clock and every device's, with its cleanup run twice, as staging's
   * runs would: one marks, one removes. On staging it waits, for the cleanup's two runs too.
   */
  async function until(at: number) {
    if (DEPLOYED) {
      const ready = at + 2 * cleanupEvery + 15_000;
      while (Date.now() < ready) await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, ready - Date.now())));
      return;
    }
    for (const [time, cleanups] of [[at + 1000, 1], [at + MINUTE, 1]] as const) {
      clock.set!(time);
      await local('/_local/clock', { now: new Date(time).toISOString().replace('.000Z', 'Z') });
      for (let i = 0; i < cleanups; i++) await local('/_local/cleanup');
    }
    send = await localSend(LOCAL!, `rt-${run}`, clock);
  }

  /**
   * Which of these the server no longer holds at all: a delete pushed for each as a new record goes in only then, where
   * one still there, expired, drops it. Those deletes go themselves after the deleted period.
   */
  async function removed(keys: readonly string[]): Promise<string[]> {
    const c = formatClock({ wall: clock.now(), counter: 0, device: `probe-${run}` });
    const probes: RecordChange[] = keys.map((key) => ({ type: kinds.get(key)!.type, id: key, fields: { deleted_at: { v: nowInstant(clock), c } } }));
    const res = await send({ cursor: await counter(), changes: probes });
    return res.changes.filter((change) => change.fields.deleted_at?.c === c).map((change) => change.id);
  }

  beforeAll(async () => {
    // Prod's periods are years, and it has real people's data beside the test user's.
    if (DEPLOYED && DEPLOYED.env !== 'staging') throw new Error(`The retention suite runs against staging only, not ${DEPLOYED.env}`);
    configureRetention(policy);
    if (LOCAL) await local('/_local/clock', { now: new Date(start).toISOString().replace('.000Z', 'Z') });
    send = DEPLOYED ? await deployedSend(DEPLOYED) : await localSend(LOCAL!, `rt-${run}`, clock);
    [writer, regular, behind] = [await device(), await device(), await device()];
  }, 60_000);

  afterAll(async () => {
    // On a deployment the test user is every suite's, and what never expires would stay there: each nightly run left a
    // practice, a project and an Inbox item, and the practices' sessions filled Week above the deployed web test's days.
    const never = [...kinds].filter(([, k]) => k.stage === 'never');
    if (writer && never.length) {
      await transact(writer.db, clock, async (w) => {
        for (const [key, k] of never) await w.delete(k.type as RecordType, key);
      });
      await writer.sync();
    }
    configureRetention(null);
    if (LOCAL) await local('/_local/clock', { now: '' });
  });

  // The longest period, its two cleanup runs, and a third for the server to have let go of everything, with room to spare.
  const timeout = DEPLOYED ? minutes(policy.closed) * MINUTE + 3 * cleanupEvery + 10 * MINUTE : 40 * MINUTE;
  it('writes one record of each kind as the app does, then waits out each period', { timeout }, async () => {
    const now = nowInstant(clock);
    const day = (offset: number) => new Date(Date.parse(`${now.slice(0, 10)}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    const add = (key: string, type: string, s: Stage) => kinds.set(id(key), { type, stage: s });

    // Open first, as the device that falls behind sees them.
    await transact(writer.db, clock, async (w) => {
      await w.create('task', { kind: 'inbox', title: 'Oil the hinges' }, id('deleted'));
      await w.create('task', { kind: 'one_off', title: 'Paint the fence' }, id('done'));
      await w.create('objective', { title: 'Keep the house', state: 'active' }, id('goal'));
      await w.create('project', { objective_id: id('goal'), title: 'Rebuild the shed', state: 'active', start: day(-30), end: day(30) }, id('project'));
      await w.create('milestone', { project_id: id('project'), title: 'Walls up' }, id('milestone'));
      await w.create('task', { kind: 'inbox', title: 'Buy brushes' }, id('open'));
      await w.create('project', { title: 'Learn to bake bread', state: 'active', start: day(-30), end: day(30) }, id('active'));
      await w.create('practice', { title: 'Practise piano', target_min: 30, per: 'day', state: 'active' }, id('practice'));
    });
    await writer.sync();
    await behind.sync();
    // It edits the task that will be deleted, and doesn't sync again until that has gone.
    await transact(behind.db, clock, (w) => w.set('task', id('deleted'), { title: 'Oil the gate hinges' }));

    await transact(writer.db, clock, async (w) => {
      await w.delete('task', id('deleted'));
      await w.set('task', id('done'), { done_at: now });
      await closeProject(w, id('project'), 'finished', clock);
      await w.set('objective', id('goal'), { state: 'archived' });
      await w.create('time_block', { task_id: id('open'), start: toInstant(clock.now() - 30 * MINUTE), end: now, tz: 'UTC' }, id('block'));
      await w.create('block_outcome', { result: 'done', answered_at: now }, outcomeId(id('block')));
      await w.create('task_completion', { task_id: id('open'), done_at: now }, id('finish'));
      // Dated records end at a midnight, so these have days to go locally and have already gone on staging.
      await w.create('week_pick', { week_start: day(-8), task_id: id('open'), minutes: 30 }, id('pick'));
      await w.create('week_plan', { week_start: day(-8), finished_at: now }, id('week'));
      await w.create('away_period', { start: day(-3), end: day(-2) }, id('away'));
    });
    add('deleted', 'task', 'deleted');
    for (const [key, type] of [['block', 'time_block'], ['finish', 'task_completion'], ['pick', 'week_pick'], ['week', 'week_plan'], ['away', 'away_period']] as const) add(key, type, 'scheduling');
    kinds.set(outcomeId(id('block')), { type: 'block_outcome', stage: 'scheduling' });
    for (const [key, type] of [['done', 'task'], ['project', 'project'], ['milestone', 'milestone'], ['goal', 'objective']] as const) add(key, type, 'closed');
    for (const [key, type] of [['open', 'task'], ['active', 'project'], ['practice', 'practice']] as const) add(key, type, 'never');

    // Each record's expiry, as the write path worked it out, before anything removed it here.
    const expiry = new Map<string, number | null>();
    for (const key of kinds.keys()) {
      const row = await writer.db.get<{ at: string | null }>("SELECT json_extract(data, '$.expires_at') AS at FROM records WHERE id = :id", { id: key });
      expiry.set(key, row?.at ? Date.parse(row.at) : null);
    }
    const after = (period: Period, from = start) => addPeriod(from, period);
    // A project's and a goal's close counts from their state's clock, which runs ahead of real time once this device has
    // pulled a clock from the future: on a deployment the test user is every suite's, and the server takes clocks up to a
    // day ahead. The closes would then expire that much later than the checks below allow.
    for (const key of [id('project'), id('goal')]) {
      const row = await writer.db.get<{ c: string }>("SELECT json_extract(clocks, '$.state') AS c FROM records WHERE id = :id", { id: key });
      expect(parseClock(row!.c).wall, `${key}: closed at a clock ahead of real time, from one in the account`).toBeLessThanOrEqual(clock.now() + MINUTE);
    }
    for (const [key, k] of kinds) {
      const at = expiry.get(key)!;
      if (k.stage === 'never') expect(at, key).toBeNull();
      // Staging's clock runs on while the writes go out.
      else expect(at, key).toBeLessThanOrEqual(after(policy[k.stage]) + MINUTE);
    }
    expect(expiry.get(id('deleted'))).toBeGreaterThanOrEqual(after(policy.deleted));

    await writer.sync();
    await regular.sync();
    const checkpoints = [policy.deleted, policy.scheduling, policy.closed].map((p) => after(p)).sort((a, b) => a - b);
    const gone = new Set<string>();
    for (const [i, checkpoint] of checkpoints.entries()) {
      await until(checkpoint);
      const now = clock.now();
      const expired = [...kinds.keys()].filter((key) => expiry.get(key) !== null && expiry.get(key)! <= now);
      const waiting = [...kinds.keys()].filter((key) => !expired.includes(key));
      const label = `${new Date(checkpoint).toISOString()}`;

      // A new device gets none of what has expired, and all the rest.
      const fresh = await device();
      await fresh.sync();
      const has = await fresh.has();
      expect(expired.filter((key) => has.has(key)), `${label}: a new device got`).toEqual([]);
      expect(waiting.filter((key) => !has.has(key)), `${label}: a new device is missing`).toEqual([]);

      // A device that had it removed it, by its own clock, on its next sync.
      await regular.sync();
      const kept = await regular.has();
      expect(expired.filter((key) => kept.has(key)), `${label}: a device kept`).toEqual([]);
      expect(waiting.filter((key) => !kept.has(key)), `${label}: a device lost`).toEqual([]);

      if (i === 0) {
        // The device behind held an old copy of the deleted task, and an edit to it: a reset drops both.
        await behind.sync();
        const left = await behind.has();
        expect(left.has(id('deleted')), 'the device behind kept its old copy').toBe(false);
        expect(waiting.filter((key) => !left.has(key)), 'the device behind is missing').toEqual([]);
        expect(await behind.db.all('SELECT * FROM outbox')).toEqual([]);
      }

      // An old copy pushed late, as an app from before sends it, doesn't come back.
      for (const key of expired.filter((k) => !gone.has(k) && (kinds.get(k)!.type === 'task' || kinds.get(k)!.type === 'time_block')).slice(0, 1)) {
        const late = formatClock({ wall: start, counter: 1, device: `late-${run}` });
        const res = await send({ cursor: await counter(), changes: [{ type: kinds.get(key)!.type, id: key, fields: { title: { v: 'Old copy', c: late } } }] });
        expect(res.changes.map((c) => c.id), `${label}: an old copy went in`).not.toContain(key);
        const fresher = await device();
        await fresher.sync();
        expect((await fresher.has()).has(key), `${label}: an old copy came back`).toBe(false);
      }
      expired.forEach((key) => gone.add(key));
    }

    // Everything expired has gone from the server too, which on staging is the cleanup's work.
    const deadline = Date.now() + (DEPLOYED ? cleanupEvery : 0);
    let left = [...gone];
    for (;;) {
      const out = new Set(await removed(left));
      left = left.filter((key) => !out.has(key));
      if (left.length === 0 || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 20_000));
    }
    expect(left, 'still on the server').toEqual([]);
  });
});
