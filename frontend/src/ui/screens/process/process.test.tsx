import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatClock } from '../../../core/clock';
import { applyRemote, getRecord, listRecords, weekPickId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderScreen } from '../../app/testing';
import type { HarnessOptions } from '../../app/testing';
import { EST_STEPS } from '../../components/EstimateSlider';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// The harness clock is Monday Nov 2, 2pm in Chicago.
const running = { state: 'active' as const, start: '2026-10-01', end: '2027-01-31' };

async function seed(w: Writer) {
  await w.create('objective', { title: 'Keep the house', state: 'active' }, 'g1');
  await w.create('project', { title: 'Paint the fence', objective_id: 'g1', ...running }, 'p1');
  await w.create('project', { title: 'Learn to bake bread', ...running }, 'p2');
  await w.create('project', { title: 'Write the report', ...running, state: 'paused' }, 'p3');
  await w.create('project', { title: 'Plant the garden', objective_id: 'g1', ...running, start: '2026-12-01' }, 'p4');
  await w.create('milestone', { project_id: 'p1', title: 'First coat', due: '2026-11-20' }, 'm1');
  await w.create('task', { kind: 'inbox', title: 'Call the bank' }, 'i1');
  await w.create('task', { kind: 'inbox', title: 'Fix the gate', estimate_min: 120 }, 'i2');
  await w.create('task', { kind: 'inbox', title: 'Read the article' }, 'i3');
  await w.create('task', { kind: 'inbox', title: 'Buy stamps' }, 'i4');
  await w.create('task', { kind: 'inbox', title: 'Return the books' }, 'i5');
}

const open = (options: HarnessOptions & { params?: Record<string, string>; close?(): void } = {}) =>
  renderScreen('process', { seed, presentation: 'overlay', ...options });

const title = () => screen.getByRole('heading', { level: 1 });
const card = () => screen.getByRole('dialog', { name: 'Process Inbox' });
const btn = (name: string | RegExp) => within(card()).getByRole('button', { name });
const task = (db: Parameters<typeof getRecord>[0], id: string) => getRecord(db, 'task', id);
const slide = (minutes: number) => fireEvent.change(screen.getByRole('slider', { name: 'Time' }), { target: { value: String(EST_STEPS.indexOf(minutes)) } });
const key = (k: string, target: Element = title()) => fireEvent.keyDown(target, { key: k });
/** Option or Alt with a key, which types another character on a Mac. */
const altKey = (code: string, target: Element = title()) => fireEvent.keyDown(target, { key: '∂', code, altKey: true });
/** Single-key shortcuts, the device setting. */
const keysOn = () => localStorage.setItem('multiscale.processKeys', 'true');
const form = () => within(card()).getByRole('form');
/** Where the item goes: one searchable field. */
const picker = () => screen.getByRole('combobox', { name: 'Add to a project or One offs' });
const list = () => screen.getByRole('listbox', { name: 'Projects and One offs' });
const options = () => within(list()).getAllByRole('option').map((o) => o.getAttribute('aria-label'));
const lit = () => within(list()).getByRole('option', { selected: true });
/** The app's toast, apart from the card. */
const toast = () => document.querySelector<HTMLElement>('.toast');
const toastUndo = () => within(toast()!).getByRole('button', { name: 'Undo' });
/** Picks a place from the list by typing its name, then Enter. */
const addTo = async (name: string) => {
  await userEvent.clear(picker());
  await userEvent.type(picker(), `${name}{Enter}`);
};

