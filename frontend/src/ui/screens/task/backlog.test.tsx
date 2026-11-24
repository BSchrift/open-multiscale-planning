import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRecord } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { pickFrom, renderScreen } from '../../app/testing';

afterEach(cleanup);

// The harness clock is Monday Nov 2, 2026.
async function seed(w: Writer) {
  await w.create('objective', { title: 'Learn to bake bread', state: 'active' }, 'g1');
  await w.create('objective', { title: 'Stay fit', state: 'active' }, 'g2');
  await w.create('objective', { title: 'Old goal', state: 'archived' }, 'g3');
  await w.create('project', { objective_id: 'g1', title: 'Rye bread', state: 'active', start: '2026-10-01', end: '2026-12-15' }, 'p1');
  await w.create('milestone', { project_id: 'p1', title: 'First loaf', due: '2026-11-20' }, 'm1');
  // Made by an earlier filing; it lists as a backlog, never as a project.
  await w.create('project', { objective_id: 'g1', title: 'Learn to bake bread, Backlog', state: 'active', start: '2026-10-01', end: '2027-03-31' }, 'backlog:g1');
  await w.create('task', { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Shape the dough', estimate_min: 60 }, 't1');
  await w.create('task', { kind: 'inbox', title: 'Buy a banneton' }, 'i1');
  await w.create('task', { kind: 'project', project_id: 'backlog:g1', title: 'Watch a shaping video', order: 1 }, 'b1');
  await w.create('task', { kind: 'one_off', title: 'Order rye flour', schedule: { type: 'once', from: '2026-11-20' }, next_due: '2026-11-20' }, 'o1');
  await w.create('task', { kind: 'one_off', title: 'Feed the starter', schedule: { type: 'float', every: 1, unit: 'week' }, next_due: '2026-11-09' }, 'o2');
}

const popup = async (task: string) => {
  const t = await renderScreen('task', { seed, presentation: 'overlay', params: { task }, close: vi.fn() });
  return { t, popup: await screen.findByRole('dialog') };
};
const belongs = (popup: HTMLElement) => within(popup).getByRole('combobox', { name: 'Belongs to' });

describe('Belongs to, with goal backlogs', () => {
  it('lists each active goal\'s backlog after One offs, flat, and never a backlog as a project', async () => {
    const { popup: p } = await popup('i1');
    await userEvent.click(belongs(p));
    expect(within(p).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Inbox',
      'One offs',
      'Learn to bake bread, Backlog',
      'Stay fit, Backlog',
      'Rye bread, First loaf',
      'Rye bread, Done',
    ]);
  });

  it('moves an Inbox item into a backlog not made yet, last in arrival order, with Undo', async () => {
    const { t, popup: p } = await popup('i1');
    await pickFrom(belongs(p), 'Stay fit, Backlog');
    await userEvent.click(within(p).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Moved Buy a banneton to the backlog for Stay fit.')).toBeVisible();
    expect(await getRecord(t.db, 'task', 'i1')).toMatchObject({ kind: 'project', project_id: 'backlog:g2', milestone_id: null });
    expect(typeof (await getRecord(t.db, 'task', 'i1'))?.order).toBe('number');
    expect(await getRecord(t.db, 'project', 'backlog:g2')).toMatchObject({ objective_id: 'g2', state: 'active', title: 'Stay fit, Backlog' });
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 'i1'))?.kind).toBe('inbox'));
  });

  it('says first that a dated one off loses its date, and clears it', async () => {
    const { t, popup: p } = await popup('o1');
    await pickFrom(belongs(p), 'Learn to bake bread, Backlog');
    const note = within(p).getByRole('status');
    expect(note).toHaveTextContent('Backlog tasks have no date, so Fri Nov 20 will be cleared.');
    expect(belongs(p)).toHaveAttribute('aria-describedby', note.id);
    await userEvent.click(within(p).getByRole('button', { name: 'Save' }));
    await screen.findByText('Moved Order rye flour to the backlog for Learn to bake bread.');
    expect(await getRecord(t.db, 'task', 'o1')).toMatchObject({ kind: 'project', project_id: 'backlog:g1', schedule: null, next_due: null });
  });

  it('keeps a repeating one off out of backlogs, saying why from the start', async () => {
    const { popup: p } = await popup('o2');
    expect(within(p).getByRole('status')).toHaveTextContent('A repeating task stays in One offs. For regular time toward a goal, add a practice.');
    await userEvent.click(belongs(p));
    const option = within(p).getByRole('option', { name: 'Learn to bake bread, Backlog, Not for a repeating task' });
    expect(option).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(option);
    expect(belongs(p)).toHaveDisplayValue('One offs');
  });

  it('moves a project task to a backlog, dropping its milestone', async () => {
    const { t, popup: p } = await popup('t1');
    await pickFrom(belongs(p), 'Learn to bake bread, Backlog');
    await userEvent.click(within(p).getByRole('button', { name: 'Save' }));
    await screen.findByText('Moved Shape the dough to the backlog for Learn to bake bread.');
    expect(await getRecord(t.db, 'task', 't1')).toMatchObject({ project_id: 'backlog:g1', milestone_id: null });
  });

  it('shows a backlog task where it is', async () => {
    const { popup: p } = await popup('b1');
    expect(belongs(p)).toHaveDisplayValue('Learn to bake bread, Backlog');
  });
});
