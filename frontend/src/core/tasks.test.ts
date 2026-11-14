import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock';
import { openDb } from './db';
import { applyPlanChange, gatherPlans, markMilestoneDone } from './plan';
import type { PlanChange } from './plan';
import { finishedTasks } from './queries';
import { getRecord, listRecords, transact } from './records';
import {
  closeProject,
  closeTask,
  deleteGoal,
  endPractice,
  goalContents,
  makeHome,
  retickOneOff,
  scheduledWork,
  tickOneOff,
  undoHome,
  undoProjectChange,
  untickOneOff,
} from './tasks';
import type { Home, Made } from './tasks';
import { nodeSqliteDriver } from '../platform/node-sqlite';

const NOW = '2026-11-04T12:00:00Z'; // a Wednesday; its week starts 2026-11-02

async function setup() {
  const clock = fixedClock(NOW);
  const db = await openDb(nodeSqliteDriver());
  await transact(db, clock, async (w) => {
    await w.create('task', { kind: 'project', title: 'Write the report', project_id: 'p' }, 't');
    await w.create('task', { kind: 'project', title: 'Paint the fence', project_id: 'p' }, 'other');
    const block = (start: string, end: string, extra = {}) => ({ task_id: 't', start, end, tz: 'UTC', ...extra });
    await w.create('time_block', block('2026-11-03T09:00:00Z', '2026-11-03T10:00:00Z'), 'past');
    await w.create('time_block', block('2026-11-04T11:30:00Z', '2026-11-04T12:30:00Z', { started_at: '2026-11-04T11:30:00Z' }), 'started');
    await w.create('time_block', block('2026-11-05T09:00:00Z', '2026-11-05T10:00:00Z'), 'future');
    await w.create('time_block', { ...block('2026-11-05T11:00:00Z', '2026-11-05T12:00:00Z'), task_id: 'other' }, 'theirs');
    await w.create('week_pick', { week_start: '2026-10-26', task_id: 't', minutes: 60 }, 'pick:2026-10-26:t');
    await w.create('week_pick', { week_start: '2026-11-02', task_id: 't', minutes: 60 }, 'pick:2026-11-02:t');
    await w.create('week_pick', { week_start: '2026-11-09', task_id: 't', minutes: 30 }, 'pick:2026-11-09:t');
  });
  return { clock, db };
}

describe('closeTask', () => {
  for (const [how, field] of [
    ['done', 'done_at'],
    ['cancelled', 'cancelled_at'],
    ['deleted', 'deleted_at'],
  ] as const) {
    it(`${how}: frees the task's future time, keeps its history, and undoes exactly`, async () => {
      const { clock, db } = await setup();
      const undo = await transact(db, clock, async (w) => closeTask(w, 't', how, clock));

      expect((await getRecord(db, 'task', 't'))?.[field]).toBe(NOW);
      // Only a project's close marks what it cancelled, so Restore leaves the person's own cancels alone.
      expect((await getRecord(db, 'task', 't'))?.cancelled_by).toBeUndefined();
      expect((await getRecord(db, 'time_block', 'future'))?.cancelled).toBe(true);
      expect((await getRecord(db, 'time_block', 'past'))?.cancelled).toBeUndefined();
      expect((await getRecord(db, 'time_block', 'started'))?.cancelled).toBeUndefined();
      expect((await getRecord(db, 'time_block', 'theirs'))?.cancelled).toBeUndefined();
      expect((await getRecord(db, 'week_pick', 'pick:2026-10-26:t'))?.deleted_at).toBeUndefined();
      expect((await getRecord(db, 'week_pick', 'pick:2026-11-02:t'))?.deleted_at).toBe(NOW);
      expect((await getRecord(db, 'week_pick', 'pick:2026-11-09:t'))?.deleted_at).toBe(NOW);

      await transact(db, clock, (w) => applyPlanChange(w, undo));
      expect((await getRecord(db, 'task', 't'))?.[field]).toBeNull();
      expect((await getRecord(db, 'time_block', 'future'))?.cancelled).toBeNull();
      expect((await getRecord(db, 'week_pick', 'pick:2026-11-02:t'))?.deleted_at).toBeNull();
    });
  }

  it('refuses a repeating one off, which finishes through schedule.tick instead', async () => {
    const { clock, db } = await setup();
    await transact(db, clock, (w) =>
      w.create('task', { kind: 'one_off', title: 'Water the plants', schedule: { type: 'float', every: 1, unit: 'week' } }, 'r'),
    );
    await expect(transact(db, clock, (w) => closeTask(w, 'r', 'done', clock))).rejects.toThrow(/repeating/);
  });
});