describe('Process on desktop', () => {
  it('shows one item at a time, with focus in Add to, which starts empty, and a group to make a home', async () => {
    await open();
    // The first render in a run also loads the modules, so it gets longer.
    expect(await screen.findByRole('heading', { name: 'Call the bank', level: 1 }, { timeout: 5000 })).toBeInTheDocument();
    await waitFor(() => expect(picker()).toHaveFocus());
    expect(picker()).toHaveValue('');
    expect(picker()).toHaveAttribute('placeholder', 'Add to a project or One offs');
    expect(picker()).toHaveAttribute('aria-expanded', 'false');
    expect(within(card()).getByText('1 of 5')).toBeInTheDocument();
    // The bar fills as far as the count says: the first of five is a fifth.
    expect(card().querySelector<HTMLElement>('.pxbar > span')!.style.width).toBe('20%');
    // No numbered destinations: the picker replaces them, and New project lives in it.
    expect(card().querySelector('.pxdest, .pxkey')).toBeNull();
    expect(within(card()).queryByRole('button', { name: /^Add to (?!this week)/ })).toBeNull();
    const group = within(card()).getByRole('group', { name: 'No home yet? Make one' });
    expect(within(group).getAllByRole('button').map((b) => [b.getAttribute('aria-label'), b.textContent])).toEqual([
      ['New practice from this item', 'Alt PNew practice'],
      ['New goal from this item', 'Alt GNew goal'],
    ]);
    for (const [name, k] of [['‹ Undo and go back', 'Z'], ['Skip', 'S'], ['Delete/done', 'D'], ['Add to this week', 'W']]) expect(btn(name!).querySelector('kbd')).toHaveTextContent(k!);
    expect(btn('‹ Undo and go back')).toBeDisabled();
    // The card no longer reports what happened: the toast does.
    expect(within(card()).queryByRole('status')).toBeNull();
  });

  it('opens a list with New project first, then One offs, then every active or paused project under its goal', async () => {
    await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    await waitFor(() => expect(picker()).toHaveFocus());
    await userEvent.keyboard('{ArrowDown}');
    expect(picker()).toHaveAttribute('aria-expanded', 'true');
    expect(options()).toEqual(['+ New project', 'One offs', 'Paint the fence, Keep the house', 'Plant the garden, Keep the house', 'Learn to bake bread', 'Write the report']);
    expect(within(screen.getByRole('group', { name: 'Keep the house' })).getAllByRole('option')).toHaveLength(2);
    expect(within(screen.getByRole('group', { name: 'No goal' })).getAllByRole('option')).toHaveLength(2);
    // With nothing typed and nothing used yet, One offs is lit, and the field says so.
    expect(lit()).toHaveAccessibleName('One offs');
    expect(picker()).toHaveAttribute('aria-activedescendant', lit().id);
    await userEvent.keyboard('{ArrowDown}');
    expect(lit()).toHaveAccessibleName('Paint the fence, Keep the house');
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
    expect(lit()).toHaveAccessibleName('+ New project');
  });

  it('adds to One offs from the list, moves on, says so in a toast with Undo, and Undo puts it back', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    await userEvent.click(picker());
    await userEvent.click(screen.getByRole('option', { name: 'One offs' }));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(await task(t.db, 'i1')).toMatchObject({ kind: 'one_off', schedule: { type: 'once' } });
    expect(within(card()).getByText('2 of 5')).toBeInTheDocument();
    expect(toast()).toHaveTextContent('Added Call the bank to One offs.');
    expect(card().contains(toast())).toBe(false);
    // Focus is in Add to on the next item, ready to type.
    expect(picker()).toHaveFocus();

    await userEvent.click(toastUndo());
    await screen.findByRole('heading', { name: 'Call the bank' });
    expect((await task(t.db, 'i1'))?.kind).toBe('inbox');
    expect(btn('‹ Undo and go back')).toBeDisabled();
    await waitFor(() => expect(picker()).toHaveFocus());
  });

  it("reaches the toast's Undo with Tab from the card's last control, and goes back with Tab again", async () => {
    await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    await addTo('Learn to bake bread');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    btn('Delete/done').focus();
    await userEvent.tab();
    expect(toastUndo()).toHaveFocus();
    await userEvent.tab();
    expect(btn('Delete/done')).toHaveFocus();
  });

  it('narrows by name or goal as you type, lights the best match, says how many match, and adds it with Enter', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    await userEvent.type(picker(), 'house');
    expect(options()).toEqual(['+ New project “house”', 'Paint the fence, Keep the house', 'Plant the garden, Keep the house']);
    expect(lit()).toHaveAccessibleName('Paint the fence, Keep the house');
    expect(within(card()).getByText('2 matches')).toHaveClass('sr');
    // Typing only narrows: nothing is added until Enter.
    expect((await task(t.db, 'i1'))?.kind).toBe('inbox');
    await userEvent.keyboard('{ArrowDown}');
    expect(lit()).toHaveAccessibleName('Plant the garden, Keep the house');
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(await task(t.db, 'i1')).toMatchObject({ kind: 'project', project_id: 'p4', milestone_id: null });
    expect(toast()).toHaveTextContent('Added Call the bank to Plant the garden.');

    await userEvent.type(picker(), 'one');
    expect(options()).toEqual(['+ New project “one”', 'One offs']);
    expect(within(card()).getByText('1 match')).toBeInTheDocument();
    await userEvent.clear(picker());
    await userEvent.type(picker(), 'zzz');
    expect(options()).toEqual(['+ New project “zzz”']);
    expect(within(list()).getByText('No project matches “zzz”.')).toBeInTheDocument();
    expect(within(card()).getByText('No matches')).toBeInTheDocument();
  });

  it('starts on the last place used, remembered on this device: Enter adds there, and typing replaces it to search', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    await addTo('Write the report');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(picker()).toHaveValue('Write the report');
    expect(picker()).toHaveFocus();
    // Selected, so typing replaces it.
    const field = picker() as HTMLInputElement;
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'Write the report'.length]);
    expect(btn('Add to Write the report')).toHaveTextContent('↩');
    expect(localStorage.getItem('multiscale.processLast')).toBe('"p3"');
    slide(90);
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('heading', { name: 'Read the article' });
    expect(await task(t.db, 'i2')).toMatchObject({ kind: 'project', project_id: 'p3', estimate_min: 90 });
    await userEvent.click(btn('Add to Write the report'));
    await screen.findByRole('heading', { name: 'Buy stamps' });
    expect((await task(t.db, 'i3'))?.project_id).toBe('p3');

    // Another time on this device, it starts there too.
    cleanup();
    await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    await waitFor(() => expect(picker()).toHaveValue('Write the report'));
    await userEvent.keyboard('One');
    expect(picker()).toHaveValue('One');
    expect(lit()).toHaveAccessibleName('One offs');
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(picker()).toHaveValue('One offs');
    expect(localStorage.getItem('multiscale.processLast')).toBe('"one_offs"');
  });

  it('starts empty when the place last used has gone', async () => {
    localStorage.setItem('multiscale.processLast', '"gone"');
    await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    expect(picker()).toHaveValue('');
    expect(within(card()).queryByRole('button', { name: /^Add to (?!this week)/ })).toBeNull();
  });

  it('closes the list on Esc, then clears what was typed, then leaves the field, and only then Process', async () => {
    const close = vi.fn();
    await open({ close });
    await screen.findByRole('heading', { name: 'Call the bank' });
    await userEvent.type(picker(), 'pai');
    await userEvent.keyboard('{Escape}');
    expect(picker()).toHaveAttribute('aria-expanded', 'false');
    expect(picker()).toHaveValue('pai');
    await userEvent.keyboard('{Escape}');
    expect(picker()).toHaveValue('');
    await userEvent.keyboard('{Escape}');
    expect(within(title()).getByRole('button')).toHaveFocus();
    expect(close).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalled();
  });

  it('keeps focus where Esc put it while an add is still saving, so the next Esc closes Process', async () => {
    const close = vi.fn();
    const t = await open({ close });
    await screen.findByRole('heading', { name: 'Call the bank' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const transaction = t.db.transaction.bind(t.db);
    vi.spyOn(t.db, 'transaction').mockImplementationOnce(async (fn) => {
      await held;
      return transaction(fn);
    });
    await userEvent.type(picker(), 'One offs{Enter}');
    await userEvent.keyboard('{Escape}');
    expect(within(title()).getByRole('button')).toHaveFocus();
    release();
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(within(title()).getByRole('button')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(close).toHaveBeenCalled();
  });

  it('clears what the other kind of task had, so two devices sorting one item merge into one kind', async () => {
    const t = await open();
    // Another device sent each item the other way first; its writes reach this one after this one's.
    const earlier = (id: string, fields: Record<string, unknown>) =>
      applyRemote(t.db, [{ type: 'task', id, fields: Object.fromEntries(Object.entries(fields).map(([f, v]) => [f, { v, c: formatClock({ wall: 1, counter: 0, device: 'other' }) }])) }]);
    await screen.findByRole('heading', { name: 'Call the bank' });
    await addTo('One offs');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    await earlier('i1', { kind: 'project', project_id: 'p1', milestone_id: 'm1' });
    expect(await task(t.db, 'i1')).toMatchObject({ kind: 'one_off', project_id: null, milestone_id: null });

    await addTo('Paint the fence');
    await screen.findByRole('heading', { name: 'Read the article' });
    await earlier('i2', { kind: 'one_off', schedule: { type: 'float', every: 2, unit: 'week' }, next_due: '2026-11-16' });
    expect(await task(t.db, 'i2')).toMatchObject({ kind: 'project', project_id: 'p1', schedule: null, next_due: null });
  });

  it('lets the item just added to a project pick a milestone, and one just added to One offs a date', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    await addTo('Paint the fence');
    const milestone = await within(card()).findByRole('combobox', { name: 'Milestone for Call the bank' });
    // A project's tasks with no milestone sit under its Done.
    expect(within(milestone).getAllByRole('option').map((o) => o.textContent)).toEqual(['Done', 'First coat']);
    await userEvent.selectOptions(milestone, 'First coat');
    await waitFor(async () => expect((await task(t.db, 'i1'))?.milestone_id).toBe('m1'));

    await addTo('One offs');
    await userEvent.click(await within(card()).findByRole('button', { name: 'Add date for Fix the gate' }));
    fireEvent.change(within(card()).getByLabelText('Date'), { target: { value: '2026-11-12' } });
    await userEvent.click(btn('Set date'));
    await waitFor(async () => expect((await task(t.db, 'i2'))?.schedule).toMatchObject({ type: 'once', from: '2026-11-12' }));
    expect(title()).toHaveTextContent('Read the article');
  });

  it('adds to this week as a pick, not on the calendar, says so on the lit row and in the toast, then resets the toggle', async () => {
    const t = await open();
    const toggle = await screen.findByRole('button', { name: 'Add to this week' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggle);
    expect(btn('Adding to this week')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(picker());
    expect(lit()).toHaveTextContent('+ this week');
    expect(lit()).toHaveAccessibleName('One offs, and to this week');
    expect(within(list()).getAllByText('+ this week')).toHaveLength(1);
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(toast()).toHaveTextContent('Added Call the bank to One offs and to this week.');
    expect(await getRecord(t.db, 'week_pick', weekPickId('2026-11-02', 'i1'))).toMatchObject({ minutes: 30, deleted_at: null });
    expect(await listRecords(t.db, 'time_block')).toHaveLength(0);
    expect(btn('Add to this week')).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(btn('‹ Undo and go back'));
    await screen.findByRole('heading', { name: 'Call the bank' });
    expect((await getRecord(t.db, 'week_pick', weekPickId('2026-11-02', 'i1')))?.deleted_at).toBeTruthy();
  });

  it('adds to the plan being made, as a pick rather than a block', async () => {
    const t = await open({ params: { planning: '2026-11-09' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Add to the plan for Nov 9 to 15' }));
    await addTo('Learn to bake bread');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(toast()).toHaveTextContent('Added Call the bank to Learn to bake bread and to the plan.');
    expect(await getRecord(t.db, 'week_pick', weekPickId('2026-11-09', 'i1'))).toMatchObject({ minutes: 60, deleted_at: null });
    expect(await listRecords(t.db, 'time_block')).toHaveLength(0);
  });

  it('opens on the item it was given', async () => {
    await open({ params: { item: 'i3' } });
    expect(await screen.findByRole('heading', { name: 'Read the article', level: 1 })).toBeInTheDocument();
    expect(within(card()).getByText('1 of 5')).toBeInTheDocument();
  });

  it('skips and deletes with a toast for each, asks before deleting, and sums up on the done card', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    await addTo('One offs');
    await addTo('Paint the fence');
    await addTo('Learn to bake bread');
    await screen.findByRole('heading', { name: 'Buy stamps' });
    await userEvent.click(btn('Skip'));
    await screen.findByRole('heading', { name: 'Return the books' });
    expect(toast()).toHaveTextContent('Skipped Buy stamps. It stays in your Inbox.');
    expect(toastUndo()).toBeInTheDocument();

    await userEvent.click(btn('Delete/done'));
    expect(within(card()).getByRole('alert')).toHaveTextContent('Delete this item?');
    await userEvent.click(btn('Cancel'));
    expect(title()).toHaveTextContent('Return the books');
    await userEvent.click(btn('Delete/done'));
    await userEvent.click(btn('Yes, delete'));
    expect(await screen.findByRole('heading', { name: "That's everything for now" })).toBeInTheDocument();
    expect(toast()).toHaveTextContent('Deleted Return the books.');
    expect(within(card()).getByText('3 sorted, 1 deleted, 1 skipped, still in your Inbox.')).toBeInTheDocument();
    expect((await task(t.db, 'i5'))?.deleted_at).toBeTruthy();
    expect((await task(t.db, 'i4'))?.kind).toBe('inbox');

    // The toast's Undo is the step back, here as anywhere.
    await userEvent.click(toastUndo());
    await screen.findByRole('heading', { name: 'Return the books' });
    expect((await task(t.db, 'i5'))?.deleted_at).toBeNull();
  });

  it('says Inbox clear when nothing is left, and Done closes', async () => {
    const close = vi.fn();
    await renderScreen('process', { presentation: 'overlay', close, seed: (w) => w.create('task', { kind: 'inbox', title: 'Call the bank' }, 'i1') });
    await screen.findByRole('heading', { name: 'Call the bank' });
    await addTo('One offs');
    expect(await screen.findByRole('heading', { name: 'Inbox clear' })).toBeInTheDocument();
    expect(within(card()).getByText('1 sorted.')).toBeInTheDocument();
    await userEvent.click(btn('Done'));
    expect(close).toHaveBeenCalled();
  });

  it('works from the keyboard, with Option or Alt keys in Add to too, and letters there only searching', async () => {
    keysOn();
    const close = vi.fn();
    const t = await open({ close });
    await screen.findByRole('heading', { name: 'Call the bank' });
    await addTo('One offs');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    // In the field, a letter searches, even with single keys on.
    key('s', picker());
    expect(title()).toHaveTextContent('Fix the gate');
    altKey('KeyS', picker());
    await screen.findByRole('heading', { name: 'Read the article' });
    altKey('KeyZ', picker());
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect((await task(t.db, 'i2'))?.kind).toBe('inbox');
    // Away from a field, single keys work with the setting on.
    key('s');
    await screen.findByRole('heading', { name: 'Read the article' });
    key('z');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    altKey('KeyW', picker());
    expect(btn('Adding to this week')).toBeInTheDocument();
    key('w');
    expect(btn('Add to this week')).toBeInTheDocument();
    altKey('KeyD', picker());
    expect(within(card()).getByRole('alert')).toHaveTextContent('Delete this item?');
    key('Escape', within(card()).getByRole('alert'));
    expect(within(card()).queryByRole('alert')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    key('d');
    key('d');
    await screen.findByRole('heading', { name: 'Read the article' });
    expect((await task(t.db, 'i2'))?.deleted_at).toBeTruthy();
    altKey('KeyP', picker());
    expect(form()).toHaveAccessibleName('New practice');
  });

  it('has no keys for destinations or New project any more', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    for (const code of ['Digit1', 'Digit9', 'KeyO', 'Slash', 'KeyN']) {
      altKey(code);
      altKey(code, picker());
    }
    expect(title()).toHaveTextContent('Call the bank');
    expect(within(card()).queryByRole('form')).toBeNull();
    expect((await task(t.db, 'i1'))?.kind).toBe('inbox');
  });

  it('takes single keys only with the setting on: off, as by default, a key needs Option or Alt held', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    // Speech input can type letters, and they mustn't skip or delete items.
    for (const k of ['s', 'w', 'd', 'p']) key(k);
    expect(title()).toHaveTextContent('Call the bank');
    expect(within(card()).queryByRole('form')).toBeNull();
    expect(within(card()).queryByRole('alert')).toBeNull();
    expect(within(card()).getByText('Keys work with Option or Alt held. Settings can make them work alone.')).toBeInTheDocument();

    altKey('KeyD');
    expect(within(card()).getByRole('alert')).toHaveTextContent('Delete this item?');
    // The question's own D needs Option or Alt too; Enter needs nothing.
    key('d');
    expect(title()).toHaveTextContent('Call the bank');
    key('Enter', within(card()).getByRole('alert'));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect((await task(t.db, 'i1'))?.deleted_at).toBeTruthy();
  });

  it('undoes with Cmd or Ctrl and Z, whatever the setting, and from Add to while nothing is typed there', async () => {
    await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    await addTo('One offs');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Time' }), { key: 'z', metaKey: true });
    await screen.findByRole('heading', { name: 'Call the bank' });
    await addTo('One offs');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    fireEvent.keyDown(picker(), { key: 'z', ctrlKey: true });
    await screen.findByRole('heading', { name: 'Call the bank' });
    // With letters typed, it's the field's own undo.
    await userEvent.type(picker(), 'pai');
    fireEvent.keyDown(picker(), { key: 'z', metaKey: true });
    expect(btn('‹ Undo and go back')).toBeDisabled();
  });

  it("shows Option on each key's cap while single keys are off, and the key alone once they're on", async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    const caps = () => [...card().querySelectorAll('.keycap')].map((k) => k.textContent).filter((c) => c !== '↩');
    await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    expect(caps().sort()).toEqual(['⌥D', '⌥E', '⌥G', '⌥P', '⌥S', '⌥W', '⌥Z']);
    cleanup();
    keysOn();
    await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    expect(caps().sort()).toEqual(['D', 'E', 'G', 'P', 'S', 'W', 'Z']);
  });

  it('labels the held key Alt away from a Mac', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    for (const k of card().querySelectorAll('.keycap')) expect(k.textContent).toMatch(/^Alt .$/);
  });

  it('swipes a copy of the card away after a choice, out of reach of keys and screen readers, then removes it', async () => {
    const animated: { el: Element; keyframes: Keyframe[] }[] = [];
    let land!: () => void;
    const landed = new Promise<void>((resolve) => (land = resolve));
    const animate = vi.fn(function (this: Element, keyframes: Keyframe[]) {
      animated.push({ el: this, keyframes });
      return { finished: landed } as unknown as Animation;
    });
    Object.assign(HTMLElement.prototype, { animate });
    try {
      await open();
      await screen.findByRole('heading', { name: 'Call the bank' });
      await addTo('One offs');
      await screen.findByRole('heading', { name: 'Fix the gate' });
      const copy = document.querySelector('.pxghost')!;
      expect(copy).toHaveTextContent('Call the bank');
      expect(copy).toHaveAttribute('aria-hidden', 'true');
      expect((copy as HTMLElement).inert).toBe(true);
      expect(copy.querySelector('[id]')).toBeNull();
      expect(animated.map((a) => a.el)).toEqual([copy, card()]);
      expect(animated[0]!.keyframes.at(-1)).toMatchObject({ transform: 'translateX(70%) rotate(7deg)', opacity: 0 });
      land();
      await waitFor(() => expect(document.querySelector('.pxghost')).toBeNull());
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    }
  });

  it("doesn't swipe for someone who asks for less motion", async () => {
    const animate = vi.fn();
    Object.assign(HTMLElement.prototype, { animate });
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} }));
    try {
      await open();
      await screen.findByRole('heading', { name: 'Call the bank' });
      await addTo('One offs');
      await screen.findByRole('heading', { name: 'Fix the gate' });
      expect(animate).not.toHaveBeenCalled();
      expect(document.querySelector('.pxghost')).toBeNull();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'animate');
      vi.unstubAllGlobals();
    }
  });
});

