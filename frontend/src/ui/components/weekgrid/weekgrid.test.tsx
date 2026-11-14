import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SlotContext } from '../../../core/slots';
import { WeekGrid } from './WeekGrid';
import type { GridBlock, WeekGridProps } from './WeekGrid';

afterEach(cleanup);

const WEEK = '2026-11-02';
const ctx = (over: Partial<SlotContext> = {}): SlotContext => ({
  week: WEEK,
  // 10pm to 7am, and 9 to 5 on weekdays.
  availability: [
    { days: 'all', from: 22 * 60, to: 7 * 60, projects: true, one_offs: true },
    { days: 'weekdays', from: 9 * 60, to: 17 * 60, projects: true, one_offs: true },
  ],
  busy: [{ date: '2026-11-03', start: 18 * 60, end: 19 * 60, id: 'e1', title: 'Quiz night' }],
  placed: [],
  avoided: [],
  earliest: { date: '2026-11-04', minutes: 14 * 60 },
  ...over,
});

const report: GridBlock = { id: 'b1', date: '2026-11-05', start: 17 * 60, end: 18 * 60, title: 'Write the report', kind: 'project' };
const piano: GridBlock = { id: 'b2', date: '2026-11-06', start: 7 * 60, end: 7 * 60 + 30, title: 'Piano practice', kind: 'practice' };
const fence: GridBlock = { id: 'b3', date: '2026-11-07', start: 10 * 60, end: 11 * 60, title: 'Paint the fence', kind: 'one_off' };

function draw(props: Partial<WeekGridProps> = {}) {
  const handlers = { onChange: vi.fn(), onRemove: vi.fn(), onOpen: vi.fn() };
  const result = render(<WeekGrid ctx={ctx()} blocks={[report, piano, fence]} {...handlers} {...props} />);
  // jsdom has no layout: each day column is 100px wide.
  for (const col of result.container.querySelectorAll('.colbody')) {
    vi.spyOn(col, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 680, top: 0, left: 0, right: 100, bottom: 680, x: 0, y: 0, toJSON: () => ({}) });
  }
  return { ...result, ...handlers };
}

