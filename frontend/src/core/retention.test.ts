import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadRetention, parsePeriod } from '../../../config/retention';
import { fixedClock, formatClock } from './clock';
import type { Db } from './db';
import { getRecord, outcomeId, transact, updateSettings } from './records';
import { addPeriod, configureRetention, expiryDiffers, expiryFor, trimmedLists } from './retention';
import type { Retention, StoredRecord } from './retention';
import { openTestDb } from '../platform/node-sqlite';

const NOW = '2026-11-02T15:00:00Z';
const io = { read: (path: string) => readFileSync(path, 'utf8'), parse };
const policy: Retention = { scheduling: parsePeriod('P2Y'), closed: parsePeriod('P5Y'), deleted: parsePeriod('P30D') };
const clockAt = (iso: string, device = 'dev') => formatClock({ wall: Date.parse(iso), counter: 0, device });
const record = (data: Record<string, unknown>, clocks: Record<string, unknown> = {}): StoredRecord => ({ data, clocks });
const expiry = (type: string, data: Record<string, unknown>, clocks?: Record<string, unknown>, parent?: StoredRecord) =>
  expiryFor(type, record(data, clocks), policy, parent);

describe('the committed policy', () => {
  it('loads for each environment, prod with no cleanup and staging in minutes', () => {
    const prod = loadRetention('prod', io);
    expect([prod.scheduling.iso, prod.closed.iso, prod.deleted.iso, prod.cleanup]).toEqual(['P2Y', 'P5Y', 'P30D', undefined]);
    const staging = loadRetention('staging', io);
    expect([staging.deleted.minutes, staging.scheduling.minutes, staging.closed.minutes, staging.cleanup?.minutes]).toEqual([5, 10, 20, 1]);
    expect(loadRetention('local', io)).toEqual(prod);
    expect(() => loadRetention('test', io)).toThrow(/prod, staging and local/);
  });

  it('fails on a bad value anywhere in the file', () => {
    const good = 'scheduling: P2Y\n  closed: P5Y\n  deleted: P30D';
    const file = (staging: string) => ({ read: () => `prod:\n  ${good}\nstaging:\n  ${staging}\nlocal:\n  ${good}\n`, parse });
    expect(() => loadRetention('prod', file(good.replace('P30D', '30 days')))).toThrow(/staging: deleted/);
    expect(() => loadRetention('prod', file(`${good}\n  cleanup: P1M`))).toThrow(/cleanup must be whole minutes/);
    expect(() => loadRetention('prod', file(`${good}\n  cleanup: PT30S`))).toThrow(/cleanup must be whole minutes/);
    expect(() => loadRetention('prod', file(`${good}\n  keep: P1D`))).toThrow(/unknown key keep/);
    expect(() => loadRetention('prod', file('scheduling: P2Y\n  closed: P5Y'))).toThrow(/deleted is required/);
    expect(loadRetention('staging', file(`${good}\n  cleanup: PT1M`)).cleanup?.minutes).toBe(1);
  });

  it('reads ISO 8601 durations of whole numbers only', () => {
    expect(parsePeriod('P1Y2M3W4DT5H6M7S')).toEqual({ iso: 'P1Y2M3W4DT5H6M7S', years: 1, months: 2, days: 25, hours: 5, minutes: 6, seconds: 7 });
    for (const bad of ['', 'P', 'PT', 'P1DT', '30D', 'P-1D', 'P1.5D', 'PT0S', 'P1H', 'p1d', 'P999999Y', 30]) expect(() => parsePeriod(bad)).toThrow();
  });
});

describe('addPeriod', () => {
  it('steps calendar years, months and days in UTC, then the time', () => {
    const at = Date.parse('2024-02-29T10:00:00Z');
    const after = (iso: string) => new Date(addPeriod(at, parsePeriod(iso))).toISOString();
    // The same dates Go's AddDate gives, so the app and the server agree.
    expect(after('P2Y')).toBe('2026-03-01T10:00:00.000Z');
    expect(after('P1M')).toBe('2024-03-29T10:00:00.000Z');
    expect(after('P30D')).toBe('2024-03-30T10:00:00.000Z');
    expect(after('PT10M')).toBe('2024-02-29T10:10:00.000Z');
    expect(after('P1DT1H5S')).toBe('2024-03-01T11:00:05.000Z');
  });
});