describe('Adding a project from the picker', () => {
  it('lights New project named as typed when nothing matches, and Enter opens the form with that name and a milestone', async () => {
    await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    await userEvent.type(picker(), 'Fix up the shed');
    expect(lit()).toHaveAccessibleName('+ New project “Fix up the shed”');
    await userEvent.keyboard('{Enter}');
    expect(form()).toHaveAccessibleName('New project');
    const name = within(form()).getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
    expect(name).toHaveValue('Fix up the shed');
    expect(name).toHaveFocus();
    // The caret at the end of what was typed.
    expect([name.selectionStart, name.selectionEnd]).toEqual([15, 15]);
    expect(within(form()).getByRole('textbox', { name: 'Milestone to put it under, if any' })).toHaveValue('');
    expect(within(form()).getByText('With none, it goes under the project’s Done, as now.')).toBeInTheDocument();
    expect(within(form()).getByRole('button', { name: 'Add project' })).toHaveTextContent('↩');
    expect(within(form()).getByRole('button', { name: 'Cancel' })).toHaveTextContent('esc');
    // The picker is replaced by the form, with the rest of the card's choices.
    expect(screen.queryByRole('combobox', { name: 'Add to a project or One offs' })).toBeNull();
    expect(within(card()).queryByRole('group', { name: 'No home yet? Make one' })).toBeNull();

    // The milestone is only for the item as the project's first task.
    await userEvent.click(within(form()).getByRole('checkbox', { name: 'Keep "Call the bank" as its first task' }));
    expect(within(form()).queryByRole('textbox', { name: /Milestone/ })).toBeNull();

    // Esc steps back to the picker.
    await userEvent.keyboard('{Escape}');
    expect(within(card()).queryByRole('form')).toBeNull();
    await waitFor(() => expect(picker()).toHaveFocus());
  });

  it('starts the form blank from an empty field', async () => {
    await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    await userEvent.click(picker());
    await userEvent.click(screen.getByRole('option', { name: '+ New project' }));
    expect(within(form()).getByRole('textbox', { name: 'Name' })).toHaveValue('');
  });

  it('makes the project and milestone and stops; the picker holds it, and a second Enter adds the item, with one Undo for all', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    await userEvent.type(picker(), 'Fix up the shed{Enter}');
    await userEvent.selectOptions(within(form()).getByRole('combobox', { name: 'Goal' }), 'Keep the house');
    await userEvent.type(within(form()).getByRole('textbox', { name: /Milestone/ }), 'Roof watertight');
    const transactions = vi.spyOn(t.db, 'transaction');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(toast()).toHaveTextContent('Created Fix up the shed, under Keep the house, with the milestone Roof watertight.'));
    expect(transactions).toHaveBeenCalledTimes(1);
    // Nothing else yet: the item waits on the card, with focus on adding it there.
    expect(title()).toHaveTextContent('Call the bank');
    expect(within(card()).getByText('1 of 5')).toBeInTheDocument();
    expect((await task(t.db, 'i1'))?.kind).toBe('inbox');
    const [shed] = await t.db.all<{ id: string }>("SELECT id FROM project WHERE title = 'Fix up the shed'");
    const [roof] = await t.db.all<{ id: string }>("SELECT id FROM milestone WHERE title = 'Roof watertight'");
    expect(await getRecord(t.db, 'milestone', roof!.id)).toMatchObject({ project_id: shed!.id, due: '2026-12-31' });
    expect(picker()).toHaveValue('Fix up the shed');
    await waitFor(() => expect(btn('Add to Fix up the shed')).toHaveFocus());

    await userEvent.keyboard('{Enter}');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(await task(t.db, 'i1')).toMatchObject({ kind: 'project', project_id: shed!.id, milestone_id: roof!.id });
    expect(toast()).toHaveTextContent('Added Call the bank to Fix up the shed, under Roof watertight.');

    // One step back takes the add, the milestone and the project together.
    await userEvent.click(toastUndo());
    await screen.findByRole('heading', { name: 'Call the bank' });
    await waitFor(() => expect(toast()).toHaveTextContent('Undone: Fix up the shed removed. Call the bank is back.'));
    expect((await task(t.db, 'i1'))?.kind).toBe('inbox');
    expect((await getRecord(t.db, 'project', shed!.id))?.deleted_at).toBeTruthy();
    expect((await getRecord(t.db, 'milestone', roof!.id))?.deleted_at).toBeTruthy();
    expect(btn('‹ Undo and go back')).toBeDisabled();
    expect(picker()).toHaveFocus();
  });

  it('keeps the project on Esc from Add to, so the item can go anywhere, and Undo before adding takes back only the project', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    await userEvent.type(picker(), 'Japan trip{Enter}');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(btn('Add to Japan trip')).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    expect(picker()).toHaveFocus();
    expect(picker()).toHaveValue('Japan trip');
    await userEvent.keyboard('One offs{Enter}');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect((await task(t.db, 'i1'))?.kind).toBe('one_off');
    const [trip] = await t.db.all<{ id: string; deleted_at: string | null }>("SELECT id, deleted_at FROM project WHERE title = 'Japan trip'");
    expect(trip!.deleted_at).toBeNull();

    await userEvent.click(btn('‹ Undo and go back'));
    await screen.findByRole('heading', { name: 'Call the bank' });
    expect((await task(t.db, 'i1'))?.kind).toBe('inbox');
    expect((await getRecord(t.db, 'project', trip!.id))?.deleted_at).toBeFalsy();
    await userEvent.click(btn('‹ Undo and go back'));
    await waitFor(() => expect(toast()).toHaveTextContent('Undone: Japan trip removed.'));
    expect((await getRecord(t.db, 'project', trip!.id))?.deleted_at).toBeTruthy();
    expect(title()).toHaveTextContent('Call the bank');
  });

  it('makes a project under a new goal, and Undo after adding takes back the goal too', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    await userEvent.type(picker(), 'Sort out the bank{Enter}');
    const goal = within(form()).getByRole('combobox', { name: 'Goal' });
    // New goal is a button after the select, not one of its options.
    expect(within(goal).getAllByRole('option').map((o) => o.textContent)).toEqual(['No goal', 'Keep the house']);
    await userEvent.click(within(form()).getByRole('button', { name: '+ New goal' }));
    const goalName = within(form()).getByRole('textbox', { name: 'New goal name' });
    expect(goalName).toHaveFocus();
    // Esc in it steps back to the select, leaving the form open.
    fireEvent.keyDown(goalName, { key: 'Escape' });
    expect(within(form()).getByRole('combobox', { name: 'Goal' })).toBeInTheDocument();
    await userEvent.click(within(form()).getByRole('button', { name: '+ New goal' }));
    await userEvent.type(within(form()).getByRole('textbox', { name: 'New goal name' }), 'Money in order');
    await userEvent.click(within(form()).getByRole('button', { name: 'Change dates' }));
    fireEvent.change(within(form()).getByLabelText('Ends'), { target: { value: '2026-11-30' } });
    await userEvent.click(within(form()).getByRole('button', { name: 'Add project' }));
    await waitFor(() => expect(toast()).toHaveTextContent('Created Sort out the bank, under Money in order.'));
    const [project] = await t.db.all<{ id: string; objective_id: string }>("SELECT id, objective_id FROM project WHERE title = 'Sort out the bank'");
    expect(await getRecord(t.db, 'project', project!.id)).toMatchObject({ start: '2026-11-02', end: '2026-11-30', state: 'active' });
    expect((await getRecord(t.db, 'objective', project!.objective_id))?.title).toBe('Money in order');
    await userEvent.click(btn('Add to Sort out the bank'));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(await task(t.db, 'i1')).toMatchObject({ kind: 'project', project_id: project!.id, milestone_id: null });
    expect(toast()).toHaveTextContent('Added Call the bank to Sort out the bank.');

    await userEvent.click(btn('‹ Undo and go back'));
    await screen.findByRole('heading', { name: 'Call the bank' });
    await waitFor(() => expect(toast()).toHaveTextContent('Undone: Money in order and Sort out the bank removed. Call the bank is back.'));
    expect((await getRecord(t.db, 'project', project!.id))?.deleted_at).toBeTruthy();
    expect((await getRecord(t.db, 'objective', project!.objective_id))?.deleted_at).toBeTruthy();
  });

  it('keeps a project another device has put tasks in since, and Undo gives back only the item', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    await userEvent.type(picker(), 'Japan trip{Enter}');
    await userEvent.keyboard('{Enter}');
    await userEvent.click(await within(card()).findByRole('button', { name: 'Add to Japan trip' }));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    const [project] = await t.db.all<{ id: string }>("SELECT id FROM project WHERE title = 'Japan trip'");
    await applyRemote(t.db, [
      {
        type: 'task',
        id: 'remote',
        fields: Object.fromEntries(
          Object.entries({ kind: 'project', project_id: project!.id, title: 'Renew the passport' }).map(([f, v]) => [f, { v, c: formatClock({ wall: Date.now(), counter: 0, device: 'other' }) }]),
        ),
      },
    ]);
    await userEvent.click(btn('‹ Undo and go back'));
    await screen.findByRole('heading', { name: 'Call the bank' });
    await waitFor(() => expect(toast()).toHaveTextContent('Kept Japan trip, it has other tasks now. Call the bank is back.'));
    expect((await getRecord(t.db, 'project', project!.id))?.deleted_at).toBeFalsy();
    expect((await task(t.db, 'i1'))?.kind).toBe('inbox');
  });

  it('ends a new project with the stretch being planned', async () => {
    const t = await open({ params: { stretchStart: '2027-01-01', stretchEnd: '2027-03-31' } });
    await screen.findByRole('heading', { name: 'Call the bank' });
    await userEvent.type(picker(), 'Bank stuff{Enter}');
    expect(within(form()).getByText('Today to Mar 31')).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(toast()).toHaveTextContent('Created Bank stuff.'));
    const [made] = await t.db.all<{ end: string }>("SELECT end FROM project WHERE title = 'Bank stuff'");
    expect(made?.end).toBe('2027-03-31');
  });
});

