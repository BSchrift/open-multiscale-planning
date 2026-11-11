import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock';
import { openDb } from './db';
import { deleteInboxItems, sendInboxItems } from './inbox';
import { applyPlanChange } from './plan';
import { inboxTasks } from './queries';
import { getRecord, transact } from './records';
import { nodeSqliteDriver } from '../platform/node-sqlite';

const NOW = '2026-11-04T12:00:00Z'; // a Wednesday; its week starts 2026-11-02

async function setup() {
  const clock = fixedClock(NOW);
  const db = await openDb(nodeSqliteDriver());
  await transact(db, clock, async (w) => {
    await w.create('project', { title: 'Japan trip', state: 'active' }, 'p1');
    await w.create('task', { kind: 'inbox', title: 'Book the flights', estimate_min: 60 }, 'i1');
    await w.create('task', { kind: 'inbox', title: 'Renew the passport' }, 'i2');
    await w.create('task', { kind: 'inbox', title: 'Call the bank' }, 'i3');
    // Picked for this week before it had a home, as Process's Add to this week can leave it.
    await w.create('week_pick', { week_start: '2026-11-02', task_id: 'i2', minutes: 30 }, 'pick:2026-11-02:i2');
  });
  const titles = async () => (await inboxTasks(db)).map((r) => r.title);
  return { clock, db, titles };
}

describe('the Inbox select mode, many items at once', () => {
  it('sends items to a project as one change, as Process sends one, and one reverse puts them all back', async () => {
    const { clock, db, titles } = await setup();
    const undo = await transact(db, clock, (w) => sendInboxItems(w, ['i1', 'i2'], 'p1'));

    for (const id of ['i1', 'i2']) {
      expect(await getRecord(db, 'task', id)).toMatchObject({ kind: 'project', project_id: 'p1', milestone_id: null, schedule: null, next_due: null });
    }
    // The title and estimate stay as they were.
    expect(await getRecord(db, 'task', 'i1')).toMatchObject({ title: 'Book the flights', estimate_min: 60 });
    expect(await titles()).toEqual(['Call the bank']);
    expect(undo.writes.map((w) => `${w.type}:${w.id}`)).toEqual(['task:i2', 'task:i1']);

    await transact(db, clock, (w) => applyPlanChange(w, undo));
    expect(await titles()).toEqual(['Book the flights', 'Renew the passport', 'Call the bank']);
    expect(await getRecord(db, 'task', 'i1')).toMatchObject({ kind: 'inbox', project_id: null, estimate_min: 60 });
  });

  it('makes items one offs, with no date yet, as Process does', async () => {
    const { clock, db, titles } = await setup();
    const undo = await transact(db, clock, (w) => sendInboxItems(w, ['i1', 'i3'], null));

    for (const id of ['i1', 'i3']) {
      expect(await getRecord(db, 'task', id)).toMatchObject({
        kind: 'one_off',
        project_id: null,
        milestone_id: null,
        schedule: { type: 'once', from: null, to: null },
        next_due: null,
      });
    }
    expect(await titles()).toEqual(['Renew the passport']);

    await transact(db, clock, (w) => applyPlanChange(w, undo));
    expect(await titles()).toEqual(['Book the flights', 'Renew the passport', 'Call the bank']);
    expect(await getRecord(db, 'task', 'i3')).toMatchObject({ kind: 'inbox', schedule: null, next_due: null });
  });

  it("deletes items as Process's Delete/done does each, freeing their picks, with one reverse", async () => {
    const { clock, db, titles } = await setup();
    const undo = await transact(db, clock, (w) => deleteInboxItems(w, ['i2', 'i3'], clock));

    expect((await getRecord(db, 'task', 'i2'))?.deleted_at).toBe(NOW);
    expect((await getRecord(db, 'task', 'i3'))?.deleted_at).toBe(NOW);
    expect((await getRecord(db, 'week_pick', 'pick:2026-11-02:i2'))?.deleted_at).toBe(NOW);
    expect(await titles()).toEqual(['Book the flights']);
    // The last item closed is the first put back.
    expect(undo.writes.map((w) => `${w.type}:${w.id}`)).toEqual(['task:i3', 'week_pick:pick:2026-11-02:i2', 'task:i2']);

    await transact(db, clock, (w) => applyPlanChange(w, undo));
    expect(await titles()).toEqual(['Book the flights', 'Renew the passport', 'Call the bank']);
    expect((await getRecord(db, 'week_pick', 'pick:2026-11-02:i2'))?.deleted_at).toBeNull();
  });
});
