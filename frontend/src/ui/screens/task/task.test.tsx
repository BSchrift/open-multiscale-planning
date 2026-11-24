import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRecord, listRecords } from '../../../core/records';
import type { Writer } from '../../../core/records';
import type { Layout } from '../../app/registry';
import { pickFrom, renderScreen } from '../../app/testing';
import type { Harness } from '../../app/testing';
import { EST_STEPS } from '../../components/EstimateSlider';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function report(w: Writer) {
  await w.create('project', { title: 'Report', state: 'active', start: '2026-10-01', end: '2026-12-15' }, 'p1');
  await w.create('milestone', { project_id: 'p1', title: 'Drafts', due: '2026-11-20' }, 'm1');
  await w.create('milestone', { project_id: 'p1', title: 'Final', due: '2026-12-10' }, 'm2');
  await w.create('milestone', { project_id: 'p1', title: 'Outline', due: '2026-10-20', met_at: '2026-10-19T15:00:00Z' }, 'm0');
  await w.create('project', { title: 'Garden', state: 'finished', start: '2026-01-01', end: '2026-06-01' }, 'p2');
  await w.create(
    'task',
    { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Draft the summary', estimate_min: 120, notes: 'Use the **Q3 numbers** first.' },
    't1',
  );
  await w.create('task', { kind: 'inbox', title: 'Call the bank' }, 'i1');
  await w.create('task', { kind: 'one_off', title: 'Return the drill', schedule: { type: 'once', from: '2026-11-07' }, next_due: '2026-11-07' }, 'o1');
  await w.create('task', { kind: 'one_off', title: 'Water the plants', schedule: { type: 'float', every: 1, unit: 'week' }, next_due: '2026-11-09' }, 'o2');
  await w.create('task', { kind: 'inbox', title: 'Renew the passport', schedule: { type: 'once', from: '2026-11-16', to: '2026-11-20' }, next_due: '2026-11-16' }, 'i2');
}

const open = (task: string, options: { layout?: Layout; note?: string } = {}) => {
  const close = vi.fn();
  return renderScreen('task', {
    layout: options.layout ?? 'desktop',
    seed: report,
    presentation: 'overlay',
    params: { task, ...(options.note ? { note: options.note } : {}) },
    close,
  }).then((t) => ({ t, close }));
};
const record = (t: Harness, id: string) => getRecord(t.db, 'task', id);

describe('the task popup', () => {
  for (const layout of ['desktop', 'phone'] as const) {
    it(`shows the task top to bottom, with focus on its name (${layout})`, async () => {
      await open('t1', { layout });
      const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
      expect(popup).toHaveAttribute('aria-modal', 'true');
      expect(popup).toHaveClass('taskpop');
      // Read as the heading, so the phone's keyboard stays down until a field is tapped.
      await waitFor(() => expect(within(popup).getByRole('heading', { name: 'Draft the summary' })).toHaveFocus());
      const order = Array.from(popup.querySelectorAll('h2, input[type="range"], .ssfield, .notesname, .taskpopbar button')).map((e) =>
        e.matches('.ssfield') ? 'Belongs to' : e.matches('input') ? 'Time estimate' : e.textContent,
      );
      expect(order).toEqual(['Draft the summary', 'Time estimate', 'Belongs to', 'Description', 'Delete task', 'Cancel', 'Save']);
      expect(within(popup).getByRole('slider', { name: 'Time estimate' })).toHaveAttribute('aria-valuetext', '2h');
      // A search on desktop, showing where it is; on phone a button saying so, which opens a sheet of places.
      if (layout === 'desktop') expect(within(popup).getByRole('combobox', { name: 'Belongs to' })).toHaveDisplayValue('Report, Drafts');
      else expect(within(popup).getByLabelText('Belongs to')).toHaveAccessibleName('Belongs to: Report, Drafts');
      expect(within(popup).getByText('Q3 numbers').tagName).toBe('STRONG');
      // Desktop has a close button in its header; phone has a grab handle and closes from the scrim.
      expect(within(popup).queryByRole('button', { name: 'Close' }) === null).toBe(layout === 'phone');
      expect(!!popup.querySelector('.taskpopgrab')).toBe(layout === 'phone');
    });
  }

  it('offers every open milestone of active projects, Done, One offs and Inbox, but not met milestones or finished projects', async () => {
    await open('t1');
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    await userEvent.click(within(popup).getByLabelText('Belongs to'));
    expect(within(popup).getAllByRole('option').map((o) => o.textContent)).toEqual(['Inbox', 'One offs', 'Report, Drafts', 'Report, Final', 'Report, Done']);
  });

  it('on desktop, Belongs to is a search: typing narrows the places to those with the letters, and Enter takes the lit one', async () => {
    const { t, close } = await open('t1');
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    const field = within(popup).getByRole('combobox', { name: 'Belongs to' });
    await userEvent.click(field);
    expect(field).toHaveAttribute('aria-expanded', 'true');
    // It opens on the place the task is in.
    expect(within(popup).getByRole('option', { name: 'Report, Drafts' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('fin');
    expect(within(popup).getAllByRole('option').map((o) => o.textContent)).toEqual(['Report, Final']);
    expect(within(popup).getByRole('option', { name: 'Report, Final' })).toHaveAttribute('aria-selected', 'true');
    expect(within(popup).getByText('Fin').tagName).toBe('B');
    expect(within(popup).getByText('1 match')).toHaveAttribute('aria-live', 'polite');
    // Enter takes the place, rather than saving the popup.
    await userEvent.keyboard('{Enter}');
    expect(field).toHaveDisplayValue('Report, Final');
    expect(field).toHaveAttribute('aria-expanded', 'false');
    expect(close).not.toHaveBeenCalled();
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Moved Draft the summary to Report, Final.')).toBeVisible();
    expect(await record(t, 't1')).toMatchObject({ milestone_id: 'm2' });
  });

  it('on desktop, the arrows move over the places, Esc closes the list and then clears what was typed, and only then closes the popup', async () => {
    const { close } = await open('t1');
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    const field = within(popup).getByRole('combobox', { name: 'Belongs to' });
    field.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(field).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{ArrowDown}');
    expect(field).toHaveAttribute('aria-activedescendant', within(popup).getByRole('option', { name: 'Report, Final' }).id);
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{Enter}');
    expect(field).toHaveDisplayValue('One offs');
    // The place taken stays selected, so typing replaces it.
    await userEvent.keyboard('zz');
    expect(within(popup).getByText('Nothing matches “zz”.')).toBeVisible();
    // None in the list; One offs' Repeats has options of its own below.
    expect(popup.querySelectorAll('[role="listbox"] [role="option"]')).toHaveLength(0);
    await userEvent.keyboard('{Escape}');
    expect(field).toHaveAttribute('aria-expanded', 'false');
    expect(field).toHaveDisplayValue('zz');
    await userEvent.keyboard('{Escape}');
    expect(field).toHaveDisplayValue('One offs');
    expect(close).not.toHaveBeenCalled();
    // The popup now has a change, so its own Esc asks first.
    await userEvent.keyboard('{Escape}');
    expect(within(popup).getByRole('alert')).toHaveTextContent("Your changes aren't saved.");
  });

  it('on phone, Belongs to is a button that opens the places in a sheet, ready to search, and a tap takes one', async () => {
    const { t } = await open('t1', { layout: 'phone' });
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    await userEvent.click(within(popup).getByRole('button', { name: 'Belongs to: Report, Drafts' }));
    const sheet = await screen.findByRole('dialog', { name: 'Belongs to' });
    const search = within(sheet).getByRole('combobox', { name: 'Search places' });
    expect(search).toHaveFocus();
    expect(within(sheet).getAllByRole('option')).toHaveLength(5);
    await userEvent.keyboard('offs');
    expect(within(sheet).getAllByRole('option').map((o) => o.textContent)).toEqual(['One offs']);
    await userEvent.click(within(sheet).getByRole('option', { name: 'One offs' }));
    expect(screen.queryByRole('dialog', { name: 'Belongs to' })).toBeNull();
    expect(within(popup).getByRole('button', { name: 'Belongs to: One offs' })).toBeVisible();
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Moved Draft the summary to One offs.')).toBeVisible();
    expect(await record(t, 't1')).toMatchObject({ kind: 'one_off' });
  });

  it('saves the name, estimate and description together, with Undo', async () => {
    const { t, close } = await open('t1');
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    // The name shows a pencil, as Process's title does, so it reads as editable.
    const rename = within(popup).getByRole('button', { name: 'Rename Draft the summary' });
    expect(rename.querySelector('.pen svg')).not.toBeNull();
    await userEvent.click(rename);
    const name = within(popup).getByRole('textbox', { name: 'Name' });
    expect(name).toHaveFocus();
    await userEvent.clear(name);
    await userEvent.type(name, 'Draft the executive summary');
    fireEvent.change(within(popup).getByRole('slider', { name: 'Time estimate' }), { target: { value: String(EST_STEPS.indexOf(180)) } });
    await userEvent.click(within(popup).getByRole('button', { name: 'Edit description' }));
    await userEvent.type(within(popup).getByRole('textbox', { name: 'Description' }), '\n- Check the totals');
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved Draft the executive summary.')).toBeVisible();
    expect(close).toHaveBeenCalled();
    expect(await record(t, 't1')).toMatchObject({
      title: 'Draft the executive summary',
      estimate_min: 180,
      notes: 'Use the **Q3 numbers** first.\n- Check the totals',
      milestone_id: 'm1',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () =>
      expect(await record(t, 't1')).toMatchObject({ title: 'Draft the summary', estimate_min: 120, notes: 'Use the **Q3 numbers** first.' }),
    );
  });

  it('closes without writing when nothing changed, and on Cancel or Esc', async () => {
    const { t, close } = await open('t1');
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    const before = await t.db.all('SELECT * FROM outbox');
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    expect(close).toHaveBeenCalledTimes(1);
    await userEvent.click(within(popup).getByRole('button', { name: 'Cancel' }));
    expect(close).toHaveBeenCalledTimes(2);
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalledTimes(3);
    await userEvent.click(within(popup).getByRole('button', { name: 'Close' }));
    expect(close).toHaveBeenCalledTimes(4);
    expect(await t.db.all('SELECT * FROM outbox')).toEqual(before);
  });

  for (const layout of ['desktop', 'phone'] as const) {
    it(`with changes, Esc, Close and the backdrop keep it open and say so (${layout})`, async () => {
      const { t, close } = await open('t1', { layout });
      const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
      fireEvent.change(within(popup).getByRole('slider', { name: 'Time estimate' }), { target: { value: String(EST_STEPS.indexOf(180)) } });
      await userEvent.keyboard('{Escape}');
      expect(within(popup).getByRole('alert')).toHaveTextContent("Your changes aren't saved. Save them, or Cancel to drop them.");
      expect(within(popup).getByRole('button', { name: 'Save' })).toHaveFocus();
      // Desktop's close icon, phone's backdrop.
      await userEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(close).not.toHaveBeenCalled();
      expect((await record(t, 't1'))?.estimate_min).toBe(120);
      await userEvent.click(within(popup).getByRole('button', { name: 'Cancel' }));
      expect(close).toHaveBeenCalledTimes(1);
      expect((await record(t, 't1'))?.estimate_min).toBe(120);
    });
  }

  it('wants a name', async () => {
    const { t, close } = await open('t1');
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    await userEvent.click(within(popup).getByRole('button', { name: 'Rename Draft the summary' }));
    await userEvent.clear(within(popup).getByRole('textbox', { name: 'Name' }));
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    expect(within(popup).getByRole('alert')).toHaveTextContent('Give it a title.');
    expect(close).not.toHaveBeenCalled();
    expect((await record(t, 't1'))?.title).toBe('Draft the summary');
  });

  it('moves a task between milestones, projects, One offs and the Inbox, each with Undo', async () => {
    const { t } = await open('t1');
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    await pickFrom(within(popup).getByLabelText('Belongs to'), 'One offs');
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Moved Draft the summary to One offs.')).toBeVisible();
    expect(await record(t, 't1')).toMatchObject({ kind: 'one_off', project_id: null, milestone_id: null, schedule: { type: 'once' }, notes: 'Use the **Q3 numbers** first.' });
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await record(t, 't1')).toMatchObject({ kind: 'project', project_id: 'p1', milestone_id: 'm1', schedule: null }));
  });

  it('gives an Inbox item a home, and a one off a project', async () => {
    const first = await open('i1');
    let popup = await screen.findByRole('dialog', { name: 'Call the bank' });
    await pickFrom(within(popup).getByLabelText('Belongs to'), 'Report, Final');
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Moved Call the bank to Report, Final.')).toBeVisible();
    expect(await record(first.t, 'i1')).toMatchObject({ kind: 'project', project_id: 'p1', milestone_id: 'm2' });
    cleanup();

    const second = await open('o1');
    popup = await screen.findByRole('dialog', { name: 'Return the drill' });
    expect(within(popup).getByLabelText('Belongs to')).toHaveDisplayValue('One offs');
    await pickFrom(within(popup).getByLabelText('Belongs to'), 'Inbox');
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    await screen.findByText('Moved Return the drill to Inbox.');
    expect(await record(second.t, 'o1')).toMatchObject({ kind: 'inbox', schedule: null, next_due: null });
  });

  it('keeps a one off’s date as it moves to a project, but not a repeat, and says so', async () => {
    const dated = await open('o1');
    let popup = await screen.findByRole('dialog', { name: 'Return the drill' });
    await pickFrom(within(popup).getByLabelText('Belongs to'), 'Report, Drafts');
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Moved Return the drill to Report, Drafts.')).toBeVisible();
    expect(await record(dated.t, 'o1')).toMatchObject({ kind: 'project', milestone_id: 'm1', schedule: { type: 'once', from: '2026-11-07', to: null }, next_due: '2026-11-07' });
    cleanup();

    const repeating = await open('o2');
    popup = await screen.findByRole('dialog', { name: 'Water the plants' });
    await pickFrom(within(popup).getByLabelText('Belongs to'), 'Report, Done');
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText("Moved Water the plants to Report, Done. Repeats stay with One offs, so it won't repeat.")).toBeVisible();
    expect(await record(repeating.t, 'o2')).toMatchObject({ kind: 'project', schedule: null, next_due: null });
  });

  it('keeps the date an Inbox item has as it becomes a one off', async () => {
    const { t } = await open('i2');
    const popup = await screen.findByRole('dialog', { name: 'Renew the passport' });
    await pickFrom(within(popup).getByLabelText('Belongs to'), 'One offs');
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    await screen.findByText('Moved Renew the passport to One offs.');
    expect(await record(t, 'i2')).toMatchObject({ kind: 'one_off', schedule: { type: 'once', from: '2026-11-16', to: '2026-11-20' }, next_due: '2026-11-16' });
  });

  it('deletes the task, with Undo taking focus', async () => {
    const { t, close } = await open('t1');
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    await userEvent.click(within(popup).getByRole('button', { name: 'Delete task' }));
    expect(await screen.findByText('Deleted Draft the summary.')).toBeVisible();
    expect(close).toHaveBeenCalled();
    expect((await record(t, 't1'))?.deleted_at).toBeTruthy();
    const undo = screen.getByRole('button', { name: 'Undo' });
    expect(undo).toHaveFocus();
    await userEvent.click(undo);
    await waitFor(async () => expect((await record(t, 't1'))?.deleted_at).toBeNull());
  });

  it('closes when the task is deleted on another device', async () => {
    const { t, close } = await open('t1');
    await screen.findByRole('dialog', { name: 'Draft the summary' });
    await t.write((w) => w.delete('task', 't1'));
    await waitFor(() => expect(close).toHaveBeenCalled());
  });

  it('shows why a task is suggested, when it opened from Pick tasks', async () => {
    await open('t1', { layout: 'phone', note: 'Suggested: milestone overdue' });
    expect(within(await screen.findByRole('dialog', { name: 'Draft the summary' })).getByText('Suggested: milestone overdue')).toBeVisible();
  });
});

/** The popup's sections top to bottom, as its body lays them out. */
function sections(popup: HTMLElement): string[] {
  return [...popup.querySelector('.taskpopbody')!.children].flatMap((el) => {
    if (el.matches('.blocksec')) return ['Time block'];
    if (el.matches('.taskacts')) return ['Actions'];
    if (el.matches('.estslider')) return ['Time estimate'];
    if (el.querySelector('.ssfield')) return ['Belongs to'];
    if (el.matches('.taskpopdates')) return ['Dates'];
    if (el.matches('.notesfield')) return ['Description'];
    if (el.matches('.attachments')) return ['Attachments'];
    return [];
  });
}
const buttonsIn = (section: HTMLElement) => within(section).getAllByRole('button').map((b) => b.textContent);
const FIELDS = ['Time estimate', 'Belongs to', 'Dates', 'Description', 'Attachments'];

describe('the same popup wherever a task opens', () => {
  async function everywhere(w: Writer) {
    await report(w);
    await w.create('week_plan', { week_start: '2026-11-02', finished_at: '2026-11-02T14:00:00Z' }, 'week:2026-11-02');
    // Later today, 4pm to 5pm in Chicago.
    await w.create('time_block', { task_id: 't1', start: '2026-11-02T22:00:00Z', end: '2026-11-02T23:00:00Z', tz: 'America/Chicago' }, 'b1');
  }

  it('has the same sections in the same order from Inbox, One offs, a project and a block on Today; only the actions change', async () => {
    await renderScreen('inbox', { seed: everywhere });
    await userEvent.click(await screen.findByRole('button', { name: 'Call the bank' }));
    let popup = await screen.findByRole('dialog', { name: 'Call the bank' });
    expect(sections(popup)).toEqual(['Actions', ...FIELDS]);
    // An Inbox item gets a time once it has a home, and says how to give it a date.
    expect(buttonsIn(within(popup).getByRole('region', { name: 'Actions' }))).toEqual(['Mark done']);
    expect(within(popup).getByText('Inbox items have no date. To give it one, choose One offs or a project under Belongs to.')).toBeVisible();
    cleanup();

    await renderScreen('oneoffs', { seed: everywhere });
    await userEvent.click(await screen.findByRole('button', { name: 'Return the drill' }));
    popup = await screen.findByRole('dialog', { name: 'Return the drill' });
    expect(sections(popup)).toEqual(['Actions', ...FIELDS]);
    expect(buttonsIn(within(popup).getByRole('region', { name: 'Actions' }))).toEqual(['Start now', 'Mark done', 'Schedule…']);
    expect(within(popup).getByLabelText('Repeats')).toHaveValue('once');
    cleanup();

    await renderScreen('goals', { seed: everywhere, params: { project: 'p1' } });
    await userEvent.click(await screen.findByRole('button', { name: /^Edit task Draft the summary/ }));
    popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    expect(sections(popup)).toEqual(['Actions', ...FIELDS]);
    expect(buttonsIn(within(popup).getByRole('region', { name: 'Actions' }))).toEqual(['Start now', 'Mark done', 'Schedule…']);
    // A project's task can have a date, but never repeats.
    expect(within(popup).queryByLabelText('Repeats')).toBeNull();
    expect(within(popup).getByLabelText('Date (optional)')).toHaveValue('');
    cleanup();

    await renderScreen('today', { seed: everywhere });
    await userEvent.click(await screen.findByRole('button', { name: /^Draft the summary, 4pm to 5pm/ }));
    popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    // The block's own section takes the actions' place, with the block's Start now, Mark done and Move….
    expect(sections(popup)).toEqual(['Time block', ...FIELDS]);
    expect(buttonsIn(within(popup).getByRole('region', { name: 'Time block' }))).toEqual(['Start now', 'Mark done', 'Move…', 'Remove from calendar']);
  });
});

describe("the popup's actions", () => {
  const actions = async (title: string) => within(await screen.findByRole('dialog', { name: title })).getByRole('region', { name: 'Actions' });

  it('Mark done finishes the task and takes its actions away, with Undo', async () => {
    const { t, close } = await open('t1');
    await userEvent.click(within(await actions('Draft the summary')).getByRole('button', { name: 'Mark done' }));
    expect(await screen.findByText('Draft the summary done')).toBeVisible();
    await waitFor(async () => expect((await record(t, 't1'))?.done_at).toBeTruthy());
    // It saves at once and stays open, as a block's Mark done does, with focus back on its name.
    const popup = screen.getByRole('dialog', { name: 'Draft the summary' });
    await waitFor(() => expect(within(popup).queryByRole('region', { name: 'Actions' })).toBeNull());
    await waitFor(() => expect(within(popup).getByRole('heading', { name: 'Draft the summary' })).toHaveFocus());
    expect(close).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await record(t, 't1'))?.done_at).toBeNull());
    expect(await within(popup).findByRole('region', { name: 'Actions' })).toBeVisible();
  });

  it('Mark done on a repeating one off marks only this time done', async () => {
    const { t } = await open('o2');
    await userEvent.click(within(await actions('Water the plants')).getByRole('button', { name: 'Mark done' }));
    expect(await screen.findByText('Water the plants done')).toBeVisible();
    await waitFor(async () => expect(await listRecords(t.db, 'task_completion')).toHaveLength(1));
    // Still open, it moves on a week from today and can be done again.
    expect(await record(t, 'o2')).toMatchObject({ next_due: '2026-11-09' });
    expect((await record(t, 'o2'))?.done_at).toBeFalsy();
    expect(within(await actions('Water the plants')).getByRole('button', { name: 'Mark done' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await listRecords(t.db, 'task_completion')).filter((c) => !c.deleted_at)).toHaveLength(0));
  });

  it('Start now puts it on the clock from now, with Undo', async () => {
    const { t } = await open('t1');
    await userEvent.click(within(await actions('Draft the summary')).getByRole('button', { name: 'Start now' }));
    expect(await screen.findByText('Started Draft the summary.')).toBeVisible();
    const started = async () => (await listRecords(t.db, 'time_block')).filter((b) => b.task_id === 't1' && !b.deleted_at);
    // Its 2h estimate, from 2pm.
    await waitFor(async () => expect(await started()).toMatchObject([{ start: '2026-11-02T20:00:00Z', end: '2026-11-02T22:00:00Z', started_at: '2026-11-02T20:00:00Z' }]));
    // Counting, it needs no other start.
    await waitFor(async () => expect(within(await actions('Draft the summary')).queryByRole('button', { name: 'Start now' })).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await started()).toEqual([]));
    expect(await within(await actions('Draft the summary')).findByRole('button', { name: 'Start now' })).toBeVisible();
  });

  it("Schedule… offers To schedule's times for it this week, placing one with Undo, and Choose a time… opens Week to place it", async () => {
    const { t, close } = await open('t1');
    await userEvent.click(within(await actions('Draft the summary')).getByRole('button', { name: 'Schedule…' }));
    const menu = await screen.findByRole('menu', { name: 'Schedule' });
    const items = within(menu).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items.at(-1)).toBe('Choose a time…');
    expect(items.length).toBeGreaterThan(1);
    // Said as Move… says a time: Today or Tomorrow by name, another day by its date.
    expect(items[0]).toMatch(/^(Today|Tomorrow|(Mon|Tue|Wed|Thu|Fri|Sat|Sun) Nov \d+), \d+(:\d\d)?[ap]m$/);
    await userEvent.click(within(menu).getAllByRole('menuitem')[0]!);
    expect(await screen.findByText(/^Placed Draft the summary, /)).toBeVisible();
    const placed = async () => (await listRecords(t.db, 'time_block')).filter((b) => b.task_id === 't1' && !b.deleted_at);
    await waitFor(async () => expect(await placed()).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await placed()).toEqual([]));

    await userEvent.click(within(await actions('Draft the summary')).getByRole('button', { name: 'Schedule…' }));
    await userEvent.click(within(await screen.findByRole('menu', { name: 'Schedule' })).getByRole('menuitem', { name: 'Choose a time…' }));
    expect(close).toHaveBeenCalled();
    expect(t.nav().route).toMatchObject({ area: 'week', params: { place: 't1' } });
  });
  it('Schedule… suggests no time before its date', async () => {
    await renderScreen('task', {
      seed: (w) => w.create('task', { kind: 'one_off', title: 'Return the drill', estimate_min: 30, schedule: { type: 'once', from: '2026-11-10' }, next_due: '2026-11-10' }, 'later'),
      presentation: 'overlay',
      params: { task: 'later' },
      close: vi.fn(),
    });
    await userEvent.click(within(await actions('Return the drill')).getByRole('button', { name: 'Schedule…' }));
    // Dated next week, it has no time this week, only Week's Choose a time.
    const menu = await screen.findByRole('menu', { name: 'Schedule' });
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Choose a time…']);
  });
});