describe('Making a home from the card', () => {
  it.each([
    ['p', 'New practice'],
    ['g', 'New goal'],
  ])('%s opens the form in place of the picker, its name the item, selected; Esc returns to the button', async (k, name) => {
    keysOn();
    await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    key(k);
    expect(form()).toHaveAccessibleName(name);
    const field = within(form()).getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
    expect(field).toHaveFocus();
    expect(field).toHaveValue('Call the bank');
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'Call the bank'.length]);
    expect(screen.queryByRole('combobox', { name: 'Add to a project or One offs' })).toBeNull();
    expect(within(card()).queryByRole('group', { name: 'No home yet? Make one' })).toBeNull();

    // Keys belong to the form now: S types, and files nothing.
    key('s', field);
    key('s', form());
    expect(title()).toHaveTextContent('Call the bank');

    await userEvent.click(within(form()).getByRole('button', { name: 'Clear name' }));
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(within(form()).getByRole('alert')).toHaveTextContent('Give it a name.');

    await userEvent.keyboard('{Escape}');
    expect(within(card()).queryByRole('form')).toBeNull();
    expect(btn(`${name} from this item`)).toHaveFocus();
  });

  it('switches between the three kinds in one form, keeping the name', async () => {
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'New goal from this item' }));
    // The name is selected, so typing replaces it.
    await userEvent.keyboard('Money in order');
    const kinds = within(form()).getByRole('group', { name: 'Make it a' });
    expect(within(kinds).getByRole('button', { name: 'Goal' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(kinds).getByRole('button', { name: 'Project' }));
    expect(form()).toHaveAccessibleName('New project');
    expect(within(form()).getByRole('textbox', { name: 'Name' })).toHaveValue('Money in order');
    expect(within(form()).getByText('Today to Dec 31')).toBeInTheDocument();
    expect(within(form()).getByRole('checkbox', { name: 'Keep "Call the bank" as its first task' })).toBeChecked();
    await userEvent.click(within(kinds).getByRole('button', { name: 'Practice' }));
    expect(within(form()).getByText('30m a day')).toBeInTheDocument();
    expect(within(form()).queryByLabelText(/Preferred time/)).toBeNull();
    expect(within(form()).getByRole('checkbox', { name: 'Keep it on this card to file next' })).not.toBeChecked();
    expect(within(form()).getByRole('button', { name: 'Make it a practice' })).toBeInTheDocument();
  });

  it('makes the item a project itself when it is not to be its first task: closed with a link, and back on Undo', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    await userEvent.type(picker(), 'Call the bank{Enter}');
    await userEvent.click(within(form()).getByRole('checkbox', { name: 'Keep "Call the bank" as its first task' }));
    await userEvent.click(within(form()).getByRole('button', { name: 'Add project' }));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(toast()).toHaveTextContent('Call the bank is now a project.');
    const [project] = await t.db.all<{ id: string }>("SELECT id FROM project WHERE title = 'Call the bank'");
    expect(await task(t.db, 'i1')).toMatchObject({ kind: 'inbox', done_at: expect.any(String), became: { type: 'project', id: project!.id } });
    await userEvent.click(toastUndo());
    await screen.findByRole('heading', { name: 'Call the bank' });
    await waitFor(() => expect(toast()).toHaveTextContent('Undone: Call the bank removed. Call the bank is back.'));
    expect(await task(t.db, 'i1')).toMatchObject({ done_at: null, became: null });
  });

  it('makes a practice the item becomes, 30m a day by default under the goal picked last, closed with a link', async () => {
    const t = await open();
    // A goal picked in one form is where the next starts.
    await userEvent.click(await screen.findByRole('button', { name: 'New goal from this item' }));
    await userEvent.click(within(form()).getByRole('button', { name: 'Project' }));
    await userEvent.selectOptions(within(form()).getByRole('combobox', { name: 'Goal' }), 'Keep the house');
    await userEvent.click(within(form()).getByRole('button', { name: 'Add project' }));
    await waitFor(() => expect(toast()).toHaveTextContent('Created Call the bank, under Keep the house.'));
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('heading', { name: 'Fix the gate' });

    await userEvent.click(btn('New practice from this item'));
    expect(within(form()).getByRole('combobox', { name: 'Goal' })).toHaveDisplayValue('Keep the house');
    await userEvent.clear(within(form()).getByRole('textbox', { name: 'Name' }));
    await userEvent.type(within(form()).getByRole('textbox', { name: 'Name' }), 'Fix things weekly');
    await userEvent.click(within(form()).getByRole('button', { name: 'Change time' }));
    fireEvent.change(within(form()).getByRole('slider', { name: 'Target' }), { target: { value: '60' } });
    await userEvent.selectOptions(within(form()).getByRole('combobox', { name: 'Per' }), 'Week');
    await userEvent.click(within(form()).getByRole('button', { name: 'Make it a practice' }));
    await screen.findByRole('heading', { name: 'Read the article' });
    expect(toast()).toHaveTextContent('Fix the gate is now the practice Fix things weekly.');
    const [practice] = await t.db.all<{ id: string }>("SELECT id FROM practice WHERE title = 'Fix things weekly'");
    expect(await getRecord(t.db, 'practice', practice!.id)).toMatchObject({ objective_id: 'g1', target_min: 60, per: 'week', preferred_times: [] });
    expect(await task(t.db, 'i2')).toMatchObject({ done_at: expect.any(String), became: { type: 'practice', id: practice!.id } });
  });

  it('makes a goal and keeps the item on the card to file next; Undo takes back only the goal', async () => {
    const t = await open();
    await userEvent.click(await screen.findByRole('button', { name: 'New goal from this item' }));
    await userEvent.clear(within(form()).getByRole('textbox', { name: 'Name' }));
    await userEvent.type(within(form()).getByRole('textbox', { name: 'Name' }), 'Money in order');
    await userEvent.click(within(form()).getByRole('checkbox', { name: 'Keep it on this card to file next' }));
    await userEvent.click(within(form()).getByRole('button', { name: 'Add goal' }));
    await waitFor(() => expect(toast()).toHaveTextContent('Created Money in order.'));
    expect(title()).toHaveTextContent('Call the bank');
    await waitFor(() => expect(picker()).toHaveFocus());
    expect(within(card()).getByText('1 of 5')).toBeInTheDocument();
    expect((await task(t.db, 'i1'))?.kind).toBe('inbox');

    await addTo('One offs');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    await userEvent.click(btn('‹ Undo and go back'));
    await screen.findByRole('heading', { name: 'Call the bank' });
    await userEvent.click(btn('‹ Undo and go back'));
    await waitFor(() => expect(toast()).toHaveTextContent('Undone: Money in order removed.'));
    expect(title()).toHaveTextContent('Call the bank');
    expect(await t.db.all("SELECT id FROM objective WHERE title = 'Money in order' AND deleted_at IS NULL")).toEqual([]);
    expect((await task(t.db, 'i1'))?.kind).toBe('inbox');
  });
});

