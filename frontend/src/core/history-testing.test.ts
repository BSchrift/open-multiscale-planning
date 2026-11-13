import { describe, expect, it } from 'vitest';
import { isClock, parseClock } from './clock';
import { RECORD_FIELDS } from './db';
import { historyBatches, historyChanges, historyFacts, HISTORY, keptHistory, seedHistory } from './history-testing';
import { parsePeriod } from '../../../config/retention';
import { ID_PATTERN, outcomeId } from './records';
import { fakeSyncServer } from './sync-testing';
import type { RecordChange, RecordType } from './types';

const changes = historyChanges();
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const value = (change: RecordChange, field: string) => change.fields[field]?.v;
const ofType = (type: RecordType) => changes.filter((c) => c.type === type);
const nowMs = Date.parse(HISTORY.now);
const WEEK_MS = 7 * 86_400_000;

describe('the history', () => {
  it('is the same on every run', () => {
    expect(historyChanges()).toEqual(changes);
    expect(JSON.stringify(historyChanges())).toBe(JSON.stringify(changes));
  });

  it('is about 40,000 records of about 400 bytes each, a fifth of them deleted', () => {
    const facts = historyFacts(changes);
    expect(facts.records).toBe(changes.length);
    expect(changes.length).toBeGreaterThan(38_000);
    expect(changes.length).toBeLessThan(42_000);
    expect(facts.meanBytes).toBeGreaterThan(380);
    expect(facts.meanBytes).toBeLessThan(420);
    expect(facts.deleted / facts.records).toBeGreaterThan(0.19);
    expect(facts.deleted / facts.records).toBeLessThan(0.21);
    expect(new Set(changes.map((c) => c.id)).size).toBe(changes.length);
  });

  it("has a heavy user's weekly mix", () => {
    const perWeek = (n: number) => n / HISTORY.weeks;
    const blocks = ofType('time_block').length;
    const outcomes = ofType('block_outcome').length;
    expect(perWeek(blocks + outcomes)).toBeCloseTo(70, -1);
    expect(perWeek(ofType('task').length)).toBeCloseTo(40, -1);
    expect(perWeek(ofType('week_pick').length)).toBeCloseTo(20, -1);
    expect(perWeek(ofType('task_completion').length)).toBeCloseTo(10, -1);
    const planning = (['week_plan', 'project', 'milestone', 'objective', 'practice', 'away_period', 'calendar_source', 'settings'] as const)
      .map((t) => ofType(t).length)
      .reduce((a, b) => a + b);
    expect(perWeek(planning)).toBeCloseTo(10, -1);
    expect(ofType('settings')).toHaveLength(1);
    // Inbox captures among the tasks, some still waiting to be sorted.
    expect(changes.filter((c) => c.type === 'task' && value(c, 'kind') === 'inbox').length).toBeGreaterThan(HISTORY.weeks * 2);
    expect(historyFacts(changes).openInbox).toBeGreaterThan(5);
  });

  // Each check collects what breaks it rather than asserting per record, which would take tens of seconds.
  it('spreads its dates over five years up to its end, with every answer on a block that ended', () => {
    const blocks = ofType('time_block');
    const starts = blocks.map((c) => Date.parse(value(c, 'start') as string));
    expect(Math.min(...starts)).toBeLessThan(nowMs - 259 * WEEK_MS);
    expect(Math.max(...starts)).toBeLessThan(nowMs);
    expect([...new Set(starts.map((s) => new Date(s).toISOString().slice(0, 4)))].sort()).toEqual(['2021', '2022', '2023', '2024', '2025', '2026']);
    const ids = new Set(changes.map((c) => c.id));
    expect(ofType('block_outcome').filter((o) => !ids.has(o.id.replace(/^outcome:/, '')))).toEqual([]);
    expect(blocks.filter((b) => Date.parse(value(b, 'end') as string) > nowMs)).toEqual([]);
    expect(blocks.filter((b) => !value(b, 'deleted_at') && !ids.has(outcomeId(b.id)))).toEqual([]);
  });

  it('is records the app reads: known types and fields, ids, and references that resolve', () => {
    const ids = new Set(changes.map((c) => c.id));
    const problems: string[] = [];
    for (const change of changes) {
      const fields = RECORD_FIELDS[change.type as RecordType] as readonly string[] | undefined;
      if (!fields) problems.push(`${change.id}: type ${change.type}`);
      if (!ID_PATTERN.test(change.id)) problems.push(`${change.id}: id`);
      for (const field of Object.keys(change.fields)) if (!fields?.includes(field)) problems.push(`${change.id}: field ${field}`);
      for (const ref of ['task_id', 'project_id', 'milestone_id', 'practice_id', 'objective_id']) {
        const id = value(change, ref);
        if (typeof id === 'string' && !ids.has(id)) problems.push(`${change.id}: ${ref} ${id}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('has practices on every kind of schedule: some days, some times a week, and a time of its own on one day', () => {
    const practices = ofType('practice');
    expect(practices.some((c) => value(c, 'per') === 'week' && value(c, 'sessions') === undefined)).toBe(true);
    expect(practices.some((c) => value(c, 'per') === 'week' && value(c, 'sessions') === 3)).toBe(true);
    expect(practices.some((c) => value(c, 'per') === 'day' && (value(c, 'day_times') as unknown[] | undefined)?.length === 7)).toBe(true);
  });

  it('is what the server takes: clocks from before its end, records under the size limit, last write last', () => {
    const problems: string[] = [];
    let last = '';
    for (const change of changes) {
      const clocks = [...new Set(Object.values(change.fields).map((f) => f.c))];
      const clock = clocks[0]!;
      if (clocks.length !== 1 || !isClock(clock)) problems.push(`${change.id}: clocks ${clocks.join(' ')}`);
      else if (parseClock(clock).wall > nowMs || parseClock(clock).counter !== HISTORY.version) problems.push(`${change.id}: clock ${clock}`);
      if (bytes(change.fields) >= 100 * 1024) problems.push(`${change.id}: too large`);
      // In the order the writes happened, so a sync from 0 brings the oldest first and settings, touched last, at the end.
      if (clock < last) problems.push(`${change.id}: out of order`);
      last = clock;
    }
    expect(problems).toEqual([]);
    expect(changes.at(-1)!.type).toBe('settings');
  });
});

describe('keptHistory', () => {
  it('leaves out only the deleted records whose deleted period has passed, which the server would drop', () => {
    const kept = keptHistory(parsePeriod('P30D'), nowMs, changes);
    const gone = changes.filter((c) => !kept.includes(c));
    expect(gone.length).toBeGreaterThan(0);
    for (const c of gone) expect(Date.parse(value(c, 'deleted_at') as string)).toBeLessThanOrEqual(nowMs - 30 * 86_400_000);
    expect(kept.filter((c) => value(c, 'deleted_at') == null)).toHaveLength(changes.filter((c) => value(c, 'deleted_at') == null).length);
    // Deleted within the period, still kept.
    expect(kept.some((c) => typeof value(c, 'deleted_at') === 'string')).toBe(true);
    // An hour on, staging's minutes leave none deleted.
    expect(keptHistory(parsePeriod('PT5M'), nowMs + 3_600_000, changes).filter((c) => value(c, 'deleted_at') != null)).toEqual([]);
  });
});

describe('historyBatches', () => {
  it('splits into batches of at most 99 records and 4 MB, in order', () => {
    const batches = historyBatches(changes);
    expect(batches.flat()).toEqual(changes);
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(99);
      expect(bytes(batch)).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
    const big = Array.from({ length: 50 }, (_, i) => ({ type: 'task', id: `big-${i}`, fields: { title: { v: 'x'.repeat(90_000), c: '0000000000001-000001-history' } } }));
    const split = historyBatches(big);
    expect(split.length).toBeGreaterThan(1);
    for (const batch of split) expect(bytes(batch)).toBeLessThanOrEqual(4 * 1024 * 1024);
  });
});

describe('seedHistory', () => {
  const sample = changes.slice(0, 1000);
  const run = (server: ReturnType<typeof fakeSyncServer>, unitsPerSecond = Infinity) => {
    const slept: number[] = [];
    const ms = { now: 0 };
    return {
      slept,
      done: seedHistory(server.send, {
        changes: sample,
        unitsPerSecond,
        now: () => ms.now,
        sleep: async (wait) => {
          slept.push(wait);
          ms.now += wait;
        },
      }),
    };
  };

  it('writes every record through the sync API, and a rerun writes nothing and never waits', async () => {
    const server = fakeSyncServer({ now: () => nowMs });
    const first = run(server, 500);
    expect(await first.done).toEqual({ batches: 11, written: 1000 });
    expect(server.counter).toBe(1000);
    expect(Object.keys(server.values())).toHaveLength(1000);
    for (const request of server.requests) expect(request.changes.length).toBeLessThanOrEqual(99);
    // As an up-to-date app, so the server takes the history's old clocks as they are.
    expect(server.requests.every((request) => request.expiry_reset === true)).toBe(true);

    const again = run(server, 500);
    expect(await again.done).toEqual({ batches: 11, written: 0 });
    expect(server.counter).toBe(1000);
    expect(again.slept).toEqual([]);
  });

  it('paces batches to the write units the partition takes', async () => {
    const server = fakeSyncServer({ now: () => nowMs });
    const { slept, done } = run(server, 500);
    await done;
    // Two units a kilobyte for each record in a transaction, rounded up, and two for the counter.
    const units = sample.reduce((sum, c) => sum + 2 * Math.ceil((bytes(c) + 100) / 1024), 0) + 2 * 11;
    expect(slept.reduce((a, b) => a + b, 0)).toBeCloseTo((units / 500) * 1000, -1);
  });

  it('sends a refused batch again after a wait, since merging the same records twice is safe', async () => {
    const server = fakeSyncServer({ now: () => nowMs });
    let refusals = 2;
    const send: typeof server.send = async (request) => {
      if (request.changes.length > 0 && refusals-- > 0) throw new Error('409');
      return server.send(request);
    };
    const slept: number[] = [];
    const result = await seedHistory(send, { changes: sample, unitsPerSecond: Infinity, sleep: async (ms) => void slept.push(ms) });
    expect(result.written).toBe(1000);
    expect(slept).toEqual([1000, 2000]);
  });

  it('gives up after five refusals in a row', async () => {
    const send = async (request: { changes: unknown[] }) => {
      if (request.changes.length > 0) throw new Error('503');
      return { cursor: 0, more: false, changes: [] };
    };
    await expect(seedHistory(send, { changes: sample, unitsPerSecond: Infinity, sleep: async () => undefined })).rejects.toThrow('503');
  });
});
