import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock';
import { openDb } from './db';
import { applyPlanChange, dropMilestone, gatherPlans, restoreProject } from './plan';
import type { ProjectPlan } from './plan';
import { context } from './plan-testing';
import { getRecord, listRecords, transact } from './records';
import { closeProject, scheduledWork } from './tasks';
import { nodeSqliteDriver } from '../platform/node-sqlite';

const NOW = '2026-11-04T12:00:00Z'; // a Wednesday; its week starts 2026-11-02

async function setup() {
  const clock = fixedClock(NOW);
  const db = await openDb(nodeSqliteDriver());
  await transact(db, clock, async (w) => {
    await w.create('project', { title: 'Paint the fence', state: 'paused', start: '2026-10-01', end: '2026-12-31' }, 'p');
    await w.create('milestone', { project_id: 'p', title: 'First coat', due: '2026-10-20' }, 'm');
    await w.create('task', { kind: 'project', project_id: 'p', milestone_id: 'm', title: 'Sand the boards' }, 'open');
    await w.create('task', { kind: 'project', project_id: 'p', title: 'Buy paint', done_at: '2026-10-20T12:00:00Z' }, 'done');
    await w.create('time_block', { task_id: 'open', start: '2026-11-05T09:00:00Z', end: '2026-11-05T10:00:00Z', tz: 'UTC' }, 'ahead');
    await w.create('time_block', { task_id: 'open', start: '2026-11-03T09:00:00Z', end: '2026-11-03T10:00:00Z', tz: 'UTC' }, 'past');
    await w.create('week_pick', { week_start: '2026-11-02', task_id: 'open', minutes: 60 }, 'pick:2026-11-02:open');
    await w.create('week_pick', { week_start: '2026-10-26', task_id: 'open', minutes: 60 }, 'pick:2026-10-26:open');
  });
  const load = async (): Promise<ProjectPlan> =>
    gatherPlans(await listRecords(db, 'project'), await listRecords(db, 'milestone'), await listRecords(db, 'task'))[0]!;
  return { clock, db, load };
}

describe('restoring a finished or dropped project', () => {
  it('logs the close, and Restore reopens what it cancelled while its freed time stays free', async () => {
    const { clock, db, load } = await setup();
    await transact(db, clock, (w) => closeProject(w, 'p', 'dropped', clock));
    const closed = await load();
    expect(closed.project.slip_log?.at(-1)).toMatchObject({ kind: 'close', text: 'Nov 4: Dropped.' });

    await transact(db, clock, (w) => applyPlanChange(w, restoreProject(closed, clock)));
    const back = await load();
    expect(back.project.state).toBe('paused');
    expect(back.project.slip_log).toEqual([]);
    expect(back.tasks.find((t) => t.id === 'open')?.cancelled_at).toBeNull();
    expect(back.tasks.find((t) => t.id === 'done')?.cancelled_at).toBeUndefined();
    expect((await getRecord(db, 'time_block', 'ahead'))?.cancelled).toBe(true);
    expect((await getRecord(db, 'week_pick', 'pick:2026-11-02:open'))?.deleted_at).toBe(NOW);
  });

  it('makes a project closed some other way active again', () => {
    const plan: ProjectPlan = {
      project: { id: 'p', title: 'Paint the fence', state: 'finished', start: '2026-10-01', end: '2026-12-31' },
      milestones: [],
      tasks: [],
    };
    expect(restoreProject(plan, fixedClock(NOW))).toEqual({ writes: [{ type: 'project', id: 'p', fields: { state: 'active' } }] });
  });
});

describe('scheduledWork', () => {
  it('finds the blocks not yet started and the picks from this week on, which a plan change then frees', async () => {
    const { clock, db, load } = await setup();
    const work = await scheduledWork(db, ['open', 'done'], clock);
    expect(work.blocks?.map((b) => b.id)).toEqual(['ahead']);
    expect(work.picks?.map((p) => p.id)).toEqual(['pick:2026-11-02:open']);

    const plan = await load();
    const ctx = context({ clock });
    await transact(db, clock, (w) => applyPlanChange(w, dropMilestone(plan, 'm', { cancelOpen: true, ...work }, ctx)));
    expect((await getRecord(db, 'time_block', 'ahead'))?.cancelled).toBe(true);
    expect((await getRecord(db, 'time_block', 'past'))?.cancelled).toBeUndefined();
    expect((await getRecord(db, 'week_pick', 'pick:2026-11-02:open'))?.deleted_at).toBe(NOW);
  });
});
