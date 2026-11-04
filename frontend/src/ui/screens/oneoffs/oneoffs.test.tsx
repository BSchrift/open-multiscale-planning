import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../../core/clock';
import { getRecord } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderScreen } from '../../app/testing';
import { moreLine } from './moreLine';

afterEach(cleanup);

// The harness clock is Monday Nov 2, 2pm in Chicago.
async function seedList(w: Writer) {
  await w.create('task', { kind: 'one_off', title: 'Mend the gate', schedule: { type: 'once', from: '2026-11-03', to: '2026-11-06' }, next_due: '2026-11-03', estimate_min: 60 }, 'range');
  await w.create('task', { kind: 'one_off', title: 'Tidy the shed', schedule: { type: 'once' } }, 'undated');
  await w.create('task', { kind: 'one_off', title: 'Return the drill', schedule: { type: 'once', from: '2026-11-07' }, next_due: '2026-11-07' }, 'day');
  await w.create('task', { kind: 'one_off', title: 'Feed the fish', schedule: { type: 'recurring', every: 1, unit: 'week', anchor: '2026-11-02' }, next_due: '2026-11-09' }, 'weekly');
  await w.create('task', { kind: 'one_off', title: 'Sharpen the knives', schedule: { type: 'float', every: 6, unit: 'week' } }, 'float');
  await w.create('task', { kind: 'project', project_id: 'p', title: 'Write the report' }, 'project-task');
  await w.create('time_block', { task_id: 'day', start: '2026-11-07T15:00:00Z', end: '2026-11-07T16:00:00Z', tz: 'America/Chicago' }, 'day-block');
}

const checkboxes = (within_: HTMLElement = document.body) => within(within_).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'));
const box = (title: string) => screen.getByRole('checkbox', { name: `${title} done` });
const lineOf = (title: string) => box(title).closest('.maintrow')!.querySelector('.small.quiet')!.textContent;
const repeating = () => screen.getByRole('region', { name: 'Repeating' });

