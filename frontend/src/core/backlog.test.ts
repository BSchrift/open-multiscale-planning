import { describe, expect, it } from 'vitest';
import {
  addToBacklog,
  arrivalOrder,
  backlogDates,
  backlogId,
  backlogTouches,
  ensureBacklog,
  fileToBacklog,
  isBacklog,
  orderBetween,
  projectLabel,
  untouchedSince,
} from './backlog';
import { fixedClock, parseClock } from './clock';
import { openDb } from './db';
import { applyPlanChange, gatherBacklogs, gatherPlans, msTasks, plannable, suggestions } from './plan';
import { welcomeOptions } from './queue';
import { context } from './plan-testing';
import { getRecord, listRecords, transact, updateSettings } from './records';
import type { Project, Task } from './types';
import { nodeSqliteDriver } from '../platform/node-sqlite';

const NOW = '2026-11-16T12:00:00Z';
const CADENCE = { plan_cadence: { every: 2, unit: 'weeks' as const, anchor: '2026-11-02' }, plan_stretch: {} };

async function setup() {
  const clock = fixedClock(NOW);
  const db = await openDb(nodeSqliteDriver());
  await transact(db, clock, async (w) => {
    await updateSettings(w, CADENCE);
    await w.create('objective', { title: 'Learn to bake bread', state: 'active' }, 'bread');
    await w.create('task', { kind: 'inbox', title: 'Buy a banneton', order: 1 }, 'banneton');
    await w.create('task', { kind: 'one_off', title: 'Order rye flour', schedule: { type: 'once', from: '2026-11-20' }, next_due: '2026-11-20' }, 'rye');
  });
  return { clock, db };
}

const clocksOf = async (db: Awaited<ReturnType<typeof setup>>['db'], id: string) =>
  JSON.parse((await db.get<{ clocks: string }>('SELECT clocks FROM records WHERE id = :id', { id }))!.clocks) as Record<string, string>;

describe('a goal backlog', () => {
  it('is a project known by its id alone', () => {
    expect(backlogId('bread')).toBe('backlog:bread');
    expect(isBacklog({ id: 'backlog:bread' })).toBe(true);
    // A title, a goal or a flag never makes one.
    expect(isBacklog({ id: 'p1', title: 'Learn to bake bread, Backlog' } as Project)).toBe(false);
  });

  it('is made by its first task, with real placeholder dates and a title written as automatic writes', async () => {
    const { clock, db } = await setup();
    await transact(db, clock, (w) => fileToBacklog(w, 'bread', ['banneton'], clock));

    const made = await getRecord(db, 'project', 'backlog:bread');
    // This stretch's start and the next stretch's end: dates every released screen can draw.
    expect(made).toMatchObject({ objective_id: 'bread', state: 'active', title: 'Learn to bake bread, Backlog', start: '2026-11-16', end: '2026-12-13', deleted_at: null });
    const clocks = await clocksOf(db, 'backlog:bread');
    for (const field of ['title', 'start', 'end']) expect(parseClock(clocks[field]!).wall).toBe(0);
    expect(parseClock(clocks.state!).wall).toBeGreaterThan(0);
    expect(parseClock(clocks.objective_id!).wall).toBeGreaterThan(0);
  });

  it('files a task with no milestone or date, stamped with when it arrived, and undoes only the task', async () => {
    const { clock, db } = await setup();
    const reverse = await transact(db, clock, (w) => fileToBacklog(w, 'bread', ['rye', 'banneton'], clock));

    const rye = await getRecord(db, 'task', 'rye');
    expect(rye).toMatchObject({ kind: 'project', project_id: 'backlog:bread', milestone_id: null, schedule: null, next_due: null, order: Date.parse(NOW) });
    expect((await getRecord(db, 'task', 'banneton'))?.order).toBe(Date.parse(NOW) + 1);

    await transact(db, clock, (w) => applyPlanChange(w, reverse));
    expect(await getRecord(db, 'task', 'rye')).toMatchObject({ kind: 'one_off', project_id: null, schedule: { type: 'once', from: '2026-11-20' } });
    expect((await getRecord(db, 'task', 'banneton'))?.kind).toBe('inbox');
    // The empty record stays, so a filing another device made offline never lands in a deleted backlog.
    expect((await getRecord(db, 'project', 'backlog:bread'))?.deleted_at).toBeNull();
  });

  it('adds a new task at the end of the backlog', async () => {
    const { clock, db } = await setup();
    const id = await transact(db, clock, (w) => addToBacklog(w, 'bread', { title: 'Watch a shaping video', estimate_min: 20 }, clock));
    expect(await getRecord(db, 'task', id)).toMatchObject({ kind: 'project', project_id: 'backlog:bread', milestone_id: null, title: 'Watch a shaping video', order: Date.parse(NOW) });
  });

  it('revives after a tombstone, and reopens one an older app closed or paused, without resuming its dates', async () => {
    const { clock, db } = await setup();
    await transact(db, clock, (w) => ensureBacklog(w, 'bread', clock));
    await transact(db, clock, (w) => w.set('project', 'backlog:bread', { deleted_at: NOW, state: 'paused', paused_on: '2026-11-10', end: '2026-12-20' }));
    await transact(db, clock, (w) => ensureBacklog(w, 'bread', clock));
    expect(await getRecord(db, 'project', 'backlog:bread')).toMatchObject({ deleted_at: null, state: 'active', paused_on: null, end: '2026-12-13' });
  });

  it('is repaired to its own goal when an older app moved it, so the second goal still has at most one', async () => {
    const { clock, db } = await setup();
    await transact(db, clock, (w) => ensureBacklog(w, 'bread', clock));
    await transact(db, clock, (w) => w.set('project', 'backlog:bread', { objective_id: 'fit' }));
    await transact(db, clock, (w) => ensureBacklog(w, 'bread', clock));
    expect((await getRecord(db, 'project', 'backlog:bread'))?.objective_id).toBe('bread');
  });

  it('works its title out again after a rename, and rewrites its dates only when they differ', async () => {
    const { clock, db } = await setup();
    await transact(db, clock, (w) => ensureBacklog(w, 'bread', clock));
    const before = await clocksOf(db, 'backlog:bread');
    await transact(db, clock, (w) => w.set('objective', 'bread', { title: 'Bake sourdough' }));
    await transact(db, clock, (w) => ensureBacklog(w, 'bread', clock));
    const after = await clocksOf(db, 'backlog:bread');
    expect((await getRecord(db, 'project', 'backlog:bread'))?.title).toBe('Bake sourdough, Backlog');
    expect(after.start).toBe(before.start);
    expect(after.end).toBe(before.end);
  });

  it('is never offered for a goal whose id would make an id too long', async () => {
    const { clock, db } = await setup();
    const long = 'g'.repeat(199);
    await expect(transact(db, clock, (w) => ensureBacklog(w, long, clock))).rejects.toThrow(/Invalid record id/);
  });

  it('reads as the goal it belongs to, under its current name', () => {
    const backlog = { id: 'backlog:bread', title: 'Old name, Backlog', state: 'active', start: '2026-11-16', end: '2026-12-13' } as Project;
    const goals = [{ id: 'bread', title: 'Learn to bake bread', state: 'active' as const }];
    expect(projectLabel(backlog, goals)).toBe('Learn to bake bread, Backlog');
    expect(projectLabel(backlog, [])).toBe('Backlog of a removed goal');
    expect(projectLabel({ ...backlog, id: 'p1', title: 'Rye bread' }, goals)).toBe('Rye bread');
  });

  it('takes dates from the stretches, or with no cadence two windows from today', () => {
    expect(backlogDates(CADENCE, '2026-11-16')).toEqual({ start: '2026-11-16', end: '2026-12-13' });
    const none = backlogDates({ plan_cadence: null, plan_stretch: {} }, '2026-11-16');
    expect(none.start).toBe('2026-11-16');
    expect(none.end > '2027-01-01').toBe(true);
  });
});

