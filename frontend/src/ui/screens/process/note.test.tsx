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

// The harness clock is Monday Nov 2, 2pm in Chicago. No goals, so no Goal backlog: Save as note shows anyway.
async function seed(w: Writer) {
  await w.create('task', { kind: 'inbox', title: 'Paint for the hall: Pale Oat', notes: 'From the tin in the garage.', order: 1 }, 'i1');
  await w.create('attachment', { task_id: 'i1', kind: 'link', name: 'example.com', url: 'https://example.com/oat' }, 'a1');
  await w.create('task', { kind: 'inbox', title: 'Book the boiler service', order: 2 }, 'i2');
}

const open = (layout: 'desktop' | 'phone' = 'desktop') => renderScreen('process', { layout, seed, presentation: 'overlay' });
const card = () => screen.getByRole('dialog', { name: 'Process Inbox' });
const title = () => screen.getByRole('heading', { level: 1 });

describe('Save as note in Process', () => {
  it.each(['desktop', 'phone'] as const)('on %s saves the item as a note in one tap, with its description and link, and Undo brings it back', async (layout) => {
    const t = await open(layout);
    await screen.findByRole('heading', { name: 'Paint for the hall: Pale Oat', level: 1 }, { timeout: 5000 });
    const button = within(card()).getByRole('button', { name: /^Save as note/ });
    // One tap: nothing more to choose, so no dialog of its own.
    expect(button).not.toHaveAttribute('aria-haspopup');
    await userEvent.click(button);
    expect(await screen.findByRole('heading', { name: 'Book the boiler service', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Saved Paint for the hall: Pale Oat in Notes.')).toBeInTheDocument();
    expect(await getRecord(t.db, 'memo', noteId('i1'))).toMatchObject({ title: 'Paint for the hall: Pale Oat', body: 'From the tin in the garage.', deleted_at: null });
    expect((await getRecord(t.db, 'task', 'i1'))?.deleted_at).toBeTruthy();
    expect((await memoAttachments(t.db, noteId('i1'))).map((a) => a.id)).toEqual(['a1']);

    await userEvent.click(within(card()).getByRole('button', { name: /^Undo/ }));
    expect(await screen.findByRole('heading', { name: 'Paint for the hall: Pale Oat', level: 1 })).toBeInTheDocument();
    await waitFor(async () => expect((await getRecord(t.db, 'task', 'i1'))?.deleted_at).toBeNull());
    expect((await getRecord(t.db, 'memo', noteId('i1')))?.deleted_at).toBeTruthy();
    expect((await getRecord(t.db, 'attachment', 'a1'))?.task_id).toBe('i1');
  });

  it('K saves with Option held, and the week toggle is left out and says so', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Paint for the hall: Pale Oat', level: 1 }, { timeout: 5000 });
    await userEvent.click(within(card()).getByRole('switch', { name: 'Add to this week' }));
    fireEvent.keyDown(title(), { key: '˚', code: 'KeyK', altKey: true });
    expect(await screen.findByText("Saved Paint for the hall: Pale Oat in Notes. Notes aren't added to the week.")).toBeInTheDocument();
    expect(await getRecord(t.db, 'week_pick', 'pick:2026-11-02:i1')).toBeUndefined();
    expect(await getRecord(t.db, 'memo', noteId('i1'))).toBeTruthy();
  });
});