describe('One offs on desktop', () => {
  it('lists one-time ones soonest first with undated last, then the repeating ones apart', async () => {
    await renderScreen('oneoffs', { seed: seedList });
    expect(await screen.findByRole('heading', { name: 'One offs', level: 1 })).toHaveClass('mhead');
    await screen.findByText('Mend the gate');
    expect(checkboxes()).toEqual(['Mend the gate done', 'Return the drill done', 'Tidy the shed done', 'Feed the fish done', 'Sharpen the knives done']);
    expect(checkboxes(repeating())).toEqual(['Feed the fish done', 'Sharpen the knives done']);
    expect(lineOf('Mend the gate')).toBe('Nov 3 to Nov 6, 1h');
    expect(lineOf('Tidy the shed')).toBe('No date');
    expect(lineOf('Feed the fish')).toBe('Weekly, next Mon Nov 9');
    expect(lineOf('Sharpen the knives')).toBe('6 weeks after last done, next after first done');
    expect(screen.queryByText('Write the report')).toBeNull();
  });

  it('ticks a one-time one, freeing its time, out of view with Undo, focus moving to the next one', async () => {
    const t = await renderScreen('oneoffs', { seed: seedList });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Return the drill done' }));
    expect(await screen.findByText('Completed Return the drill.')).toBeVisible();
    await waitFor(() => expect(screen.queryByText('Return the drill')).toBeNull());
    expect(box('Tidy the shed')).toHaveFocus();
    expect((await getRecord(t.db, 'task', 'day'))?.done_at).toBeTruthy();
    expect((await getRecord(t.db, 'time_block', 'day-block'))?.cancelled).toBe(true);
    // The toast says it, so the list's own line doesn't say it again.
    expect(screen.getAllByRole('status').some((s) => s.textContent === 'Return the drill done')).toBe(false);
    expect(screen.getByRole('button', { name: 'Show 1 completed in One offs' })).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(box('Return the drill')).toHaveFocus());
    expect(box('Return the drill')).not.toBeChecked();
    expect(lineOf('Return the drill')).toBe('Nov 7');
    expect((await getRecord(t.db, 'task', 'day'))?.done_at).toBeNull();
    expect((await getRecord(t.db, 'time_block', 'day-block'))?.cancelled).toBeNull();
  });

  it('Show completed shows the ones ticked today, which untick and tick in place', async () => {
    const t = await renderScreen('oneoffs', { seed: seedList });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Return the drill done' }));
    const show = await screen.findByRole('button', { name: 'Show 1 completed in One offs' });
    await userEvent.click(show);
    expect(show).toHaveAccessibleName('Hide completed in One offs');
    expect(box('Return the drill')).toBeChecked();
    expect(screen.getByText('Return the drill')).toHaveClass('done');
    expect(lineOf('Return the drill')).toBe('Done today');
    expect(screen.queryByRole('button', { name: /date for Return the drill/ })).toBeNull();

    await userEvent.click(box('Return the drill'));
    await waitFor(() => expect(box('Return the drill')).not.toBeChecked());
    expect(lineOf('Return the drill')).toBe('Nov 7');
    expect((await getRecord(t.db, 'task', 'day'))?.done_at).toBeNull();
    await userEvent.click(box('Return the drill'));
    await waitFor(() => expect(box('Return the drill')).toBeChecked());
    expect(screen.getAllByRole('status').some((s) => s.textContent === 'Return the drill done')).toBe(true);
  });

  it('ticks a repeating one onto its next date, as one row, and unticks it back', async () => {
    await renderScreen('oneoffs', { seed: seedList });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Feed the fish done' }));
    await waitFor(() => expect(lineOf('Feed the fish')).toBe('Done today, next Mon Nov 16'));
    expect(checkboxes(repeating())).toEqual(['Feed the fish done', 'Sharpen the knives done']);
    // It's still to do on its next date, so it stays in view.
    expect(screen.queryByRole('button', { name: /completed/ })).toBeNull();
    await userEvent.click(box('Feed the fish'));
    await waitFor(() => expect(lineOf('Feed the fish')).toBe('Weekly, next Mon Nov 9'));
  });

  it('keeps ticked rows, shown, until the day changes', async () => {
    localStorage.setItem('multiscale.showCompleted', 'true');
    const t = await renderScreen('oneoffs', { seed: seedList });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Return the drill done' }));
    await userEvent.click(box('Feed the fish'));
    await waitFor(() => expect(box('Feed the fish')).toBeChecked());
    expect(box('Return the drill')).toBeChecked();

    t.clock.set('2026-11-03T20:00:00Z');
    await t.write((w) => w.create('task', { kind: 'inbox', title: 'Anything' }));
    await waitFor(() => expect(screen.queryByText('Return the drill')).toBeNull());
    expect(box('Feed the fish')).not.toBeChecked();
    expect(lineOf('Feed the fish')).toBe('Weekly, next Mon Nov 16');
  });

  it('adds one offs from the form, and dates one in place', async () => {
    const t = await renderScreen('oneoffs', { seed: seedList });
    const form = await screen.findByRole('form', { name: 'Add a one off' });
    await userEvent.type(within(form).getByLabelText('Title'), 'Clean the oven');
    await userEvent.selectOptions(within(form).getByLabelText('Repeats'), 'recurring');
    await userEvent.selectOptions(within(form).getByLabelText('How often'), 'Monthly');
    await userEvent.click(within(form).getByRole('button', { name: 'Add one off' }));
    await waitFor(() => expect(checkboxes(repeating())).toContain('Clean the oven done'));
    expect(lineOf('Clean the oven')).toBe('Monthly on the 2nd, next Nov 2, 30m');

    await userEvent.click(screen.getByRole('button', { name: 'Add date for Tidy the shed' }));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-11-04' } });
    await userEvent.click(screen.getByRole('button', { name: 'Set date' }));
    await waitFor(() => expect(lineOf('Tidy the shed')).toBe('Nov 4'));
    expect(checkboxes().slice(0, 3)).toEqual(['Mend the gate done', 'Tidy the shed done', 'Return the drill done']);
    expect((await getRecord(t.db, 'task', 'undated'))?.next_due).toBe('2026-11-04');
  });
});