describe('arrival order', () => {
  const t = (id: string, order?: number): Task => ({ id, kind: 'project', project_id: 'backlog:bread', title: id, ...(order === undefined ? {} : { order }) });

  it('lists by when each task arrived, with tasks an older app added last in the order they were made', () => {
    expect([t('b'), t('x', 5), t('a'), t('y', 2)].sort(arrivalOrder).map((x) => x.id)).toEqual(['y', 'x', 'a', 'b']);
  });

  it('gives a dragged task an order between its new neighbours', () => {
    const list = [t('a', 10), t('b', 20), t('c', 30)];
    expect(orderBetween(list, 'c', 0)).toBeLessThan(10);
    expect(orderBetween(list, 'a', 2)).toBeGreaterThan(30);
    const mid = orderBetween(list, 'c', 1);
    expect(mid).toBeGreaterThan(10);
    expect(mid).toBeLessThan(20);
    // Tasks with no order yet still land where they were dropped.
    expect(orderBetween([t('a'), t('b'), t('c', 30)], 'c', 0)).toBeLessThan(30);
  });
});

describe('backlogs in planning', () => {
  const backlog = (extra: Partial<Project> = {}): Project => ({ id: 'backlog:bread', objective_id: 'bread', title: 'Learn to bake bread, Backlog', state: 'active', start: '2026-08-01', end: '2026-08-02', weekly_aim: 300, ...extra });
  const report: Project = { id: 'report', title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-15' };
  const tasks: Task[] = [
    { id: 'late', kind: 'project', project_id: 'backlog:bread', title: 'Late', order: 9, estimate_min: 60 },
    { id: 'early', kind: 'project', project_id: 'backlog:bread', title: 'Early', order: 1, estimate_min: 60 },
    { id: 'r1', kind: 'project', project_id: 'report', title: 'Draft', estimate_min: 60 },
  ];

  it('gatherPlans never returns a backlog, and gatherBacklogs lists each with its tasks in arrival order', () => {
    expect(gatherPlans([report, backlog()], [], tasks).map((p) => p.project.id)).toEqual(['report']);
    const [b] = gatherBacklogs([report, backlog(), backlog({ id: 'backlog:gone', deleted_at: NOW })], [], tasks);
    expect(b!.project.id).toBe('backlog:bread');
    expect(b!.tasks.map((x) => x.id)).toEqual(['early', 'late']);
  });

  it('can be planned whatever its placeholder dates say, after every dated project', () => {
    const ctx = context();
    const plans = [...gatherBacklogs([backlog()], [], tasks), ...gatherPlans([report], [], tasks)];
    expect(plannable(plans, ctx).map((p) => p.project.id)).toEqual(['report', 'backlog:bread']);
    expect(plannable(gatherBacklogs([backlog({ state: 'finished' })], [], tasks), ctx)).toEqual([]);
  });

  it('is never suggested, even with a weekly aim an older app set and its placeholder end inside a plan', () => {
    const ctx = context();
    const week = { weekStart: '2026-10-26', picks: [], blocks: [], freeMin: 6000 };
    for (const end of ['2026-10-31', '2026-11-20']) {
      expect(suggestions(gatherBacklogs([backlog({ end })], [], tasks), [], week, ctx)).toEqual({});
    }
  });
});

describe('a task split by two devices moving it at once', () => {
  it("counts once, in the backlog, not under the milestone it left", () => {
    const report: Project = { id: 'report', title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-15' };
    const m = { id: 'm1', project_id: 'report', title: 'Draft' };
    const split: Task = { id: 's', kind: 'project', project_id: 'backlog:bread', milestone_id: 'm1', title: 'Split', done_at: NOW };
    const open: Task = { id: 'o', kind: 'project', project_id: 'report', milestone_id: 'm1', title: 'Open' };
    expect(msTasks({ project: report, tasks: [split, open] }, m).map((t) => t.id)).toEqual(['o']);
  });
});

describe('Next up and Welcome back', () => {
  it('offer one task per backlog as dateless work, after a one off due today', () => {
    const clock = fixedClock(NOW);
    const projects: Project[] = [{ id: 'backlog:bread', objective_id: 'bread', title: 'Learn to bake bread, Backlog', state: 'active', start: '2026-11-16', end: '2026-12-13' }];
    const tasks: Task[] = [
      { id: 'b1', kind: 'project', project_id: 'backlog:bread', title: 'Watch a shaping video', order: 1 },
      { id: 'b2', kind: 'project', project_id: 'backlog:bread', title: 'Read the book', order: 2 },
      { id: 'tap', kind: 'one_off', title: 'Fix the dripping tap', schedule: { type: 'once', from: '2026-11-16' } },
    ];
    expect(welcomeOptions(tasks, [], projects, clock).map((t) => t.id)).toEqual(['tap', 'b1']);
  });
});

describe('untouched backlog tasks', () => {
  it('counts a task touched by its own writes, a pick or a block, but not by automatic writes', async () => {
    const clock = fixedClock('2026-04-02T12:00:00Z');
    const db = await openDb(nodeSqliteDriver());
    await transact(db, clock, async (w) => {
      await w.create('objective', { title: 'Learn to bake bread', state: 'active' }, 'bread');
      await addToBacklog(w, 'bread', { title: 'Ask Sam for his focaccia recipe' }, clock);
      await addToBacklog(w, 'bread', { title: 'Watch a shaping video' }, clock);
      await addToBacklog(w, 'bread', { title: 'Read the book' }, clock);
    });
    const [ask, watch, read] = (await listRecords(db, 'task')).sort(arrivalOrder);
    clock.set('2026-06-10T12:00:00Z');
    await transact(db, clock, async (w) => {
      await w.create('week_pick', { week_start: '2026-06-08', task_id: watch!.id, minutes: 30 }, `pick:2026-06-08:${watch!.id}`);
      await w.create('time_block', { task_id: read!.id, start: '2026-07-01T09:00:00Z', end: '2026-07-01T10:00:00Z', tz: 'UTC' });
      // The app's own writes, such as an expiry, never count.
      await w.automatic.set('task', ask!.id, { remaining_min: 5 });
    });
    const touches = await backlogTouches(db);
    expect(touches[ask!.id]).toBe(Date.parse('2026-04-02T12:00:00Z'));
    expect(touches[watch!.id]).toBe(Date.parse('2026-06-08T00:00:00Z'));
    expect(touches[read!.id]).toBe(Date.parse('2026-07-01T09:00:00Z'));

    expect(untouchedSince(touches[ask!.id], '2026-10-01')).toBe(null);
    expect(untouchedSince(touches[ask!.id], '2026-10-03')).toBe('2026-04-02');
    // Keep restarts the clock.
    clock.set('2026-10-03T12:00:00Z');
    await transact(db, clock, (w) => w.set('task', ask!.id, { kept_at: '2026-10-03T12:00:00Z' }));
    expect(untouchedSince((await backlogTouches(db))[ask!.id], '2026-10-03')).toBe(null);
  });
});
