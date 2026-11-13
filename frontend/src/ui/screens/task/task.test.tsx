import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRecord } from '../../../core/records';
import type { Writer } from '../../../core/records';
import type { Layout } from '../../app/registry';
import { renderScreen } from '../../app/testing';
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
      const order = Array.from(popup.querySelectorAll('h2, input[type="range"], select, .notesname, .taskpopbar button')).map((e) =>
        e.matches('input') ? 'Time estimate' : e.matches('select') ? 'Belongs to' : e.textContent,
      );
      expect(order).toEqual(['Draft the summary', 'Time estimate', 'Belongs to', 'Description', 'Delete task', 'Cancel', 'Save']);
      expect(within(popup).getByRole('slider', { name: 'Time estimate' })).toHaveAttribute('aria-valuetext', '2h');
      expect(within(popup).getByLabelText('Belongs to')).toHaveDisplayValue('Report, Drafts');
      expect(within(popup).getByText('Q3 numbers').tagName).toBe('STRONG');
      // Desktop has a close button in its header; phone has a grab handle and closes from the scrim.
      expect(within(popup).queryByRole('button', { name: 'Close' }) === null).toBe(layout === 'phone');
      expect(!!popup.querySelector('.taskpopgrab')).toBe(layout === 'phone');
    });
  }

  it('offers every open milestone of active projects, Done, One offs and Inbox, but not met milestones or finished projects', async () => {
    await open('t1');
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    expect(within(popup).getAllByRole('option').map((o) => o.textContent)).toEqual(['Inbox', 'One offs', 'Report, Drafts', 'Report, Final', 'Report, Done']);
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
    await userEvent.selectOptions(within(popup).getByLabelText('Belongs to'), 'One offs');
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Moved Draft the summary to One offs.')).toBeVisible();
    expect(await record(t, 't1')).toMatchObject({ kind: 'one_off', project_id: null, milestone_id: null, schedule: { type: 'once' }, notes: 'Use the **Q3 numbers** first.' });
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await record(t, 't1')).toMatchObject({ kind: 'project', project_id: 'p1', milestone_id: 'm1', schedule: null }));
  });

  it('gives an Inbox item a home, and a one off a project', async () => {
    const first = await open('i1');
    let popup = await screen.findByRole('dialog', { name: 'Call the bank' });
    await userEvent.selectOptions(within(popup).getByLabelText('Belongs to'), 'Report, Final');
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Moved Call the bank to Report, Final.')).toBeVisible();
    expect(await record(first.t, 'i1')).toMatchObject({ kind: 'project', project_id: 'p1', milestone_id: 'm2' });
    cleanup();

    const second = await open('o1');
    popup = await screen.findByRole('dialog', { name: 'Return the drill' });
    expect(within(popup).getByLabelText('Belongs to')).toHaveDisplayValue('One offs');
    await userEvent.selectOptions(within(popup).getByLabelText('Belongs to'), 'Inbox');
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    await screen.findByText('Moved Return the drill to Inbox.');
    expect(await record(second.t, 'o1')).toMatchObject({ kind: 'inbox', schedule: null, next_due: null });
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

describe('the task popup after a failed save', () => {
  /** The next save fails, as when the disk is full. */
  const failNextSave = (t: Harness) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(t.db, 'transaction').mockRejectedValueOnce(new Error('disk full'));
  };

  it('stays open as it was when Save fails', async () => {
    const { t, close } = await open('t1');
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    await userEvent.selectOptions(within(popup).getByLabelText('Belongs to'), 'Report, Done');
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