describe('Editing the item on the card', () => {
  /** The title, a button in the heading that edits it. */
  const pen = () => within(title()).getByRole('button');

  it('edits the title in place from its pencil or Option E, with Save and Cancel, and focus back on the title', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    expect(pen()).toHaveAccessibleName('Call the bank');
    expect(pen()).toHaveAccessibleDescription('Edit title');
    expect(pen().querySelector('.pen svg')).not.toBeNull();
    expect(card().querySelector('.pxhead .keycap')).toHaveTextContent('Alt E');
    await userEvent.click(pen());
    const field = within(card()).getByRole('textbox', { name: 'Title' }) as HTMLInputElement;
    expect(field).toHaveFocus();
    expect([field.selectionStart, field.selectionEnd]).toEqual([13, 13]);
    expect(within(card()).getByText('Up to 2,000 characters.')).toBeInTheDocument();
    expect(btn('Save')).toHaveTextContent('↩');
    expect(btn('Cancel')).toHaveTextContent('esc');
    // Esc or Cancel puts the old title back.
    await userEvent.type(field, ' about the loan');
    await userEvent.keyboard('{Escape}');
    expect(title()).toHaveTextContent('Call the bank');
    expect(pen()).toHaveFocus();
    expect((await task(t.db, 'i1'))?.title).toBe('Call the bank');

    // Option E edits it from anywhere on the card, Add to included; Enter saves.
    altKey('KeyE', picker());
    await userEvent.clear(within(card()).getByRole('textbox', { name: 'Title' }));
    await userEvent.keyboard('{Enter}');
    expect(within(card()).getByRole('alert')).toHaveTextContent('Give it a title.');
    await userEvent.type(within(card()).getByRole('textbox', { name: 'Title' }), 'Call the bank about the loan{Enter}');
    await waitFor(async () => expect((await task(t.db, 'i1'))?.title).toBe('Call the bank about the loan'));
    await waitFor(() => expect(title()).toHaveTextContent('Call the bank about the loan'));
    expect(pen()).toHaveFocus();
    // The toast names it as it is now.
    await addTo('One offs');
    expect(toast()).toHaveTextContent('Added Call the bank about the loan to One offs.');
  });

  it("writes the description with the popup's field: Enter makes a new line, Cmd or Ctrl Enter or Save keeps it, Esc drops it", async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    expect(btn('Add description').querySelector('svg')).not.toBeNull();
    await userEvent.click(btn('Add description'));
    const box = () => within(card()).getByRole('textbox', { name: 'Description' });
    expect(box()).toHaveFocus();
    expect(within(card()).getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
    expect(btn('Save')).toHaveTextContent('↩');
    await userEvent.type(box(), 'Ask about{Enter}the rate');
    expect(box()).toHaveValue('Ask about\nthe rate');
    await userEvent.keyboard('{Escape}');
    expect(within(card()).queryByRole('textbox', { name: 'Description' })).toBeNull();
    expect(pen()).toHaveFocus();
    expect((await task(t.db, 'i1'))?.notes ?? null).toBeNull();

    await userEvent.click(btn('Add description'));
    await userEvent.type(box(), 'Ask about **rates**');
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
    await waitFor(async () => expect((await task(t.db, 'i1'))?.notes).toBe('Ask about **rates**'));
    // Shown formatted where it was written, with Edit; Add description has gone.
    expect((await within(card()).findByText('rates')).tagName).toBe('STRONG');
    expect(within(card()).queryByRole('button', { name: 'Add description' })).toBeNull();
    await userEvent.click(btn('Edit description'));
    await userEvent.type(box(), ' today');
    await userEvent.click(btn('Save'));
    await waitFor(async () => expect((await task(t.db, 'i1'))?.notes).toBe('Ask about **rates** today'));
  });

  it('adds a link on the card at once, with Add link beside the others, and removes it with its own Undo', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    // Not signed in here, so there's nowhere to keep a photo.
    expect(within(card()).queryByRole('button', { name: 'Add photo' })).toBeNull();
    await userEvent.click(btn('Add link'));
    await userEvent.type(within(card()).getByRole('textbox', { name: 'Address' }), 'https://bank.example.com/loans{Enter}');
    expect(await within(card()).findByRole('link', { name: 'bank.example.com' })).toBeVisible();
    const [link] = await listRecords(t.db, 'attachment');
    expect(link).toMatchObject({ task_id: 'i1', kind: 'link' });
    // With one, it's listed under Attachments, with Add link under it.
    expect(within(within(card()).getByRole('region', { name: 'Attachments' })).getByRole('button', { name: 'Add link' })).toBeInTheDocument();
    await userEvent.click(btn('Remove bank.example.com'));
    expect(await screen.findByText('Removed bank.example.com.')).toBeVisible();
    await userEvent.click(toastUndo());
    expect(await within(card()).findByRole('link', { name: 'bank.example.com' })).toBeVisible();
  });

  it('saves Time as it moves, so an item skipped keeps it', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    slide(90);
    await waitFor(async () => expect((await task(t.db, 'i1'))?.estimate_min).toBe(90));
    await userEvent.click(btn('Skip'));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect((await task(t.db, 'i1'))?.estimate_min).toBe(90);
  });

  it("puts the item back as it arrived with one Undo before stepping back, and the toast's Undo after adding takes back only the add", async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    await addTo('Learn to bake bread');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    await userEvent.click(pen());
    await userEvent.type(within(card()).getByRole('textbox', { name: 'Title' }), ' latch{Enter}');
    await waitFor(() => expect(title()).toHaveTextContent('Fix the gate latch'));
    await userEvent.click(btn('Add description'));
    await userEvent.type(within(card()).getByRole('textbox', { name: 'Description' }), 'Hinges');
    await userEvent.click(btn('Save'));
    slide(30);
    await userEvent.click(btn('Add link'));
    await userEvent.type(within(card()).getByRole('textbox', { name: 'Address' }), 'https://hinges.example.com{Enter}');
    await within(card()).findByRole('link', { name: 'hinges.example.com' });
    await waitFor(async () => expect(await task(t.db, 'i2')).toMatchObject({ title: 'Fix the gate latch', notes: 'Hinges', estimate_min: 30 }));

    await addTo('One offs');
    await screen.findByRole('heading', { name: 'Read the article' });
    await userEvent.click(toastUndo());
    await screen.findByRole('heading', { name: 'Fix the gate latch' });
    expect(await task(t.db, 'i2')).toMatchObject({ kind: 'inbox', title: 'Fix the gate latch', notes: 'Hinges', estimate_min: 30 });

    await userEvent.click(btn('‹ Undo and go back'));
    await waitFor(() => expect(title()).toHaveTextContent(/^Fix the gate$/));
    expect(await task(t.db, 'i2')).toMatchObject({ kind: 'inbox', title: 'Fix the gate', notes: null, estimate_min: 120 });
    expect((await listRecords(t.db, 'attachment')).filter((a) => a.task_id === 'i2')).toEqual([]);
    expect(toast()).toHaveTextContent('Fix the gate is back as it arrived.');
    // Then it steps back to the item before.
    await userEvent.click(btn('‹ Undo and go back'));
    await screen.findByRole('heading', { name: 'Call the bank' });
  });

  it('keeps focus in order: the title, the add buttons, Time, Add to, the week, New practice and goal, Skip, Delete/done', async () => {
    await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    const stops = Array.from(card().querySelectorAll<HTMLElement>('button, input, textarea, select'))
      .filter((e) => !e.hidden && !(e as HTMLButtonElement).disabled)
      .map((e) => (e.tagName === 'INPUT' && (e as HTMLInputElement).type === 'range' ? 'Time' : (e.getAttribute('aria-label') ?? e.textContent)));
    expect(stops.slice(stops.indexOf('Call the bank'))).toEqual([
      'Call the bank',
      'Add description',
      'Add link',
      'Time',
      'Add to a project or One offs',
      '+Add to this weekAlt W',
      'New practice from this item',
      'New goal from this item',
      'SkipAlt S',
      'Delete/doneAlt D',
    ]);
  });

  it('on phone: the title edits with Save and Cancel under it, and the add buttons sit two by two', async () => {
    const t = await open({ layout: 'phone' });
    await screen.findByRole('heading', { name: 'Call the bank' });
    expect(within(card().querySelector<HTMLElement>('.pxfour')!).getAllByRole('button').map((b) => b.textContent)).toEqual(['Add description', 'Add link']);
    await userEvent.click(pen());
    const field = within(card()).getByRole('textbox', { name: 'Title' });
    await userEvent.type(field, ' today');
    expect(btn('Cancel')).toBeInTheDocument();
    await userEvent.click(btn('Save'));
    await waitFor(async () => expect((await task(t.db, 'i1'))?.title).toBe('Call the bank today'));
  });
});

