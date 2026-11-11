import { cleanup, fireEvent, screen, within } from '@testing-library/react';
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
