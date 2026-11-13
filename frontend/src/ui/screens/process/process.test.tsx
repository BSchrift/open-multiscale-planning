import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatClock } from '../../../core/clock';
import { applyRemote, getRecord, listRecords, weekPickId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderScreen } from '../../app/testing';
import type { HarnessOptions } from '../../app/testing';
import { EST_STEPS } from '../../components/EstimateSlider';

afterEach(cleanup);

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
const last = () => within(card()).getByRole('status');
const btn = (name: string | RegExp) => within(card()).getByRole('button', { name });
const task = (db: Parameters<typeof getRecord>[0], id: string) => getRecord(db, 'task', id);
const slide = (minutes: number) => fireEvent.change(screen.getByRole('slider', { name: 'Time' }), { target: { value: String(EST_STEPS.indexOf(minutes)) } });
const key = (k: string, target: Element = title()) => fireEvent.keyDown(target, { key: k });
/** Option or Alt with a key, which types another character on a Mac. */
const altKey = (code: string, target: Element = title()) => fireEvent.keyDown(target, { key: '∂', code, altKey: true });
/** Single-key shortcuts, the device setting. */
const keysOn = () => localStorage.setItem('multiscale.processKeys', 'true');
const form = () => within(card()).getByRole('form');

describe('Process on desktop', () => {
  it('shows one item at a time with live projects in added order, a finder for the rest, and a group to make a home', async () => {
    await open();
    expect(await screen.findByRole('heading', { name: 'Call the bank', level: 1 })).toHaveFocus();
    expect(within(card()).getByText('1 of 5')).toBeInTheDocument();
    // The bar fills as far as the count says: the first of five is a fifth.
    expect(card().querySelector<HTMLElement>('.pxbar > span')!.style.width).toBe('20%');
    const dests = within(card()).getAllByRole('button').filter((b) => b.classList.contains('pxdest'));
    expect(dests.map((b) => b.textContent)).toEqual(['1Paint the fence', '2Learn to bake bread', '/Find a project', '+ New project', 'OOne offs']);
    const group = within(card()).getByRole('group', { name: 'No home yet? Make one' });
    expect(within(group).getAllByRole('button').map((b) => [b.getAttribute('aria-label'), b.textContent])).toEqual([
      ['New project from this item', 'NNew project'],
      ['New practice from this item', 'PNew practice'],
      ['New goal from this item', 'GNew goal'],
    ]);
    // Every button shows its key.
    for (const [name, k] of [['‹ Undo and go back', 'Z'], ['Skip', 'S'], ['Delete/done', 'D'], ['Add to this week', 'W']]) expect(btn(name!).querySelector('kbd')).toHaveTextContent(k!);
    expect(btn('‹ Undo and go back')).toBeDisabled();
  });

  it('sends to One offs in one click, moves on, and Undo puts it back', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    await userEvent.click(btn('One offs'));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(last()).toHaveTextContent('Sent to One offs.');
    expect(await task(t.db, 'i1')).toMatchObject({ kind: 'one_off', schedule: { type: 'once' } });
    expect(within(card()).getByText('2 of 5')).toBeInTheDocument();

    await userEvent.click(btn('‹ Undo and go back'));
    await screen.findByRole('heading', { name: 'Call the bank' });
    expect((await task(t.db, 'i1'))?.kind).toBe('inbox');
    expect(btn('‹ Undo and go back')).toBeDisabled();
  });

  it.each(['desktop', 'phone'] as const)('on %s, makes a new project from the card and sends the item to it in one change', async (layout) => {
    const t = await open({ layout });
    await screen.findByRole('heading', { name: 'Call the bank' });
    await userEvent.click(btn('+ New project'));
    const form = screen.getByRole('form', { name: 'Add project' });
    await userEvent.type(within(form).getByLabelText('Name'), 'Fix up the shed');
    const saves = vi.spyOn(t.db, 'transaction');
    await userEvent.click(within(form).getByRole('button', { name: 'Add project' }));
    await waitFor(() => expect(form).not.toBeInTheDocument());
    // The card has already moved on as the form closes, so a key pressed now is for the next item.
    expect(title()).toHaveTextContent('Fix the gate');
    expect(saves).toHaveBeenCalledTimes(1);
    expect(last()).toHaveTextContent('Sent to new project Fix up the shed.');
    const [shed] = await t.db.all<{ id: string }>("SELECT id FROM project WHERE title = 'Fix up the shed'");
    expect(await task(t.db, 'i1')).toMatchObject({ kind: 'project', project_id: shed!.id });
    // Single keys are off by default and Alt with the key always works on desktop; phone has no keys, so it taps.
    if (layout === 'phone') await userEvent.click(btn('One offs'));
    else altKey('KeyO');
    await screen.findByRole('heading', { name: 'Read the article' });
    expect((await task(t.db, 'i2'))?.kind).toBe('one_off');

    // One Undo per change: the first takes back the send to One offs, the second the project and the send to it.
    const undo = () => userEvent.click(btn(layout === 'phone' ? '‹ Undo' : '‹ Undo and go back'));
    await undo();
    await screen.findByRole('heading', { name: 'Fix the gate' });
    await undo();
    await screen.findByRole('heading', { name: 'Call the bank' });
    expect((await task(t.db, 'i1'))?.kind).toBe('inbox');
    expect(await getRecord(t.db, 'project', shed!.id)).toMatchObject({ deleted_at: expect.any(String) });
    expect(btn(layout === 'phone' ? '‹ Undo' : '‹ Undo and go back')).toBeDisabled();
    expect(within(card()).queryByText(/Fix up the shed/)).toBeNull();
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
      await userEvent.click(btn('One offs'));
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
      await userEvent.click(await screen.findByRole('button', { name: 'One offs' }));
      await screen.findByRole('heading', { name: 'Fix the gate' });
      expect(animate).not.toHaveBeenCalled();
      expect(document.querySelector('.pxghost')).toBeNull();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'animate');
      vi.unstubAllGlobals();
    }
  });

  it('starts the slider from the captured estimate, keeps the card when it moves, and sends it with the task', async () => {
    const t = await open();
    await userEvent.click(await screen.findByRole('button', { name: 'One offs' }));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(screen.getByRole('slider', { name: 'Time' })).toHaveAttribute('aria-valuetext', '2h');
    slide(90);
    expect(title()).toHaveTextContent('Fix the gate');
    await userEvent.click(btn('Paint the fence'));
    await screen.findByRole('heading', { name: 'Read the article' });
    expect(await task(t.db, 'i2')).toMatchObject({ kind: 'project', project_id: 'p1', estimate_min: 90 });
    expect(last()).toHaveTextContent('Sent to Paint the fence.');
    expect(screen.getByRole('slider', { name: 'Time' })).toHaveAttribute('aria-valuetext', 'No estimate');
  });

  it('clears what the other kind of task had, so two devices sorting one item merge into one kind', async () => {
    const t = await open();
    // Another device sent each item the other way first; its writes reach this one after this one's.
    const earlier = (id: string, fields: Record<string, unknown>) =>
      applyRemote(t.db, [{ type: 'task', id, fields: Object.fromEntries(Object.entries(fields).map(([f, v]) => [f, { v, c: formatClock({ wall: 1, counter: 0, device: 'other' }) }])) }]);
    await userEvent.click(await screen.findByRole('button', { name: 'One offs' }));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    await earlier('i1', { kind: 'project', project_id: 'p1', milestone_id: 'm1' });
    expect(await task(t.db, 'i1')).toMatchObject({ kind: 'one_off', project_id: null, milestone_id: null });

    await userEvent.click(btn('Paint the fence'));
    await screen.findByRole('heading', { name: 'Read the article' });
    await earlier('i2', { kind: 'one_off', schedule: { type: 'float', every: 2, unit: 'week' }, next_due: '2026-11-16' });
    expect(await task(t.db, 'i2')).toMatchObject({ kind: 'project', project_id: 'p1', schedule: null, next_due: null });
  });

  it('lets the last project send pick a milestone, and the last one off a date', async () => {
    const t = await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Paint the fence' }));
    const milestone = await within(card()).findByRole('combobox', { name: 'Milestone for Call the bank' });
    // A project's tasks with no milestone sit under its Done.
    expect(within(milestone).getAllByRole('option').map((o) => o.textContent)).toEqual(['Done', 'First coat']);
    await userEvent.selectOptions(milestone, 'First coat');
    await waitFor(async () => expect((await task(t.db, 'i1'))?.milestone_id).toBe('m1'));

    await userEvent.click(btn('One offs'));
    await userEvent.click(await within(card()).findByRole('button', { name: 'Add date for Fix the gate' }));
    fireEvent.change(within(card()).getByLabelText('Date'), { target: { value: '2026-11-12' } });
    await userEvent.click(btn('Set date'));
    await waitFor(async () => expect((await task(t.db, 'i2'))?.schedule).toMatchObject({ type: 'once', from: '2026-11-12' }));
    expect(title()).toHaveTextContent('Read the article');
  });

  it('adds to this week as a pick, not on the calendar, then resets the toggle', async () => {
    const t = await open();
    const toggle = await screen.findByRole('button', { name: 'Add to this week' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggle);
    expect(btn('Adding to this week')).toHaveAttribute('aria-pressed', 'true');
    expect(btn('One offs, add to this week')).toBeInTheDocument();
    await userEvent.click(btn('One offs, add to this week'));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(last()).toHaveTextContent('Sent to One offs and added to this week, not on the calendar yet.');
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
    await userEvent.click(btn('Learn to bake bread, add to the plan'));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(last()).toHaveTextContent('Sent to Learn to bake bread and added to the plan.');
    expect(await getRecord(t.db, 'week_pick', weekPickId('2026-11-09', 'i1'))).toMatchObject({ minutes: 60, deleted_at: null });
    expect(await listRecords(t.db, 'time_block')).toHaveLength(0);
  });

  it('opens on the item it was given', async () => {
    await open({ params: { item: 'i3' } });
    expect(await screen.findByRole('heading', { name: 'Read the article', level: 1 })).toBeInTheDocument();
    expect(within(card()).getByText('1 of 5')).toBeInTheDocument();
  });

  it('skips, asks before deleting, and sums up on the done card', async () => {
    const t = await open();
    await userEvent.click(await screen.findByRole('button', { name: 'One offs' }));
    await userEvent.click(btn('Paint the fence'));
    await userEvent.click(btn('Learn to bake bread'));
    await screen.findByRole('heading', { name: 'Buy stamps' });
    await userEvent.click(btn('Skip'));
    await screen.findByRole('heading', { name: 'Return the books' });
    expect(last()).toHaveTextContent('Skipped. It stays in your Inbox.');

    await userEvent.click(btn('Delete/done'));
    expect(within(card()).getByRole('alert')).toHaveTextContent('Delete this item?');
    await userEvent.click(btn('Cancel'));
    expect(title()).toHaveTextContent('Return the books');
    await userEvent.click(btn('Delete/done'));
    await userEvent.click(btn('Yes, delete'));
    expect(await screen.findByRole('heading', { name: "That's everything for now" })).toBeInTheDocument();
    expect(within(card()).getByText('3 sorted, 1 deleted, 1 skipped, still in your Inbox.')).toBeInTheDocument();
    expect((await task(t.db, 'i5'))?.deleted_at).toBeTruthy();
    expect((await task(t.db, 'i4'))?.kind).toBe('inbox');

    await userEvent.click(btn('‹ Undo and go back'));
    await screen.findByRole('heading', { name: 'Return the books' });
    expect((await task(t.db, 'i5'))?.deleted_at).toBeNull();
  });

  it('says Inbox clear when nothing is left, and Done closes', async () => {
    const close = vi.fn();
    await renderScreen('process', { presentation: 'overlay', close, seed: (w) => w.create('task', { kind: 'inbox', title: 'Call the bank' }, 'i1') });
    await userEvent.click(await screen.findByRole('button', { name: 'One offs' }));
    expect(await screen.findByRole('heading', { name: 'Inbox clear' })).toBeInTheDocument();
    expect(within(card()).getByText('1 sorted.')).toBeInTheDocument();
    await userEvent.click(btn('Done'));
    expect(close).toHaveBeenCalled();
  });

  it('finds any project by its name or its goal, sends with Enter, and offers a new project named as typed', async () => {
    keysOn();
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    key('/');
    const find = within(card()).getByRole('combobox', { name: 'Find a project' });
    expect(find).toHaveFocus();
    const rows = () => within(card()).getAllByRole('option').map((o) => o.textContent);
    expect(rows()).toEqual([
      'Paint the fenceKeep the house, No tasks',
      'Learn to bake breadNo tasks',
      'Write the reportPaused',
      'Plant the gardenKeep the house, Not started',
      '+ New project',
    ]);
    // Typing only filters: nothing is sent until Enter.
    await userEvent.type(find, 'house');
    expect(rows()).toEqual(['Paint the fenceKeep the house, No tasks', 'Plant the gardenKeep the house, Not started', '+ New project "house"']);
    expect(within(card()).getByRole('option', { name: /Paint the fence/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowUp}');
    expect(within(card()).getByRole('option', { name: /Plant the garden/ })).toHaveAttribute('aria-selected', 'true');
    expect((await task(t.db, 'i1'))?.kind).toBe('inbox');
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(await task(t.db, 'i1')).toMatchObject({ kind: 'project', project_id: 'p4' });
    expect(last()).toHaveTextContent('Sent to Plant the garden.');
    expect(within(card()).queryByRole('combobox', { name: 'Find a project' })).toBeNull();

    // Its last row makes a new project, named as typed.
    await userEvent.click(btn('Find a project'));
    await userEvent.type(within(card()).getByRole('combobox', { name: 'Find a project' }), 'shed');
    expect(rows()).toEqual(['+ New project "shed"']);
    await userEvent.keyboard('{Enter}');
    expect(form()).toHaveAccessibleName('New project');
    expect(within(form()).getByRole('textbox', { name: 'Name' })).toHaveValue('shed');

    // Esc steps back to the card, focus on the button that opened it.
    await userEvent.keyboard('{Escape}');
    expect(within(card()).queryByRole('form')).toBeNull();
    expect(btn('Find a project')).toHaveFocus();
  });

  it('offers 9 for the project last used that has no number, such as a paused one found by name', async () => {
    keysOn();
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    expect(within(card()).queryByRole('button', { name: /last used/ })).toBeNull();
    key('/');
    await userEvent.type(within(card()).getByRole('combobox', { name: 'Find a project' }), 'report{Enter}');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(btn('Write the report, last used')).toHaveTextContent('9');
    key('9');
    await screen.findByRole('heading', { name: 'Read the article' });
    expect(await task(t.db, 'i2')).toMatchObject({ kind: 'project', project_id: 'p3' });
    // One with a number keeps it, and 9 stays with the last one that has none.
    key('1');
    await screen.findByRole('heading', { name: 'Buy stamps' });
    expect(btn('Write the report, last used')).toBeInTheDocument();
  });

  it('works from the keyboard', async () => {
    keysOn();
    const close = vi.fn();
    const t = await open({ close });
    await screen.findByRole('heading', { name: 'Call the bank' });
    key('o');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    key('1', screen.getByRole('slider', { name: 'Time' }));
    await screen.findByRole('heading', { name: 'Read the article' });
    expect((await task(t.db, 'i2'))?.project_id).toBe('p1');
    key('z');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    key('s');
    await screen.findByRole('heading', { name: 'Read the article' });
    key('w');
    expect(btn('Adding to this week')).toBeInTheDocument();
    key('w');
    key('d');
    expect(within(card()).getByRole('alert')).toHaveTextContent('Delete this item?');
    key('Escape');
    expect(within(card()).queryByRole('alert')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    key('d');
    key('d');
    await screen.findByRole('heading', { name: 'Buy stamps' });
    expect((await task(t.db, 'i3'))?.deleted_at).toBeTruthy();
    key('Enter');
    expect(title()).toHaveTextContent('Buy stamps');
    key('Escape');
    expect(close).toHaveBeenCalled();
  });

  it('keeps Esc inside a field on the card', async () => {
    keysOn();
    const close = vi.fn();
    await open({ close });
    await userEvent.click(await screen.findByRole('button', { name: 'One offs' }));
    await userEvent.click(await within(card()).findByRole('button', { name: 'Add date for Call the bank' }));
    const date = within(card()).getByLabelText('Date');
    key('o', date);
    expect(title()).toHaveTextContent('Fix the gate');
    fireEvent.keyDown(date, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
  });

  it('takes single keys only with the setting on: off, as by default, a key needs Option or Alt held', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    // Speech input can type letters, and they mustn't skip and send items.
    for (const k of ['o', 's', '1', 'n', '/', 'w', 'd']) key(k);
    expect(title()).toHaveTextContent('Call the bank');
    expect(within(card()).queryByRole('form')).toBeNull();
    expect(within(card()).queryByRole('alert')).toBeNull();
    expect(within(card()).getByText('Keys work with Option or Alt held. Settings can make them work alone.')).toBeInTheDocument();

    altKey('KeyO');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect((await task(t.db, 'i1'))?.kind).toBe('one_off');
    altKey('Digit1');
    await screen.findByRole('heading', { name: 'Read the article' });
    altKey('KeyZ');
    await screen.findByRole('heading', { name: 'Fix the gate' });
    altKey('KeyD');
    expect(within(card()).getByRole('alert')).toHaveTextContent('Delete this item?');
    // The question's own D needs Option or Alt too; Enter needs nothing.
    key('d');
    expect(title()).toHaveTextContent('Fix the gate');
    key('Enter', within(card()).getByRole('alert'));
    await screen.findByRole('heading', { name: 'Read the article' });
    expect((await task(t.db, 'i2'))?.deleted_at).toBeTruthy();
    altKey('KeyP');
    expect(form()).toHaveAccessibleName('New practice');
  });

  it('undoes with Cmd or Ctrl and Z, whatever the setting', async () => {
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'One offs' }));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Time' }), { key: 'z', metaKey: true });
    await screen.findByRole('heading', { name: 'Call the bank' });
    await userEvent.click(btn('One offs'));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    fireEvent.keyDown(title(), { key: 'z', ctrlKey: true });
    await screen.findByRole('heading', { name: 'Call the bank' });
  });
});