describe('Process for planning a stretch', () => {
  async function seedStretch(w: Writer) {
    await w.create('objective', { title: 'Keep the house', state: 'active' }, 'g1');
    // Ends before the stretch, so it isn't in that plan.
    await w.create('project', { title: 'Paint the fence', ...running, end: '2026-12-15' }, 'p1');
    await w.create('project', { title: 'Plant the garden', objective_id: 'g1', ...running, end: '2027-03-15' }, 'p2');
    await w.create('task', { kind: 'inbox', title: 'Call the bank' }, 'i1');
    await w.create('task', { kind: 'inbox', title: 'Fix the gate' }, 'i2');
  }
  const stretch = { stretchStart: '2027-01-01', stretchEnd: '2027-03-31' };

  it('lists the stretch’s projects first, hides the week, and says Back to planning', async () => {
    keysOn();
    const close = vi.fn();
    await open({ seed: seedStretch, params: stretch, close });
    await screen.findByRole('heading', { name: 'Call the bank' });
    await userEvent.click(picker());
    expect(within(screen.getByRole('group', { name: 'In this stretch' })).getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['Plant the garden, Keep the house']);
    expect(options()).toEqual(['+ New project', 'One offs', 'Plant the garden, Keep the house', 'Paint the fence']);
    expect(within(card()).queryByRole('button', { name: /this week|the plan/ })).toBeNull();
    await userEvent.keyboard('{Escape}');
    key('w');
    expect(within(card()).queryByRole('button', { name: /^Adding/ })).toBeNull();
    expect(within(card()).getByText('Planning Jan 1 to Mar 31')).toBeInTheDocument();
    await userEvent.click(btn('Back to planning'));
    expect(close).toHaveBeenCalled();
  });

  it('says Back to planning on phone too', async () => {
    await open({ seed: seedStretch, params: stretch, layout: 'phone' });
    await screen.findByRole('heading', { name: 'Call the bank' });
    expect(btn('Back to planning')).toBeInTheDocument();
    expect(within(card()).queryByRole('button', { name: 'Add to this week' })).toBeNull();
  });
});