describe('ticking a one off', () => {
  // NOW is a Wednesday at noon UTC.
  async function oneOffs() {
    const { clock, db } = await setup();
    await transact(db, clock, async (w) => {
      await w.create('task', { kind: 'one_off', title: 'Paint the fence', schedule: { type: 'once', from: '2026-11-05' }, next_due: '2026-11-05' }, 'once');
      await w.create('task', { kind: 'one_off', title: 'Feed the fish', schedule: { type: 'recurring', every: 1, unit: 'week', anchor: '2026-11-02' }, next_due: '2026-11-09' }, 'weekly');
      await w.create('time_block', { task_id: 'once', start: '2026-11-05T09:00:00Z', end: '2026-11-05T10:00:00Z', tz: 'UTC' }, 'once-block');
      await w.create('week_pick', { week_start: '2026-11-02', task_id: 'once', minutes: 60 }, 'pick:2026-11-02:once');
      await w.create('time_block', { task_id: 'weekly', start: '2026-11-06T09:00:00Z', end: '2026-11-06T10:00:00Z', tz: 'UTC' }, 'this-week');
      await w.create('time_block', { task_id: 'weekly', start: '2026-11-17T09:00:00Z', end: '2026-11-17T10:00:00Z', tz: 'UTC' }, 'next-week');
    });
    const completions = async (task: string) =>
      (await db.all<{ id: string; deleted_at: string | null }>('SELECT id, deleted_at FROM task_completion WHERE task_id = :task', { task })).filter((c) => !c.deleted_at);
    return { clock, db, completions };
  }

  it('closes a one-time one, freeing its time, with a completion, and undoes exactly', async () => {
    const { clock, db, completions } = await oneOffs();
    const undo = await transact(db, clock, (w) => tickOneOff(w, 'once', clock));
    expect((await getRecord(db, 'task', 'once'))?.done_at).toBe(NOW);
    expect((await getRecord(db, 'time_block', 'once-block'))?.cancelled).toBe(true);
    expect((await getRecord(db, 'week_pick', 'pick:2026-11-02:once'))?.deleted_at).toBe(NOW);
    expect(await completions('once')).toHaveLength(1);

    await transact(db, clock, (w) => applyPlanChange(w, undo));
    expect((await getRecord(db, 'task', 'once'))?.done_at).toBeNull();
    expect((await getRecord(db, 'time_block', 'once-block'))?.cancelled).toBeNull();
    expect(await completions('once')).toHaveLength(0);
  });

  it('moves a repeating one on and frees only the block for the occurrence it used up', async () => {
    const { clock, db, completions } = await oneOffs();
    const undo = await transact(db, clock, (w) => tickOneOff(w, 'weekly', clock));
    const task = await getRecord(db, 'task', 'weekly');
    expect(task?.done_at).toBeUndefined();
    expect(task?.next_due).toBe('2026-11-16');
    expect((await getRecord(db, 'time_block', 'this-week'))?.cancelled).toBe(true);
    expect((await getRecord(db, 'time_block', 'next-week'))?.cancelled).toBeUndefined();
    expect(await completions('weekly')).toHaveLength(1);

    await transact(db, clock, (w) => applyPlanChange(w, undo));
    expect((await getRecord(db, 'task', 'weekly'))?.next_due).toBe('2026-11-09');
    expect((await getRecord(db, 'time_block', 'this-week'))?.cancelled).toBeNull();
    expect(await completions('weekly')).toHaveLength(0);
  });

  it('does nothing to a one-time one that is already done', async () => {
    const { clock, db } = await oneOffs();
    await transact(db, clock, (w) => tickOneOff(w, 'once', clock));
    expect(await transact(db, clock, (w) => tickOneOff(w, 'once', clock))).toEqual({ writes: [] });
  });

  it('unticks and reticks a finish through the schedule rules', async () => {
    const { clock, db, completions } = await oneOffs();
    await transact(db, clock, (w) => tickOneOff(w, 'weekly', clock));
    const [done] = await completions('weekly');
    await transact(db, clock, (w) => untickOneOff(w, done!.id, clock));
    expect((await getRecord(db, 'task', 'weekly'))?.next_due).toBe('2026-11-09');
    expect(await completions('weekly')).toHaveLength(0);

    await transact(db, clock, (w) => retickOneOff(w, done!.id, clock));
    expect((await getRecord(db, 'task', 'weekly'))?.next_due).toBe('2026-11-16');
    expect(await completions('weekly')).toHaveLength(1);

    await transact(db, clock, (w) => tickOneOff(w, 'once', clock));
    const [onceDone] = await completions('once');
    await transact(db, clock, (w) => untickOneOff(w, onceDone!.id, clock));
    expect((await getRecord(db, 'task', 'once'))?.done_at).toBeNull();
    await transact(db, clock, (w) => retickOneOff(w, onceDone!.id, clock));
    expect((await getRecord(db, 'task', 'once'))?.done_at).toBe(NOW);
  });

  it('unticking a one-time one later gives back the pick and block it freed, and reticking frees them again', async () => {
    const { clock, db, completions } = await oneOffs();
    await transact(db, clock, (w) => tickOneOff(w, 'once', clock));
    const [done] = await completions('once');
    // Unticked later, as from Today's row or the finished list, with no Undo held on screen.
    clock.set('2026-11-04T15:00:00Z');
    await transact(db, clock, (w) => untickOneOff(w, done!.id, clock));
    expect((await getRecord(db, 'task', 'once'))?.done_at).toBeNull();
    expect((await getRecord(db, 'time_block', 'once-block'))?.cancelled).toBeNull();
    expect((await getRecord(db, 'week_pick', 'pick:2026-11-02:once'))?.deleted_at).toBeNull();

    await transact(db, clock, (w) => retickOneOff(w, done!.id, clock));
    expect((await getRecord(db, 'task', 'once'))?.done_at).toBe(NOW);
    expect((await getRecord(db, 'time_block', 'once-block'))?.cancelled).toBe(true);
    expect((await getRecord(db, 'week_pick', 'pick:2026-11-02:once'))?.deleted_at).toBe('2026-11-04T15:00:00Z');
  });

  it('gives back only what is still ahead: a block whose time has passed stays freed', async () => {
    const { clock, db, completions } = await oneOffs();
    await transact(db, clock, (w) => tickOneOff(w, 'once', clock));
    const [done] = await completions('once');
    clock.set('2026-11-05T11:00:00Z');
    await transact(db, clock, (w) => untickOneOff(w, done!.id, clock));
    expect((await getRecord(db, 'time_block', 'once-block'))?.cancelled).toBe(true);
    expect((await getRecord(db, 'week_pick', 'pick:2026-11-02:once'))?.deleted_at).toBeNull();
  });

  it("a repeating one's time left belongs to the occurrence it finished, and comes back with its block on untick", async () => {
    const { clock, db, completions } = await oneOffs();
    await transact(db, clock, (w) => w.set('task', 'weekly', { estimate_min: 120, remaining_min: 60 }));
    await transact(db, clock, (w) => tickOneOff(w, 'weekly', clock));
    expect((await getRecord(db, 'task', 'weekly'))?.remaining_min).toBeNull();

    const [done] = await completions('weekly');
    clock.set('2026-11-04T15:00:00Z');
    await transact(db, clock, (w) => untickOneOff(w, done!.id, clock));
    expect((await getRecord(db, 'task', 'weekly'))?.remaining_min).toBe(60);
    expect((await getRecord(db, 'time_block', 'this-week'))?.cancelled).toBeNull();

    await transact(db, clock, (w) => retickOneOff(w, done!.id, clock));
    expect((await getRecord(db, 'task', 'weekly'))?.remaining_min).toBeNull();
    expect((await getRecord(db, 'time_block', 'this-week'))?.cancelled).toBe(true);
  });

  it('unticking an older finish of a repeating one leaves the task and its blocks alone', async () => {
    const { clock, db, completions } = await oneOffs();
    await transact(db, clock, (w) => tickOneOff(w, 'weekly', clock));
    const [first] = await completions('weekly');
    clock.set('2026-11-04T13:00:00Z');
    await transact(db, clock, (w) => tickOneOff(w, 'weekly', clock));
    await transact(db, clock, (w) => untickOneOff(w, first!.id, clock));
    expect((await getRecord(db, 'task', 'weekly'))?.next_due).toBe('2026-11-23');
    expect((await getRecord(db, 'time_block', 'this-week'))?.cancelled).toBe(true);
  });
});

