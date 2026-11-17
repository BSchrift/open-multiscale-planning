import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../../core/clock';
import { deleteNote, noteId, saveAsNote } from '../../../core/memos';
import { inboxTasks, memoAttachments, taskAttachments } from '../../../core/queries';
import { getRecord } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderApp, renderScreen } from '../../app/testing';

afterEach(cleanup);

// The harness clock is Monday Nov 2, 2pm in Chicago. Notes come only through Process, so the seed saves Inbox items.
async function note(w: Writer, id: string, title: string, body?: string, on = '2026-11-02T20:00:00Z') {
  await w.create('task', { kind: 'inbox', title, ...(body ? { notes: body } : {}) }, id);
  await saveAsNote(w, id, fixedClock(on, 'America/Chicago'));
}

async function seed(w: Writer) {
  await note(w, 'paint', 'Paint for the hall: Pale Oat, eggshell', 'From the tin in the garage.\nTwo coats.', '2026-11-02T20:00:00Z');
  await w.create('attachment', { memo_id: noteId('paint'), kind: 'photo', name: 'Tin.jpg' }, 'photo');
  await note(w, 'cafe', 'Émile’s café opens at 8', undefined, '2026-10-20T15:00:00Z');
  await note(w, 'tyres', 'Bike tyres', '700x28c, 85 psi', '2025-12-01T15:00:00Z');
}

const open = (layout: 'desktop' | 'phone' = 'desktop') => renderScreen('notes', { layout, seed });
const row = (title: RegExp) => screen.getByRole('button', { name: title });
const popup = () => screen.getByRole('dialog', { name: /^Note: / });

