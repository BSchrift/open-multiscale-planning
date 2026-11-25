import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localToInstant } from '../../../core/dates';
import { listRecords } from '../../../core/records';
import type { Writer } from '../../../core/records';
import type { Slot } from '../../../core/slots';
import { renderApp, renderInApp, renderScreen } from '../../app/testing';
import type { Layout } from '../../app/registry';
import { EST_STEPS } from '../../components/EstimateSlider';
import { slotRange } from '../../components/weekgrid';
import { Capture } from '.';
import type { FoundTask, TaskFinder } from '.';

afterEach(cleanup);

const running = { state: 'active' as const, start: '2026-10-01', end: '2027-01-31' };
async function seed(w: Writer) {
  await w.create('project', { title: 'Paint the fence', ...running }, 'p1');
  await w.create('project', { title: 'Write the report', ...running, state: 'finished' }, 'p2');
  await w.create('milestone', { project_id: 'p1', title: 'Primer on', due: '2026-11-20' }, 'm1');
  await w.create('milestone', { project_id: 'p1', title: 'Second coat', due: '2026-11-10' }, 'm2');
  await w.create('milestone', { project_id: 'p1', title: 'Sanded', due: '2026-11-01', met_at: '2026-10-30T12:00:00Z' }, 'm3');
  await w.create('milestone', { project_id: 'p1', title: 'Old plan', dropped_at: '2026-10-20T12:00:00Z' }, 'm4');
  await w.create('milestone', { project_id: 'p2', title: 'First draft', due: '2026-11-15' }, 'm5');
}

const open = (layout: Layout = 'desktop') => {
  const close = vi.fn();
  return renderScreen('capture', { layout, seed, presentation: 'overlay', close }).then(async (t) => {
    await screen.findByRole('textbox', { name: /Capture to/ });
    return { ...t, close };
  });
};
const field = () => screen.getByRole('textbox', { name: /Capture to/ });
const tasks = async (db: Parameters<typeof listRecords>[0]) => listRecords(db, 'task');

