import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { getRecord } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderScreen } from '../../app/testing';

afterEach(cleanup);

// The harness clock is Monday Nov 2, 2026.
async function rye(w: Writer, goal: string | null = 'g1') {
  await w.create('objective', { title: 'Learn to bake bread', state: 'active' }, 'g1');
  await w.create('project', { objective_id: goal, title: 'Rye bread', state: 'active', start: '2026-10-01', end: '2026-12-15' }, 'p1');
  await w.create('milestone', { project_id: 'p1', title: 'First loaf', due: '2026-11-20' }, 'm1');
  await w.create('task', { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Shape the dough', estimate_min: 60 }, 't1');
  await w.create('task', { kind: 'project', project_id: 'p1', title: 'Bake it', estimate_min: 30 }, 't2');
  await w.create('task', { kind: 'project', project_id: 'p1', title: 'Buy rye', estimate_min: 30, done_at: '2026-10-20T15:00:00Z' }, 't3');
}

const settings = async (seed: (w: Writer) => Promise<void> = rye) => {
  const t = await renderScreen('goals', { seed, params: { project: 'p1' } });
  await userEvent.click(await screen.findByRole('button', { name: 'Project settings' }));
  return { t, dialog: screen.getByRole('dialog', { name: 'Project settings' }) };
};

describe('Finish or Drop with open tasks', () => {
  for (const [button, yes, done] of [
    ['Finish', 'Yes, finish', 'Finished'],
    ['Drop', 'Yes, drop', 'Dropped'],
  ] as const) {
    it(`${button}: one unticked box moves the open tasks to the goal's backlog instead, with Undo`, async () => {
      const { t, dialog } = await settings();
      await userEvent.click(within(dialog).getByRole('button', { name: button }));
      const ask = within(dialog).getByRole('alert');
      expect(ask).toHaveTextContent('2 tasks are still open, 1h 30m.');
      const box = within(ask).getByRole('checkbox', { name: 'Move them to the backlog for Learn to bake bread' });
      // Nothing moves unless you say so.
      expect(box).not.toBeChecked();
      expect(within(ask).getByRole('button', { name: /^Cancel/ })).toHaveFocus();
      await userEvent.click(box);
      await userEvent.click(within(ask).getByRole('button', { name: yes }));
      expect(await screen.findByText(`${done}. 2 open tasks moved to the backlog for Learn to bake bread.`)).toBeVisible();
      expect((await getRecord(t.db, 'project', 'p1'))?.state).toBe(button === 'Finish' ? 'finished' : 'dropped');
      expect(await getRecord(t.db, 'task', 't1')).toMatchObject({ project_id: 'backlog:g1', milestone_id: null, moved_from: 'm1' });
      expect((await getRecord(t.db, 'task', 't2'))?.cancelled_at).toBeUndefined();
      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await waitFor(async () => expect(await getRecord(t.db, 'task', 't1')).toMatchObject({ project_id: 'p1', milestone_id: 'm1' }));
      expect((await getRecord(t.db, 'project', 'p1'))?.state).toBe('active');
    });
  }

  it('left unticked, cancels the open tasks as before', async () => {
    const { t, dialog } = await settings();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Finish' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Yes, finish' }));
    expect(await screen.findByText('Finished. Open tasks cancelled.')).toBeVisible();
    expect(await getRecord(t.db, 'task', 't1')).toMatchObject({ project_id: 'p1', cancelled_by: 'p1' });
  });

  it('has no box for a project with no goal', async () => {
    const { dialog } = await settings((w) => rye(w, null));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Finish' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Finish this project?');
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });
});