describe('Process on phone', () => {
  it('puts the item on top, then Add to low in thumb reach, then New practice and goal, then Undo, Skip and Delete', async () => {
    await open({ layout: 'phone' });
    await screen.findByRole('heading', { name: 'Call the bank' });
    const order = Array.from(card().querySelectorAll('h1, button, input')).map((e) =>
      e.tagName === 'INPUT' ? 'Time' : e.tagName === 'H1' ? 'title' : (e.getAttribute('aria-label') ?? e.textContent),
    );
    expect(order).toEqual([
      'Exit',
      'title',
      'Call the bank',
      'Add description',
      'Add link',
      'Time',
      '+Add to this week',
      'Add to a project or One offs',
      'New practice from this item',
      'New goal from this item',
      '‹ Undo',
      'Skip',
      'Delete/done',
    ]);
    await waitFor(() => expect(btn('Add to a project or One offs')).toHaveFocus());
    // A phone has no keyboard: no setting, and keys do nothing, Option or not.
    key('s');
    altKey('KeyS');
    expect(title()).toHaveTextContent('Call the bank');
  });

  it('opens Add to as a sheet, ready to search; a tap on a row adds there, and next time Add to it is one tap', async () => {
    const t = await open({ layout: 'phone' });
    await userEvent.click(await screen.findByRole('button', { name: 'Add to a project or One offs' }));
    const sheet = screen.getByRole('dialog', { name: 'Add to' });
    expect(picker()).toHaveFocus();
    expect(picker()).toHaveAttribute('placeholder', 'Search projects');
    expect(options()).toEqual(['+ New project', 'One offs', 'Paint the fence, Keep the house', 'Plant the garden, Keep the house', 'Learn to bake bread', 'Write the report']);
    // Nothing used yet, so nothing is lit for return to add.
    expect(within(list()).queryByRole('option', { selected: true })).toBeNull();
    await userEvent.type(picker(), 'garden');
    expect(options()).toEqual(['+ New project “garden”', 'Plant the garden, Keep the house']);
    await userEvent.click(within(sheet).getByRole('option', { name: 'Plant the garden, Keep the house' }));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(screen.queryByRole('dialog', { name: 'Add to' })).toBeNull();
    expect(await task(t.db, 'i1')).toMatchObject({ kind: 'project', project_id: 'p4' });
    expect(toast()).toHaveTextContent('Added Call the bank to Plant the garden.');

    expect(btn('Add to a project or One offs: Plant the garden')).toHaveTextContent('Plant the garden· Keep the house');
    await userEvent.click(btn('Add to Plant the garden'));
    await screen.findByRole('heading', { name: 'Read the article' });
    expect((await task(t.db, 'i2'))?.project_id).toBe('p4');

    // Close, or a tap above the sheet, puts it away.
    await userEvent.click(btn(/^Add to a project or One offs/));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Add to' })).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Add to' })).toBeNull();
  });

  it('makes a new project from the sheet in a sheet of its own, then adds the item with Add to it', async () => {
    const t = await open({ layout: 'phone' });
    await userEvent.click(await screen.findByRole('button', { name: 'Add to a project or One offs' }));
    await userEvent.type(picker(), 'Fix up the shed');
    await userEvent.click(screen.getByRole('option', { name: '+ New project “Fix up the shed”' }));
    const sheet = screen.getByRole('dialog', { name: 'New project' });
    expect(screen.queryByRole('dialog', { name: 'Add to' })).toBeNull();
    expect(within(sheet).getByRole('textbox', { name: 'Name' })).toHaveValue('Fix up the shed');
    await userEvent.type(within(sheet).getByRole('textbox', { name: /Milestone/ }), 'Roof watertight');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Add project' }));
    await waitFor(() => expect(toast()).toHaveTextContent('Created Fix up the shed, with the milestone Roof watertight.'));
    expect(screen.queryByRole('dialog', { name: 'New project' })).toBeNull();
    expect(title()).toHaveTextContent('Call the bank');
    await userEvent.click(btn('Add to Fix up the shed'));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    const [shed] = await t.db.all<{ id: string }>("SELECT id FROM project WHERE title = 'Fix up the shed'");
    expect((await task(t.db, 'i1'))?.project_id).toBe(shed!.id);
    expect(toast()).toHaveTextContent('Added Call the bank to Fix up the shed, under Roof watertight.');
  });

  it('swipes the card away without the sheet the choice was made in', async () => {
    const copies: Element[] = [];
    Object.assign(HTMLElement.prototype, {
      animate: vi.fn(function (this: Element) {
        copies.push(this);
        return { finished: new Promise(() => undefined) } as unknown as Animation;
      }),
    });
    try {
      await open({ layout: 'phone' });
      await userEvent.click(await screen.findByRole('button', { name: 'Add to a project or One offs' }));
      await userEvent.click(screen.getByRole('option', { name: 'One offs' }));
      await screen.findByRole('heading', { name: 'Fix the gate' });
      const ghost = copies.find((c) => c.classList.contains('pxghost'))!;
      expect(ghost).toHaveTextContent('Call the bank');
      expect(ghost.querySelector('.sheet, .scrim')).toBeNull();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    }
  });

  it('opens the form in a sheet, the caret after the name, and makes the item a practice', async () => {
    const t = await open({ layout: 'phone' });
    await userEvent.click(await screen.findByRole('button', { name: 'New practice from this item' }));
    const sheet = screen.getByRole('dialog', { name: 'New practice' });
    const field = within(sheet).getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
    expect(field).toHaveValue('Call the bank');
    expect([field.selectionStart, field.selectionEnd]).toEqual(['Call the bank'.length, 'Call the bank'.length]);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Make it a practice' }));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(screen.queryByRole('dialog', { name: 'New practice' })).toBeNull();
    // One picker, whatever was open beside it.
    expect(within(card()).getAllByRole('button', { name: /^Add to a project or One offs/ })).toHaveLength(1);
    expect(toast()).toHaveTextContent('Call the bank is now a practice.');
    expect((await task(t.db, 'i1'))?.became).toMatchObject({ type: 'practice' });
    await userEvent.click(btn('‹ Undo'));
    await screen.findByRole('heading', { name: 'Call the bank' });
    expect((await task(t.db, 'i1'))?.done_at).toBeNull();
  });
});