describe('Capture on desktop', () => {
  it('opens on the name with Time under it, and the other details folded away', async () => {
    await open();
    expect(screen.getByRole('dialog', { name: 'Capture' })).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: 'Capture to Inbox' })).toHaveFocus();
    expect(screen.getByRole('slider', { name: 'Time' })).toHaveAttribute('aria-valuetext', 'No estimate');
    expect(screen.getByText('Saves to Inbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add details' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('saves to the Inbox on Enter, says so, then closes', async () => {
    const t = await open();
    await userEvent.type(field(), '  Call  the bank {Enter}');
    expect(await screen.findByText('Saved to Inbox, 1 waiting')).toBeInTheDocument();
    expect(await tasks(t.db)).toMatchObject([{ kind: 'inbox', title: 'Call the bank' }]);
    expect((await tasks(t.db))[0]!.estimate_min ?? null).toBeNull();
    await waitFor(() => expect(t.close).toHaveBeenCalled(), { timeout: 2000 });
  });

  it('says what it saved through a live region that was already there, so screen readers announce it', async () => {
    await open();
    const status = within(screen.getByRole('dialog', { name: 'Capture' })).getByRole('status');
    expect(status).toBeEmptyDOMElement();
    await userEvent.type(field(), 'Call the bank{Enter}');
    await waitFor(() => expect(status).toHaveTextContent('Saved to Inbox, 1 waiting'));
    expect(status).toBeInTheDocument();
  });

  it('keeps a pasted title to a length that syncs', async () => {
    const t = await open();
    await userEvent.click(field());
    await userEvent.paste('x'.repeat(5000));
    await userEvent.keyboard('{Enter}');
    await waitFor(async () => expect((await tasks(t.db))[0]?.title).toHaveLength(2000));
  });

  it('saves nothing when empty, and Esc cancels', async () => {
    const t = await open();
    await userEvent.type(field(), '{Enter}');
    expect(await tasks(t.db)).toEqual([]);
    expect(t.close).not.toHaveBeenCalled();
    await userEvent.type(field(), 'Half a thought');
    await userEvent.keyboard('{Escape}');
    expect(t.close).toHaveBeenCalled();
    expect(await tasks(t.db)).toEqual([]);
  });

  it('keeps a time estimate set without opening the details, and Enter saves it with the task', async () => {
    const t = await open();
    fireEvent.change(screen.getByRole('slider', { name: 'Time' }), { target: { value: String(EST_STEPS.indexOf(120)) } });
    await userEvent.type(field(), 'Fix the gate{Enter}');
    await screen.findByText(/Saved to Inbox/);
    expect(await tasks(t.db)).toMatchObject([{ kind: 'inbox', title: 'Fix the gate', estimate_min: 120 }]);
  });

  it('lists the places a task can go under Add details', async () => {
    await open();
    expect(screen.queryByRole('combobox', { name: 'Send to' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    const where = screen.getByRole('combobox', { name: 'Send to' });
    expect(within(where).getAllByRole('option').map((o) => o.textContent)).toEqual(['Inbox', 'One offs', 'Paint the fence']);
  });

  it('sends straight to a project', async () => {
    const t = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'Paint the fence');
    expect(screen.getByText('Saves to Paint the fence')).toBeInTheDocument();
    await userEvent.type(field(), 'Buy brushes{Enter}');
    expect(await screen.findByText('Saved to Paint the fence')).toBeInTheDocument();
    expect(await tasks(t.db)).toMatchObject([{ kind: 'project', project_id: 'p1', title: 'Buy brushes', milestone_id: null }]);
  });

  it("offers the chosen project's open milestones, soonest first, and saves to the one picked", async () => {
    const t = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    expect(screen.queryByRole('combobox', { name: 'Milestone' })).toBeNull();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'Paint the fence');
    const milestone = await screen.findByRole('combobox', { name: 'Milestone' });
    expect(within(milestone).getAllByRole('option').map((o) => o.textContent)).toEqual(['No milestone', 'Second coat', 'Primer on']);
    await userEvent.selectOptions(milestone, 'Primer on');
    expect(screen.getByText('Saves to Paint the fence, Primer on')).toBeInTheDocument();
    await userEvent.type(field(), 'Buy brushes{Enter}');
    expect(await screen.findByText('Saved to Paint the fence, Primer on')).toBeInTheDocument();
    expect(await tasks(t.db)).toMatchObject([{ kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Buy brushes' }]);
  });

  it('forgets the milestone when the place changes', async () => {
    const t = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'Paint the fence');
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Milestone' }), 'Second coat');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'One offs');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Milestone' })).toBeNull());
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'Paint the fence');
    expect(await screen.findByRole('combobox', { name: 'Milestone' })).toHaveValue('');
    await userEvent.type(field(), 'Buy brushes{Enter}');
    await screen.findByText('Saved to Paint the fence');
    expect(await tasks(t.db)).toMatchObject([{ project_id: 'p1', milestone_id: null }]);
  });

  it("saves straight to a goal's backlog, listed after One offs, with no milestone to choose", async () => {
    const close = vi.fn();
    const t = await renderScreen('capture', {
      seed: async (w) => {
        await seed(w);
        await w.create('objective', { title: 'Learn to bake bread', state: 'active' }, 'g1');
        await w.create('objective', { title: 'Old goal', state: 'archived' }, 'g2');
        await w.create('project', { objective_id: 'g1', title: 'Learn to bake bread, Backlog', ...running }, 'backlog:g1');
      },
      presentation: 'overlay',
      close,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Add details' }));
    const to = screen.getByRole('combobox', { name: 'Send to' });
    expect(within(to).getAllByRole('option').map((o) => o.textContent)).toEqual(['Inbox', 'One offs', 'Learn to bake bread, Backlog', 'Paint the fence']);
    await userEvent.selectOptions(to, 'Learn to bake bread, Backlog');
    expect(screen.queryByRole('combobox', { name: 'Milestone' })).toBeNull();
    expect(screen.getByText('Saves to the backlog for Learn to bake bread')).toBeInTheDocument();
    await userEvent.type(field(), 'Buy a banneton{Enter}');
    expect(await screen.findByText('Saved to the backlog for Learn to bake bread')).toBeInTheDocument();
    const [task] = await tasks(t.db);
    expect(task).toMatchObject({ kind: 'project', project_id: 'backlog:g1', milestone_id: null, title: 'Buy a banneton' });
    expect(typeof task?.order).toBe('number');
  });

  it('sends straight to One offs', async () => {
    const t = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'One offs');
    await userEvent.type(field(), 'Return the books{Enter}');
    expect(await screen.findByText('Saved to One offs')).toBeInTheDocument();
    expect(await tasks(t.db)).toMatchObject([{ kind: 'one_off', title: 'Return the books', schedule: { type: 'once' } }]);
  });
});

