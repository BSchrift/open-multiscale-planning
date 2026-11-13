import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRecord } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderScreen } from '../../app/testing';
import type { Harness } from '../../app/testing';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The harness clock is Monday Nov 2, 2026, in Chicago.
async function paint(w: Writer) {
  await w.create('project', { title: 'Paint the fence', state: 'active', start: '2026-10-01', end: '2026-12-15' }, 'p1');
  await w.create('milestone', { project_id: 'p1', title: 'Buy the paint', due: '2026-11-20' }, 'm1');
  // No tasks, so it offers Mark met.
  await w.create('milestone', { project_id: 'p1', title: 'Prime the wood', due: '2026-11-27' }, 'm2');
  await w.create('task', { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Pick a colour', estimate_min: 30 }, 't1');
}

const project = () => renderScreen('goals', { seed: paint, params: { project: 'p1' } });

/** The next save fails, as when the disk is full. */
function failNextSave(t: Harness) {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(t.db, 'transaction').mockRejectedValueOnce(new Error('disk full'));
}

const failed = () => screen.findByText("Couldn't save that. Try again.");

describe('editors after a failed save', () => {
  it('Add milestone keeps what was typed and never says it was added', async () => {
    const t = await project();
    await userEvent.click(await screen.findByRole('button', { name: 'Add milestone' }));
    const editor = screen.getByRole('dialog', { name: 'Add milestone' });
    await userEvent.type(within(editor).getByLabelText('Name'), 'Sand the fence');
    fireEvent.change(within(editor).getByLabelText('Due date'), { target: { value: '2026-11-25' } });
    failNextSave(t);
    await userEvent.click(within(editor).getByRole('button', { name: 'Add' }));
    await failed();
    expect(within(editor).getByLabelText('Name')).toHaveValue('Sand the fence');
    expect(within(editor).getByLabelText('Due date')).toHaveValue('2026-11-25');
    expect(within(editor).getByRole('status')).toBeEmptyDOMElement();
    expect(within(editor).getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  it('Edit milestone stays open when Save fails', async () => {
    const t = await project();
    await userEvent.click(await screen.findByRole('button', { name: /^Edit milestone Buy the paint/ }));
    const editor = screen.getByRole('dialog', { name: 'Edit milestone' });
    await userEvent.clear(within(editor).getByLabelText('Name'));
    await userEvent.type(within(editor).getByLabelText('Name'), 'Buy white paint');
    failNextSave(t);
    await userEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await failed();
    expect(screen.getByRole('dialog', { name: 'Edit milestone' })).toBe(editor);
    expect(within(editor).getByLabelText('Name')).toHaveValue('Buy white paint');
    expect((await getRecord(t.db, 'milestone', 'm1'))?.title).toBe('Buy the paint');
  });

  it('Edit milestone stays open when Mark met fails', async () => {
    const t = await project();
    await userEvent.click(await screen.findByRole('button', { name: /^Edit milestone Prime the wood/ }));
    const editor = screen.getByRole('dialog', { name: 'Edit milestone' });
    failNextSave(t);
    await userEvent.click(within(editor).getByRole('button', { name: 'Mark met' }));
    await failed();
    expect(screen.getByRole('dialog', { name: 'Edit milestone' })).toBe(editor);
    expect((await getRecord(t.db, 'milestone', 'm2'))?.met_at).toBeFalsy();
  });
});

async function stretch(w: Writer) {
  await w.create('objective', { title: 'Run a 10k', state: 'active' }, 'g1');
  await w.create('practice', { title: 'Stretch', target_min: 15, per: 'day', state: 'active', preferred_times: [420] }, 'pr1');
}

const unchanged = { title: 'Stretch', target_min: 15, preferred_times: [420] };

/** Stretch as it was seeded, with no goal. */
async function expectUnchanged(t: Harness) {
  const practice = await getRecord(t.db, 'practice', 'pr1');
  expect(practice).toMatchObject(unchanged);
  expect(practice?.objective_id ?? null).toBeNull();
}
const unsaved = "Your changes aren't saved. Save them, or Cancel to drop them.";

/** Opens Stretch's editor: its sheet on phone, its row on desktop. */
async function openStretch(layout: 'desktop' | 'phone') {
  const t = await renderScreen('goals', { layout, seed: stretch });
  await userEvent.click(await screen.findByRole('button', { name: /Practices with no goal/ }));
  const open = screen.getByRole('button', { name: /^Stretch/ });
  await userEvent.click(open);
  const editor = () => (layout === 'phone' ? screen.getByRole('dialog', { name: 'Edit practice' }) : screen.getByRole('group', { name: 'Edit Stretch' }));
  return { t, open, editor };
}

/** Changes every field, and types a time without adding it. */
async function editStretch(editor: HTMLElement) {
  const name = within(editor).getByLabelText('Name');
  await userEvent.clear(name);
  await userEvent.type(name, 'Stretch daily');
  fireEvent.change(within(editor).getByRole('slider', { name: 'Target' }), { target: { value: '30' } });
  await userEvent.selectOptions(within(editor).getByRole('combobox', { name: 'Goal' }), 'Run a 10k');
  fireEvent.change(within(editor).getByLabelText('New preferred time'), { target: { value: '18:30' } });
  await userEvent.click(within(editor).getByRole('button', { name: 'Add time' }));
  fireEvent.change(within(editor).getByLabelText('New preferred time'), { target: { value: '06:00' } });
}

describe.each(['phone', 'desktop'] as const)('a practice editor on %s', (layout) => {
  it('changes nothing until Save, and Cancel drops every change and gives focus back', async () => {
    const { t, open, editor } = await openStretch(layout);
    await editStretch(editor());
    expect(within(editor()).getByRole('button', { name: 'Remove 6:30pm' })).toBeVisible();
    await expectUnchanged(t);
    await userEvent.click(within(editor()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Edit Stretch' })).toBeNull();
    await waitFor(() => expect(open).toHaveFocus());
    await expectUnchanged(t);

    await userEvent.click(open);
    expect(within(editor()).getByLabelText('Name')).toHaveValue('Stretch');
    expect(within(editor()).queryByRole('button', { name: 'Remove 6:30pm' })).toBeNull();
  });

  it('Save writes every change at once, a time typed but not added included, with Undo', async () => {
    const { t, editor } = await openStretch(layout);
    await editStretch(editor());
    const writes = vi.spyOn(t.db, 'transaction');
    await userEvent.click(within(editor()).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved Stretch daily.')).toBeVisible();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Edit practice' })).toBeNull();
    expect(screen.queryByRole('group', { name: /^Edit Stretch/ })).toBeNull();
    expect(await getRecord(t.db, 'practice', 'pr1')).toMatchObject({ title: 'Stretch daily', target_min: 30, objective_id: 'g1', preferred_times: [360, 420, 1110] });
    // The row moves under its new goal, which opens, and focus follows it there.
    await waitFor(() => expect(screen.getByRole('button', { name: /^Stretch daily/ })).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expectUnchanged(t));
  });

  it('Save with nothing changed closes without writing', async () => {
    const { t, open, editor } = await openStretch(layout);
    const writes = vi.spyOn(t.db, 'transaction');
    await userEvent.click(within(editor()).getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('group', { name: 'Edit Stretch' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(open).toHaveFocus());
    expect(writes).not.toHaveBeenCalled();
  });

  it('a blank name is never saved', async () => {
    const { t, editor } = await openStretch(layout);
    await userEvent.clear(within(editor()).getByLabelText('Name'));
    await userEvent.click(within(editor()).getByRole('button', { name: 'Save' }));
    expect(within(editor()).getByRole('alert')).toHaveTextContent('Give it a name.');
    expect((await getRecord(t.db, 'practice', 'pr1'))?.title).toBe('Stretch');
  });

  it('with changes, Esc keeps it open and says so; without, Esc closes it', async () => {
    const { t, open, editor } = await openStretch(layout);
    await userEvent.type(within(editor()).getByLabelText('Name'), ' daily');
    await userEvent.keyboard('{Escape}');
    expect(within(editor()).getByRole('alert')).toHaveTextContent(unsaved);
    expect(within(editor()).getByRole('button', { name: 'Save' })).toHaveFocus();
    if (layout === 'phone') {
      // The backdrop too.
      await userEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(screen.getByRole('dialog', { name: 'Edit practice' })).toBeVisible();
    } else {
      // And the row's own toggle.
      await userEvent.click(screen.getByRole('button', { name: /^Stretch/, expanded: true }));
      expect(screen.getByRole('group', { name: 'Edit Stretch' })).toBeVisible();
    }
    expect(within(editor()).getByLabelText('Name')).toHaveValue('Stretch daily');
    expect((await getRecord(t.db, 'practice', 'pr1'))?.title).toBe('Stretch');

    await userEvent.click(within(editor()).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(open);
    within(editor()).getByLabelText('Name').focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Edit Stretch' })).toBeNull();
    await waitFor(() => expect(open).toHaveFocus());
  });

  it('Pause acts at once, apart from Save and Cancel', async () => {
    const { t, editor } = await openStretch(layout);
    await userEvent.click(within(editor()).getByRole('button', { name: 'Pause' }));
    await waitFor(async () => expect((await getRecord(t.db, 'practice', 'pr1'))?.state).toBe('paused'));
    expect(within(editor()).getByRole('button', { name: 'Resume' })).toBeVisible();
  });
});

describe.each(['desktop', 'phone'] as const)('Edit milestone on %s', (layout) => {
  const open = async () => {
    const t = await renderScreen('goals', { layout, seed: paint, params: { project: 'p1' } });
    const opener = await screen.findByRole('button', { name: /^Edit milestone Buy the paint/ });
    await userEvent.click(opener);
    return { t, opener, editor: () => screen.getByRole('dialog', { name: 'Edit milestone' }) };
  };

  it('with changes, Esc and a click outside keep it open and say so; Cancel drops them', async () => {
    const { t, opener, editor } = await open();
    await userEvent.type(within(editor()).getByLabelText('Name'), ' and brushes');
    await userEvent.keyboard('{Escape}');
    expect(within(editor()).getByRole('alert')).toHaveTextContent(unsaved);
    expect(within(editor()).getByRole('button', { name: 'Save' })).toHaveFocus();
    if (layout === 'phone') await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    else fireEvent.pointerDown(document.body);
    expect(within(editor()).getByLabelText('Name')).toHaveValue('Buy the paint and brushes');
    await userEvent.click(within(editor()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Edit milestone' })).toBeNull();
    expect((await getRecord(t.db, 'milestone', 'm1'))?.title).toBe('Buy the paint');

    // With nothing changed, Esc closes it, and focus goes back.
    await userEvent.click(opener);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Edit milestone' })).toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('Save says what it saved, with Undo', async () => {
    const { t, editor } = await open();
    await userEvent.type(within(editor()).getByLabelText('Name'), ' and brushes');
    await userEvent.click(within(editor()).getByRole('button', { name: 'Save' }));
    const saved = (await screen.findByText('Saved Buy the paint and brushes.')).closest('.toast') as HTMLElement;
    expect((await getRecord(t.db, 'milestone', 'm1'))?.title).toBe('Buy the paint and brushes');
    await userEvent.click(within(saved).getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'milestone', 'm1'))?.title).toBe('Buy the paint'));
  });
});