describe('expiryFor', () => {
  it('counts scheduling records from when they end', () => {
    expect(expiry('time_block', { start: '2026-11-02T14:00:00Z', end: '2026-11-02T15:00:00Z', cancelled: true })).toBe('2028-11-02T15:00:00Z');
    expect(expiry('task_completion', { task_id: 't', done_at: '2026-11-02T15:00:00Z' })).toBe('2028-11-02T15:00:00Z');
    // A week ends at the next Monday's midnight, and a date at its own, in UTC so every device agrees.
    expect(expiry('week_pick', { week_start: '2026-11-02', task_id: 't', minutes: 30 })).toBe('2028-11-09T00:00:00Z');
    expect(expiry('week_plan', { week_start: '2026-11-02' })).toBe('2028-11-09T00:00:00Z');
    expect(expiry('away_period', { start: '2026-11-02', end: '2026-11-04' })).toBe('2028-11-05T00:00:00Z');
  });

  it('counts an answer from its block, or from when it was answered with no block here', () => {
    const block = record({ end: '2026-11-02T15:00:00Z' });
    expect(expiry('block_outcome', { result: 'done', answered_at: '2026-11-04T09:00:00Z' }, {}, block)).toBe('2028-11-02T15:00:00Z');
    expect(expiry('block_outcome', { result: 'done', answered_at: '2026-11-04T09:00:00Z' })).toBe('2028-11-04T09:00:00Z');
  });

  it('counts closed tasks from when they closed, and keeps open ones and Inbox items', () => {
    expect(expiry('task', { kind: 'one_off', title: 'x', done_at: '2026-11-02T15:00:00Z' })).toBe('2031-11-02T15:00:00Z');
    expect(expiry('task', { kind: 'project', title: 'x', cancelled_at: '2026-11-02T15:00:00Z' })).toBe('2031-11-02T15:00:00Z');
    expect(expiry('task', { kind: 'one_off', title: 'x', done_at: '2026-10-01T00:00:00Z', cancelled_at: '2026-11-02T15:00:00Z' })).toBe('2031-11-02T15:00:00Z');
    expect(expiry('task', { kind: 'one_off', title: 'x', schedule: { type: 'recurring', every: 1, unit: 'week', anchor: '2026-11-02' } })).toBeNull();
    expect(expiry('task', { kind: 'inbox', title: 'x', done_at: null })).toBeNull();
  });

  it('counts finished and dropped projects, with their milestones, and archived goals, from when their state was set', () => {
    const closedAt = { state: clockAt('2026-11-02T15:00:00Z') };
    for (const state of ['finished', 'dropped']) expect(expiry('project', { title: 'x', state }, closedAt)).toBe('2031-11-02T15:00:00Z');
    for (const state of ['active', 'paused']) expect(expiry('project', { title: 'x', state }, closedAt)).toBeNull();
    expect(expiry('milestone', { project_id: 'p', title: 'm' }, {}, record({ state: 'finished' }, closedAt))).toBe('2031-11-02T15:00:00Z');
    expect(expiry('milestone', { project_id: 'p', title: 'm', met_at: '2026-01-01T00:00:00Z' }, {}, record({ state: 'active' }, closedAt))).toBeNull();
    expect(expiry('milestone', { project_id: 'p', title: 'm' })).toBeNull();
    expect(expiry('objective', { title: 'x', state: 'archived' }, closedAt)).toBe('2031-11-02T15:00:00Z');
    for (const state of ['active', 'not_now']) expect(expiry('objective', { title: 'x', state }, closedAt)).toBeNull();
    // A state set by an automatic write doesn't say when.
    expect(expiry('project', { title: 'x', state: 'finished' }, { state: formatClock({ wall: 0, counter: 0, device: 'd' }) })).toBeNull();
  });

  it('keeps practices, settings and the calendar records', () => {
    for (const type of ['practice', 'settings', 'calendar', 'calendar_source']) expect(expiry(type, { state: 'ended', end: '2026-11-02T15:00:00Z' })).toBeNull();
  });

  it('counts anything deleted from when it was deleted, before anything else', () => {
    const deleted = { deleted_at: '2026-11-02T15:00:00Z' };
    for (const type of ['task', 'time_block', 'practice', 'settings', 'calendar_source', 'some_new_type']) {
      expect(expiry(type, { ...deleted, end: '2020-01-01T00:00:00Z', done_at: '2020-01-01T00:00:00Z' })).toBe('2026-12-02T15:00:00Z');
    }
    expect(expiry('milestone', { project_id: 'p' }, {}, record(deleted))).toBe('2026-12-02T15:00:00Z');
  });

  it('gives nothing for a date it can\'t read', () => {
    expect(expiry('time_block', { end: 'soon' })).toBeNull();
    expect(expiry('week_pick', { week_start: '2026-13-45' })).toBeNull();
    expect(expiry('task', { done_at: 7 })).toBeNull();
  });

  it('says when a stored expiry needs writing', () => {
    expect(expiryDiffers(undefined, null)).toBe(false);
    expect(expiryDiffers(null, null)).toBe(false);
    expect(expiryDiffers('2030-01-01T00:00:00Z', null)).toBe(true);
    expect(expiryDiffers(undefined, '2030-01-01T00:00:00Z')).toBe(true);
    expect(expiryDiffers('2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z')).toBe(false);
  });
});