describe('Capture on phone', () => {
  it('is a sheet with one field and Save, saving to the Inbox and closing at once', async () => {
    const t = await open('phone');
    expect(screen.getByRole('dialog', { name: 'Capture' })).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: 'Capture to Inbox' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'Paint the fence');
    expect(screen.getByRole('textbox', { name: 'Capture to Paint the fence' })).toBeInTheDocument();
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Milestone' }), 'Second coat');
    expect(screen.getByRole('textbox', { name: 'Capture to Paint the fence, Second coat' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'Inbox');
    await userEvent.type(field(), 'Call the bank');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(t.close).toHaveBeenCalled();
    expect(await tasks(t.db)).toMatchObject([{ kind: 'inbox', title: 'Call the bank' }]);
  });

  it('shows Time under the name before Add details, and Save keeps what it says', async () => {
    const t = await open('phone');
    expect(screen.getByRole('button', { name: 'Add details' })).toHaveAttribute('aria-expanded', 'false');
    const slider = screen.getByRole('slider', { name: 'Time' });
    fireEvent.change(slider, { target: { value: String(EST_STEPS.indexOf(45)) } });
    await waitFor(() => expect(slider).toHaveAttribute('aria-valuetext', '45m'));
    await userEvent.type(field(), 'Call the bank');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect(await tasks(t.db)).toMatchObject([{ kind: 'inbox', title: 'Call the bank', estimate_min: 45 }]));
  });
});

describe("Capture's details", () => {
  /** The details' controls in order, by their names. */
  const order = (dialog: HTMLElement) =>
    Array.from(dialog.querySelectorAll('input, select, textarea, [role="toolbar"]'))
      .map((e) => (e as HTMLElement).getAttribute('aria-label') ?? (e as HTMLInputElement).labels?.[0]?.textContent ?? e.tagName)
      .filter((name) => !name.startsWith('Capture to'));

  for (const layout of ['desktop', 'phone'] as const) {
    it(`open under Time with Send to, then Milestone and Description, and Time shows once (${layout})`, async () => {
      const t = await open(layout);
      expect(order(screen.getByRole('dialog', { name: 'Capture' }))).toEqual(['Time']);
      await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'Paint the fence');
      await screen.findByRole('combobox', { name: 'Milestone' });
      expect(order(screen.getByRole('dialog', { name: 'Capture' }))).toEqual(['Time', 'Send to', 'Milestone', 'Formatting', 'Description']);
      await userEvent.type(field(), 'Buy brushes');
      await userEvent.type(screen.getByRole('textbox', { name: 'Description' }), 'Two **wide** ones{Enter}and a narrow one');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(async () => expect(await tasks(t.db)).toMatchObject([{ title: 'Buy brushes', project_id: 'p1', notes: 'Two **wide** ones\nand a narrow one' }]));
    });
  }

  for (const layout of ['desktop', 'phone'] as const) {
    it(`one Tab from the name reaches Time, with the details folded or open (${layout})`, async () => {
      await open(layout);
      field().focus();
      await userEvent.tab();
      expect(screen.getByRole('slider', { name: 'Time' })).toHaveFocus();
      await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
      field().focus();
      await userEvent.tab();
      expect(screen.getByRole('slider', { name: 'Time' })).toHaveFocus();
    });
  }

  it('saves from the description with ⌘Enter, where Enter makes a new line', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const t = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    await userEvent.type(field(), 'Call the bank');
    const description = screen.getByRole('textbox', { name: 'Description' });
    await userEvent.type(description, 'Ask about{Enter}the fee');
    expect(await tasks(t.db)).toEqual([]);
    fireEvent.keyDown(description, { key: 'Enter', metaKey: true });
    await screen.findByText(/Saved to Inbox/);
    expect(await tasks(t.db)).toMatchObject([{ kind: 'inbox', title: 'Call the bank', notes: 'Ask about\nthe fee' }]);
  });

  it('leaves out an empty description', async () => {
    const t = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    await userEvent.type(field(), 'Call the bank{Enter}');
    await screen.findByText(/Saved to Inbox/);
    expect((await tasks(t.db))[0]).not.toHaveProperty('notes');
  });
});