describe("the popup's dates", () => {
  it("sets a one off's date range, with the rules One offs uses, saved with Undo", async () => {
    const { t } = await open('o1');
    const popup = await screen.findByRole('dialog', { name: 'Return the drill' });
    fireEvent.change(within(popup).getByLabelText('Date (optional)'), { target: { value: '2026-11-10' } });
    await userEvent.click(within(popup).getByRole('button', { name: '+ End date' }));
    fireEvent.change(within(popup).getByLabelText('End date'), { target: { value: '2026-11-08' } });
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    // An end before the start is refused, as on One offs, and nothing is saved.
    expect(within(popup).getByRole('alert')).toHaveTextContent(/./);
    expect((await record(t, 'o1'))?.schedule).toEqual({ type: 'once', from: '2026-11-07' });
    fireEvent.change(within(popup).getByLabelText('End date'), { target: { value: '2026-11-12' } });
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved Return the drill.')).toBeVisible();
    expect(await record(t, 'o1')).toMatchObject({ schedule: { type: 'once', from: '2026-11-10', to: '2026-11-12' }, next_due: '2026-11-10' });
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await record(t, 'o1')).toMatchObject({ schedule: { type: 'once', from: '2026-11-07' }, next_due: '2026-11-07' }));
  });

  it('makes a one off repeat, counting from today, and opens on the rule it has, with a weekly one’s days', async () => {
    const { t } = await open('o1');
    const popup = await screen.findByRole('dialog', { name: 'Return the drill' });
    await userEvent.selectOptions(within(popup).getByLabelText('Repeats'), 'recurring');
    await userEvent.click(within(within(popup).getByRole('group', { name: 'On' })).getByRole('checkbox', { name: 'Thursday' }));
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Return the drill.');
    expect(await record(t, 'o1')).toMatchObject({ schedule: { type: 'recurring', every: 1, unit: 'week', anchor: '2026-11-02', days: [0, 3] }, next_due: '2026-11-02' });
    cleanup();

    const close = vi.fn();
    await renderScreen('task', {
      seed: async (w) => {
        await w.create('task', { kind: 'one_off', title: 'Put the bins out', schedule: { type: 'recurring', every: 1, unit: 'week', anchor: '2026-10-05', days: [3, 0] }, next_due: '2026-11-05' }, 'bins');
      },
      presentation: 'overlay',
      params: { task: 'bins' },
      close,
    });
    const bins = await screen.findByRole('dialog', { name: 'Put the bins out' });
    expect(within(bins).getByLabelText('Repeats')).toHaveValue('recurring');
    expect(within(bins).getByLabelText('How often')).toHaveValue('week');
    const on = within(bins).getByRole('group', { name: 'On' });
    expect(within(on).getAllByRole('checkbox', { checked: true }).map((c) => c.getAttribute('aria-label'))).toEqual(['Monday', 'Thursday']);
    // Saved unchanged, nothing is written and its next date stays.
    await userEvent.click(within(bins).getByRole('button', { name: 'Save' }));
    expect(close).toHaveBeenCalled();
  });

  it('leaves a repeat the form can’t show, such as every 2 weeks, alone when something else is saved', async () => {
    const fortnightly = { type: 'recurring', every: 2, unit: 'week', anchor: '2026-10-05' } as const;
    const t = await renderScreen('task', {
      seed: (w) => w.create('task', { kind: 'one_off', title: 'Clean the gutters', schedule: fortnightly, next_due: '2026-11-02' }, 'g'),
      presentation: 'overlay',
      params: { task: 'g' },
      close: vi.fn(),
    });
    const popup = await screen.findByRole('dialog', { name: 'Clean the gutters' });
    await userEvent.click(within(popup).getByRole('button', { name: 'Rename Clean the gutters' }));
    await userEvent.type(within(popup).getByRole('textbox', { name: 'Name' }), ' and drains');
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved Clean the gutters and drains.');
    expect(await record(t, 'g')).toMatchObject({ schedule: fortnightly, next_due: '2026-11-02' });
  });

  it("gives a project's task a date, saved with the rest", async () => {
    const { t } = await open('t1');
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    fireEvent.change(within(popup).getByLabelText('Date (optional)'), { target: { value: '2026-11-18' } });
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved Draft the summary.')).toBeVisible();
    expect(await record(t, 't1')).toMatchObject({ schedule: { type: 'once', from: '2026-11-18', to: null }, next_due: '2026-11-18', milestone_id: 'm1' });
  });

  it('shows an Inbox item its dates once Belongs to gives it a home', async () => {
    const { t } = await open('i1');
    const popup = await screen.findByRole('dialog', { name: 'Call the bank' });
    expect(within(popup).queryByLabelText('Date (optional)')).toBeNull();
    await pickFrom(within(popup).getByLabelText('Belongs to'), 'One offs');
    fireEvent.change(within(popup).getByLabelText('Date (optional)'), { target: { value: '2026-11-05' } });
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    await screen.findByText('Moved Call the bank to One offs.');
    expect(await record(t, 'i1')).toMatchObject({ kind: 'one_off', schedule: { type: 'once', from: '2026-11-05', to: null }, next_due: '2026-11-05' });
  });
});

