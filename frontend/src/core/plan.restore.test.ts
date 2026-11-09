import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock';
import { openDb } from './db';
import type { Db } from './db';
import { applyPlanChange, dropMilestone, gatherPlans, moveMilestone, msTasks, pauseProject, restoreProject, resumeProject } from './plan';
import type { ProjectPlan } from './plan';
import { context } from './plan-testing';
import { getRecord, listRecords, transact } from './records';
import { runSync } from './sync';
import { fakeSyncServer } from './sync-testing';
import { closeProject, closeTask, scheduledWork } from './tasks';
import { nodeSqliteDriver, openTestDb } from '../platform/node-sqlite';

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
    expect(closed.tasks.find((t) => t.id === 'open')?.cancelled_by).toBe('p');

    await transact(db, clock, (w) => applyPlanChange(w, restoreProject(closed)));
    const back = await load();
    expect(back.project.state).toBe('paused');
    expect(back.project.slip_log).toEqual([]);
    expect(back.tasks.find((t) => t.id === 'open')).toMatchObject({ cancelled_at: null, cancelled_by: null });
    expect(back.tasks.find((t) => t.id === 'done')?.cancelled_at).toBeUndefined();
    expect((await getRecord(db, 'time_block', 'ahead'))?.cancelled).toBe(true);
    expect((await getRecord(db, 'week_pick', 'pick:2026-11-02:open'))?.deleted_at).toBe(NOW);
  });

  it('restores a project closed before tasks were marked from its close entry, which the milestone counts by too', () => {
    const undo = [
      { type: 'project', id: 'p', fields: { state: 'paused' } },
      { type: 'task', id: 'sand', fields: { cancelled_at: null } },
    ];
    const plan: ProjectPlan = {
      project: {
        id: 'p',
        title: 'Paint the fence',
        state: 'finished',
        start: '2026-10-01',
        end: '2026-12-31',
        slip_log: [{ at: NOW, kind: 'close', text: 'Nov 4: Finished.', undo }],
      },
      milestones: [{ id: 'm', project_id: 'p', title: 'First coat' }],
      tasks: [
        { id: 'sand', kind: 'project', project_id: 'p', milestone_id: 'm', title: 'Sand the boards', cancelled_at: NOW },
        { id: 'hire', kind: 'project', project_id: 'p', milestone_id: 'm', title: 'Hire a sprayer', cancelled_at: NOW },
      ],
    };
    expect(msTasks(plan, plan.milestones[0]!).map((t) => t.id)).toEqual(['sand']);
    expect(restoreProject(plan)).toEqual({ writes: [...undo, { type: 'project', id: 'p', fields: { slip_log: [] } }] });
  });

  it('makes a project closed some other way active again', () => {
    const plan: ProjectPlan = {
      project: { id: 'p', title: 'Paint the fence', state: 'finished', start: '2026-10-01', end: '2026-12-31' },
      milestones: [],
      tasks: [],
    };
    expect(restoreProject(plan)).toEqual({ writes: [{ type: 'project', id: 'p', fields: { state: 'active' } }] });
  });
});

// Sync merges each field by last writer wins, and the whole log is one field. So a phone that replans offline, after
// the Mac finished or paused the project, replaces the Mac's log with its own and loses the Mac's entry.
describe('a replan on another device that replaces the log', () => {
  async function devices() {
    const mac = fixedClock(NOW);
    const phone = fixedClock(NOW);
    const server = fakeSyncServer({ now: () => Math.max(mac.now(), phone.now()) });
    const macDb = await openTestDb();
    const phoneDb = await openTestDb();
    await transact(macDb, mac, async (w) => {
      await w.create('project', { title: 'Paint the fence', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p');
      await w.create('milestone', { project_id: 'p', title: 'First coat', due: '2026-11-20' }, 'm');
      await w.create('task', { kind: 'project', project_id: 'p', milestone_id: 'm', title: 'Sand the boards' }, 'sand');
      await w.create('task', { kind: 'project', project_id: 'p', milestone_id: 'm', title: 'Prime the boards' }, 'prime');
      await w.create('task', { kind: 'project', project_id: 'p', milestone_id: 'm', title: 'Hire a sprayer' }, 'hire');
    });
    // Cancelled by the person, so no close should bring it back.
    await transact(macDb, mac, (w) => closeTask(w, 'hire', 'cancelled', mac));
    await runSync(macDb, server.send);
    await runSync(phoneDb, server.send);
    const load = async (db: Db): Promise<ProjectPlan> =>
      gatherPlans(await listRecords(db, 'project'), await listRecords(db, 'milestone'), await listRecords(db, 'task'))[0]!;
    /** The phone, offline since that sync, moves the milestone an hour after the Mac's change, then both sync. */
    async function phoneMoves() {
      phone.set(mac.now() + 3_600_000);
      const plan = await load(phoneDb);
      await transact(phoneDb, phone, (w) => applyPlanChange(w, moveMilestone(plan, 'm', '2026-11-27', context({ clock: phone }))));
      await runSync(phoneDb, server.send);
      await runSync(macDb, server.send);
    }
    return { mac, macDb, phoneDb, send: server.send, load, phoneMoves };
  }

  it('Restore still reopens the tasks finishing cancelled, and the milestone still counts them', async () => {
    const { mac, macDb, phoneDb, send, load, phoneMoves } = await devices();
    await transact(macDb, mac, (w) => closeProject(w, 'p', 'finished', mac));
    await runSync(macDb, send);
    await phoneMoves();

    const closed = await load(macDb);
    expect(closed.project.state).toBe('finished');
    expect(closed.project.slip_log?.map((e) => e.kind)).toEqual(['move']);
    const m = closed.milestones[0]!;
    expect(msTasks(closed, m).map((t) => t.id).sort()).toEqual(['prime', 'sand']);

    await transact(macDb, mac, (w) => applyPlanChange(w, restoreProject(closed)));
    await runSync(macDb, send);
    await runSync(phoneDb, send);
    for (const db of [macDb, phoneDb]) {
      const back = await load(db);
      expect(back.project.state).toBe('active');
      for (const id of ['sand', 'prime']) expect(back.tasks.find((t) => t.id === id)).toMatchObject({ cancelled_at: null, cancelled_by: null });
      expect(back.tasks.find((t) => t.id === 'hire')?.cancelled_at).toBe(NOW);
    }
  });

  it('Resume still moves open dates by the days the project was paused', async () => {
    const { mac, macDb, send, load, phoneMoves } = await devices();
    const paused = await load(macDb);
    await transact(macDb, mac, (w) => applyPlanChange(w, pauseProject(paused, context({ clock: mac }))));
    await runSync(macDb, send);
    await phoneMoves();

    mac.set('2026-11-18T12:00:00Z');
    const before = await load(macDb);
    expect(before.project).toMatchObject({ state: 'paused', paused_on: '2026-11-04' });
    expect(before.project.slip_log?.map((e) => e.kind)).toEqual(['move']);
    await transact(macDb, mac, (w) => applyPlanChange(w, resumeProject(before, context({ clock: mac }))));
    const after = await load(macDb);
    expect(after.project).toMatchObject({ state: 'active', end: '2027-01-14', paused_on: null });
    expect(after.milestones[0]?.due).toBe('2026-12-11');
    expect(after.project.slip_log?.at(-1)?.text).toBe('Nov 18: Resumed. Open dates moved by the 14 days it was paused.');
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