describe('Notes', () => {
  it('sits after One offs on the desktop sidebar and under More on phone, never with a count', async () => {
    await renderApp({ seed });
    const nav = within(await screen.findByRole('navigation', { name: 'Main' }));
    const names = nav.getAllByRole('button').map((b) => b.textContent);
    expect(names.indexOf('Notes')).toBe(names.indexOf('One offs') + 1);
    cleanup();
    await renderApp({ seed, layout: 'phone' });
    await userEvent.click(within(await screen.findByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'More' }));
    const rows = screen.getAllByRole('button').filter((b) => b.classList.contains('morerow')).map((b) => b.textContent);
    expect(rows.indexOf('Notes')).toBe(rows.indexOf('One offs') + 1);
  });

  it('leads with search, then lists every note by month, newest first, each read as its title with its first line and saved day', async () => {
    await open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Notes' })).toBeInTheDocument();
    const search = screen.getByRole('searchbox', { name: 'Search notes' });
    expect(screen.getByText('Things to look up or remember. Nothing here is due or ticked.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 3, name: 'November' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['November', 'October', 'December 2025']);
    // The search comes before every list.
    expect(search.compareDocumentPosition(screen.getByRole('heading', { level: 2, name: 'All notes' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const paint = row(/^Paint for the hall/);
    expect(paint).toHaveAccessibleDescription('From the tin in the garage. Saved Nov 2 · 1 photo');
    expect(row(/^Bike tyres/)).toHaveAccessibleDescription('700x28c, 85 psi Saved Dec 1');
    // No checkbox and no count: nothing here is ticked or due.
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('finds words in titles and descriptions ignoring case and accents, underlines them, says how many, and Escape shows all again', async () => {
    await open();
    const search = await screen.findByRole('searchbox', { name: 'Search notes' });
    await screen.findByRole('heading', { level: 3, name: 'November' });
    await userEvent.type(search, 'EMILE');
    expect(screen.getAllByRole('button').filter((b) => b.classList.contains('nrow')).map((b) => b.querySelector('.ntitle')?.textContent)).toEqual(['Émile’s café opens at 8']);
    expect(within(row(/^Émile/)).getByText('Émile', { selector: 'mark' })).toBeInTheDocument();
    // One live region, outside the list.
    const live = screen.getAllByRole('status').find((el) => el.classList.contains('sr'))!;
    await waitFor(() => expect(live).toHaveTextContent('1 note matches “EMILE”'));
    await userEvent.clear(search);
    await userEvent.type(search, 'psi');
    expect(row(/^Bike tyres/)).toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, 'gate code');
    expect(screen.getAllByText('No notes match “gate code”.').length).toBeGreaterThan(0);
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(live).toHaveTextContent('Showing all notes');
    expect(row(/^Paint for the hall/)).toBeInTheDocument();
  });

  it('shows 100 notes, then 100 more on request, with focus on the first new one', async () => {
    await renderScreen('notes', {
      seed: async (w) => {
        for (let i = 0; i < 130; i++) await note(w, `n${String(i).padStart(3, '0')}`, `Fact ${i}`);
      },
    });
    await screen.findByRole('heading', { level: 3, name: 'November' });
    expect(screen.getAllByRole('button', { name: /^Fact / })).toHaveLength(100);
    await userEvent.click(screen.getByRole('button', { name: 'Show 30 more' }));
    expect(screen.getAllByRole('button', { name: /^Fact / })).toHaveLength(130);
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole('button', { name: /^Fact / })[100]));
  });

  it('keeps a deleted note in Recently deleted, closed, until Restore brings it back with its photo', async () => {
    const t = await open();
    await t.write((w) => deleteNote(w, noteId('paint'), t.clock));
    const bin = await screen.findByRole('button', { name: /^Recently deleted/ });
    expect(bin).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(bin);
    expect(screen.getByText('Deleted Nov 2 · gone after Dec 2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restore Paint for the hall: Pale Oat, eggshell' }));
    expect(await screen.findByText('Restored Paint for the hall: Pale Oat, eggshell.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Paint for the hall/ })).toBeInTheDocument();
    expect(await memoAttachments(t.db, noteId('paint'))).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Recently deleted/ })).toBeNull();
  });

  it('tells telemetry only that Notes is open, never what was searched or opened', async () => {
    await renderApp({ seed, initial: { area: 'notes', params: {} } });
    const search = await screen.findByRole('searchbox', { name: 'Search notes' });
    await waitFor(() => expect(document.documentElement.dataset.screen).toBe('notes'));
    await userEvent.type(search, 'hall');
    await userEvent.click(await screen.findByRole('button', { name: /^Paint for the hall/ }));
    await screen.findByRole('dialog', { name: /^Note: / });
    expect(document.documentElement.dataset.screen).toBe('notes');
    expect(JSON.stringify(document.documentElement.dataset)).not.toMatch(/hall/i);
  });
});

describe('a note open', () => {
  it.each(['desktop', 'phone'] as const)('on %s is laid out as a task: its name, Belongs to, Description, Attachments, a word on where notes are kept, then Delete note, Cancel and Save', async (layout) => {
    await open(layout);
    await userEvent.click(await screen.findByRole('button', { name: /^Paint for the hall/ }));
    const dialog = within(popup());
    expect(popup()).toHaveAccessibleName('Note: Paint for the hall: Pale Oat, eggshell');
    await waitFor(() => expect(dialog.getByRole('heading', { level: 2 })).toHaveFocus());
    expect(dialog.getByRole('button', { name: 'Rename Paint for the hall: Pale Oat, eggshell' })).toBeInTheDocument();
    expect(dialog.getByText('Note · saved Nov 2')).toBeInTheDocument();
    expect(dialog.getByRole('combobox', { name: 'Belongs to' })).toHaveValue('notes');
    expect(dialog.getByRole('region', { name: 'Attachments' })).toBeInTheDocument();
    expect(dialog.getByText(/Use a password manager for passwords and codes\./)).toBeInTheDocument();
    expect(dialog.getAllByRole('button').map((b) => b.textContent).slice(-3)).toEqual(['Delete note', 'Cancel', 'Save']);
    // No pin, no tick, no time.
    expect(dialog.queryByRole('checkbox')).toBeNull();
    expect(dialog.queryByRole('slider')).toBeNull();
  });

  it('saves a new name and description on Save, with Undo, and Cancel drops edits and returns to the row', async () => {
    const t = await open();
    await userEvent.click(await screen.findByRole('button', { name: /^Bike tyres/ }));
    await userEvent.click(within(popup()).getByRole('button', { name: 'Rename Bike tyres' }));
    await userEvent.clear(within(popup()).getByRole('textbox', { name: 'Name' }));
    await userEvent.type(within(popup()).getByRole('textbox', { name: 'Name' }), 'Road bike tyres');
    await userEvent.click(within(popup()).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved Road bike tyres.')).toBeInTheDocument();
    expect((await getRecord(t.db, 'memo', noteId('tyres')))?.title).toBe('Road bike tyres');
    await waitFor(() => expect(screen.getByRole('button', { name: /^Road bike tyres/ })).toHaveFocus());

    await userEvent.click(screen.getByRole('button', { name: /^Road bike tyres/ }));
    await userEvent.click(within(popup()).getByRole('button', { name: 'Rename Road bike tyres' }));
    await userEvent.type(within(popup()).getByRole('textbox', { name: 'Name' }), ' and tubes');
    await userEvent.click(within(popup()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: /^Note: / })).toBeNull();
    expect((await getRecord(t.db, 'memo', noteId('tyres')))?.title).toBe('Road bike tyres');
    await waitFor(() => expect(screen.getByRole('button', { name: /^Road bike tyres/ })).toHaveFocus());
  });

  it('becomes an Inbox item with what was edited and its photo when Belongs to is Inbox, on Save, with one Undo', async () => {
    const t = await open();
    await userEvent.click(await screen.findByRole('button', { name: /^Paint for the hall/ }));
    await userEvent.selectOptions(within(popup()).getByRole('combobox', { name: 'Belongs to' }), 'inbox');
    await userEvent.click(within(popup()).getByRole('button', { name: 'Save' }));
    const undo = await screen.findByRole('button', { name: /^Undo/ });
    expect(screen.getByText('Moved Paint for the hall: Pale Oat, eggshell to your Inbox.')).toBeInTheDocument();
    await waitFor(() => expect(undo).toHaveFocus());
    const inbox = await inboxTasks(t.db);
    const made = inbox.find((i) => i.title === 'Paint for the hall: Pale Oat, eggshell')!;
    expect((await taskAttachments(t.db, made.id)).map((a) => a.id)).toEqual(['photo']);
    expect((await getRecord(t.db, 'memo', noteId('paint')))?.deleted_at).toBeTruthy();
    await userEvent.click(undo);
    await waitFor(async () => expect((await getRecord(t.db, 'memo', noteId('paint')))?.deleted_at).toBeNull());
    expect(await screen.findByRole('button', { name: /^Paint for the hall/ })).toBeInTheDocument();
  });

  it('Delete note acts at once, with focus on the toast’s Undo', async () => {
    const t = await open();
    await userEvent.click(await screen.findByRole('button', { name: /^Bike tyres/ }));
    await userEvent.click(within(popup()).getByRole('button', { name: 'Delete note' }));
    const undo = await screen.findByRole('button', { name: /^Undo/ });
    expect(screen.getByText('Deleted Bike tyres.')).toBeInTheDocument();
    await waitFor(() => expect(undo).toHaveFocus());
    expect((await getRecord(t.db, 'memo', noteId('tyres')))?.deleted_at).toBeTruthy();
    await act(async () => void (await userEvent.click(undo)));
    await waitFor(async () => expect((await getRecord(t.db, 'memo', noteId('tyres')))?.deleted_at).toBeNull());
  });
});
