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

describe('Process on desktop', () => {
  it('shows one item at a time with live projects in added order and the rest in a selector', async () => {
    await open();
    expect(await screen.findByRole('heading', { name: 'Call the bank', level: 1 })).toHaveFocus();
    expect(within(card()).getByText('1 of 5')).toBeInTheDocument();
    const dests = within(card()).getAllByRole('button').filter((b) => b.classList.contains('pxdest'));
    expect(dests.map((b) => b.textContent)).toEqual(['1Paint the fence', '2Learn to bake bread', '+ New project', 'OOne offs']);
    const other = within(card()).getByRole('combobox', { name: 'Send to another project' });
    expect(within(other).getAllByRole('option').map((o) => o.textContent)).toEqual(['Other project', 'Write the report (Paused)', 'Plant the garden (Not started)']);
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

  it.each(['desktop', 'phone'] as const)('on %s, makes a new project from the card and sends the item to it', async (layout) => {
    const t = await open({ layout });
    await screen.findByRole('heading', { name: 'Call the bank' });
    await userEvent.click(btn('+ New project'));
    const form = screen.getByRole('form', { name: 'Add project' });
    await userEvent.type(within(form).getByLabelText('Name'), 'Fix up the shed');
    await userEvent.click(within(form).getByRole('button', { name: 'Add project' }));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(last()).toHaveTextContent('Sent to Fix up the shed.');
    const [shed] = await t.db.all<{ id: string }>("SELECT id FROM project WHERE title = 'Fix up the shed'");
    expect(await task(t.db, 'i1')).toMatchObject({ kind: 'project', project_id: shed!.id });
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

  it('sends to another project only once it is confirmed', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'Call the bank' });
    expect(within(card()).queryByRole('button', { name: 'Send' })).toBeNull();
    await userEvent.selectOptions(within(card()).getByRole('combobox', { name: 'Send to another project' }), 'Write the report (Paused)');
    expect(title()).toHaveTextContent('Call the bank');
    expect((await task(t.db, 'i1'))?.kind).toBe('inbox');
    await userEvent.click(btn('Send'));
    await screen.findByRole('heading', { name: 'Fix the gate' });
    expect(await task(t.db, 'i1')).toMatchObject({ kind: 'project', project_id: 'p3' });
    expect(last()).toHaveTextContent('Sent to Write the report.');
  });

  it('works from the keyboard', async () => {
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
});

describe('Process on phone', () => {
  it('puts title and last action on top, then Time and the week toggle, then the destinations, then Undo, Skip and Delete', async () => {
    await open({ layout: 'phone' });
    await screen.findByRole('heading', { name: 'Call the bank' });
    const order = Array.from(card().querySelectorAll('h1, [role=status], button, input')).map((e) =>
      e.tagName === 'INPUT' ? 'Time' : e.tagName === 'H1' ? 'title' : e.getAttribute('role') === 'status' ? 'last' : (e.getAttribute('aria-label') ?? e.textContent),
    );
    expect(order).toEqual(['Exit', 'title', 'last', 'Time', '+Add to this week', 'Paint the fence', 'Learn to bake bread', 'One offs', 'Other project', '+ New project', '‹ Undo', 'Skip', 'Delete/done']);
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