describe('trimmedLists', () => {
  const now = Date.parse(NOW);
  it("drops a project's slip log entries and pinned stretches older than the scheduling period", () => {
    const slip_log = [
      { at: '2024-11-01T00:00:00Z', kind: 'move' },
      { at: '2024-11-03T00:00:00Z', kind: 'end' },
      { kind: 'pause' },
    ];
    expect(trimmedLists('project', { slip_log }, policy, now)).toEqual({ slip_log: slip_log.slice(1) });
    const one_offs = [
      { start: '2024-10-01', end: '2024-11-01' },
      { start: '2024-10-01', end: '2024-11-02' },
    ];
    expect(trimmedLists('settings', { plan_stretch: { one_offs, last_planned: '2026-10-01' } }, policy, now)).toEqual({
      plan_stretch: { one_offs: one_offs.slice(1), last_planned: '2026-10-01' },
    });
    expect(trimmedLists('project', { slip_log: slip_log.slice(1) }, policy, now)).toEqual({});
    expect(trimmedLists('task', { slip_log }, policy, now)).toEqual({});
  });
});

describe('the write path', () => {
  const clock = fixedClock(NOW);
  let db: Db;
  const fields = async (id: string) => (await db.get<{ data: string }>('SELECT data FROM records WHERE id = :id', { id }))!.data;
  const expiresAt = async (id: string) => (JSON.parse(await fields(id)) as { expires_at?: string | null }).expires_at;
  const outboxClock = async (id: string, field: string) =>
    (await db.get<{ clock: string }>('SELECT clock FROM outbox WHERE record_id = :id AND field = :field', { id, field }))?.clock;

  beforeEach(async () => {
    db = await openTestDb();
    configureRetention(policy);
    clock.set(NOW);
  });
  afterEach(() => configureRetention(null));

  it('sets a closed task to expire, clears it when reopened, and sends it with the change', async () => {
    const id = await transact(db, clock, (w) => w.create('task', { kind: 'one_off', title: 'Paint the fence' }));
    expect(await expiresAt(id)).toBeUndefined();
    const previous = await transact(db, clock, (w) => w.set('task', id, { done_at: NOW }));
    expect(previous).toEqual({ done_at: null });
    expect(await expiresAt(id)).toBe('2031-11-02T15:00:00Z');
    expect(await outboxClock(id, 'expires_at')).toBe(await outboxClock(id, 'done_at'));
    await transact(db, clock, (w) => w.set('task', id, { done_at: null }));
    expect(await expiresAt(id)).toBeNull();
  });

  it('lets a delete beat everything, and a restore put it back', async () => {
    const id = await transact(db, clock, (w) => w.create('task', { kind: 'one_off', title: 'x', done_at: NOW }));
    await transact(db, clock, (w) => w.delete('task', id));
    expect(await expiresAt(id)).toBe('2026-12-02T15:00:00Z');
    await transact(db, clock, (w) => w.set('task', id, { deleted_at: null }));
    expect(await expiresAt(id)).toBe('2031-11-02T15:00:00Z');
  });

  it("gives a closed project's milestones its expiry, and takes it back when it's restored", async () => {
    const project = await transact(db, clock, (w) => w.create('project', { title: 'Rebuild the shed', state: 'active', start: '2026-11-01', end: '2026-12-31' }));
    const milestone = await transact(db, clock, (w) => w.create('milestone', { project_id: project, title: 'Walls up' }));
    await transact(db, clock, (w) => w.set('project', project, { state: 'finished' }));
    expect(await expiresAt(project)).toBe('2031-11-02T15:00:00Z');
    expect(await expiresAt(milestone)).toBe('2031-11-02T15:00:00Z');
    // A milestone added to a closed project gets it too.
    const later = await transact(db, clock, (w) => w.create('milestone', { project_id: project, title: 'Roof on' }));
    expect(await expiresAt(later)).toBe('2031-11-02T15:00:00Z');
    await transact(db, clock, (w) => w.set('project', project, { state: 'active' }));
    expect([await expiresAt(project), await expiresAt(milestone), await expiresAt(later)]).toEqual([null, null, null]);
  });

  it("moves an answer's expiry with its block", async () => {
    const block = await transact(db, clock, (w) => w.create('time_block', { task_id: 't', start: '2026-11-02T14:00:00Z', end: '2026-11-02T15:00:00Z', tz: 'UTC' }));
    await transact(db, clock, (w) => w.create('block_outcome', { result: 'done', answered_at: NOW }, outcomeId(block)));
    expect(await expiresAt(outcomeId(block))).toBe('2028-11-02T15:00:00Z');
    await transact(db, clock, (w) => w.set('time_block', block, { end: '2026-11-02T16:00:00Z' }));
    expect(await expiresAt(block)).toBe('2028-11-02T16:00:00Z');
    expect(await expiresAt(outcomeId(block))).toBe('2028-11-02T16:00:00Z');
  });

  it('trims lists on a real write, and leaves them to one on an automatic write', async () => {
    const stretch = { start: '2024-10-01', end: '2024-10-31' };
    await transact(db, clock, (w) => w.automatic.create('settings', { plan_stretch: { one_offs: [stretch] } }, 'settings'));
    expect(JSON.parse(await fields('settings')).plan_stretch.one_offs).toEqual([stretch]);
    await transact(db, clock, (w) => updateSettings(w, { one_offs_weekly_aim: 60 }));
    expect(JSON.parse(await fields('settings')).plan_stretch).toEqual({ one_offs: [] });
    const project = await transact(db, clock, (w) =>
      w.create('project', { title: 'x', state: 'active', start: '2024-01-01', end: '2027-01-01', slip_log: [{ at: '2024-01-01T00:00:00Z', kind: 'move', text: 'Moved.' }] }),
    );
    expect(JSON.parse(await fields(project)).slip_log).toEqual([]);
  });

  it('fills an expiry with the lowest clock through the automatic writer, so a real edit wins', async () => {
    configureRetention(null);
    const id = await transact(db, clock, (w) => w.create('task', { kind: 'one_off', title: 'x', done_at: NOW }));
    configureRetention(policy);
    await transact(db, clock, (w) => w.automatic.refresh(id));
    expect(await expiresAt(id)).toBe('2031-11-02T15:00:00Z');
    expect(await outboxClock(id, 'expires_at')).toMatch(/^0000000000000-000000-/);
    // A field with a clock already ticks as any write does.
    await transact(db, clock, (w) => w.automatic.set('task', id, { title: 'y' }));
    expect(await outboxClock(id, 'title')).not.toMatch(/^0000000000000-/);
    expect(await getRecord(db, 'task', id)).toMatchObject({ title: 'y' });
  });

  it('writes nothing when nothing follows', async () => {
    const id = await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'x' }));
    await db.run('DELETE FROM outbox');
    let changes = 0;
    db.subscribe(() => changes++);
    await transact(db, clock, (w) => w.refresh(id));
    expect(await db.all('SELECT * FROM outbox')).toEqual([]);
    expect(changes).toBe(0);
  });
});
