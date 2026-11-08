import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock';
import type { Db, Sql } from './db';
import { applyPlanChange, gatherPlans, moveMilestone, pauseProject, restoreProject, resumeProject, undoLastChange } from './plan';
import type { ProjectPlan } from './plan';
import { context } from './plan-testing';
import { getRecord, ID_PATTERN, listRecords, transact } from './records';
import { entryId, getProject, listProjects, mergeLog } from './slipLog';
import { runSync } from './sync';
import { fakeSyncServer } from './sync-testing';
import { closeProject } from './tasks';
import type { Project, SlipEntry, SlipEntryRecord } from './types';
import { openTestDb } from '../platform/node-sqlite';

const NOW = Date.parse('2026-11-04T12:00:00Z'); // a Wednesday
const HOUR = 3_600_000;

const load = async (sql: Sql): Promise<ProjectPlan> =>
  gatherPlans(await listProjects(sql), await listRecords(sql, 'milestone'), await listRecords(sql, 'task'))[0]!;

async function fence(db: Db, clock = fixedClock(NOW), slip_log?: SlipEntry[]) {
  await transact(db, clock, async (w) => {
    await w.create('project', { title: 'Paint the fence', state: 'active', start: '2026-10-01', end: '2026-12-31', ...(slip_log ? { slip_log } : {}) }, 'p');
    await w.create('milestone', { project_id: 'p', title: 'First coat', due: '2026-11-20' }, 'm');
    await w.create('task', { kind: 'project', project_id: 'p', milestone_id: 'm', title: 'Sand the boards' }, 'sand');
  });
}

/** A laptop and a phone that share one project, synced, each with a clock of its own. */
async function twoDevices() {
  const server = fakeSyncServer({ now: () => NOW + 24 * HOUR });
  const laptop = { db: await openTestDb(), clock: fixedClock(NOW) };
  const phone = { db: await openTestDb(), clock: fixedClock(NOW) };
  await fence(laptop.db, laptop.clock);
  const sync = async () => {
    for (const device of [laptop, phone, laptop]) await runSync(device.db, server.send);
  };
  await sync();
  return { laptop, phone, sync };
}

/** The phone, offline, moves the milestone later than the laptop's change, so its whole array wins. */
async function phoneMovesLater(phone: { db: Db; clock: ReturnType<typeof fixedClock> }) {
  phone.clock.set(NOW + 2 * HOUR);
  const plan = await load(phone.db);
  await transact(phone.db, phone.clock, (w) => applyPlanChange(w, moveMilestone(plan, 'm', '2026-12-04', context({ clock: phone.clock }))));
}

describe('two devices replanning one project offline', () => {
  it('keep both entries, so Restore still reopens the tasks the laptop’s finish cancelled', async () => {
    const { laptop, phone, sync } = await twoDevices();
    laptop.clock.set(NOW + HOUR);
    await transact(laptop.db, laptop.clock, (w) => closeProject(w, 'p', 'finished', laptop.clock));
    await phoneMovesLater(phone);
    await sync();

    // The array older bundles read is the phone's alone, as before; the records keep the laptop's entry.
    expect((await getRecord(laptop.db, 'project', 'p'))?.slip_log?.map((e) => e.kind)).toEqual(['move']);
    for (const device of [laptop, phone]) {
      const plan = await load(device.db);
      expect(plan.project.state).toBe('finished');
      expect(plan.project.slip_log?.map((e) => e.kind)).toEqual(['close', 'move']);
    }
    const plan = await load(laptop.db);
    await transact(laptop.db, laptop.clock, (w) => applyPlanChange(w, restoreProject(plan, laptop.clock)));
    await sync();
    for (const device of [laptop, phone]) {
      const back = await load(device.db);
      expect(back.project.state).toBe('active');
      expect((await getRecord(device.db, 'task', 'sand'))?.cancelled_at).toBeNull();
      expect(back.project.slip_log?.map((e) => e.kind)).toEqual(['move']);
      expect(back.milestones[0]?.due).toBe('2026-12-04');
    }
  });

  it('keep the laptop’s pause, so resuming still moves dates by the days paused', async () => {
    const { laptop, phone, sync } = await twoDevices();
    laptop.clock.set(NOW + HOUR);
    const before = await load(laptop.db);
    await transact(laptop.db, laptop.clock, (w) => applyPlanChange(w, pauseProject(before, context({ clock: laptop.clock }))));
    await phoneMovesLater(phone);
    await sync();

    phone.clock.set(NOW + 10 * 24 * HOUR);
    const plan = await load(phone.db);
    expect(plan.project.slip_log?.map((e) => e.kind)).toEqual(['pause', 'move']);
    await transact(phone.db, phone.clock, (w) => applyPlanChange(w, resumeProject(plan, context({ clock: phone.clock }))));
    const resumed = await load(phone.db);
    expect(resumed.project).toMatchObject({ state: 'active', end: '2027-01-10' });
    expect(resumed.milestones[0]?.due).toBe('2026-12-14');
  });
});

