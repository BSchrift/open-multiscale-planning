import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { getRecord } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderScreen } from '../../app/testing';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// The harness clock is Monday Nov 2, 2pm in Chicago.
async function seed(w: Writer) {
  await w.create('objective', { title: 'Learn to bake bread', state: 'active', order: 1 }, 'g1');
  await w.create('objective', { title: 'Stay fit', state: 'active', order: 2 }, 'g2');
  await w.create('objective', { title: 'Old goal', state: 'archived' }, 'g3');
  await w.create('project', { objective_id: 'g1', title: 'Learn to bake bread, Backlog', state: 'active', start: '2026-10-01', end: '2027-03-31' }, 'backlog:g1');
  await w.create('task', { kind: 'project', project_id: 'backlog:g1', title: 'Watch a shaping video', order: 1 }, 'b1');
  await w.create('task', { kind: 'inbox', title: 'Buy a banneton', order: 1 }, 'i1');
  await w.create('task', { kind: 'inbox', title: 'Get a bike fit', order: 2 }, 'i2');
  await w.create('task', { kind: 'inbox', title: 'Book a dentist check-up', order: 3 }, 'i3');
}

const open = (layout: 'desktop' | 'phone' = 'desktop') => renderScreen('process', { layout, seed, presentation: 'overlay' });
const card = () => screen.getByRole('dialog', { name: 'Process Inbox' });
const title = () => screen.getByRole('heading', { level: 1 });
const keysOn = () => localStorage.setItem('multiscale.processKeys', 'true');

describe('Process into a goal backlog, desktop', () => {
  it("B swaps the picker for the goals, and a goal's number adds the item to its backlog, last, with Undo", { timeout: 15000 }, async () => {
    keysOn();
    const t = await open();
    await screen.findByRole('heading', { name: 'Buy a banneton', level: 1 }, { timeout: 5000 });
    fireEvent.keyDown(title(), { key: 'b', code: 'KeyB' });
    const chooser = within(card()).getByRole('group', { name: "Which goal's backlog?" });
    expect(screen.queryByRole('combobox', { name: 'Add to a project or One offs' })).toBeNull();
    const goals = within(chooser).getAllByRole('button', { name: /backlog for/ });
    expect(goals.map((b) => b.getAttribute('aria-label'))).toEqual(['Add to the backlog for Learn to bake bread, 1 task', 'Add to the backlog for Stay fit, No tasks yet']);
    expect(goals[0]).toHaveAttribute('aria-keyshortcuts', '1 Alt+1');
    await waitFor(() => expect(goals[0]).toHaveFocus());
    fireEvent.keyDown(goals[0]!, { key: '1', code: 'Digit1' });
    expect(await screen.findByRole('heading', { name: 'Get a bike fit', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Added Buy a banneton to the backlog for Learn to bake bread.')).toBeInTheDocument();
    expect(await getRecord(t.db, 'task', 'i1')).toMatchObject({ kind: 'project', project_id: 'backlog:g1', milestone_id: null });
    // Back on the picker for the next item.
    expect(screen.getByRole('combobox', { name: 'Add to a project or One offs' })).toBeInTheDocument();
    await userEvent.click(within(card()).getByRole('button', { name: /^‹ Undo/ }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 'i1'))?.kind).toBe('inbox'));
  });

  it('makes a backlog for a goal with none, and Back or Esc puts the picker back with focus on Goal backlog', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Buy a banneton', level: 1 }, { timeout: 5000 });
    const opener = within(card()).getByRole('button', { name: /^Goal backlog/ });
    await userEvent.click(opener);
    await userEvent.click(within(card()).getByRole('button', { name: /^Back/ }));
    await waitFor(() => expect(within(card()).getByRole('button', { name: /^Goal backlog/ })).toHaveFocus());
    await userEvent.click(within(card()).getByRole('button', { name: /^Goal backlog/ }));
    fireEvent.keyDown(within(card()).getByRole('group', { name: "Which goal's backlog?" }), { key: 'Escape' });
    await waitFor(() => expect(within(card()).getByRole('button', { name: /^Goal backlog/ })).toHaveFocus());
    expect(screen.getByRole('dialog', { name: 'Process Inbox' })).toBeInTheDocument();
    await userEvent.click(within(card()).getByRole('button', { name: /^Goal backlog/ }));
    await userEvent.click(within(card()).getByRole('button', { name: 'Add to the backlog for Stay fit, No tasks yet' }));
    await screen.findByText('Added Buy a banneton to the backlog for Stay fit.');
    expect(await getRecord(t.db, 'project', 'backlog:g2')).toMatchObject({ objective_id: 'g2', state: 'active' });
  });
});

describe('Process into a goal backlog, phone', () => {
  it('Goal backlog opens a sheet of goals; the repeat for the same goal is two taps', async () => {
    const t = await open('phone');
    await screen.findByRole('heading', { name: 'Buy a banneton', level: 1 }, { timeout: 5000 });
    await userEvent.click(within(card()).getByRole('button', { name: 'Goal backlog' }));
    let sheet = await screen.findByRole('dialog', { name: "Which goal's backlog?" });
    // Nothing chosen yet, so the button says what's needed rather than doing nothing.
    expect(within(sheet).getByRole('button', { name: 'Choose a goal first' })).toBeDisabled();
    await userEvent.click(within(sheet).getByRole('button', { name: /^Learn to bake bread/ }));
    expect(within(sheet).getByRole('button', { name: /^Learn to bake bread/ })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Add to the backlog for Learn to bake bread' }));
    expect(await screen.findByRole('heading', { name: 'Get a bike fit', level: 1 })).toBeInTheDocument();
    expect((await getRecord(t.db, 'task', 'i1'))?.project_id).toBe('backlog:g1');

    // The last goal used starts chosen: Goal backlog, then Add.
    await userEvent.click(within(card()).getByRole('button', { name: 'Goal backlog' }));
    sheet = await screen.findByRole('dialog', { name: "Which goal's backlog?" });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Add to the backlog for Learn to bake bread' }));
    expect(await screen.findByRole('heading', { name: 'Book a dentist check-up', level: 1 })).toBeInTheDocument();
    expect((await getRecord(t.db, 'task', 'i2'))?.project_id).toBe('backlog:g1');
  });
});