describe('closeProject', () => {
  for (const state of ['finished', 'dropped'] as const) {
    it(`${state}: cancels its open tasks, freeing their time, and undoes exactly`, async () => {
      const { clock, db } = await setup();
      await transact(db, clock, async (w) => {
        await w.create('project', { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-10-31' }, 'p');
        await w.create('task', { kind: 'project', title: 'Done already', project_id: 'p', done_at: '2026-10-20T12:00:00Z' }, 'done');
      });
      const undo = await transact(db, clock, (w) => closeProject(w, 'p', state, clock));

      expect((await getRecord(db, 'project', 'p'))?.state).toBe(state);
      for (const id of ['t', 'other']) expect(await getRecord(db, 'task', id)).toMatchObject({ cancelled_at: NOW, cancelled_by: 'p' });
      expect(await getRecord(db, 'task', 'done')).not.toHaveProperty('cancelled_by');
      expect((await getRecord(db, 'task', 'done'))?.cancelled_at).toBeUndefined();
      expect((await getRecord(db, 'time_block', 'future'))?.cancelled).toBe(true);
      expect((await getRecord(db, 'week_pick', 'pick:2026-11-02:t'))?.deleted_at).toBe(NOW);

      await transact(db, clock, (w) => applyPlanChange(w, undo));
      expect((await getRecord(db, 'project', 'p'))?.state).toBe('active');
      for (const id of ['t', 'other']) expect(await getRecord(db, 'task', id)).toMatchObject({ cancelled_at: null, cancelled_by: null });
      expect((await getRecord(db, 'time_block', 'future'))?.cancelled).toBeNull();
      expect((await getRecord(db, 'week_pick', 'pick:2026-11-02:t'))?.deleted_at).toBeNull();
    });
  }

  it("logs the close with an undo that clears the marks too, so an older app's Restore leaves none behind", async () => {
    const { clock, db } = await setup();
    await transact(db, clock, (w) => w.create('project', { title: 'Write the report', state: 'paused', start: '2026-10-01', end: '2026-10-31' }, 'p'));
    await transact(db, clock, (w) => closeProject(w, 'p', 'finished', clock));
    expect((await getRecord(db, 'project', 'p'))?.slip_log?.at(-1)?.undo).toEqual([
      { type: 'project', id: 'p', fields: { state: 'paused' } },
      { type: 'task', id: 't', fields: { cancelled_at: null, cancelled_by: null } },
      { type: 'task', id: 'other', fields: { cancelled_at: null, cancelled_by: null } },
    ]);
  });
});

describe('endPractice', () => {
  it('takes the sessions still to come off the week, keeps the rest as history, and undoes exactly', async () => {
    const { clock, db } = await setup();
    await transact(db, clock, async (w) => {
      await w.create('practice', { title: 'Piano', target_min: 30, per: 'day', state: 'active' }, 'pr');
      const session = (start: string, end: string, extra = {}) => ({ practice_id: 'pr', start, end, tz: 'UTC', ...extra });
      await w.create('time_block', session('2026-11-03T07:00:00Z', '2026-11-03T07:30:00Z'), 'pr-past');
      await w.create('time_block', session('2026-11-04T11:45:00Z', '2026-11-04T12:15:00Z', { started_at: '2026-11-04T11:45:00Z' }), 'pr-now');
      await w.create('time_block', session('2026-11-05T07:00:00Z', '2026-11-05T07:30:00Z'), 'pr-future');
    });
    const undo = await transact(db, clock, (w) => endPractice(w, 'pr', clock));

    expect((await getRecord(db, 'practice', 'pr'))?.state).toBe('ended');
    expect((await getRecord(db, 'time_block', 'pr-future'))?.cancelled).toBe(true);
    expect((await getRecord(db, 'time_block', 'pr-past'))?.cancelled).toBeUndefined();
    expect((await getRecord(db, 'time_block', 'pr-now'))?.cancelled).toBeUndefined();
    expect((await getRecord(db, 'time_block', 'future'))?.cancelled).toBeUndefined();

    await transact(db, clock, (w) => applyPlanChange(w, undo));
    expect((await getRecord(db, 'practice', 'pr'))?.state).toBe('active');
    expect((await getRecord(db, 'time_block', 'pr-future'))?.cancelled).toBeNull();
  });
});

describe('deleteGoal', () => {
  it('deletes the goal with its projects, milestones, tasks and practices, frees their future time, syncs, and undoes exactly', async () => {
    const { clock, db } = await setup();
    await transact(db, clock, async (w) => {
      await w.create('objective', { title: 'Learn to bake bread', state: 'active' }, 'g');
      await w.create('project', { objective_id: 'g', title: 'Bake a loaf', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p');
      await w.create('milestone', { project_id: 'p', title: 'First loaf', due: '2026-11-20' }, 'm');
      await w.create('project', { objective_id: 'g', title: 'Buy flour', state: 'finished', start: '2026-09-01', end: '2026-09-30' }, 'q');
      await w.create('task', { kind: 'project', title: 'Order flour', project_id: 'q', done_at: '2026-09-20T12:00:00Z' }, 'qdone');
      await w.create('task', { kind: 'project', title: 'Gone already', project_id: 'p', deleted_at: '2026-11-01T12:00:00Z' }, 'gone');
      await w.create('practice', { objective_id: 'g', title: 'Knead', target_min: 15, per: 'day', state: 'active' }, 'pr');
      await w.create('time_block', { practice_id: 'pr', start: '2026-11-03T07:00:00Z', end: '2026-11-03T07:15:00Z', tz: 'UTC' }, 'pr-past');
      await w.create('block_outcome', { result: 'done', answered_at: '2026-11-03T07:15:00Z' }, 'outcome:pr-past');
      await w.create('time_block', { practice_id: 'pr', start: '2026-11-05T07:00:00Z', end: '2026-11-05T07:15:00Z', tz: 'UTC' }, 'pr-future');
      await w.create('objective', { title: 'Run a 10k', state: 'active' }, 'g2');
      await w.create('project', { objective_id: 'g2', title: 'Train', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p2');
      await w.create('practice', { objective_id: 'g2', title: 'Jog', target_min: 30, per: 'day', state: 'active' }, 'pr2');
    });

    expect(await goalContents(db, 'g')).toEqual({
      projects: [
        { id: 'p', title: 'Bake a loaf', milestones: ['m'], tasks: ['other', 't'] },
        { id: 'q', title: 'Buy flour', milestones: [], tasks: ['qdone'] },
      ],
      practices: [{ id: 'pr', title: 'Knead' }],
    });
    await db.run('DELETE FROM outbox');
    const undo = await transact(db, clock, (w) => deleteGoal(w, 'g', clock));

    for (const [type, id] of [
      ['objective', 'g'],
      ['project', 'p'],
      ['project', 'q'],
      ['milestone', 'm'],
      ['task', 't'],
      ['task', 'other'],
      ['task', 'qdone'],
      ['practice', 'pr'],
    ] as const) {
      expect((await getRecord(db, type, id))?.deleted_at, `${type} ${id}`).toBe(NOW);
    }
    expect(await goalContents(db, 'g')).toEqual({ projects: [], practices: [] });
    // Future time is freed, as closing a task frees it; the past and what's under way stay as history.
    expect((await getRecord(db, 'time_block', 'future'))?.cancelled).toBe(true);
    expect((await getRecord(db, 'time_block', 'theirs'))?.cancelled).toBe(true);
    expect((await getRecord(db, 'time_block', 'pr-future'))?.cancelled).toBe(true);
    expect((await getRecord(db, 'time_block', 'past'))?.cancelled).toBeUndefined();
    expect((await getRecord(db, 'time_block', 'started'))?.cancelled).toBeUndefined();
    expect((await getRecord(db, 'time_block', 'pr-past'))?.cancelled).toBeUndefined();
    expect((await getRecord(db, 'block_outcome', 'outcome:pr-past'))?.deleted_at).toBeUndefined();
    expect((await getRecord(db, 'week_pick', 'pick:2026-11-02:t'))?.deleted_at).toBe(NOW);
    expect((await getRecord(db, 'week_pick', 'pick:2026-10-26:t'))?.deleted_at).toBeUndefined();
    // Another goal's work is left alone.
    expect((await getRecord(db, 'objective', 'g2'))?.deleted_at).toBeUndefined();
    expect((await getRecord(db, 'project', 'p2'))?.deleted_at).toBeUndefined();
    expect((await getRecord(db, 'practice', 'pr2'))?.deleted_at).toBeUndefined();
    // Marked deleted for every device, not just hidden here.
    const sent = await db.all<{ record_id: string; field: string }>("SELECT record_id, field FROM outbox WHERE field = 'deleted_at' ORDER BY record_id");
    expect(sent.map((o) => o.record_id)).toEqual(['g', 'm', 'other', 'p', 'pick:2026-11-02:t', 'pick:2026-11-09:t', 'pr', 'q', 'qdone', 't']);

    await transact(db, clock, (w) => applyPlanChange(w, undo));
    for (const [type, id] of [
      ['objective', 'g'],
      ['project', 'p'],
      ['project', 'q'],
      ['milestone', 'm'],
      ['task', 't'],
      ['task', 'qdone'],
      ['practice', 'pr'],
    ] as const) {
      expect((await getRecord(db, type, id))?.deleted_at, `${type} ${id}`).toBeNull();
    }
    expect((await getRecord(db, 'task', 'gone'))?.deleted_at).toBe('2026-11-01T12:00:00Z');
    expect((await getRecord(db, 'time_block', 'future'))?.cancelled).toBeNull();
    expect((await getRecord(db, 'time_block', 'pr-future'))?.cancelled).toBeNull();
    expect((await getRecord(db, 'week_pick', 'pick:2026-11-02:t'))?.deleted_at).toBeNull();
    expect((await goalContents(db, 'g')).projects).toHaveLength(2);
  });
});

describe('undoProjectChange', () => {
  it('days later gives back only what is still ahead: a block whose time has passed and a past week pick stay freed', async () => {
    const { clock, db } = await setup();
    await transact(db, clock, async (w) => {
      await w.create('project', { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p');
      await w.create('milestone', { project_id: 'p', title: 'First draft', due: '2026-11-20' }, 'm');
      await w.set('task', 't', { milestone_id: 'm' });
      await w.create('time_block', { task_id: 't', start: '2026-11-16T09:00:00Z', end: '2026-11-16T10:00:00Z', tz: 'UTC' }, 'later');
    });
    const load = async () => gatherPlans(await listRecords(db, 'project'), await listRecords(db, 'milestone'), await listRecords(db, 'task'))[0]!;
    const ctx = { settings: { plan_cadence: null, plan_stretch: {} }, clock };
    const before = await load();
    await transact(db, clock, async (w) => applyPlanChange(w, markMilestoneDone(before, 'm', await scheduledWork(w.sql, ['t'], clock), ctx)));
    expect((await getRecord(db, 'time_block', 'future'))?.cancelled).toBe(true);
    expect((await getRecord(db, 'time_block', 'later'))?.cancelled).toBe(true);

    clock.set('2026-11-10T12:00:00Z'); // The next Tuesday: Thursday's block has passed and last week is over.
    const after = await load();
    await transact(db, clock, (w) => undoProjectChange(w, after, clock));
    expect((await getRecord(db, 'task', 't'))?.done_at).toBeNull();
    expect((await getRecord(db, 'milestone', 'm'))?.met_at).toBeNull();
    expect((await getRecord(db, 'project', 'p'))?.slip_log).toEqual([]);
    expect((await getRecord(db, 'time_block', 'future'))?.cancelled).toBe(true);
    expect((await getRecord(db, 'time_block', 'later'))?.cancelled).toBeNull();
    expect((await getRecord(db, 'week_pick', 'pick:2026-11-02:t'))?.deleted_at).toBe(NOW);
    expect((await getRecord(db, 'week_pick', 'pick:2026-11-09:t'))?.deleted_at).toBeNull();
  });
});

describe('makeHome', () => {
  async function inbox() {
    const clock = fixedClock(NOW);
    const db = await openDb(nodeSqliteDriver());
    await transact(db, clock, async (w) => {
      await w.create('objective', { title: 'Travel more', state: 'active' }, 'g');
      await w.create('task', { kind: 'inbox', title: 'Book flights to Osaka', estimate_min: 45 }, 'i');
    });
    const make = (home: Home) => transact(db, clock, (w) => makeHome(w, 'i', home, clock));
    const undo = (made: Made, reverse: PlanChange) => transact(db, clock, (w) => undoHome(w, 'i', made, reverse));
    const live = async (type: 'objective' | 'project' | 'practice') => (await listRecords(db, type)).map((r) => r.title);
    return { clock, db, make, undo, live };
  }
  const dates = { start: '2026-11-04', end: '2026-12-31' };

  it('makes a project under a new goal with a milestone at its end, and leaves the item to add next, in one change that undoes exactly', async () => {
    const { db, make, undo, live } = await inbox();
    const before = await getRecord(db, 'task', 'i');
    const { made, reverse } = await make({ kind: 'project', title: 'Japan trip', goal: { title: 'See Asia' }, ...dates, keep: true, milestone: 'Visas sorted' });
    expect(made).toMatchObject({ type: 'project', milestone: expect.any(String) });
    expect(await getRecord(db, 'project', made.id)).toMatchObject({ title: 'Japan trip', state: 'active', ...dates, objective_id: made.goal, added_on: '2026-11-04' });
    expect(await getRecord(db, 'objective', made.goal!)).toMatchObject({ title: 'See Asia', state: 'active' });
    expect(await getRecord(db, 'milestone', made.milestone!)).toMatchObject({ project_id: made.id, title: 'Visas sorted', due: '2026-12-31', added_on: '2026-11-04' });
    // The item waits on the card, to be added on a second Enter.
    expect(await getRecord(db, 'task', 'i')).toEqual(before);

    expect(await undo(made, reverse)).toBe(false);
    expect(await live('project')).toEqual([]);
    expect(await live('objective')).toEqual(['Travel more']);
    expect((await getRecord(db, 'milestone', made.milestone!))?.deleted_at).toBeTruthy();
    expect(await getRecord(db, 'task', 'i')).toEqual(before);
  });

  it('makes a project with no milestone when none is named', async () => {
    const { db, make } = await inbox();
    const { made } = await make({ kind: 'project', title: 'Japan trip', goal: null, ...dates, keep: true, milestone: null });
    expect(made.milestone).toBeNull();
    expect(await listRecords(db, 'milestone')).toEqual([]);
  });

  it('makes a project from an item that is the project itself: closed with a link, listed as finished, and back on Undo', async () => {
    const { db, make, undo, live } = await inbox();
    const { made, reverse } = await make({ kind: 'project', title: 'Japan trip', goal: { id: 'g' }, ...dates, keep: false });
    expect(await getRecord(db, 'project', made.id)).toMatchObject({ objective_id: 'g' });
    expect(made.goal).toBeNull();
    expect(await getRecord(db, 'task', 'i')).toMatchObject({ kind: 'inbox', done_at: NOW, became: { type: 'project', id: made.id } });
    expect(await finishedTasks(db)).toMatchObject([{ task_id: 'i', title: 'Book flights to Osaka', became_type: 'project', became_id: made.id }]);

    await undo(made, reverse);
    expect(await getRecord(db, 'task', 'i')).toMatchObject({ kind: 'inbox', done_at: null, became: null });
    expect(await finishedTasks(db)).toEqual([]);
    expect(await live('project')).toEqual([]);
    expect(await live('objective')).toEqual(['Travel more']);
  });

  it.each([
    ['practice', { kind: 'practice', title: 'Meditate', goal: null, target_min: 30, per: 'day', keep: false }, 'practice'],
    ['goal', { kind: 'goal', title: 'Make pottery', keep: false }, 'objective'],
  ] as const)('makes a %s the item becomes: closed with a link to it', async (_, home, type) => {
    const { db, make, undo, live } = await inbox();
    const { made, reverse } = await make(home);
    expect(made).toEqual({ type, id: expect.any(String), goal: null });
    expect(await getRecord(db, type, made.id)).toMatchObject({ title: home.title, state: 'active' });
    expect(await getRecord(db, 'task', 'i')).toMatchObject({ done_at: NOW, became: { type, id: made.id } });

    await undo(made, reverse);
    expect(await getRecord(db, 'task', 'i')).toMatchObject({ kind: 'inbox', done_at: null, became: null });
    expect(await live(type)).toEqual(type === 'objective' ? ['Travel more'] : []);
  });

  it('makes a practice with no preferred time under a new goal, and keeps the item open to file next', async () => {
    const { db, make, undo, live } = await inbox();
    const before = await getRecord(db, 'task', 'i');
    const { made, reverse } = await make({ kind: 'practice', title: 'Walk more', goal: { title: 'Health' }, target_min: 20, per: 'week', keep: true });
    expect(await getRecord(db, 'practice', made.id)).toMatchObject({ title: 'Walk more', objective_id: made.goal, target_min: 20, per: 'week', preferred_times: [], state: 'active' });
    expect(await getRecord(db, 'task', 'i')).toEqual(before);

    await undo(made, reverse);
    expect(await live('practice')).toEqual([]);
    expect(await live('objective')).toEqual(['Travel more']);
    expect(await getRecord(db, 'task', 'i')).toEqual(before);
  });

  it('keeps a project another device has put tasks in since, with its new goal, and gives back only the item', async () => {
    const { db, clock, make, undo, live } = await inbox();
    const { made, reverse } = await make({ kind: 'project', title: 'Japan trip', goal: { title: 'See Asia' }, ...dates, keep: true, milestone: null });
    await transact(db, clock, (w) => w.create('task', { kind: 'project', project_id: made.id, title: 'Renew the passport' }, 'other'));
    expect(await undo(made, reverse)).toBe(true);
    expect(await live('project')).toEqual(['Japan trip']);
    expect((await live('objective')).sort()).toEqual(['See Asia', 'Travel more']);
    expect((await getRecord(db, 'task', 'i'))?.kind).toBe('inbox');
  });
});