/** An entry as a bundle from before slip_entry records logged it: no id, and no record. */
const OLD: SlipEntry = {
  at: '2026-10-20T15:00:00Z',
  kind: 'move',
  milestone_id: 'm',
  from: '2026-11-10',
  to: '2026-11-20',
  days: 10,
  text: 'Oct 20: Moved First coat from Nov 10 to Nov 20.',
  undo: [{ type: 'milestone', id: 'm', fields: { due: '2026-11-10' } }],
};

describe('reading the log', () => {
  it('reads a project from before entry records exactly as its array', async () => {
    const db = await openTestDb();
    await fence(db, fixedClock(NOW), [OLD]);
    expect(await listProjects(db)).toEqual(await listRecords(db, 'project'));
    expect(await getProject(db, 'p')).toEqual(await getRecord(db, 'project', 'p'));
  });

  it('shows an entry in both places once, one only a record holds by when it was logged, and none a deleted record holds', () => {
    const at = (h: number) => `2026-11-04T${String(h).padStart(2, '0')}:00:00Z`;
    const entry = (key: string, h: number): SlipEntry => ({ id: `slip:p:${key}`, at: at(h), kind: 'pause', text: key });
    const record = (key: string, h: number, deleted_at?: string): SlipEntryRecord => {
      const { id, ...fields } = entry(key, h);
      return { id: id!, project_id: 'p', ...fields, ...(deleted_at ? { deleted_at } : {}) };
    };
    const project: Project = { id: 'p', title: 'Paint the fence', state: 'active', start: '2026-10-01', end: '2026-12-31', slip_log: [entry('a', 1), entry('c', 3)] };
    const log = mergeLog(project, [record('a', 1), record('b', 2), record('c', 3, at(4)), record('d', 0)]);
    expect(log.map((e) => e.text)).toEqual(['d', 'a', 'b']);
  });

  it('gives an entry from before records an id from what it says, the same on any device', () => {
    const id = entryId('p', OLD);
    expect(id).toMatch(/^slip:p:[0-9a-z]+$/);
    expect(id).toMatch(ID_PATTERN);
    // As the server may hand it back: its undo's keys in another order.
    const back = { ...OLD, undo: [{ fields: { due: '2026-11-10' }, id: 'm', type: 'milestone' }] };
    expect(entryId('p', back)).toBe(id);
    expect(entryId('p', { ...OLD, to: '2026-11-21' })).not.toBe(id);
    expect(entryId('q', OLD)).not.toBe(id);
    expect(entryId('p', { ...OLD, id: 'slip:p:given' })).toBe('slip:p:given');
  });
});

