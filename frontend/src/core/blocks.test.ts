import { describe, expect, it } from 'vitest';
import {
  answerBlock,
  answerBlocks,
  currentBlock,
  extendBlock,
  isPaused,
  keepPracticeChange,
  markDoneNow,
  moveBlock,
  nextBlock,
  partlyLeft,
  pauseBlock,
  placeBlock,
  placeSession,
  placeWeekPractices,
  removeBlock,
  resumeBlock,
  ringFill,
  skipPractice,
  spentLine,
  startBlock,
  startEarly,
  startTaskNow,
  swapBlocks,
  timeLeftMs,
  timeSpentMs,
  unscheduleBlock,
  workMinutes,
} from './blocks';
import { fixedClock } from './clock';
import { openDb } from './db';
import { applyPlanChange } from './plan';
import type { BlockRow } from './queries';
import { blocksInRange } from './queries';
import { getRecord, listRecords, outcomeId, setWeekPick, transact, weekPickId, weekPlanId } from './records';
import type { Writer } from './records';
import { missedBlocks } from './reminders';
import { runSync } from './sync';
import { fakeSyncServer } from './sync-testing';
import { tickOneOff } from './tasks';
import { nodeSqliteDriver, openTestDb } from '../platform/node-sqlite';

const NOW = '2026-11-02T18:30:00Z';
const at = (time: string) => `2026-11-02T${time}:00Z`;