describe('Making a home from the card', () => {
  it.each([
    ['n', 'New project'],
    ['p', 'New practice'],
    ['g', 'New goal'],
  ])('%s opens the form in place of the destinations, its name the item, selected; Esc returns to the button', async (k, name) => {
    keysOn();
    await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    key(k);
    expect(form()).toHaveAccessibleName(name);
    const field = within(form()).getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
    expect(field).toHaveFocus();
    expect(field).toHaveValue('Call the bank');
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'Call the bank'.length]);
    expect(within(card()).queryByRole('button', { name: 'Paint the fence' })).toBeNull();
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

  it('makes a project under a new goal and sends the item there, in one change with one Undo that takes both back', async () => {
    const t = await open();
    await userEvent.click(await screen.findByRole('button', { name: 'New project from this item' }));
    const name = within(form()).getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Sort out the bank');
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

    const transactions = vi.spyOn(t.db, 'transaction');
    await userEvent.click(within(form()).getByRole('button', { name: 'Add project and send it there' }));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(transactions).toHaveBeenCalledTimes(1);
    expect(last()).toHaveTextContent('Added goal Money in order and project Sort out the bank, and sent "Call the bank" to it.');
    const [project] = await t.db.all<{ id: string; objective_id: string }>("SELECT id, objective_id FROM project WHERE title = 'Sort out the bank'");
    expect(await getRecord(t.db, 'project', project!.id)).toMatchObject({ start: '2026-11-02', end: '2026-11-30', state: 'active' });
    expect((await getRecord(t.db, 'objective', project!.objective_id))?.title).toBe('Money in order');
    expect(await task(t.db, 'i1')).toMatchObject({ kind: 'project', project_id: project!.id });
    // It takes a number at once.
    expect(btn('Sort out the bank').querySelector('.pxkey')).toHaveTextContent(/^[1-8]$/);

    await userEvent.click(btn('‹ Undo and go back'));
    await screen.findByRole('heading', { name: 'Call the bank' });
    expect(last()).toHaveTextContent('Undone: Money in order and Sort out the bank removed, "Call the bank" is back in your Inbox.');
    expect((await getRecord(t.db, 'project', project!.id))?.deleted_at).toBeTruthy();
    expect((await getRecord(t.db, 'objective', project!.objective_id))?.deleted_at).toBeTruthy();
    expect((await task(t.db, 'i1'))?.kind).toBe('inbox');
    expect(btn('‹ Undo and go back')).toBeDisabled();
    expect(title()).toHaveFocus();
  });

  it('keeps a project another device has put tasks in since, and Undo gives back only the item', async () => {
    const t = await open();
    await userEvent.click(await screen.findByRole('button', { name: 'New project from this item' }));
    await userEvent.clear(within(form()).getByRole('textbox', { name: 'Name' }));
    await userEvent.type(within(form()).getByRole('textbox', { name: 'Name' }), 'Japan trip');
    await userEvent.click(within(form()).getByRole('button', { name: 'Add project and send it there' }));
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
    expect(last()).toHaveTextContent('Kept Japan trip, it has other tasks now. "Call the bank" is back in your Inbox.');
    expect((await getRecord(t.db, 'project', project!.id))?.deleted_at).toBeFalsy();
    expect((await task(t.db, 'i1'))?.kind).toBe('inbox');
  });

  it('makes the item a project itself when it is not to be its first task: closed with a link, and back on Undo', async () => {
    const t = await open();
    await userEvent.click(await screen.findByRole('button', { name: 'New project from this item' }));
    await userEvent.click(within(form()).getByRole('checkbox', { name: 'Keep "Call the bank" as its first task' }));
    await userEvent.click(within(form()).getByRole('button', { name: 'Add project' }));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(last()).toHaveTextContent('"Call the bank" is now a project. It left your Inbox.');
    const [project] = await t.db.all<{ id: string }>("SELECT id FROM project WHERE title = 'Call the bank'");
    expect(await task(t.db, 'i1')).toMatchObject({ kind: 'inbox', done_at: expect.any(String), became: { type: 'project', id: project!.id } });
    await userEvent.click(btn('‹ Undo and go back'));
    await screen.findByRole('heading', { name: 'Call the bank' });
    expect(last()).toHaveTextContent('Undone: Call the bank removed, "Call the bank" is back in your Inbox.');
    expect(await task(t.db, 'i1')).toMatchObject({ done_at: null, became: null });
  });

  it('makes a practice the item becomes, 30m a day by default under the goal picked last, closed with a link', async () => {
    const t = await open();
    // A goal picked in one form is where the next starts.
    await userEvent.click(await screen.findByRole('button', { name: 'New goal from this item' }));
    await userEvent.click(within(form()).getByRole('button', { name: 'Project' }));
    await userEvent.selectOptions(within(form()).getByRole('combobox', { name: 'Goal' }), 'Keep the house');
    await userEvent.click(within(form()).getByRole('button', { name: 'Add project and send it there' }));
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
    expect(last()).toHaveTextContent('"Fix the gate" is now the practice Fix things weekly, 1h a week. It left your Inbox.');
    const [practice] = await t.db.all<{ id: string }>("SELECT id FROM practice WHERE title = 'Fix things weekly'");
    expect(await getRecord(t.db, 'practice', practice!.id)).toMatchObject({ objective_id: 'g1', target_min: 60, per: 'week', preferred_times: [] });
    expect(await task(t.db, 'i2')).toMatchObject({ done_at: expect.any(String), became: { type: 'practice', id: practice!.id } });
    // No toast: the card's line says it.
    expect(document.querySelector('.toast')).toBeNull();
  });

  it('makes a goal and keeps the item on the card to file next; Undo takes back only the goal', async () => {
    const t = await open();
    await userEvent.click(await screen.findByRole('button', { name: 'New goal from this item' }));
    await userEvent.clear(within(form()).getByRole('textbox', { name: 'Name' }));
    await userEvent.type(within(form()).getByRole('textbox', { name: 'Name' }), 'Money in order');
    await userEvent.click(within(form()).getByRole('checkbox', { name: 'Keep it on this card to file next' }));
    await userEvent.click(within(form()).getByRole('button', { name: 'Add goal' }));
    await waitFor(() => expect(last()).toHaveTextContent('Added goal Money in order. Now file "Call the bank".'));
    expect(title()).toHaveTextContent('Call the bank');
    expect(title()).toHaveFocus();
    expect(within(card()).getByText('1 of 5')).toBeInTheDocument();
    expect((await task(t.db, 'i1'))?.kind).toBe('inbox');

    await userEvent.click(btn('One offs'));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    await userEvent.click(btn('‹ Undo and go back'));
    await screen.findByRole('heading', { name: 'Call the bank' });
    await userEvent.click(btn('‹ Undo and go back'));
    await waitFor(() => expect(last()).toHaveTextContent('Undone: Money in order removed.'));
    expect(title()).toHaveTextContent('Call the bank');
    expect(await t.db.all("SELECT id FROM objective WHERE title = 'Money in order' AND deleted_at IS NULL")).toEqual([]);
    expect((await task(t.db, 'i1'))?.kind).toBe('inbox');
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

  it('puts projects in the plan first with their goals, hides the week, says Back to planning, and ends new projects with it', async () => {
    keysOn();
    const close = vi.fn();
    const t = await open({ seed: seedStretch, params: stretch, close });
    await screen.findByRole('heading', { name: 'Call the bank' });
    const dests = within(card()).getAllByRole('button').filter((b) => b.classList.contains('pxdest') && /^\d/.test(b.textContent ?? ''));
    expect(dests.map((b) => b.textContent)).toEqual(['1Plant the gardenKeep the house', '2Paint the fence']);
    expect(within(card()).queryByRole('button', { name: /this week|the plan/ })).toBeNull();
    key('w');
    expect(within(card()).queryByRole('button', { name: /^Adding/ })).toBeNull();
    expect(within(card()).getByText('Planning Jan 1 to Mar 31')).toBeInTheDocument();

    key('n');
    expect(within(form()).getByText('Today to Mar 31')).toBeInTheDocument();
    await userEvent.click(within(form()).getByRole('button', { name: 'Add project and send it there' }));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    const [made] = await t.db.all<{ end: string }>("SELECT end FROM project WHERE title = 'Call the bank'");
    expect(made?.end).toBe('2027-03-31');
    expect(document.querySelector('.toast')).toBeNull();

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
  it('puts title and last action on top, then Time and the week toggle, then the destinations, then Undo, Skip and Delete', async () => {
    await open({ layout: 'phone' });
    await screen.findByRole('heading', { name: 'Call the bank' });
    const order = Array.from(card().querySelectorAll('h1, [role=status], button, input')).map((e) =>
      e.tagName === 'INPUT' ? 'Time' : e.tagName === 'H1' ? 'title' : e.getAttribute('role') === 'status' ? 'last' : (e.getAttribute('aria-label') ?? e.textContent),
    );
    expect(order).toEqual([
      'Exit',
      'title',
      'last',
      'Time',
      '+Add to this week',
      'Paint the fence',
      'Learn to bake bread',
      'One offs',
      'Other project',
      '+ New project',
      'New project from this item',
      'New practice from this item',
      'New goal from this item',
      '‹ Undo',
      'Skip',
      'Delete/done',
    ]);
    // A phone has no keyboard: no setting, and keys do nothing, Option or not.
    key('o');
    altKey('KeyO');
    expect(title()).toHaveTextContent('Call the bank');
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
      await userEvent.click(await screen.findByRole('button', { name: 'New goal from this item' }));
      await userEvent.click(within(screen.getByRole('dialog', { name: 'New goal' })).getByRole('button', { name: 'Make it a goal' }));
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
    expect(last()).toHaveTextContent('"Call the bank" is now a practice, 30m a day. It left your Inbox.');
    expect((await task(t.db, 'i1'))?.became).toMatchObject({ type: 'practice' });
    await userEvent.click(btn('‹ Undo'));
    await screen.findByRole('heading', { name: 'Call the bank' });
    expect((await task(t.db, 'i1'))?.done_at).toBeNull();
  });

  it('picks another project from a searchable sheet, then confirms', async () => {
    const t = await open({ layout: 'phone' });
    await userEvent.click(await screen.findByRole('button', { name: 'Other project' }));
    const sheet = screen.getByRole('dialog', { name: 'Send to another project' });
    expect(within(sheet).getByRole('button', { name: /Write the report/ })).toHaveTextContent('Paused');
    expect(within(sheet).getByRole('button', { name: /Plant the garden/ })).toHaveTextContent('Keep the house, Not started');
    await userEvent.type(within(sheet).getByRole('searchbox', { name: 'Search projects' }), 'zzz');
    expect(within(sheet).getByText('No project matches.')).toBeInTheDocument();
    await userEvent.clear(within(sheet).getByRole('searchbox', { name: 'Search projects' }));
    await userEvent.type(within(sheet).getByRole('searchbox', { name: 'Search projects' }), 'garden');
    await userEvent.click(within(sheet).getByRole('button', { name: /Plant the garden/ }));
    expect((await task(t.db, 'i1'))?.kind).toBe('inbox');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Send' }));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(screen.queryByRole('dialog', { name: 'Send to another project' })).toBeNull();
    expect(await task(t.db, 'i1')).toMatchObject({ kind: 'project', project_id: 'p4' });
  });
});