describe('the task popup after a failed save', () => {
  /** The next save fails, as when the disk is full. */
  const failNextSave = (t: Harness) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(t.db, 'transaction').mockRejectedValueOnce(new Error('disk full'));
  };

  it('stays open as it was when Save fails', async () => {
    const { t, close } = await open('t1');
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    await pickFrom(within(popup).getByLabelText('Belongs to'), 'Report, Done');
    failNextSave(t);
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText("Couldn't save that. Try again.")).toBeVisible();
    expect(close).not.toHaveBeenCalled();
    expect(within(popup).getByLabelText('Belongs to')).toHaveDisplayValue('Report, Done');
    expect((await record(t, 't1'))?.milestone_id).toBe('m1');
  });

  it('stays open when Delete fails, with no Undo offered', async () => {
    const { t, close } = await open('t1');
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    failNextSave(t);
    await userEvent.click(within(popup).getByRole('button', { name: 'Delete task' }));
    expect(await screen.findByText("Couldn't save that. Try again.")).toBeVisible();
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect((await record(t, 't1'))?.deleted_at).toBeFalsy();
  });

  it('links an Inbox item Process made a goal to it, closing to show it', async () => {
    const close = vi.fn();
    const t = await renderScreen('task', {
      presentation: 'overlay',
      params: { task: 'i1' },
      close,
      seed: async (w) => {
        await w.create('objective', { title: 'Make pottery', state: 'active' }, 'g1');
        await w.create('task', { kind: 'inbox', title: 'Look into pottery classes', done_at: '2026-11-01T15:00:00Z', became: { type: 'objective', id: 'g1' } }, 'i1');
      },
    });
    const popup = await screen.findByRole('dialog', { name: 'Look into pottery classes' });
    await userEvent.click(within(popup).getByRole('button', { name: 'Became the goal Make pottery' }));
    expect(close).toHaveBeenCalled();
    expect(t.nav().route).toMatchObject({ area: 'goals', params: { show: 'g1' } });
  });

  it("says nothing of what an open item became: unticked, it's back in the Inbox", async () => {
    await renderScreen('task', {
      presentation: 'overlay',
      params: { task: 'i1' },
      seed: async (w) => {
        await w.create('objective', { title: 'Make pottery', state: 'active' }, 'g1');
        await w.create('task', { kind: 'inbox', title: 'Look into pottery classes', done_at: null, became: { type: 'objective', id: 'g1' } }, 'i1');
      },
    });
    const popup = await screen.findByRole('dialog', { name: 'Look into pottery classes' });
    expect(within(popup).queryByRole('button', { name: /^Became/ })).toBeNull();
  });
});