async function setup(seed: (w: Writer) => Promise<unknown> = async () => undefined) {
  const clock = fixedClock(NOW);
  const db = await openDb(nodeSqliteDriver());
  await transact(db, clock, async (w) => {
    await w.create('task', { kind: 'project', project_id: 'p', title: 'Write the report', estimate_min: 180, remaining_min: 180 }, 't');
    await w.create('time_block', { task_id: 't', start: at('18:00'), end: at('19:00'), tz: 'UTC' }, 'now');
    await w.create('time_block', { task_id: 't', start: at('21:00'), end: at('22:00'), tz: 'UTC' }, 'later');
    await w.create('task', { kind: 'one_off', title: 'Paint the fence' }, 'o');
    await w.create('time_block', { task_id: 'o', start: at('20:00'), end: at('20:30'), tz: 'UTC' }, 'next');
    await w.create('practice', { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' }, 'pr');
    await w.create('time_block', { practice_id: 'pr', start: at('17:00'), end: at('17:30'), tz: 'UTC' }, 'piano');
    await seed(w);
  });
  const run = <R>(fn: (w: Writer) => Promise<R>) => transact(db, clock, fn);
  const block = (id: string) => getRecord(db, 'time_block', id);
  const rows = () => blocksInRange(db, { from_utc: at('00:00'), to_utc: '2026-11-03T00:00:00Z' });
  return { clock, db, run, block, rows };
}

describe('which block is now and next', () => {
  const row = (id: string, start: string, end: string, over: Partial<BlockRow> = {}): BlockRow => ({
    id, start, end, tz: 'UTC', task_id: 't', practice_id: null, started_at: null, ended_at: null, title: 'Write the report', task_kind: 'project', result: null, ...over,
  });
  const clock = fixedClock(NOW);

  it('now is the unanswered block under the clock, and next the first one after it', () => {
    const blocks = [row('a', at('17:00'), at('18:00')), row('b', at('18:00'), at('19:00')), row('c', at('20:00'), at('21:00')), row('d', at('19:30'), at('20:00'))];
    expect(currentBlock(blocks, clock)?.id).toBe('b');
    expect(nextBlock(blocks, clock)?.id).toBe('d');
  });

  it('a block answered or ended early is no longer now', () => {
    expect(currentBlock([row('b', at('18:00'), at('19:00'), { result: 'done' })], clock)).toBeUndefined();
    expect(currentBlock([row('b', at('18:00'), at('19:00'), { ended_at: at('18:20') })], clock)).toBeUndefined();
  });
});

describe('answering a block', () => {
  it('Done finishes the task, frees its later blocks, and undoes exactly', async () => {
    const t = await setup();
    const undo = await t.run((w) => answerBlock(w, 'now', { result: 'done' }, t.clock));
    expect(await getRecord(t.db, 'block_outcome', outcomeId('now'))).toMatchObject({ result: 'done', answered_at: NOW });
    expect((await getRecord(t.db, 'task', 't'))?.done_at).toBe(NOW);
    expect((await t.block('later'))?.cancelled).toBe(true);

    await t.run((w) => applyPlanChange(w, undo));
    expect((await getRecord(t.db, 'task', 't'))?.done_at).toBeNull();
    expect((await t.block('later'))?.cancelled).toBeNull();
    expect((await t.rows()).find((b) => b.id === 'now')?.result).toBeNull();
  });

  it('Done on a one off ticks it and logs the finish', async () => {
    const t = await setup();
    await t.run((w) => answerBlock(w, 'next', { result: 'done' }, t.clock));
    expect((await getRecord(t.db, 'task', 'o'))?.done_at).toBe(NOW);
    expect((await listRecords(t.db, 'task_completion')).map((c) => c.task_id)).toEqual(['o']);
  });

  it('a Done answered days later finishes the task when its block ended, for a project task and a one-time one off', async () => {
    const t = await setup(async (w) => {
      await w.create('time_block', { task_id: 't', start: '2026-11-05T17:00:00Z', end: '2026-11-05T18:00:00Z', tz: 'UTC' }, 'thu');
      await w.create('time_block', { task_id: 'o', start: '2026-11-05T19:00:00Z', end: '2026-11-05T19:30:00Z', tz: 'UTC' }, 'thu-o');
    });
    t.clock.set('2026-11-09T08:00:00Z');
    await t.run((w) => answerBlock(w, 'thu', { result: 'done' }, t.clock));
    await t.run((w) => answerBlock(w, 'thu-o', { result: 'done' }, t.clock));
    expect((await getRecord(t.db, 'task', 't'))?.done_at).toBe('2026-11-05T18:00:00Z');
    expect((await getRecord(t.db, 'task', 'o'))?.done_at).toBe('2026-11-05T19:30:00Z');
    expect((await listRecords(t.db, 'task_completion')).map((c) => c.done_at)).toEqual(['2026-11-05T19:30:00Z']);
  });

  it('Done on a repeating one off already ticked today leaves it alone', async () => {
    const t = await setup((w) =>
      w.create('task', { kind: 'one_off', title: 'Water the plants', schedule: { type: 'float', every: 1, unit: 'week' }, next_due: '2026-11-02' }, 'r'),
    );
    await t.run(async (w) => {
      await w.create('time_block', { task_id: 'r', start: at('10:00'), end: at('10:30'), tz: 'UTC' }, 'r1');
      await w.create('time_block', { task_id: 'r', start: at('12:00'), end: at('12:30'), tz: 'UTC' }, 'r2');
    });
    await t.run((w) => answerBlock(w, 'r1', { result: 'done' }, t.clock));
    expect((await getRecord(t.db, 'task', 'r'))?.next_due).toBe('2026-11-09');
    await t.run((w) => answerBlock(w, 'r2', { result: 'done' }, t.clock));
    expect((await getRecord(t.db, 'task', 'r'))?.next_due).toBe('2026-11-09');
    expect(await listRecords(t.db, 'task_completion')).toHaveLength(1);
  });

  describe('a late Done on a repeating one off', () => {
    const daily = { kind: 'one_off' as const, title: 'Water the plants', schedule: { type: 'recurring' as const, every: 1, unit: 'day' as const, anchor: '2026-10-01' }, next_due: '2026-11-02' };
    const evening = (day: string) => ({ task_id: 'r', start: `2026-11-${day}T21:00:00Z`, end: `2026-11-${day}T21:30:00Z`, tz: 'UTC' });

    it("finishes the day the block was for, keeping today's occurrence and its block", async () => {
      const t = await setup(async (w) => {
        await w.create('task', daily, 'r');
        await w.create('time_block', evening('02'), 'mon');
        await w.create('time_block', evening('03'), 'tue');
      });
      t.clock.set('2026-11-03T08:00:00Z');
      await t.run((w) => answerBlock(w, 'mon', { result: 'done' }, t.clock));
      expect((await getRecord(t.db, 'task', 'r'))?.next_due).toBe('2026-11-03');
      expect((await t.block('tue'))?.cancelled).toBeUndefined();
      expect((await listRecords(t.db, 'task_completion')).map((c) => c.done_at)).toEqual(['2026-11-02T21:30:00Z']);
    });

    it('records each missed occurrence answered Done, and leaves the one still to come', async () => {
      const t = await setup(async (w) => {
        await w.create('task', daily, 'r');
        for (const day of ['02', '03', '04', '05']) await w.create('time_block', evening(day), `b${day}`);
      });
      t.clock.set('2026-11-05T08:00:00Z');
      for (const day of ['02', '03', '04']) await t.run((w) => answerBlock(w, `b${day}`, { result: 'done' }, t.clock));
      expect(await listRecords(t.db, 'task_completion')).toHaveLength(3);
      expect((await getRecord(t.db, 'task', 'r'))?.next_due).toBe('2026-11-05');
      expect((await t.block('b05'))?.cancelled).toBeUndefined();
    });

    it('leaves an occurrence alone that was ticked after its block began', async () => {
      const t = await setup(async (w) => {
        await w.create('task', daily, 'r');
        await w.create('time_block', evening('02'), 'mon');
      });
      t.clock.set('2026-11-03T08:00:00Z');
      await t.run((w) => tickOneOff(w, 'r', t.clock));
      await t.run((w) => answerBlock(w, 'mon', { result: 'done' }, t.clock));
      expect((await getRecord(t.db, 'task', 'r'))?.next_due).toBe('2026-11-04');
      expect(await listRecords(t.db, 'task_completion')).toHaveLength(1);
    });
  });

  it('Partly keeps the task open with the time left', async () => {
    const t = await setup();
    await t.run((w) => answerBlock(w, 'now', { result: 'partly', remaining_min: 90 }, t.clock));
    const task = await getRecord(t.db, 'task', 't');
    expect(task?.remaining_min).toBe(90);
    expect(task?.done_at).toBeUndefined();
    expect(await getRecord(t.db, 'block_outcome', outcomeId('now'))).toMatchObject({ result: 'partly', remaining_min: 90 });
  });

  it('Not done changes only the outcome', async () => {
    const t = await setup();
    await t.run((w) => answerBlock(w, 'now', { result: 'not' }, t.clock));
    expect((await getRecord(t.db, 'task', 't'))?.remaining_min).toBe(180);
    expect((await t.block('later'))?.cancelled).toBeUndefined();
  });

  it('a practice logs minutes, and a second answer corrects the first', async () => {
    const t = await setup();
    await t.run((w) => answerBlock(w, 'piano', { result: 'done', logged_min: 30 }, t.clock));
    await t.run((w) => answerBlock(w, 'piano', { result: 'done', logged_min: 20 }, t.clock));
    expect(await getRecord(t.db, 'block_outcome', outcomeId('piano'))).toMatchObject({ result: 'done', logged_min: 20 });
  });

  it('answering again after an Undo brings the outcome back', async () => {
    const t = await setup();
    const undo = await t.run((w) => answerBlock(w, 'now', { result: 'not' }, t.clock));
    await t.run((w) => applyPlanChange(w, undo));
    await t.run((w) => answerBlock(w, 'now', { result: 'not' }, t.clock));
    expect((await t.rows()).find((b) => b.id === 'now')?.result).toBe('not');
  });
});

describe('answering several missed blocks at once', () => {
  // Earlier today: two missed blocks of the report, then one of the fence. 'now' is still running.
  const missed = async (w: Writer) => {
    await w.create('time_block', { task_id: 't', start: at('10:00'), end: at('11:00'), tz: 'UTC' }, 'm1');
    await w.create('time_block', { task_id: 'o', start: at('12:00'), end: at('12:30'), tz: 'UTC' }, 'm2');
    await w.create('time_block', { task_id: 't', start: at('14:00'), end: at('15:00'), tz: 'UTC' }, 'm3');
  };
  const outcome = (t: Awaited<ReturnType<typeof setup>>, id: string) => getRecord(t.db, 'block_outcome', outcomeId(id));

  it('answers each in one transaction, and one reverse undoes them all', async () => {
    const t = await setup(missed);
    const undo = await t.run((w) =>
      answerBlocks(
        w,
        [
          { blockId: 'm2', answer: { result: 'not' } },
          { blockId: 'm3', answer: { result: 'partly', remaining_min: 45 } },
          { blockId: 'piano', answer: { result: 'done', logged_min: 20 } },
        ],
        t.clock,
      ),
    );
    expect(await outcome(t, 'm2')).toMatchObject({ result: 'not' });
    expect(await outcome(t, 'm3')).toMatchObject({ result: 'partly', remaining_min: 45 });
    expect(await outcome(t, 'piano')).toMatchObject({ result: 'done', logged_min: 20 });
    expect((await getRecord(t.db, 'task', 't'))?.remaining_min).toBe(45);
    expect(undo.freed).toEqual([]);

    await t.run((w) => applyPlanChange(w, undo));
    const rows = await t.rows();
    expect(['m2', 'm3', 'piano'].map((id) => rows.find((b) => b.id === id)?.result)).toEqual([null, null, null]);
    expect((await getRecord(t.db, 'task', 't'))?.remaining_min).toBe(180);
  });

  it('a Done that closes a task takes its later missed blocks with it, and Undo brings them back', async () => {
    const t = await setup(missed);
    const undo = await t.run((w) => answerBlocks(w, [{ blockId: 'm1', answer: { result: 'done' } }], t.clock));
    expect((await getRecord(t.db, 'task', 't'))?.done_at).toBe(at('11:00'));
    expect(undo.freed).toEqual(['m3']);
    expect((await t.block('m3'))?.cancelled).toBe(true);
    // The block running now isn't missed, and another task's block stays.
    expect((await t.block('now'))?.cancelled).toBeUndefined();
    expect((await t.block('m2'))?.cancelled).toBeUndefined();

    await t.run((w) => applyPlanChange(w, undo));
    expect((await getRecord(t.db, 'task', 't'))?.done_at).toBeNull();
    expect((await t.block('m3'))?.cancelled).toBeNull();
    expect((await t.rows()).find((b) => b.id === 'm1')?.result).toBeNull();
  });

  it('keeps a later block that is answered in the same batch, started, or earlier than the finish', async () => {
    const t = await setup(async (w) => {
      await missed(w);
      await w.create('time_block', { task_id: 't', start: at('08:00'), end: at('09:00'), tz: 'UTC' }, 'm0');
      await w.create('time_block', { task_id: 't', start: at('16:00'), end: at('17:00'), tz: 'UTC', started_at: at('16:05') }, 'm4');
    });
    const undo = await t.run((w) =>
      answerBlocks(
        w,
        [
          { blockId: 'm1', answer: { result: 'done' } },
          { blockId: 'm3', answer: { result: 'not' } },
        ],
        t.clock,
      ),
    );
    expect(undo.freed).toEqual([]);
    expect(await outcome(t, 'm3')).toMatchObject({ result: 'not' });
    for (const id of ['m0', 'm3', 'm4']) expect((await t.block(id))?.cancelled).toBeUndefined();
  });

  it('Partly, Not done, and a Done that leaves the task open take nothing else', async () => {
    const t = await setup(async (w) => {
      await missed(w);
      await w.create('task', { kind: 'one_off', title: 'Water the plants', schedule: { type: 'float', every: 1, unit: 'day' }, next_due: '2026-11-02' }, 'r');
      await w.create('time_block', { task_id: 'r', start: at('07:00'), end: at('07:30'), tz: 'UTC' }, 'r1');
      await w.create('time_block', { task_id: 'r', start: at('15:00'), end: at('15:30'), tz: 'UTC' }, 'r2');
    });
    const undo = await t.run((w) =>
      answerBlocks(
        w,
        [
          { blockId: 'r1', answer: { result: 'done' } },
          { blockId: 'm1', answer: { result: 'partly', remaining_min: 60 } },
        ],
        t.clock,
      ),
    );
    expect(undo.freed).toEqual([]);
    expect((await t.block('r2'))?.cancelled).toBeUndefined();
    expect((await t.block('m3'))?.cancelled).toBeUndefined();
  });
});

describe('the time left for Partly', () => {
  it('is the estimate less this block, or the block itself when the estimate is used up', () => {
    const block = { start: at('18:00'), end: at('19:00') };
    expect(partlyLeft({ remaining_min: 180, estimate_min: 240 }, block)).toBe(120);
    expect(partlyLeft({ estimate_min: 90 }, block)).toBe(30);
    expect(partlyLeft({ remaining_min: 45 }, block)).toBe(60);
    expect(partlyLeft({}, block)).toBe(60);
  });
});

describe('moving through the day', () => {
  it('Mark done now ends the block at once, finishes the task, and undoes exactly', async () => {
    const t = await setup();
    const undo = await t.run((w) => markDoneNow(w, 'now', t.clock));
    expect((await t.block('now'))?.ended_at).toBe(NOW);
    expect((await getRecord(t.db, 'task', 't'))?.done_at).toBe(NOW);
    await t.run((w) => applyPlanChange(w, undo));
    expect((await t.block('now'))?.ended_at).toBeNull();
    expect(currentBlock(await t.rows(), t.clock)?.id).toBe('now');
  });

  it('Start records the time it started', async () => {
    const t = await setup();
    await t.run((w) => startBlock(w, 'now', t.clock));
    expect((await t.block('now'))?.started_at).toBe(NOW);
  });

  it('Start early moves the next block to now, keeping its length', async () => {
    const t = await setup();
    await t.run((w) => startEarly(w, 'next', t.clock));
    expect(await t.block('next')).toMatchObject({ start: NOW, end: at('19:00'), started_at: NOW });
  });

  it('Do next block instead trades the work of two blocks and keeps their times', async () => {
    const t = await setup();
    const undo = await t.run((w) => swapBlocks(w, 'now', 'piano'));
    expect(await t.block('now')).toMatchObject({ task_id: null, practice_id: 'pr', start: at('18:00') });
    expect(await t.block('piano')).toMatchObject({ task_id: 't', practice_id: null, start: at('17:00') });
    await t.run((w) => applyPlanChange(w, undo));
    expect(await t.block('now')).toMatchObject({ task_id: 't', practice_id: null });
  });

  it('starting a task with nothing planned puts it on the clock now, for its time left up to 2h', async () => {
    const t = await setup();
    const id = await t.run((w) => startTaskNow(w, 'o', t.clock));
    expect(await t.block(id)).toMatchObject({ task_id: 'o', start: NOW, end: at('19:00'), started_at: NOW, tz: 'UTC' });
    const long = await t.run((w) => startTaskNow(w, 't', t.clock));
    expect((await t.block(long))?.end).toBe(at('20:30'));
  });

  it('Still going adds time to the end', async () => {
    const t = await setup();
    await t.run((w) => extendBlock(w, 'now', 30));
    expect((await t.block('now'))?.end).toBe(at('19:30'));
  });
});

describe('editing the week', () => {
  it('moving a block writes its new time once and undoes exactly, a practice session too', async () => {
    const t = await setup();
    const undo = await t.run((w) => moveBlock(w, 'later', { start: at('20:00'), end: at('21:30') }));
    expect(await t.block('later')).toMatchObject({ start: at('20:00'), end: at('21:30') });
    await t.run((w) => applyPlanChange(w, undo));
    expect(await t.block('later')).toMatchObject({ start: at('21:00'), end: at('22:00') });

    await t.run((w) => moveBlock(w, 'piano', { start: at('16:00'), end: at('16:30') }));
    expect(await t.block('piano')).toMatchObject({ start: at('16:00'), end: at('16:30') });
    expect(await t.block('piano')).not.toHaveProperty('edited');
  });

  it('removing a block takes it off the week and gives the time back, with Undo', async () => {
    const t = await setup();
    const undo = await t.run((w) => removeBlock(w, 'later'));
    expect((await t.rows()).map((b) => b.id)).not.toContain('later');
    await t.run((w) => applyPlanChange(w, undo));
    expect((await t.rows()).map((b) => b.id)).toContain('later');
  });

  it('placing a task adds a block in the zone it was placed in, and Undo takes it away', async () => {
    const t = await setup();
    const undo = await t.run((w) => placeBlock(w, 'o', { start: at('22:00'), end: at('23:00') }, t.clock));
    const id = undo.writes[0]!.id;
    expect(await t.block(id)).toMatchObject({ task_id: 'o', start: at('22:00'), end: at('23:00'), tz: 'UTC' });
    await t.run((w) => applyPlanChange(w, undo));
    expect((await t.rows()).map((b) => b.id)).not.toContain(id);
  });

  it('keeping a practice change for every week moves its preferred time and target', async () => {
    const t = await setup((w) => w.create('practice', { title: 'Sketch', target_min: 120, per: 'week', state: 'active' }, 'sk'));
    await t.run((w) => w.create('time_block', { practice_id: 'sk', start: at('07:00'), end: at('08:30'), tz: 'UTC' }, 's1'));

    const undo = await t.run((w) => keepPracticeChange(w, 'piano', 30, t.clock));
    expect(await getRecord(t.db, 'practice', 'pr')).toMatchObject({ preferred_times: [17 * 60], target_min: 30 });
    await t.run((w) => moveBlock(w, 'piano', { start: at('06:15'), end: at('07:00') }));
    await t.run((w) => keepPracticeChange(w, 'piano', 30, t.clock));
    expect(await getRecord(t.db, 'practice', 'pr')).toMatchObject({ preferred_times: [6 * 60 + 15], target_min: 45 });
    await t.run((w) => applyPlanChange(w, undo));
    expect((await getRecord(t.db, 'practice', 'pr'))?.preferred_times).toBeNull();

    // A weekly target grows or shrinks with the session, from 60 to 90 minutes here.
    await t.run((w) => keepPracticeChange(w, 's1', 60, t.clock));
    expect(await getRecord(t.db, 'practice', 'sk')).toMatchObject({ preferred_times: [7 * 60], target_min: 180 });
  });

  it('a block longer than the time left raises the estimate, and Undo puts it back', async () => {
    const t = await setup();
    // 3h left, with 1h already ahead at 9pm, so a 3h block is 1h over.
    const undo = await t.run((w) => placeBlock(w, 't', { start: at('22:00'), end: '2026-11-03T01:00:00Z' }, t.clock));
    expect(await getRecord(t.db, 'task', 't')).toMatchObject({ estimate_min: 240, remaining_min: 240 });
    await t.run((w) => applyPlanChange(w, undo));
    expect(await getRecord(t.db, 'task', 't')).toMatchObject({ estimate_min: 180, remaining_min: 180 });
    expect((await t.rows()).map((b) => b.id)).not.toContain(undo.writes[0]!.id);

    await t.run((w) => placeBlock(w, 'o', { start: at('22:00'), end: at('23:00') }, t.clock));
    expect((await getRecord(t.db, 'task', 'o'))?.estimate_min).toBeUndefined();
  });
});

describe("placing the week's practices", () => {
  const WEEK = '2026-11-02';
  const sketch = (fields = {}) => (w: Writer) =>
    w.create('practice', { title: 'Sketch', target_min: 60, per: 'day', days: [1, 2], preferred_times: [7 * 60], state: 'active', ...fields }, 'sk');
  const sessions = async (db: Parameters<typeof listRecords>[0], id = 'sk') =>
    (await listRecords(db, 'time_block'))
      .filter((b) => b.practice_id === id && !b.deleted_at && !b.cancelled)
      .map((b) => [b.start, b.end])
      .sort();
  // Piano paused, so only Sketch is placed.
  const alone = (fields = {}) => async (w: Writer) => {
    await sketch(fields)(w);
    await w.set('practice', 'pr', { state: 'paused' });
  };

  it('places the sessions each practice is missing, around what is there, and Undo takes them away', async () => {
    const t = await setup(sketch());
    const undo = await t.run((w) => placeWeekPractices(w, WEEK, t.clock));
    expect(await sessions(t.db)).toHaveLength(2);
    // Piano has Monday's session, so it gets Tuesday to Sunday.
    expect(await sessions(t.db, 'pr')).toHaveLength(7);
    expect((await t.run((w) => placeWeekPractices(w, WEEK, t.clock))).writes).toEqual([]);
    await t.run((w) => applyPlanChange(w, undo));
    expect(await sessions(t.db)).toEqual([]);
    expect(await sessions(t.db, 'pr')).toEqual([[at('17:00'), at('17:30')]]);
  });

  it('a practice skipped this week gives up its sessions still to come, and included again it waits to be placed', async () => {
    const t = await setup(sketch());
    await t.run((w) => placeWeekPractices(w, WEEK, t.clock));
    const undo = await t.run((w) => skipPractice(w, WEEK, 'sk', true, t.clock));
    expect(await sessions(t.db)).toEqual([]);
    expect((await getRecord(t.db, 'week_plan', weekPlanId(WEEK)))?.skipped_practices).toEqual(['sk']);
    await t.run((w) => applyPlanChange(w, undo));
    expect(await sessions(t.db)).toHaveLength(2);
    expect((await getRecord(t.db, 'week_plan', weekPlanId(WEEK)))?.deleted_at).toBeTruthy();

    await t.run((w) => skipPractice(w, WEEK, 'sk', true, t.clock));
    await t.run((w) => skipPractice(w, WEEK, 'sk', false, t.clock));
    expect(await sessions(t.db)).toEqual([]);
    await t.run((w) => placeWeekPractices(w, WEEK, t.clock));
    expect(await sessions(t.db)).toHaveLength(2);
  });

  it('two devices placing the same week before they sync end up with one session a day', async () => {
    const clock = fixedClock(NOW);
    const server = fakeSyncServer({ now: () => clock.now() });
    const [phone, desk] = [await openTestDb(), await openTestDb()];
    await transact(phone, clock, sketch());
    await runSync(phone, server.send);
    await runSync(desk, server.send);
    await transact(phone, clock, (w) => placeWeekPractices(w, WEEK, clock));
    await transact(desk, clock, (w) => placeWeekPractices(w, WEEK, clock));
    for (const db of [phone, desk, phone]) await runSync(db, server.send);
    expect(await sessions(phone)).toEqual([
      ['2026-11-03T07:00:00Z', '2026-11-03T08:00:00Z'],
      ['2026-11-04T07:00:00Z', '2026-11-04T08:00:00Z'],
    ]);
  });

  it('skipping a practice and placing it again undoes exactly, though its sessions come back on the same records', async () => {
    const t = await setup(sketch());
    await t.run((w) => placeWeekPractices(w, WEEK, t.clock));
    await t.run((w) => skipPractice(w, WEEK, 'sk', true, t.clock));
    await t.run((w) => skipPractice(w, WEEK, 'sk', false, t.clock));
    await t.run((w) => w.set('practice', 'sk', { preferred_times: [9 * 60] }));
    const undo = await t.run((w) => placeWeekPractices(w, WEEK, t.clock));
    expect(await sessions(t.db)).toEqual([
      ['2026-11-03T09:00:00Z', '2026-11-03T10:00:00Z'],
      ['2026-11-04T09:00:00Z', '2026-11-04T10:00:00Z'],
    ]);
    await t.run((w) => applyPlanChange(w, undo));
    expect(await sessions(t.db)).toEqual([]);
  });

  it('a session taken off the calendar is placed again, and one moved by hand stays where it is', async () => {
    const t = await setup(alone());
    await t.run((w) => placeWeekPractices(w, WEEK, t.clock));
    const [tue, wed] = (await listRecords(t.db, 'time_block')).filter((b) => b.practice_id === 'sk').sort((a, b) => (a.start < b.start ? -1 : 1));
    await t.run((w) => removeBlock(w, tue!.id));
    await t.run((w) => moveBlock(w, wed!.id, { start: '2026-11-04T06:00:00Z', end: '2026-11-04T07:00:00Z' }));
    await t.run((w) => placeWeekPractices(w, WEEK, t.clock));
    expect(await sessions(t.db)).toEqual([
      ['2026-11-03T07:00:00Z', '2026-11-03T08:00:00Z'],
      ['2026-11-04T06:00:00Z', '2026-11-04T07:00:00Z'],
    ]);
  });

  it('"every week" changes the usual time and leaves the other sessions where they are', async () => {
    // Monday 6am, before any session: two 60-minute sessions a week, Tuesday to Thursday.
    const t = await setup(alone({ target_min: 120, per: 'week', days: [1, 2, 3] }));
    t.clock.set('2026-11-02T06:00:00Z');
    await t.run((w) => placeWeekPractices(w, WEEK, t.clock));
    const tue = (await listRecords(t.db, 'time_block')).find((b) => b.practice_id === 'sk' && b.start.startsWith('2026-11-03'))!;
    await t.run((w) => moveBlock(w, tue.id, { start: '2026-11-05T09:00:00Z', end: '2026-11-05T10:00:00Z' }));
    await t.run((w) => keepPracticeChange(w, tue.id, 60, t.clock));
    expect((await getRecord(t.db, 'practice', 'sk'))?.preferred_times).toEqual([9 * 60]);
    expect(await sessions(t.db)).toEqual([
      ['2026-11-04T07:00:00Z', '2026-11-04T08:00:00Z'],
      ['2026-11-05T09:00:00Z', '2026-11-05T10:00:00Z'],
    ]);
  });
});

describe('placing and unscheduling by hand', () => {
  const WEEK = '2026-11-02';
  const live = async (db: Parameters<typeof listRecords>[0]) => (await listRecords(db, 'time_block')).filter((b) => !b.cancelled).map((b) => b.id);

  it('places one practice session, and Undo takes it away', async () => {
    const t = await setup();
    const undo = await t.run((w) => placeSession(w, 'pr', { start: '2026-11-03T07:00:00Z', end: '2026-11-03T07:30:00Z' }, t.clock));
    expect(await t.block(undo.writes[0]!.id)).toMatchObject({ practice_id: 'pr', start: '2026-11-03T07:00:00Z', tz: 'UTC' });
    await t.run((w) => applyPlanChange(w, undo));
    expect((await t.block(undo.writes[0]!.id))?.deleted_at).toBeTruthy();
  });

  it("a task not picked is picked for the time placed, so taking its block off keeps it in the week, and Undo puts it back", async () => {
    const t = await setup();
    const undo = await t.run((w) => unscheduleBlock(w, 'later', WEEK, t.clock));
    expect(await live(t.db)).not.toContain('later');
    // 1h at 6pm stays on the calendar and 1h at 9pm comes off, so 1h is left to place.
    expect(await getRecord(t.db, 'week_pick', weekPickId(WEEK, 't'))).toMatchObject({ minutes: 120, deleted_at: null });
    expect(await getRecord(t.db, 'week_pick', weekPickId(WEEK, 't'))).not.toHaveProperty('skipped');
    await t.run((w) => applyPlanChange(w, undo));
    expect(await live(t.db)).toContain('later');
    expect((await getRecord(t.db, 'week_pick', weekPickId(WEEK, 't')))?.deleted_at).toBeTruthy();
  });

  it('a picked task keeps its pick, and a practice session just comes off', async () => {
    const t = await setup((w) => setWeekPick(w, WEEK, 't', 180));
    await t.run((w) => unscheduleBlock(w, 'later', WEEK, t.clock));
    expect((await getRecord(t.db, 'week_pick', weekPickId(WEEK, 't')))?.minutes).toBe(180);
    const undo = await t.run((w) => unscheduleBlock(w, 'piano', WEEK, t.clock));
    expect(undo.writes).toHaveLength(1);
    expect(await live(t.db)).not.toContain('piano');
  });
});

describe('pausing work on a block', () => {
  // The block 'now' runs 6pm to 7pm and was started on time; it's 6:30pm.
  const MIN = 60_000;
  const started = (w: Writer) => w.set('time_block', 'now', { started_at: at('18:00') });
  const sec = (time: string) => `2026-11-02T${time}Z`;
  const row = async (t: Awaited<ReturnType<typeof setup>>) => (await t.rows()).find((b) => b.id === 'now')!;

  it('Pause stops the clock where it is, and its reverse clears it as if it never paused', async () => {
    const t = await setup(started);
    const undo = await t.run((w) => pauseBlock(w, 'now', t.clock));
    expect(await t.block('now')).toMatchObject({ paused_at: NOW, end: at('19:00') });
    t.clock.set(at('18:40'));
    const paused = await row(t);
    expect(isPaused(paused)).toBe(true);
    expect(timeSpentMs(paused, t.clock.now())).toBe(30 * MIN);
    expect(timeLeftMs(paused, t.clock.now())).toBe(30 * MIN);
    expect(currentBlock(await t.rows(), t.clock)?.id).toBe('now');
    expect(undo.writes).toEqual([{ type: 'time_block', id: 'now', fields: { paused_at: null } }]);
    await t.run((w) => applyPlanChange(w, undo));
    expect(isPaused(await row(t))).toBe(false);
  });

  it('Resume sets the end and paused_min later by the pause in whole minutes, and its reverse pauses again from the same moment', async () => {
    const t = await setup(started);
    await t.run((w) => pauseBlock(w, 'now', t.clock));
    t.clock.set(sec('18:39:20'));
    const resumed = await t.run((w) => resumeBlock(w, 'now', t.clock));
    expect(resumed).toMatchObject({ minutes: 9, end: at('19:09') });
    expect(await t.block('now')).toMatchObject({ paused_at: null, paused_min: 9, end: at('19:09') });

    // A second pause adds to the first, written as values rather than increments.
    await t.run((w) => pauseBlock(w, 'now', t.clock));
    t.clock.set(sec('18:45:50'));
    const again = await t.run((w) => resumeBlock(w, 'now', t.clock));
    expect(again.writes).toEqual([{ type: 'time_block', id: 'now', fields: { paused_at: sec('18:39:20'), paused_min: 9, end: at('19:09') } }]);
    expect(await t.block('now')).toMatchObject({ paused_at: null, paused_min: 16, end: at('19:16') });
    await t.run((w) => applyPlanChange(w, again));
    expect(await t.block('now')).toMatchObject({ paused_at: sec('18:39:20'), paused_min: 9, end: at('19:09') });
  });

  it('a pause under 30 seconds leaves no trace', async () => {
    const t = await setup(started);
    await t.run((w) => pauseBlock(w, 'now', t.clock));
    t.clock.set(sec('18:30:29'));
    const resumed = await t.run((w) => resumeBlock(w, 'now', t.clock));
    expect(resumed.minutes).toBe(0);
    const block = await t.block('now');
    expect(block).toMatchObject({ paused_at: null, end: at('19:00') });
    expect(block?.paused_min ?? null).toBeNull();
  });

  it('time spent leaves out pauses, and the ring fills by time spent against time spent plus time left', async () => {
    const t = await setup(started);
    await t.run((w) => pauseBlock(w, 'now', t.clock));
    t.clock.set(at('18:39'));
    await t.run((w) => resumeBlock(w, 'now', t.clock));
    t.clock.set(at('18:51'));
    const b = await row(t);
    expect(timeSpentMs(b, t.clock.now())).toBe(42 * MIN);
    expect(timeLeftMs(b, t.clock.now())).toBe(18 * MIN);
    expect(ringFill(b, t.clock.now())).toBeCloseTo(42 / 60);
    // Still going makes the ring drop back as the countdown grows.
    await t.run((w) => extendBlock(w, 'now', 30));
    expect(ringFill(await row(t), t.clock.now())).toBeCloseTo(42 / 90);
  });

  it('Mark done now while paused resumes first, so the time spent stops at the pause, and undoes to paused', async () => {
    const t = await setup(started);
    await t.run((w) => pauseBlock(w, 'now', t.clock));
    t.clock.set(at('18:40'));
    const undo = await t.run((w) => markDoneNow(w, 'now', t.clock));
    const done = await t.block('now');
    expect(done).toMatchObject({ paused_at: null, paused_min: 10, end: at('19:10'), ended_at: at('18:40') });
    expect(timeSpentMs(done!, t.clock.now())).toBe(30 * MIN);
    await t.run((w) => applyPlanChange(w, undo));
    expect(await t.block('now')).toMatchObject({ paused_at: NOW, end: at('19:00'), ended_at: null });
    expect((await getRecord(t.db, 'task', 't'))?.done_at).toBeNull();
  });

  it('a pause still running at the end lands in the end question, and Resume there keeps the time left', async () => {
    const t = await setup(started);
    await t.run((w) => pauseBlock(w, 'now', t.clock));
    t.clock.set(at('19:05'));
    expect(currentBlock(await t.rows(), t.clock)).toBeUndefined();
    expect(missedBlocks(await t.rows(), [], t.clock).map((b) => b.id)).toContain('now');
    expect(timeLeftMs(await row(t), t.clock.now())).toBe(30 * MIN);
    await t.run((w) => resumeBlock(w, 'now', t.clock));
    expect(await t.block('now')).toMatchObject({ paused_at: null, paused_min: 35, end: at('19:35') });
    expect(currentBlock(await t.rows(), t.clock)?.id).toBe('now');
  });

  it('Pause does nothing to a block not started, already paused, ended, answered or over, and Resume nothing to one not paused', async () => {
    const t = await setup();
    expect((await t.run((w) => pauseBlock(w, 'now', t.clock))).writes).toEqual([]);
    await t.run(started);
    await t.run((w) => pauseBlock(w, 'now', t.clock));
    t.clock.set(at('18:35'));
    expect((await t.run((w) => pauseBlock(w, 'now', t.clock))).writes).toEqual([]);
    expect((await t.block('now'))?.paused_at).toBe(NOW);
    await t.run((w) => resumeBlock(w, 'now', t.clock));
    await t.run((w) => answerBlock(w, 'now', { result: 'partly', remaining_min: 60 }, t.clock));
    expect((await t.run((w) => pauseBlock(w, 'now', t.clock))).writes).toEqual([]);
    expect((await t.run((w) => resumeBlock(w, 'now', t.clock))).writes).toEqual([]);
    await t.run((w) => w.set('time_block', 'piano', { started_at: at('17:00') }));
    expect((await t.run((w) => pauseBlock(w, 'piano', t.clock))).writes).toEqual([]);
  });

  it('the end question says the time spent and the pauses', async () => {
    const t = await setup(started);
    t.clock.set(at('19:05'));
    expect(spentLine(await row(t), 'UTC', t.clock.now())).toBe('1h spent.');
    t.clock.set(at('18:30'));
    await t.run((w) => pauseBlock(w, 'now', t.clock));
    t.clock.set(at('18:39'));
    expect(spentLine(await row(t), 'UTC', t.clock.now())).toBe('30m spent. Paused at 6:30pm.');
    await t.run((w) => resumeBlock(w, 'now', t.clock));
    t.clock.set(at('19:10'));
    expect(spentLine(await row(t), 'UTC', t.clock.now())).toBe('1h spent, 9 min paused.');
    expect(spentLine((await t.rows()).find((b) => b.id === 'next')!, 'UTC', t.clock.now())).toBeNull();
  });

  it('a practice logs its length less its pauses', async () => {
    const t = await setup((w) => w.set('time_block', 'piano', { started_at: at('17:00'), end: at('17:39'), paused_min: 9 }));
    const piano = async () => (await t.rows()).find((b) => b.id === 'piano')!;
    expect(workMinutes(await piano())).toBe(30);
    await t.run((w) => w.set('time_block', 'piano', { end: at('17:30'), paused_min: null, paused_at: at('17:20') }));
    expect(workMinutes(await piano())).toBe(20);
    await t.run((w) => w.set('time_block', 'piano', { started_at: null, paused_at: null }));
    expect(workMinutes(await piano())).toBe(30);
  });

  describe('across devices', () => {
    async function two() {
      const clock = fixedClock(NOW);
      const server = fakeSyncServer({ now: () => clock.now() });
      const [phone, desk] = [await openTestDb(), await openTestDb()];
      await transact(phone, clock, async (w) => {
        await w.create('task', { kind: 'project', project_id: 'p', title: 'Write the report', estimate_min: 180 }, 't');
        await w.create('time_block', { task_id: 't', start: at('18:00'), end: at('19:00'), tz: 'UTC', started_at: at('18:00') }, 'b');
      });
      await runSync(phone, server.send);
      await runSync(desk, server.send);
      const both = async () => {
        for (const db of [phone, desk, phone]) await runSync(db, server.send);
      };
      const rowOn = async (db: typeof phone) => (await blocksInRange(db, { from_utc: at('00:00'), to_utc: '2026-11-03T00:00:00Z' }))[0]!;
      return { clock, phone, desk, both, rowOn };
    }

    it('one device pausing while another ends the block: ended wins, and the time spent stops at whichever came first', async () => {
      const d = await two();
      await transact(d.phone, d.clock, (w) => pauseBlock(w, 'b', d.clock));
      d.clock.set(at('18:35'));
      await transact(d.desk, d.clock, (w) => markDoneNow(w, 'b', d.clock));
      await d.both();
      for (const db of [d.phone, d.desk]) {
        const b = await d.rowOn(db);
        expect(b).toMatchObject({ paused_at: NOW, ended_at: at('18:35'), result: 'done' });
        expect(isPaused(b)).toBe(false);
        expect(timeSpentMs(b, d.clock.now())).toBe(30 * MIN);
      }
    });

    it('a pause after another device ended the block is never shown, and changes nothing', async () => {
      const d = await two();
      await transact(d.desk, d.clock, (w) => markDoneNow(w, 'b', d.clock));
      d.clock.set(at('18:35'));
      // The phone hasn't heard, so its Now card still offers Pause.
      await transact(d.phone, d.clock, (w) => pauseBlock(w, 'b', d.clock));
      await d.both();
      const b = await d.rowOn(d.phone);
      expect(isPaused(b)).toBe(false);
      expect(timeSpentMs(b, d.clock.now())).toBe(30 * MIN);
    });

    it('Resume on two devices for the same pause: the later wins each field, so the end and paused_min agree', async () => {
      const d = await two();
      await transact(d.phone, d.clock, (w) => pauseBlock(w, 'b', d.clock));
      await d.both();
      d.clock.set(sec('18:39:20'));
      await transact(d.desk, d.clock, (w) => resumeBlock(w, 'b', d.clock));
      d.clock.set(sec('18:39:50'));
      await transact(d.phone, d.clock, (w) => resumeBlock(w, 'b', d.clock));
      await d.both();
      for (const db of [d.phone, d.desk]) expect(await d.rowOn(db)).toMatchObject({ paused_at: null, paused_min: 10, end: at('19:10') });
    });

    it('a pause on one device and a drag of the end on another both keep', async () => {
      const d = await two();
      await transact(d.phone, d.clock, (w) => pauseBlock(w, 'b', d.clock));
      await transact(d.desk, d.clock, (w) => moveBlock(w, 'b', { start: at('18:00'), end: at('19:30') }));
      await d.both();
      for (const db of [d.phone, d.desk]) expect(await d.rowOn(db)).toMatchObject({ paused_at: NOW, end: at('19:30') });
    });
  });
});
