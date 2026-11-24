import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { noteId } from '../../../core/memos';
import { memoAttachments } from '../../../core/queries';
import { getRecord } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderScreen } from '../../app/testing';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// The harness clock is Monday Nov 2, 2pm in Chicago.
async function seed(w: Writer) {
  await w.create('objective', { title: 'Home', state: 'active', order: 1 }, 'g1');
  await w.create('project', { objective_id: 'g1', title: 'Kitchen redo', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p1');
  await w.create('practice', { title: 'Morning run', target_min: 30, per: 'day', state: 'active' }, 'pr1');
  await w.create('task', { kind: 'inbox', title: 'Paint for the hall: Pale Oat', notes: 'From the tin in the garage.', order: 1 }, 'i1');
  await w.create('attachment', { task_id: 'i1', kind: 'link', name: 'example.com', url: 'https://example.com/oat' }, 'a1');
  await w.create('task', { kind: 'inbox', title: 'Book the boiler service', order: 2 }, 'i2');
}

const open = (layout: 'desktop' | 'phone' = 'desktop') => renderScreen('process', { layout, seed, presentation: 'overlay' });
const card = () => screen.getByRole('dialog', { name: 'Process Inbox' });
const title = () => screen.getByRole('heading', { level: 1 });
const attach = (layout: 'desktop' | 'phone') => (layout === 'phone' ? screen.getByRole('dialog', { name: 'Attach note to' }) : within(card()).getByRole('group', { name: 'Attach note to' }));

describe('Save as note in Process', () => {
  it.each(['desktop', 'phone'] as const)('on %s asks where the note lives, On its own first, and saves it with its description and link, with Undo', async (layout) => {
    const t = await open(layout);
    await screen.findByRole('heading', { name: 'Paint for the hall: Pale Oat', level: 1 }, { timeout: 5000 });
    const button = within(card()).getByRole('button', { name: /Save as note$/ });
    if (layout === 'phone') expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    await userEvent.click(button);
    const panel = attach(layout);
    const search = within(panel).getByRole('combobox', { name: 'Attach note to' });
    await waitFor(() => expect(search).toHaveFocus());
    const options = within(panel).getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-label'))).toEqual(['On its own, In Notes, no home', 'Home, Goal', 'Kitchen redo, Project · Home', 'Morning run, Practice']);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(options[0]!);
    expect(await screen.findByRole('heading', { name: 'Book the boiler service', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Saved Paint for the hall: Pale Oat in Notes.')).toBeInTheDocument();
    expect(await getRecord(t.db, 'memo', noteId('i1'))).toMatchObject({ title: 'Paint for the hall: Pale Oat', body: 'From the tin in the garage.', home: null, deleted_at: null });
    expect((await getRecord(t.db, 'task', 'i1'))?.deleted_at).toBeTruthy();
    expect((await memoAttachments(t.db, noteId('i1'))).map((a) => a.id)).toEqual(['a1']);

    // One Undo puts the item back, with nothing left to undo.
    await userEvent.click(within(card()).getByRole('button', { name: /^Undo/ }));
    expect(await screen.findByRole('heading', { name: 'Paint for the hall: Pale Oat', level: 1 })).toBeInTheDocument();
    await waitFor(async () => expect((await getRecord(t.db, 'task', 'i1'))?.deleted_at).toBeNull());
    expect((await getRecord(t.db, 'memo', noteId('i1')))?.deleted_at).toBeTruthy();
    expect((await getRecord(t.db, 'attachment', 'a1'))?.task_id).toBe('i1');
    expect(within(card()).getByRole('button', { name: /^Undo/ })).toBeDisabled();
  });

  it('finds a home by name or by type, and Enter saves the note there', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Paint for the hall: Pale Oat', level: 1 }, { timeout: 5000 });
    fireEvent.keyDown(title(), { key: '˚', code: 'KeyK', altKey: true });
    const search = within(attach('desktop')).getByRole('combobox', { name: 'Attach note to' });
    await userEvent.type(search, 'practice');
    // On its own stays first, and the best match is lit.
    expect(within(attach('desktop')).getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['On its own, In Notes, no home', 'Morning run, Practice']);
    expect(within(attach('desktop')).getByRole('option', { name: 'Morning run, Practice' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.clear(search);
    await userEvent.type(search, 'home');
    // The goal, and the project under it, each saying which it is.
    expect(within(attach('desktop')).getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['On its own, In Notes, no home', 'Home, Goal', 'Kitchen redo, Project · Home']);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(await screen.findByText('Saved Paint for the hall: Pale Oat as a note on Kitchen redo.')).toBeInTheDocument();
    expect((await getRecord(t.db, 'memo', noteId('i1')))?.home).toEqual({ type: 'project', id: 'p1' });
  });

  it('Esc goes back to the card with focus on Save as note, and the week toggle is left out and says so', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Paint for the hall: Pale Oat', level: 1 }, { timeout: 5000 });
    await userEvent.click(within(card()).getByRole('switch', { name: 'Add to this week' }));
    await userEvent.click(within(card()).getByRole('button', { name: /Save as note$/ }));
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Process Inbox' })).toBeInTheDocument();
    await waitFor(() => expect(within(card()).getByRole('button', { name: /Save as note$/ })).toHaveFocus());
    await userEvent.click(within(card()).getByRole('button', { name: /Save as note$/ }));
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText("Saved Paint for the hall: Pale Oat in Notes. Notes aren't added to the week.")).toBeInTheDocument();
    expect(await getRecord(t.db, 'week_pick', 'pick:2026-11-02:i1')).toBeUndefined();
  });
});