describe('changing how a one off repeats', () => {
  it('opens on its current rule, and saving it unchanged keeps its next date', async () => {
    const t = await renderScreen('oneoffs', { seed: seedList });
    await userEvent.click(await screen.findByRole('button', { name: 'Change repeat for Feed the fish' }));
    const form = screen.getByRole('form', { name: 'Change Feed the fish' });
    expect(within(form).getByLabelText('Repeats')).toHaveValue('recurring');
    expect(within(form).getByLabelText('How often')).toHaveValue('week');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Change Feed the fish' })).toBeNull());
    expect((await getRecord(t.db, 'task', 'weekly'))?.next_due).toBe('2026-11-09');
    expect(screen.getByRole('button', { name: 'Change repeat for Feed the fish' })).toHaveFocus();
  });

  it('deletes one from its form, freeing its time, with Undo', async () => {
    const t = await renderScreen('oneoffs', { seed: seedList });
    await userEvent.click(await screen.findByRole('button', { name: 'Change repeat for Return the drill' }));
    const form = screen.getByRole('form', { name: 'Change Return the drill' });
    await userEvent.click(within(form).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Return the drill done' })).toBeNull());
    expect((await getRecord(t.db, 'task', 'day'))?.deleted_at).toBeTruthy();
    expect((await getRecord(t.db, 'time_block', 'day-block'))?.cancelled).toBe(true);
    // The row has gone, so focus goes to Undo rather than the page.
    const undo = screen.getByRole('button', { name: 'Undo' });
    await waitFor(() => expect(undo).toHaveFocus());
    await userEvent.click(undo);
    expect(await screen.findByRole('checkbox', { name: 'Return the drill done' })).toBeVisible();
    expect((await getRecord(t.db, 'time_block', 'day-block'))?.cancelled).toBeFalsy();
  });

  it('changes weekly to monthly, and makes a one-time one repeat', async () => {
    const t = await renderScreen('oneoffs', { seed: seedList });
    await userEvent.click(await screen.findByRole('button', { name: 'Change repeat for Feed the fish' }));
    let form = screen.getByRole('form', { name: 'Change Feed the fish' });
    await userEvent.selectOptions(within(form).getByLabelText('How often'), 'Monthly');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(lineOf('Feed the fish')).toBe('Monthly on the 2nd, next Nov 2'));
    expect((await getRecord(t.db, 'task', 'weekly'))?.schedule).toEqual({ type: 'recurring', every: 1, unit: 'month', anchor: '2026-11-02' });

    await userEvent.click(screen.getByRole('button', { name: 'Change repeat for Tidy the shed' }));
    form = screen.getByRole('form', { name: 'Change Tidy the shed' });
    expect(within(form).getByLabelText('Repeats')).toHaveValue('once');
    await userEvent.selectOptions(within(form).getByLabelText('Repeats'), 'float');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(checkboxes(repeating())).toContain('Tidy the shed done'));
    expect(await getRecord(t.db, 'task', 'undated')).toMatchObject({ schedule: { type: 'float', every: 6, unit: 'week' }, next_due: null });
  });

  it('counts a float from its last finish, and a rule done today from tomorrow', async () => {
    const t = await renderScreen('oneoffs', {
      seed: async (w) => {
        await seedList(w);
        await w.create('task_completion', { task_id: 'weekly', done_at: '2026-11-02T15:00:00Z', previous_next: '2026-11-02' }, 'fish-done');
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Change repeat for Feed the fish' }));
    let form = screen.getByRole('form', { name: 'Change Feed the fish' });
    await userEvent.selectOptions(within(form).getByLabelText('How often'), 'Daily');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 'weekly'))?.next_due).toBe('2026-11-03'));

    await userEvent.click(screen.getByRole('button', { name: 'Change repeat for Feed the fish' }));
    form = screen.getByRole('form', { name: 'Change Feed the fish' });
    await userEvent.selectOptions(within(form).getByLabelText('Repeats'), 'float');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 'weekly'))?.next_due).toBe('2026-12-14'));
  });
});