const block = (name: RegExp) => screen.getByRole('group', { name });
const drag = (el: Element, from: { x: number; y: number }, to: { x: number; y: number }) => {
  fireEvent.pointerDown(el, { clientX: from.x, clientY: from.y, button: 0 });
  fireEvent.pointerMove(window, { clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(window, { clientX: to.x, clientY: to.y });
};

describe('the week grid', () => {
  it('keeps a short block to one line, so its title reads instead of being cut through', () => {
    draw({ blocks: [{ ...report, end: report.start + 120 }, { ...piano, end: piano.start + 15 }] });
    expect(screen.getByRole('button', { name: /Piano practice/ })).toHaveClass('short');
    expect(screen.getByRole('button', { name: /Write the report/ })).not.toHaveClass('short');
  });

  it('draws seven days with their free time, blocks in their colours, and calendar events behind', () => {
    const { container } = draw({ info: [{ date: '2026-11-04', start: 12 * 60, end: 13 * 60, title: 'Street fair' }] });
    const grid = screen.getByRole('group', { name: 'Week calendar' });
    expect(within(grid).getByText('Mon Nov 2')).toBeVisible();
    expect(within(grid).getByText('Sun Nov 8')).toBeVisible();
    // Weekdays are open 7 to 9 and 5 to 10, so 7h free with nothing placed.
    expect(container.querySelectorAll('.colhead .free')[3]).toHaveTextContent('7h free');
    expect(screen.getByRole('button', { name: /Write the report/ })).toHaveClass('ev-project');
    expect(screen.getByRole('button', { name: /Piano practice/ })).toHaveClass('ev-practice');
    expect(screen.getByRole('button', { name: /Paint the fence/ })).toHaveClass('ev-maint');
    expect(screen.getByText('Quiz night')).toHaveClass('ev-busy');
    expect(screen.getByText('Street fair')).toHaveClass('ev-info');
    expect(container.querySelectorAll('.colbody')[0]!.querySelectorAll('.ev-closed').length).toBeGreaterThan(0);
  });

  it('counts free time only from now on: a day gone by shows none and is never packed, and today shows its rest', () => {
    const { container } = draw({ ctx: ctx({ placed: [{ date: WEEK, start: 7 * 60, end: 22 * 60 }] }) });
    const heads = container.querySelectorAll('.colhead');
    expect(heads[0]).not.toHaveClass('tight');
    expect(heads[0]!.querySelector('.free')).toBeEmptyDOMElement();
    // Wednesday at 2pm has 5pm to 10pm left.
    expect(heads[2]!.querySelector('.free')).toHaveTextContent('5h free');
  });

  it('a block that conflicts with an event sits beside it, so both stay readable', () => {
    draw({ blocks: [{ ...report, date: '2026-11-03', clash: true, note: 'Conflicts with Quiz night' }] });
    expect(screen.getByRole('button', { name: 'Write the report, Tue Nov 3, 5pm to 6pm, Project. Conflicts with Quiz night.' })).toHaveClass('clash');
  });

  it('says what kind each block is, not only by its colour', () => {
    draw();
    expect(screen.getByRole('button', { name: 'Piano practice, Fri Nov 6, 7am to 7:30am, Practice.' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Paint the fence, Sat Nov 7, 10am to 11am, One off.' })).toBeVisible();
  });

  describe('a block gone by', () => {
    const gone = (title: string, start: number, result?: GridBlock['result']): GridBlock => ({
      id: title,
      date: '2026-11-03',
      start: start * 60,
      end: (start + 1) * 60,
      title,
      kind: 'project',
      ended: true,
      result: result ?? null,
    });
    const blocks = [gone('Write the report', 9, 'done'), gone('Read the notes', 10, 'not'), gone('Email the editor', 11, 'partly'), gone('File the receipts', 12)];

    it.each([false, true])('is struck through only when done; Partly and Not done say so in words instead, editing %s', (editing) => {
      const { container } = draw({ blocks, editing, lockPast: editing });
      const drawn = (title: string) => [...container.querySelectorAll('.ev')].find((e) => e.textContent?.endsWith(title))!;
      expect(drawn('Write the report')).toHaveClass('ended', 'done');
      expect(drawn('Read the notes')).toHaveClass('ended', 'notdone');
      expect(drawn('Read the notes')).not.toHaveClass('done');
      expect(within(drawn('Read the notes') as HTMLElement).getByText('Not done')).toBeVisible();
      expect(drawn('Email the editor')).toHaveClass('ended', 'partly');
      expect(drawn('Email the editor')).not.toHaveClass('done');
      expect(within(drawn('Email the editor') as HTMLElement).getByText('Partly')).toBeVisible();
      // One with no answer yet is only muted.
      expect(drawn('File the receipts')).toHaveClass('ended');
      expect(drawn('File the receipts')).not.toHaveClass('done');
      expect(drawn('File the receipts')).toHaveTextContent(/^File the receipts$/);
    });

    it('says how it went to a screen reader', () => {
      draw({ blocks });
      expect(screen.getByRole('button', { name: 'Write the report, Tue Nov 3, 9am to 10am, Project. Done.' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Read the notes, Tue Nov 3, 10am to 11am, Project. Not done.' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Email the editor, Tue Nov 3, 11am to 12pm, Project. Partly.' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'File the receipts, Tue Nov 3, 12pm to 1pm, Project.' })).toBeVisible();
    });
  });

  describe('the current time', () => {
    const now = { date: '2026-11-04', minutes: 14 * 60 };

    it.each([false, true])("is a line across today's column only, at the time, editing %s", (editing) => {
      const { container } = draw({ now, editing });
      const line = screen.getByRole('img', { name: 'Current time' });
      expect(container.querySelectorAll('.nowline')).toHaveLength(1);
      expect(line).toHaveClass('nowline');
      expect(container.querySelectorAll('.colbody')[2]).toContainElement(line);
      // 8 hours after 6am, at 26px an hour, or 40 while editing.
      expect(line).toHaveStyle({ top: `${8 * (editing ? 40 : 26)}px` });
    });

    it.each([false, true])('is drawn over closed time but before events, blocks and suggestions, so it passes behind them, editing %s', (editing) => {
      const draft: GridBlock = { id: 'b9', date: '2026-11-04', start: 13 * 60, end: 15 * 60, title: 'Draft the summary', kind: 'project' };
      const busy = [{ date: '2026-11-04', start: 14 * 60, end: 15 * 60, id: 'e2', title: 'Team call' }];
      const ghosts = [{ date: '2026-11-04', start: 15 * 60, end: 16 * 60, label: 'Wed Nov 4, 3pm', onAccept: vi.fn() }];
      draw({ now, editing, ctx: ctx({ busy }), blocks: [draft], ghosts });
      const line = screen.getByRole('img', { name: 'Current time' });
      const column = line.parentElement!;
      const before = (e: Element) => !!(e.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING);
      const closed = [...column.children].filter((e) => e.matches('.ev-closed'));
      const drawn = [...column.children].filter((e) => e !== line && !e.matches('.ev-closed'));
      expect(closed.length).toBeGreaterThan(0);
      expect(drawn.length).toBe(3);
      expect(closed.every(before)).toBe(true);
      expect(drawn.some(before)).toBe(false);
    });

    it.each([
      ['in another week', { date: '2026-11-11', minutes: 14 * 60 }],
      ['before 6am', { ...now, minutes: 5 * 60 + 30 }],
      ['after 11pm', { ...now, minutes: 23 * 60 + 30 }],
    ])('is not drawn %s', (_, at) => {
      const { container } = draw({ now: at });
      expect(container.querySelectorAll('.nowline')).toHaveLength(0);
    });
  });

  it('a drop whose save fails goes back to where the block was saved', async () => {
    draw({ editing: true, onChange: vi.fn(async () => undefined) });
    drag(block(/^Write the report/), { x: 50, y: 100 }, { x: 50, y: 140 });
    await waitFor(() => expect(block(/^Write the report/)).toHaveAccessibleName(/5pm to 6pm/));
  });

  it('keyboard: a block moved to another day keeps focus, so the arrows keep working', async () => {
    function Host() {
      const [blocks, setBlocks] = useState<GridBlock[]>([report, piano]);
      return <WeekGrid ctx={ctx()} blocks={blocks} editing onChange={(id, slot) => setBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, ...slot } : b)))} />;
    }
    render(<Host />);
    block(/^Write the report/).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(block(/^Write the report, Fri Nov 6/)).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(block(/^Write the report, Sat Nov 7/)).toHaveFocus();
  });

  it('a dropped block stays where it landed until the new position arrives', () => {
    const t = draw({ editing: true });
    drag(block(/^Write the report/), { x: 50, y: 100 }, { x: 50, y: 140 });
    expect(t.onChange).toHaveBeenCalledWith('b1', { date: '2026-11-05', start: 18 * 60, end: 19 * 60 });
    expect(block(/^Write the report/)).toHaveAccessibleName(/6pm to 7pm/);
  });

  it('a dropped block stays put while its caller redraws the old position, until a new one arrives', () => {
    const t = draw({ editing: true });
    drag(block(/^Write the report/), { x: 50, y: 100 }, { x: 50, y: 140 });
    const redraw = (blocks: GridBlock[]) => t.rerender(<WeekGrid ctx={ctx()} blocks={blocks} editing onChange={t.onChange} />);
    // Callers build a new list on every render, such as when the save starts, before it lands.
    redraw([{ ...report }, piano, fence]);
    expect(block(/^Write the report/)).toHaveAccessibleName(/6pm to 7pm/);
    // So the bottom edge grabbed now lengthens it where it landed, not where it was.
    drag(block(/^Write the report/).querySelector('.evh')!, { x: 50, y: 100 }, { x: 50, y: 120 });
    expect(t.onChange).toHaveBeenLastCalledWith('b1', { date: '2026-11-05', start: 18 * 60, end: 19 * 60 + 30 });
    redraw([{ ...report, start: 20 * 60, end: 21 * 60 }, piano, fence]);
    expect(block(/^Write the report/)).toHaveAccessibleName(/8pm to 9pm/);
  });

  it('opens a block on click when not editing, and drags nothing', () => {
    const t = draw();
    fireEvent.click(screen.getByRole('button', { name: /Write the report/ }));
    expect(t.onOpen).toHaveBeenCalledWith('b1');
    expect(screen.queryByRole('button', { name: 'Remove Write the report' })).toBeNull();
  });

  it('a drag moves on the 15-minute grid and saves once, on drop', () => {
    const t = draw({ editing: true });
    const el = block(/^Write the report/);
    fireEvent.pointerDown(el, { clientX: 50, clientY: 100, button: 0 });
    // 40px an hour while editing: 22px down is 33 minutes, so 30 on the grid; 100px right is a day.
    fireEvent.pointerMove(window, { clientX: 150, clientY: 122 });
    expect(t.onChange).not.toHaveBeenCalled();
    expect(block(/^Write the report/)).toHaveAccessibleName(/Fri Nov 6, 5:30pm to 6:30pm/);
    fireEvent.pointerUp(window, { clientX: 150, clientY: 122 });
    expect(t.onChange).toHaveBeenCalledTimes(1);
    expect(t.onChange).toHaveBeenCalledWith('b1', { date: '2026-11-06', start: 17 * 60 + 30, end: 18 * 60 + 30 });
  });

  it('snaps to a suggested time within 20 minutes', () => {
    const t = draw({ editing: true, ghosts: [{ date: '2026-11-05', start: 19 * 60, end: 20 * 60, label: 'Thu Nov 5, 7pm', onAccept: vi.fn() }] });
    // 100 minutes down lands on 6:45pm, 15 minutes from the suggestion.
    drag(block(/^Write the report/), { x: 50, y: 100 }, { x: 50, y: 100 + (100 * 40) / 60 });
    expect(t.onChange).toHaveBeenCalledWith('b1', { date: '2026-11-05', start: 19 * 60, end: 20 * 60 });
  });

  it('the bottom edge changes the length, keeping at least 15 minutes', () => {
    const t = draw({ editing: true });
    const edge = block(/^Write the report/).querySelector('.evh')!;
    drag(edge, { x: 50, y: 100 }, { x: 50, y: 120 });
    expect(t.onChange).toHaveBeenLastCalledWith('b1', { date: '2026-11-05', start: 17 * 60, end: 18 * 60 + 30 });
    drag(edge, { x: 50, y: 100 }, { x: 50, y: -400 });
    expect(t.onChange).toHaveBeenLastCalledWith('b1', { date: '2026-11-05', start: 17 * 60, end: 17 * 60 + 15 });
  });

  it('a 15-minute block has no edge to drag, so a press anywhere on it moves it; a 30-minute one keeps its edge', () => {
    const t = draw({ editing: true, blocks: [{ ...piano, end: piano.start + 15 }] });
    const el = block(/^Piano practice/);
    expect(el.querySelector('.evh')).toBeNull();
    // 20px is half an hour at 40px an hour: start and end both move.
    drag(el, { x: 50, y: 100 }, { x: 50, y: 120 });
    expect(t.onChange).toHaveBeenCalledWith('b2', { date: '2026-11-06', start: 7 * 60 + 30, end: 7 * 60 + 45 });
    cleanup();
    draw({ editing: true });
    expect(block(/^Piano practice/).querySelector('.evh')).not.toBeNull();
  });

  it('a press that does not move opens the block', () => {
    const t = draw({ editing: true });
    drag(block(/^Write the report/), { x: 50, y: 100 }, { x: 52, y: 103 });
    expect(t.onChange).not.toHaveBeenCalled();
    expect(t.onOpen).toHaveBeenCalledWith('b1');
  });

  it('keyboard: arrows move by 15 minutes or a day, Shift and arrows change the length, Enter opens', async () => {
    const t = draw({ editing: true });
    block(/^Write the report/).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(t.onChange).toHaveBeenLastCalledWith('b1', { date: '2026-11-05', start: 17 * 60 + 15, end: 18 * 60 + 15 });
    await userEvent.keyboard('{ArrowRight}');
    expect(t.onChange).toHaveBeenLastCalledWith('b1', { date: '2026-11-06', start: 17 * 60, end: 18 * 60 });
    await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(t.onChange).toHaveBeenLastCalledWith('b1', { date: '2026-11-05', start: 17 * 60, end: 18 * 60 + 15 });
    await userEvent.keyboard('{Enter}');
    expect(t.onOpen).toHaveBeenCalledWith('b1');
  });

  it('× removes a block', async () => {
    const t = draw({ editing: true });
    await userEvent.click(screen.getByRole('button', { name: 'Remove Write the report' }));
    expect(t.onRemove).toHaveBeenCalledWith('b1');
    expect(t.onOpen).not.toHaveBeenCalled();
  });

  it('keyboard on ×: Enter removes the block, and arrows leave it where it is', async () => {
    const t = draw({ editing: true });
    screen.getByRole('button', { name: 'Remove Write the report' }).focus();
    await userEvent.keyboard('{ArrowDown}{ArrowRight}');
    expect(t.onChange).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    expect(t.onRemove).toHaveBeenCalledWith('b1');
    expect(t.onOpen).not.toHaveBeenCalled();
  });

  it('with the past locked, time gone is grey, its blocks are fixed, and nothing moves into it', async () => {
    const past: GridBlock = { id: 'b0', date: '2026-11-03', start: 17 * 60, end: 18 * 60, title: 'Read a chapter', kind: 'project' };
    const t = draw({ editing: true, lockPast: true, blocks: [past, report] });
    expect(screen.queryByRole('group', { name: /^Read a chapter/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Read a chapter' })).toBeNull();
    expect(t.container.querySelectorAll('.colbody')[1]!.querySelector('.ev-closed')).toHaveStyle({ top: '0px' });
    // Thursday 5pm, three days left is Monday: in the past.
    drag(block(/^Write the report/), { x: 50, y: 100 }, { x: -250, y: 100 });
    expect(t.onChange).not.toHaveBeenCalled();
  });

  it('a suggested time is a button that takes the block there', async () => {
    const accept = vi.fn();
    draw({ editing: true, ghosts: [{ date: '2026-11-07', start: 9 * 60, end: 10 * 60, label: 'Sat Nov 7, 9am', onAccept: accept }] });
    await userEvent.click(screen.getByRole('button', { name: 'Use suggested time, Sat Nov 7, 9am' }));
    expect(accept).toHaveBeenCalled();
  });

  it('one offs waiting for a time sit in a row above the days they span', async () => {
    const toggle = vi.fn();
    draw({ lane: [{ id: 'o1', title: 'Renew the passport', from: '2026-11-04', to: '2026-11-06', alt: 'One off: Renew the passport, Nov 4 to Nov 6', open: false, onToggle: toggle }] });
    const chip = screen.getByRole('button', { name: 'One off: Renew the passport, Nov 4 to Nov 6' });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(chip.style.width).toBe('calc(300% + 4px)');
    await userEvent.click(chip);
    expect(toggle).toHaveBeenCalled();
  });
});