describe('Capture in the app', () => {
  it('opens from the phone + button and lands in the Inbox count', async () => {
    await renderApp({ layout: 'phone' });
    await userEvent.click(await screen.findByRole('button', { name: 'Capture a task' }));
    expect(await screen.findByRole('slider', { name: 'Time' })).toBeVisible();
    await userEvent.type(await screen.findByRole('textbox', { name: 'Capture to Inbox' }), 'Call the bank');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('button', { name: 'Inbox, 1 to sort' })).toBeInTheDocument();
    expect(await screen.findByText('Saved to Inbox')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Capture' })).toBeNull();
  });

  it('opens from Shift+Cmd+Space on desktop', async () => {
    await renderApp();
    await screen.findByRole('navigation', { name: 'Main' });
    act(() => void fireEvent.keyDown(window, { code: 'Space', key: ' ', shiftKey: true, metaKey: true }));
    expect(await screen.findByRole('slider', { name: 'Time' })).toBeVisible();
    await userEvent.type(await screen.findByRole('textbox', { name: 'Capture to Inbox' }), 'Call the bank{Enter}');
    expect(await screen.findByText('Saved to Inbox, 1 waiting')).toBeInTheDocument();
  });
});

describe.each(['desktop', 'phone'] as const)('Capture from a hold on a calendar, on %s', (layout) => {
  const at = (minutes: number) => localToInstant('2026-11-02', minutes, 'America/Chicago');
  /** What a calendar keeps while Capture is open: the draft's time, which Capture's Time slider changes. */
  function Held(props: { close(): void; anchor?: DOMRect; finder?: TaskFinder }) {
    const [slot, setSlot] = useState<Slot>({ date: '2026-11-02', start: 17 * 60 + 45, end: 18 * 60 + 45 });
    return (
      <>
        <p data-testid="draft">{slotRange(slot)}</p>
        <Capture
          layout={layout}
          close={props.close}
          slot={{
            slot,
            overlap: 'Overlaps Team sync prep by 15m.',
            onLength: (minutes) => setSlot((s) => ({ ...s, end: s.start + minutes })),
            ...(props.anchor ? { anchor: () => props.anchor } : {}),
            ...(props.finder ? { finder: props.finder } : {}),
          }}
        />
      </>
    );
  }
  const hold = async (anchor?: DOMRect) => {
    const close = vi.fn();
    const t = await renderInApp(<Held close={close} {...(anchor ? { anchor } : {})} />, { layout, seed });
    await screen.findByRole('textbox', { name: /Capture to/ });
    return { ...t, close };
  };
  // What a calendar's finder offers: two tasks to schedule and a practice that can't go here, then, once typed, a one off.
  const todo: FoundTask[] = [
    { key: 't1', title: 'Write the report', kind: 'project', meta: 'Project · 1h', tag: 'Fits' },
    { key: 'r1', title: 'Morning run', kind: 'practice', meta: 'Practice · 30m', off: 'Already on Monday, 7am' },
    { key: 't2', title: 'Plan the offsite', kind: 'project', meta: 'Project · 2h', tag: 'Longer by 45m', quiet: true },
  ];
  const flights: FoundTask = { key: 'o1', title: 'Book flights', kind: 'one_off', meta: 'One off · 30m', tag: 'Fits' };
  const finder = (placed: boolean | Promise<boolean> = true) => {
    const place = vi.fn(() => Promise.resolve(placed));
    const f: TaskFinder = {
      find: (typed) => {
        const has = (x: FoundTask) => x.title.toLowerCase().includes(typed.toLowerCase());
        return [
          { label: 'To schedule · 1h 15m free here', tasks: todo.filter(has) },
          { label: 'One offs', tasks: typed ? [flights].filter(has) : [] },
        ].filter((g) => g.tasks.length);
      },
      place,
    };
    return { f, place };
  };
  const find = async (placed?: boolean | Promise<boolean>) => {
    const close = vi.fn();
    const { f, place } = finder(placed);
    const t = await renderInApp(<Held close={close} finder={f} />, { layout, seed });
    await screen.findByRole('combobox', { name: 'Capture to Inbox' });
    return { ...t, close, place };
  };
  const search = () => screen.getByRole('combobox', { name: 'Capture to Inbox' });
  const options = () => within(screen.getByRole('listbox', { name: 'A new task or one you have' })).getAllByRole('option');
  const lit = () => options().find((o) => o.getAttribute('aria-selected') === 'true');
  const draft = () => screen.getByTestId('draft');
  const blocks = async (db: Parameters<typeof listRecords>[0]) => listRecords(db, 'time_block');

  it('opens on the name, under a line saying the day and time and one saying what it overlaps, and saves to the Inbox', async () => {
    await hold();
    await waitFor(() => expect(field()).toHaveFocus());
    expect(field()).toHaveAccessibleName('Capture to Inbox');
    expect(screen.getByText('Today, 5:45pm to 6:45pm')).toBeVisible();
    // One run of text, so VoiceOver and the iPhone's UI tests read it as one line rather than three.
    expect(screen.getByText('Today, 5:45pm to 6:45pm').childNodes).toHaveLength(1);
    expect(screen.getByText('Overlaps Team sync prep by 15m.')).toBeVisible();
    // The drafted time already sets the length, so Time waits in Add details here.
    expect(screen.queryByRole('slider', { name: 'Time' })).toBeNull();
  });

  it('saves an Inbox item with its block at that time, its length as its time, and Undo takes both away', async () => {
    const t = await hold();
    await userEvent.type(field(), 'Book dentist{Enter}');
    expect(await screen.findByText('Saved to Inbox, 5:45pm to 6:45pm')).toBeVisible();
    expect(t.close).toHaveBeenCalled();
    const [task] = await tasks(t.db);
    expect(task).toMatchObject({ kind: 'inbox', title: 'Book dentist', estimate_min: 60 });
    expect(await blocks(t.db)).toMatchObject([{ task_id: task!.id, start: at(17 * 60 + 45), end: at(18 * 60 + 45), tz: 'America/Chicago' }]);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await tasks(t.db)).toEqual([]));
    expect(await blocks(t.db)).toEqual([]);
  });

  it('its Time slider, in Add details, starts at the draft’s length and changes it as it moves, never under 15 minutes, and saves that length', async () => {
    const t = await hold();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    expect(screen.getAllByRole('slider', { name: 'Time' })).toHaveLength(1);
    const slider = screen.getByRole('slider', { name: 'Time' });
    expect(slider).toHaveAttribute('aria-valuetext', '1h');
    fireEvent.change(slider, { target: { value: String(EST_STEPS.indexOf(90)) } });
    expect(draft()).toHaveTextContent('5:45pm to 7:15pm');
    expect(screen.getByText('Today, 5:45pm to 7:15pm')).toBeVisible();
    fireEvent.change(slider, { target: { value: '0' } });
    expect(draft()).toHaveTextContent('5:45pm to 6pm');
    await waitFor(() => expect(slider).toHaveAttribute('aria-valuetext', '15m'));
    await userEvent.type(field(), 'Book dentist{Enter}');
    await screen.findByText('Saved to Inbox, 5:45pm to 6pm');
    expect(await tasks(t.db)).toMatchObject([{ estimate_min: 15 }]);
    expect(await blocks(t.db)).toMatchObject([{ end: at(18 * 60) }]);
  });

  it('files it straight away when Send to says One offs, with its block', async () => {
    const t = await hold();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'One offs');
    await userEvent.type(field(), 'Book dentist{Enter}');
    expect(await screen.findByText('Saved to One offs, 5:45pm to 6:45pm')).toBeVisible();
    const [task] = await tasks(t.db);
    expect(task).toMatchObject({ kind: 'one_off', title: 'Book dentist' });
    expect(await blocks(t.db)).toMatchObject([{ task_id: task!.id }]);
  });

  it('closes with nothing saved on Cancel, and on Esc', async () => {
    const t = await hold();
    await userEvent.type(field(), 'Book');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(t.close).toHaveBeenCalledOnce();
    await userEvent.keyboard('{Escape}');
    expect(t.close).toHaveBeenCalledTimes(2);
    expect(await tasks(t.db)).toEqual([]);
    expect(await blocks(t.db)).toEqual([]);
  });

  describe('with a finder of tasks you have', () => {
    it('is one search field whose list starts on the new Inbox task, lit, then the tasks to schedule, best fit first', async () => {
      await find();
      await waitFor(() => expect(search()).toHaveFocus());
      expect(search()).toHaveAttribute('aria-expanded', 'true');
      expect(search()).toHaveAttribute('aria-autocomplete', 'list');
      expect(options().map((o) => o.getAttribute('aria-label'))).toEqual([
        'New Inbox task',
        'Write the report, Project · 1h, Fits',
        'Morning run, Practice · 30m, Already on Monday, 7am',
        'Plan the offsite, Project · 2h, Longer by 45m',
      ]);
      expect(lit()).toHaveAccessibleName('New Inbox task');
      expect(search()).toHaveAttribute('aria-activedescendant', lit()!.id);
      expect(screen.getByRole('group', { name: 'To schedule · 1h 15m free here' })).toBeVisible();
      expect(options()[2]).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByText('Type to search your other open tasks.')).toBeVisible();
    });

    it('names the new task as it’s typed, finds other open tasks too, and Enter on the new one saves it as before', async () => {
      const t = await find();
      await userEvent.type(search(), 'B');
      expect(lit()).toHaveAccessibleName('New Inbox task: B');
      expect(within(screen.getByRole('group', { name: 'One offs' })).getByRole('option', { name: 'Book flights, One off · 30m, Fits' })).toBeVisible();
      expect(screen.queryByRole('group', { name: /^To schedule/ })).toBeNull();
      expect(screen.getByText('1 match')).toBeInTheDocument();
      await userEvent.type(search(), 'ook dentist');
      expect(screen.getByText('No open task matches “Book dentist”.')).toBeVisible();
      await userEvent.keyboard('{Enter}');
      expect(await screen.findByText('Saved to Inbox, 5:45pm to 6:45pm')).toBeVisible();
      expect(t.place).not.toHaveBeenCalled();
      expect(await tasks(t.db)).toMatchObject([{ kind: 'inbox', title: 'Book dentist' }]);
    });

    it('the arrows pass over a task that can’t go here, and Enter places the lit one instead of making a new task', async () => {
      const t = await find();
      await userEvent.keyboard('{ArrowDown}');
      expect(lit()).toHaveAccessibleName('Write the report, Project · 1h, Fits');
      expect(search()).toHaveAttribute('aria-activedescendant', lit()!.id);
      await userEvent.keyboard('{ArrowDown}');
      expect(lit()).toHaveAccessibleName('Plan the offsite, Project · 2h, Longer by 45m');
      await userEvent.keyboard('{ArrowDown}{ArrowUp}{Enter}');
      await waitFor(() => expect(t.close).toHaveBeenCalledOnce());
      expect(t.place).toHaveBeenCalledWith('t1');
      expect(await tasks(t.db)).toEqual([]);
    });

    it('a tap or click on a task places it, and Capture comes back as it was when placing is called off', async () => {
      const t = await find(false);
      await userEvent.type(search(), 'fli');
      await userEvent.click(screen.getByRole('option', { name: /^Book flights/ }));
      expect(t.place).toHaveBeenCalledWith('o1');
      expect(await screen.findByRole('combobox', { name: 'Capture to Inbox' })).toHaveValue('fli');
      expect(t.close).not.toHaveBeenCalled();
    });

    it('stands aside while the finder asks about a block it lands on', async () => {
      let answer: (placed: boolean) => void = () => {};
      const t = await find(new Promise<boolean>((r) => (answer = r)));
      await userEvent.click(screen.getByRole('option', { name: /^Write the report/ }));
      await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Capture to Inbox' })).toBeNull());
      await act(async () => answer(true));
      expect(t.close).toHaveBeenCalledOnce();
    });

    it('Esc closes it with nothing placed or saved', async () => {
      const t = await find();
      await userEvent.type(search(), 'Writ{ArrowDown}{Escape}');
      expect(t.close).toHaveBeenCalledOnce();
      expect(t.place).not.toHaveBeenCalled();
      expect(await tasks(t.db)).toEqual([]);
    });

    it('folds the list away under Add details, which are for a new task', async () => {
      await find();
      await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
      expect(search()).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('listbox')).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Hide details' }));
      expect(search()).toHaveAttribute('aria-expanded', 'true');
    });
  });

  if (layout === 'desktop') {
    it('opens beside the draft, with no scrim, so the time chosen stays in view', async () => {
      await hold(new DOMRect(300, 200, 100, 40));
      const sheet = screen.getByRole('dialog', { name: 'Capture' });
      expect(sheet.style.left).toBe('408px');
      expect(sheet.style.top).toBe('188px');
      expect(sheet.closest('.capoverlay')).toHaveClass('beside');
    });
  }
});