describe('Finished tasks', () => {
  async function seedFinished(w: Writer) {
    await w.create('task', { kind: 'one_off', title: 'Feed the fish', schedule: { type: 'recurring', every: 1, unit: 'week', anchor: '2026-01-05' }, next_due: '2026-11-09' }, 'weekly');
    for (let i = 1; i <= 25; i++) {
      const day = new Date(Date.UTC(2026, 9, 31) - i * 7 * 86_400_000).toISOString().slice(0, 10);
      await w.create('task_completion', { task_id: 'weekly', done_at: `${day}T15:00:00Z`, previous_next: day }, `done-${i}`);
    }
    await w.create('task', { kind: 'one_off', title: 'Paint the fence', schedule: { type: 'once' }, done_at: '2026-10-28T15:00:00Z' }, 'fence');
    await w.create('task_completion', { task_id: 'fence', done_at: '2026-10-28T15:00:00Z', previous_next: null }, 'fence-done');
  }
  const finished = () => screen.getByRole('region', { name: 'Finished tasks' });

  it('shows the newest ten in months, more on request, and searches', async () => {
    await renderScreen('oneoffs', { seed: seedFinished });
    const open = await screen.findByRole('button', { name: 'Finished tasks' });
    expect(open).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(open);
    expect(await within(finished()).findByText('26 finished')).toBeVisible();
    await waitFor(() => expect(checkboxes(finished())).toHaveLength(10));
    expect(within(finished()).getAllByRole('heading').map((h) => h.textContent)).toEqual(['October', 'September', 'August']);
    expect(checkboxes(finished())[0]).toBe('Paint the fence done');

    await userEvent.click(within(finished()).getByRole('button', { name: 'Show 16 more, 16 older' }));
    await waitFor(() => expect(checkboxes(finished())).toHaveLength(26));
    expect(within(finished()).queryByRole('button', { name: /more/ })).toBeNull();

    await userEvent.type(within(finished()).getByRole('searchbox', { name: 'Search finished tasks' }), 'fence');
    await waitFor(() => expect(checkboxes(finished())).toEqual(['Paint the fence done']));
    expect(within(finished()).getByText('1 matching')).toBeVisible();
    await userEvent.type(within(finished()).getByRole('searchbox'), 'zzz');
    expect(await within(finished()).findByText('No finished tasks match.')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Finished tasks' }));
    await userEvent.click(screen.getByRole('button', { name: 'Finished tasks' }));
    expect(within(finished()).getByRole('searchbox')).toHaveValue('');
  });

  it('unticking there reopens a one-time task and keeps the row to re-tick', async () => {
    const t = await renderScreen('oneoffs', { seed: seedFinished });
    await userEvent.click(await screen.findByRole('button', { name: 'Finished tasks' }));
    const fence = await within(finished()).findByRole('checkbox', { name: 'Paint the fence done' });
    expect(fence.closest('.maintrow')).toHaveTextContent('Done Oct 28');
    await userEvent.click(fence);
    await waitFor(() => expect(within(finished()).getByRole('checkbox', { name: 'Paint the fence done' })).not.toBeChecked());
    expect(within(finished()).getByRole('checkbox', { name: 'Paint the fence done' }).closest('.maintrow')).toHaveTextContent('Not done');
    await waitFor(() => expect(checkboxes().filter((c) => c === 'Paint the fence done')).toHaveLength(2));
    expect((await getRecord(t.db, 'task', 'fence'))?.done_at).toBeNull();

    await userEvent.click(within(finished()).getByRole('checkbox', { name: 'Paint the fence done' }));
    await waitFor(() => expect(checkboxes().filter((c) => c === 'Paint the fence done')).toHaveLength(1));
    expect(within(finished()).getByRole('checkbox', { name: 'Paint the fence done' })).toBeChecked();
    expect((await getRecord(t.db, 'task', 'fence'))?.done_at).toBe('2026-10-28T15:00:00Z');
  });

  it('unticking the latest finish of a repeating task gives back its date', async () => {
    const t = await renderScreen('oneoffs', { seed: seedFinished });
    await userEvent.click(await screen.findByRole('button', { name: 'Finished tasks' }));
    await waitFor(() => expect(checkboxes(finished())[1]).toBe('Feed the fish done'));
    await userEvent.click(within(finished()).getAllByRole('checkbox', { name: 'Feed the fish done' })[0]!);
    await waitFor(async () => expect((await getRecord(t.db, 'task', 'weekly'))?.next_due).toBe('2026-10-24'));
  });
});

describe('One offs on phone', () => {
  it('adds through a sheet and ticks like the desktop', async () => {
    await renderScreen('oneoffs', { layout: 'phone', seed: seedList });
    expect(await screen.findByText('Not part of a project.')).toBeVisible();
    expect(screen.queryByRole('form', { name: 'Add a one off' })).toBeNull();
    const add = screen.getByRole('button', { name: 'Add one off' });
    await userEvent.click(add);
    const sheet = screen.getByRole('dialog', { name: 'Add a one off' });
    expect(within(sheet).getByLabelText('Title')).toHaveFocus();
    await userEvent.type(within(sheet).getByLabelText('Title'), 'Post the letter');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Add one off' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Post the letter')).toBeVisible();
    expect(lineOf('Post the letter')).toBe('No date, 30m');
    expect(add).toHaveFocus();

    await userEvent.click(box('Post the letter'));
    expect(await screen.findByText('Completed Post the letter.')).toBeVisible();
    await waitFor(() => expect(screen.queryByText('Post the letter')).toBeNull());
    const show = screen.getByRole('button', { name: 'Show 1 completed in One offs' });
    expect(show).toHaveClass('link');
    expect(show).not.toHaveClass('small');
  });
});

describe('the line under One offs on More', () => {
  it('counts what is still to do', async () => {
    const t = await renderScreen('oneoffs', { seed: seedList });
    const clock = fixedClock('2026-11-02T20:00:00Z', 'America/Chicago');
    expect(await moreLine(t.db, clock)).toBe('5 to do');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Return the drill done' }));
    await waitFor(async () => expect(await moreLine(t.db, clock)).toBe('4 to do'));
  });

  it('says nothing when there is nothing', async () => {
    const t = await renderScreen('oneoffs');
    expect(await moreLine(t.db, t.clock)).toBeNull();
  });
});