describe('writing the log', () => {
  const clock = fixedClock(NOW);
  const ctx = context({ clock });

  it('logs a new entry as a record and in the array, and its Undo takes it off both', async () => {
    const db = await openTestDb();
    await fence(db);
    const reverse = await transact(db, clock, async (w) => applyPlanChange(w, moveMilestone(await load(w.sql), 'm', '2026-12-04', ctx)));

    const [record] = await listRecords(db, 'slip_entry');
    expect(record).toMatchObject({ project_id: 'p', kind: 'move', from: '2026-11-20', to: '2026-12-04', text: 'Nov 4: Moved First coat from Nov 20 to Dec 4.' });
    // Older bundles read the same entry from the array.
    expect((await getRecord(db, 'project', 'p'))?.slip_log).toEqual([{ id: record!.id, ...withoutRecordFields(record!) }]);
    expect((await load(db)).project.slip_log?.map((e) => e.id)).toEqual([record!.id]);

    await transact(db, clock, (w) => applyPlanChange(w, reverse));
    expect((await getRecord(db, 'slip_entry', record!.id))?.deleted_at).toBe('2026-11-04T12:00:00Z');
    // Back to as it was: never written.
    expect((await getRecord(db, 'project', 'p'))?.slip_log).toBeNull();
    const back = await load(db);
    expect(back.project.slip_log).toEqual([]);
    expect(back.milestones[0]?.due).toBe('2026-11-20');
  });

  it('undoes the latest change from its line, and the toast after that brings it back', async () => {
    const db = await openTestDb();
    await fence(db);
    await transact(db, clock, async (w) => applyPlanChange(w, moveMilestone(await load(w.sql), 'm', '2026-12-04', ctx)));
    const moved = await load(db);
    const reverse = await transact(db, clock, (w) => applyPlanChange(w, undoLastChange(moved, clock)!));
    const undone = await load(db);
    expect(undone.project.slip_log).toEqual([]);
    expect(undone.milestones[0]?.due).toBe('2026-11-20');

    await transact(db, clock, (w) => applyPlanChange(w, reverse));
    const again = await load(db);
    expect(again.project.slip_log).toEqual(moved.project.slip_log);
    expect(again.milestones[0]?.due).toBe('2026-12-04');
  });

  it('undoes an entry from before records, keeps it off when an older bundle writes its array back, and can bring it back', async () => {
    const db = await openTestDb();
    await fence(db, clock, [OLD]);
    const plan = await load(db);
    const reverse = await transact(db, clock, (w) => applyPlanChange(w, undoLastChange(plan, clock)!));
    const undone = await load(db);
    expect(undone.project.slip_log).toEqual([]);
    expect(undone.milestones[0]?.due).toBe('2026-11-10');
    expect(await getRecord(db, 'slip_entry', entryId('p', OLD))).toMatchObject({ project_id: 'p', kind: 'move', deleted_at: '2026-11-04T12:00:00Z' });

    // An older bundle that hadn't heard of the undo writes the whole array back.
    await transact(db, clock, (w) => w.set('project', 'p', { slip_log: [OLD] }));
    expect((await load(db)).project.slip_log).toEqual([]);

    await transact(db, clock, (w) => applyPlanChange(w, reverse));
    const back = await load(db);
    expect(back.project.slip_log).toEqual([OLD]);
    expect(back.milestones[0]?.due).toBe('2026-11-20');
  });

  it('logs a close for Restore in both places too', async () => {
    const db = await openTestDb();
    await fence(db);
    await transact(db, clock, (w) => closeProject(w, 'p', 'dropped', clock));
    const [record] = await listRecords(db, 'slip_entry');
    expect(record).toMatchObject({ project_id: 'p', kind: 'close', text: 'Nov 4: Dropped.' });
    expect((await getRecord(db, 'project', 'p'))?.slip_log?.map((e) => e.id)).toEqual([record!.id]);
  });
});

const withoutRecordFields = ({ id: _id, project_id: _project, deleted_at: _deleted, ...entry }: SlipEntryRecord) => entry;
