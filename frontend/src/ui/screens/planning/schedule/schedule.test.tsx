import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { localToInstant } from '../../../../core/dates';
import { getRecord, listRecords, setWeekPick, weekPickId } from '../../../../core/records';
import type { Writer } from '../../../../core/records';
import { openPlanning } from '../testing';
import type { HarnessOptions } from '../../../app/testing';

afterEach(cleanup);

// The harness clock reads Monday, Nov 2 at 2pm in Chicago, and the default hours close 10pm to 7am.
const WEEK = '2026-11-02';
const ZONE = 'America/Chicago';
const at = (date: string, h: number, m = 0) => localToInstant(date, h * 60 + m, ZONE);

async function picked(w: Writer) {
  await w.create('project', { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-15' }, 'report');
  await w.create('milestone', { project_id: 'report', title: 'Gather notes', due: '2026-10-18' }, 'm1');
  await w.create('milestone', { project_id: 'report', title: 'Draft chapters', due: '2026-11-09' }, 'm2');
  await w.create('task', { kind: 'project', project_id: 'report', milestone_id: 'm1', title: 'Collect the sources', estimate_min: 120 }, 't1');
  await w.create('task', { kind: 'project', project_id: 'report', milestone_id: 'm2', title: 'Write chapter one', estimate_min: 240 }, 't2');
  await w.create('task', { kind: 'one_off', title: 'Paint the fence', estimate_min: 90, schedule: { type: 'once', from: '2026-11-04' } }, 'o1');
  await setWeekPick(w, WEEK, 't1', 120);
  await setWeekPick(w, WEEK, 't2', 240);
  await setWeekPick(w, WEEK, 'o1', 90);
}

const stretch = (w: Writer) =>
  w.create('practice', { title: 'Morning stretch', target_min: 30, per: 'day', days: [1, 2], preferred_times: [7 * 60], state: 'active' }, 'pr');

const open = (options: HarnessOptions & { seed?(w: Writer): Promise<unknown> } = {}) =>
  openPlanning({ step: 2, zone: ZONE, ...options, seed: options.seed ?? picked });

const blocks = async (t: { db: Parameters<typeof listRecords>[0] }, task: string) =>
  (await listRecords(t.db, 'time_block')).filter((b) => b.task_id === task && !b.deleted_at && !b.cancelled).map((b) => [b.start, b.end]);
const row = (title: string) => screen.getByText(title, { selector: '.subline' }).closest('li')!;
/** On desktop, the task or practice being placed, pinned at the top of the list. */
const now = () => screen.getByRole('region', { name: 'Now' });

describe('Schedule on desktop', () => {
  it('lists the picked tasks in order, one at a time, with its block at its best time and other suggestions', async () => {
    await open();
    expect(await screen.findByText('0 of 3 placed')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Tasks' });
    expect([...list.querySelectorAll('.schedbtn')].map((b) => b.textContent)).toEqual(['▸Collect the sources', '2Write chapter one', '3Paint the fence']);
    expect(within(list).getByRole('button', { name: /^Collect the sources/ })).toHaveAttribute('aria-current', 'step');
    expect(row('Paint the fence')).toHaveClass('is-maint');
    const cur = now();
    expect(within(cur).getByRole('heading', { name: 'Collect the sources' })).toBeInTheDocument();
    expect(within(cur).getByText('Write the report, Gather notes, overdue since Oct 18')).toBeInTheDocument();
    expect(within(cur).getByText('Mon Nov 2, 2pm to 4pm (2h)')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /^Collect the sources, Mon Nov 2, 2pm to 4pm, Project\. .*Enter places it\.$/ })).toHaveClass('evdraft');
    expect(screen.getAllByRole('button', { name: /^Use suggested time/ }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Use suggested time, Tue Nov 3, 7am',
      'Use suggested time, Wed Nov 4, 7am',
      'Use suggested time, Thu Nov 5, 7am',
      'Use suggested time, Fri Nov 6, 7am',
    ]);
  });

  it("marks the current time across today's column only", async () => {
    await open();
    const line = await screen.findByRole('img', { name: 'Current time' });
    expect(document.querySelectorAll('.nowline')).toHaveLength(1);
    expect(document.querySelectorAll('.colbody')[0]).toContainElement(line);
    // 2pm is 8 hours after 6am, at 40px an hour.
    expect(line).toHaveStyle({ top: `${8 * 40}px` });
  });

  it('Place here puts the block on the week; a shorter block keeps the task current, and a placed task is ticked', async () => {
    const t = await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Place here' }));
    await waitFor(async () => expect(await blocks(t, 't1')).toEqual([[at(WEEK, 14), at(WEEK, 16)]]));
    expect(await screen.findByText('1 of 3 placed')).toBeInTheDocument();
    expect(row('Collect the sources').querySelector('.schedmark')).toHaveTextContent('✓');
    expect(within(row('Collect the sources')).getByText('Mon 2pm')).toBeInTheDocument();

    const next = now();
    expect(within(next).getByRole('heading', { name: 'Write chapter one' })).toBeInTheDocument();
    expect(within(next).getByText('Mon Nov 2, 5pm to 7pm (2h)')).toBeInTheDocument();
    expect(within(next).getByText('2h more of this task stays to place')).toBeInTheDocument();
    expect(within(next).getByRole('button', { name: 'Skip for now' })).toBeInTheDocument();
    await userEvent.click(within(next).getByRole('button', { name: 'Place here' }));
    expect(await within(now()).findByRole('button', { name: 'Leave the rest for later' })).toBeInTheDocument();
    expect(screen.getByText('1 of 3 placed')).toBeInTheDocument();
    expect(await blocks(t, 't2')).toHaveLength(1);
  });

  it('a suggested time moves the block, arrow keys move it, and a spot outside open hours gets a note', async () => {
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Use suggested time, Tue Nov 3, 7am' }));
    const cur = now();
    expect(within(cur).getByText('Tue Nov 3, 7am to 9am (2h)')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('group', { name: /^Collect the sources, Tue Nov 3/ }), { key: 'ArrowUp' });
    expect(within(cur).getByText('Tue Nov 3, 6:45am to 8:45am (2h)')).toBeInTheDocument();
    expect(within(cur).getByText("That's outside your available hours.")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('group', { name: /^Collect the sources, Tue Nov 3/ }), { key: 'ArrowDown', shiftKey: true });
    expect(within(cur).getByText('Tue Nov 3, 6:45am to 9am (2h 15m)')).toBeInTheDocument();
    expect(within(cur).getByText('15m over your estimate')).toBeInTheDocument();
  });

  it('Skip for now moves on and marks it Skipped; clicking it brings it back', async () => {
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Skip for now' }));
    expect(within(row('Collect the sources')).getByText('Skipped')).toBeInTheDocument();
    expect(row('Collect the sources').querySelector('.schedmark')).toHaveTextContent('–');
    expect(screen.getByRole('button', { name: /^Write chapter one/ })).toHaveAttribute('aria-current', 'step');
    await userEvent.click(screen.getByRole('button', { name: /^Collect the sources/ }));
    expect(within(now()).getByRole('heading', { name: 'Collect the sources' })).toBeInTheDocument();
    expect(within(now()).getByRole('button', { name: 'Place here' })).toBeInTheDocument();
  });

  it('keeps keyboard focus at the top, on the next task under Now, after Place here, Skip for now, Enter on the block and Done', async () => {
    await open();
    (await screen.findByRole('button', { name: 'Place here' })).focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('1 of 3 placed')).toBeInTheDocument();
    await waitFor(() => expect(within(now()).getByRole('heading', { name: 'Write chapter one' })).toHaveFocus());

    within(now()).getByRole('button', { name: 'Skip for now' }).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(within(now()).getByRole('heading', { name: 'Paint the fence' })).toHaveFocus());

    screen.getByRole('group', { name: /^Paint the fence, .*Enter places it\.$/ }).focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('2 of 3 placed')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'All tasks are placed' })).toHaveFocus());

    await userEvent.click(screen.getByRole('button', { name: /^Collect the sources/ }));
    within(now()).getByRole('button', { name: 'Done' }).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'All tasks are placed' })).toHaveFocus());
  });

  it('a placed task opens its block, with Done, and Remove from calendar that offers Undo', async () => {
    const t = await open({
      seed: async (w) => {
        await picked(w);
        await w.create('time_block', { task_id: 't1', start: at('2026-11-03', 18), end: at('2026-11-03', 20), tz: ZONE }, 'b1');
      },
    });
    expect(await screen.findByText('1 of 3 placed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Collect the sources/ }));
    const cur = now();
    expect(within(cur).getByText('Tue Nov 3, 6pm to 8pm (2h)')).toBeInTheDocument();
    expect(within(cur).getByRole('button', { name: 'Done' })).toBeInTheDocument();
    await userEvent.click(within(cur).getByRole('button', { name: 'Remove from calendar' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBe(true));
    expect(await within(now()).findByRole('button', { name: 'Place here' })).toBeInTheDocument();
    expect(screen.getByText('Removed Collect the sources')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBeFalsy());
  });

  it('Place the rest at suggested times places everything left, and Undo takes it all back', async () => {
    const t = await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Place the rest at suggested times' }));
    expect(await screen.findByText('3 of 3 placed')).toBeInTheDocument();
    expect(await blocks(t, 't1')).toHaveLength(1);
    expect(await blocks(t, 't2')).toHaveLength(2);
    expect(await blocks(t, 'o1')).toEqual([[at('2026-11-04', 17), at('2026-11-04', 18, 30)]]);
    expect(screen.getByRole('heading', { name: 'All tasks are placed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue to review' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Place the rest at suggested times' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('0 of 3 placed')).toBeInTheDocument();
    expect(await blocks(t, 't2')).toEqual([]);
  });

  it('puts practices first, in a list of their own, and places them one at a time on their days at their usual time', async () => {
    const t = await open({ seed: async (w) => (await picked(w), stretch(w)) });
    const sessions = async () => (await listRecords(t.db, 'time_block')).filter((b) => b.practice_id === 'pr' && !b.deleted_at).map((b) => b.start);
    expect(await screen.findByText('0 of 4 placed')).toBeInTheDocument();
    expect(await sessions()).toEqual([]);
    const practices = screen.getByRole('list', { name: 'Practices' });
    const tasks = screen.getByRole('list', { name: 'Tasks' });
    expect(practices.compareDocumentPosition(tasks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...practices.querySelectorAll('.schedbtn')].map((b) => b.textContent)).toEqual(['▸Morning stretch']);
    expect([...tasks.querySelectorAll('.schedbtn')].map((b) => b.textContent)).toEqual(['1Collect the sources', '2Write chapter one', '3Paint the fence']);
    // Drawn as Week draws a practice: teal, with a double edge, not by colour alone.
    expect(row('Morning stretch')).toHaveClass('is-practice');
    // Practices are up first, so the first one is being placed without a click.
    const cur = now();
    expect(within(cur).getByRole('heading', { name: 'Morning stretch' })).toBeInTheDocument();
    expect(within(cur).getByText('Practice, 30m on Tue and Wed, around 7am')).toBeInTheDocument();
    expect(within(cur).getByText('Tue Nov 3, 7am to 7:30am (30m)')).toBeInTheDocument();
    expect(within(cur).getByText('Also this week: Wed 7am.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Use suggested time/ }).map((b) => b.getAttribute('aria-label'))).toEqual(['Use suggested time, Wed Nov 4, 7am']);
    await userEvent.click(within(cur).getByRole('button', { name: 'Place here' }));
    await waitFor(async () => expect(await sessions()).toEqual([at('2026-11-03', 7)]));
    expect(await within(now()).findByText('Wed Nov 4, 7am to 7:30am (30m)')).toBeInTheDocument();
    // Waiting while another is placed, a practice's row keeps its own mark rather than a number.
    await userEvent.click(screen.getByRole('button', { name: /^Collect the sources/ }));
    expect(row('Morning stretch').querySelector('.schedmark')).toHaveTextContent('↻');
    // A practice is skipped from its own list below, so its row has no Remove from this week.
    expect(screen.queryByRole('button', { name: 'Remove Morning stretch from this week' })).toBeNull();
  });

  it('a practice can be skipped this week, which takes its sessions off, and included again with nothing placed', async () => {
    const t = await open({
      seed: async (w) => {
        await picked(w);
        await stretch(w);
        await w.create('time_block', { practice_id: 'pr', start: at('2026-11-03', 7), end: at('2026-11-03', 7, 30), tz: ZONE }, 's1');
      },
    });
    const sessions = async () => (await listRecords(t.db, 'time_block')).filter((b) => b.practice_id === 'pr' && !b.deleted_at);
    const toggle = await screen.findByRole('button', { name: 'Skip a practice this week' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(await screen.findByText('1 session, 30m')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Skip this week, Morning stretch' }));
    expect(await screen.findByText('Skipped this week')).toBeInTheDocument();
    expect(await sessions()).toEqual([]);
    expect(screen.queryByText('Morning stretch', { selector: '.subline' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Include this week, Morning stretch' }));
    expect(await screen.findByText('0 sessions, 0m')).toBeInTheDocument();
    expect(await sessions()).toEqual([]);
    expect(row('Morning stretch')).toBeInTheDocument();
  });

  it('Place the rest places the practices too, and Undo takes them back', async () => {
    const t = await open({ seed: async (w) => (await picked(w), stretch(w)) });
    const sessions = async () => (await listRecords(t.db, 'time_block')).filter((b) => b.practice_id === 'pr' && !b.deleted_at).map((b) => b.start).sort();
    await userEvent.click(await screen.findByRole('button', { name: 'Place the rest at suggested times' }));
    expect(await screen.findByText('4 of 4 placed')).toBeInTheDocument();
    expect(await sessions()).toHaveLength(2);
    expect(screen.getByText('Placed 6 blocks')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('0 of 4 placed')).toBeInTheDocument();
    expect(await sessions()).toEqual([]);
  });

  it("Place the rest puts each session at its own day's time, and one Undo takes them all off", async () => {
    const t = await open({ seed: async (w) => (await picked(w), await stretch(w), w.set('practice', 'pr', { day_times: [null, null, 9 * 60, null, null, null, null] })) });
    const sessions = async () => (await listRecords(t.db, 'time_block')).filter((b) => b.practice_id === 'pr' && !b.deleted_at).map((b) => b.start).sort();
    await userEvent.click(await screen.findByRole('button', { name: 'Place the rest at suggested times' }));
    expect(await screen.findByText('4 of 4 placed')).toBeInTheDocument();
    expect(await sessions()).toEqual([at('2026-11-03', 7), at('2026-11-04', 9)]);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await sessions()).toEqual([]));
  });

  it('moving a practice session asks whether to keep its time, and Yes on Tuesdays changes only that day', async () => {
    const t = await open({
      seed: async (w) => {
        await picked(w);
        await stretch(w);
        await w.create('time_block', { practice_id: 'pr', start: at('2026-11-03', 7), end: at('2026-11-03', 7, 30), tz: ZONE }, 's1');
        await w.create('time_block', { practice_id: 'pr', start: at('2026-11-04', 7), end: at('2026-11-04', 7, 30), tz: ZONE }, 's2');
      },
    });
    const session = await screen.findByRole('group', { name: /^Morning stretch, Tue Nov 3, 7am to 7:30am, Practice\./ });
    fireEvent.keyDown(session, { key: 'ArrowDown' });
    const ask = await screen.findByRole('group', { name: 'Use 7:15am in future weeks too?' });
    expect(ask).toHaveAccessibleDescription('Morning stretch moved to Tue 7:15am.');
    // Moving a block leaves the task being placed as it was.
    expect(screen.getByRole('button', { name: /^Collect the sources/ })).toHaveAttribute('aria-current', 'step');
    expect(within(ask).getAllByRole('button').map((b) => b.textContent)).toEqual(['No, just this week', 'Yes, on Tuesdays', 'Yes, on Tuesdays and Wednesdays']);
    await userEvent.click(within(ask).getByRole('button', { name: 'Yes, on Tuesdays' }));
    await waitFor(async () => expect((await getRecord(t.db, 'practice', 'pr'))?.day_times).toEqual([null, 7 * 60 + 15, null, null, null, null, null]));
    expect((await getRecord(t.db, 'practice', 'pr'))?.preferred_times).toEqual([7 * 60]);
    expect(await screen.findByText('Morning stretch is now 7:15am on Tuesdays.')).toBeInTheDocument();
    expect((await getRecord(t.db, 'time_block', 's2'))?.start).toBe(at('2026-11-04', 7));
    expect(screen.queryByRole('group', { name: 'Use 7:15am in future weeks too?' })).toBeNull();
  });

  it('Place here over a placed block takes it off to place again, says so first, and Undo puts it all back', async () => {
    const t = await open({
      seed: async (w) => {
        await picked(w);
        await w.create('time_block', { task_id: 'o1', start: at('2026-11-03', 15), end: at('2026-11-03', 16, 30), tz: ZONE }, 'b1');
      },
    });
    expect(await screen.findByText('1 of 3 placed')).toBeInTheDocument();
    const under = () => screen.getByRole('group', { name: /^Paint the fence, Tue Nov 3, 3pm to 4:30pm, One off\./ });
    const was = under().getAttribute('style');
    fireEvent.keyDown(screen.getByRole('group', { name: /^Collect the sources, Mon Nov 2, 2pm to 4pm/ }), { key: 'ArrowRight' });
    const cur = now();
    expect(within(cur).getByText('Tue Nov 3, 2pm to 4pm (2h)')).toBeInTheDocument();
    expect(within(cur).getByText('Placing here takes Paint the fence off the calendar to place again.')).toBeInTheDocument();
    expect(within(cur).queryByText('That overlaps Paint the fence.')).toBeNull();
    // The draft sits beside the block, which keeps its place and size.
    expect(screen.getByRole('group', { name: /^Collect the sources, Tue Nov 3, 2pm to 4pm, Project\. Being placed\./ })).toHaveClass('evdraft', 'beside');
    expect(under().getAttribute('style')).toBe(was);

    await userEvent.click(within(cur).getByRole('button', { name: 'Place here' }));
    await waitFor(async () => expect(await blocks(t, 't1')).toEqual([[at('2026-11-03', 14), at('2026-11-03', 16)]]));
    expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBe(true);
    expect(await screen.findByText('Took Paint the fence off the calendar to place again')).toBeInTheDocument();
    expect(row('Paint the fence').querySelector('.schedmark')).toHaveTextContent('3');
    expect(screen.getByText('1 of 3 placed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBeFalsy());
    expect(await blocks(t, 't1')).toEqual([]);
    expect(await within(row('Paint the fence')).findByText('Tue 3pm')).toBeInTheDocument();
  });

  it('a block under way stays where it is under the draft, and Place here leaves it', async () => {
    const t = await open({
      seed: async (w) => {
        await picked(w);
        await w.create('time_block', { task_id: 't2', start: at(WEEK, 13, 30), end: at(WEEK, 14, 30), tz: ZONE }, 'b2');
      },
    });
    fireEvent.keyDown(await screen.findByRole('group', { name: /^Collect the sources, Mon Nov 2, 2:30pm to 4:30pm/ }), { key: 'ArrowUp' });
    const cur = now();
    expect(within(cur).getByText('Mon Nov 2, 2:15pm to 4:15pm (2h)')).toBeInTheDocument();
    expect(within(cur).getByText('That overlaps Write chapter one.')).toBeInTheDocument();
    expect(within(cur).queryByText(/^Placing here takes/)).toBeNull();
    await userEvent.click(within(cur).getByRole('button', { name: 'Place here' }));
    await waitFor(async () => expect(await blocks(t, 't1')).toEqual([[at(WEEK, 14, 15), at(WEEK, 16, 15)]]));
    expect(await blocks(t, 't2')).toEqual([[at(WEEK, 13, 30), at(WEEK, 14, 30)]]);
  });

  it('dragging a placed block only moves it; a click selects it', async () => {
    const t = await open({
      seed: async (w) => {
        await picked(w);
        await w.create('time_block', { task_id: 'o1', start: at('2026-11-03', 15), end: at('2026-11-03', 16, 30), tz: ZONE }, 'b1');
      },
    });
    const placed = await screen.findByRole('group', { name: /^Paint the fence, Tue Nov 3, 3pm to 4:30pm/ });
    // 40px is an hour.
    fireEvent.pointerDown(placed, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 100, clientY: 140 });
    fireEvent.pointerUp(window, { clientX: 100, clientY: 140 });
    await waitFor(async () => expect(await blocks(t, 'o1')).toEqual([[at('2026-11-03', 16), at('2026-11-03', 17, 30)]]));
    expect(screen.getByRole('button', { name: /^Collect the sources/ })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('group', { name: /^Collect the sources, Mon Nov 2, 2pm to 4pm, .*Enter places it\.$/ })).toHaveClass('evdraft');
    expect(screen.queryByRole('button', { name: 'Remove from calendar' })).toBeNull();

    const moved = screen.getByRole('group', { name: /^Paint the fence, Tue Nov 3, 4pm to 5:30pm/ });
    fireEvent.pointerDown(moved, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerUp(window, { clientX: 100, clientY: 100 });
    expect(await within(now()).findByRole('button', { name: 'Remove from calendar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Paint the fence/ })).toHaveAttribute('aria-current', 'step');
  });

  it('switching to another task or block never places the one waiting', async () => {
    const t = await open({
      seed: async (w) => {
        await picked(w);
        await w.create('time_block', { task_id: 'o1', start: at('2026-11-03', 15), end: at('2026-11-03', 16, 30), tz: ZONE }, 'b1');
      },
    });
    fireEvent.keyDown(await screen.findByRole('group', { name: /^Collect the sources, Mon Nov 2, 2pm to 4pm/ }), { key: 'ArrowDown' });
    expect(within(now()).getByText('Mon Nov 2, 2:15pm to 4:15pm (2h)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Write chapter one/ }));
    expect(screen.getByRole('button', { name: /^Write chapter one/ })).toHaveAttribute('aria-current', 'step');
    const placed = screen.getByRole('group', { name: /^Paint the fence, Tue Nov 3, 3pm to 4:30pm/ });
    fireEvent.pointerDown(placed, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerUp(window, { clientX: 100, clientY: 100 });
    expect(await within(now()).findByRole('button', { name: 'Remove from calendar' })).toBeInTheDocument();
    expect(await blocks(t, 't1')).toEqual([]);
    expect(await blocks(t, 't2')).toEqual([]);
    expect(screen.getByText('1 of 3 placed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Collect the sources/ }));
    expect(within(now()).getByRole('button', { name: 'Place here' })).toBeInTheDocument();
  });

  it("counts what's left to place as Week's To schedule does: a block running into next week counts only its hour in this one", async () => {
    await open({
      seed: async (w) => {
        await picked(w);
        await w.create('time_block', { task_id: 't2', start: at('2026-11-08', 23), end: at('2026-11-09', 1), tz: ZONE });
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: /^Write chapter one/ }));
    // 4h picked, less the hour this week: 3h, so a 2h block leaves 1h to place, as Week shows "3h of 4h left".
    expect(within(now()).getByText('1h more of this task stays to place')).toBeInTheDocument();
  });

  it('pins the task being placed at the top under Now; the list below keeps its order, and a clicked row keeps focus', async () => {
    await open();
    const tasks = await screen.findByRole('list', { name: 'Tasks' });
    expect(now().compareDocumentPosition(tasks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const order = () => [...tasks.querySelectorAll('.schedbtn')].map((b) => b.textContent);
    expect(order()).toEqual(['▸Collect the sources', '2Write chapter one', '3Paint the fence']);
    const fence = screen.getByRole('button', { name: /^Paint the fence/ });
    await userEvent.click(fence);
    expect(within(now()).getByRole('heading', { name: 'Paint the fence' })).toBeInTheDocument();
    expect(within(now()).getByRole('button', { name: 'Place here' })).toBeInTheDocument();
    // Nothing in the list moved, so the row clicked is still there, with focus.
    expect(order()).toEqual(['1Collect the sources', '2Write chapter one', '▸Paint the fence']);
    expect(fence).toBeInTheDocument();
    expect(fence).toHaveFocus();
    expect(fence).toHaveAttribute('aria-current', 'step');
  });

  it("Remove from this week asks first, and Cancel or Esc leaves the task in this week's plan, with focus back on the action", async () => {
    const t = await open();
    const action = await screen.findByRole('button', { name: 'Remove Write chapter one from this week' });
    await userEvent.click(action);
    const ask = screen.getByRole('dialog', { name: 'Remove Write chapter one from this week' });
    expect(ask).toHaveTextContent("Remove Write chapter one from this week's plan? It stays in its project.");
    expect(within(ask).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(action).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(within(screen.getByRole('dialog', { name: 'Remove Write chapter one from this week' })).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(action).toHaveFocus();
    expect((await getRecord(t.db, 'week_pick', weekPickId(WEEK, 't2')))?.deleted_at).toBeFalsy();
    expect(row('Write chapter one')).toBeInTheDocument();
  });

  it('Remove takes the pick and its blocks still to come out of this week, not the task, and Undo puts them all back', async () => {
    const t = await open({
      seed: async (w) => {
        await picked(w);
        // This morning's hour has been and gone, so it stays.
        await w.create('time_block', { task_id: 't2', start: at(WEEK, 9), end: at(WEEK, 10), tz: ZONE }, 'gone');
        await w.create('time_block', { task_id: 't2', start: at('2026-11-03', 9), end: at('2026-11-03', 11), tz: ZONE }, 'b2');
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Write chapter one from this week' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Remove Write chapter one from this week' })).getByRole('button', { name: 'Remove' }));
    await waitFor(async () => expect((await getRecord(t.db, 'week_pick', weekPickId(WEEK, 't2')))?.deleted_at).toBeTruthy());
    expect((await getRecord(t.db, 'time_block', 'b2'))?.cancelled).toBe(true);
    expect((await getRecord(t.db, 'time_block', 'gone'))?.cancelled).toBeFalsy();
    const task = await getRecord(t.db, 'task', 't2');
    expect([task?.deleted_at, task?.done_at, task?.cancelled_at].map(Boolean)).toEqual([false, false, false]);
    expect(screen.queryByText('Write chapter one', { selector: '.subline' })).toBeNull();
    expect(await screen.findByText('Removed Write chapter one from this week, and took its block off the calendar.')).toBeInTheDocument();
    // What was pressed has gone, so focus goes to Undo.
    const undo = screen.getByRole('button', { name: 'Undo' });
    expect(undo).toHaveFocus();
    await userEvent.click(undo);
    await waitFor(async () => expect((await getRecord(t.db, 'week_pick', weekPickId(WEEK, 't2')))?.deleted_at).toBeFalsy());
    expect((await getRecord(t.db, 'week_pick', weekPickId(WEEK, 't2')))?.minutes).toBe(240);
    expect((await getRecord(t.db, 'time_block', 'b2'))?.cancelled).toBeFalsy();
    expect(await screen.findByText('Write chapter one', { selector: '.subline' })).toBeInTheDocument();
  });

  it('removing the task being placed moves on to the next, and a one off stays in One offs', async () => {
    const t = await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Collect the sources from this week' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Removed Collect the sources from this week.')).toBeInTheDocument();
    expect(within(now()).getByRole('heading', { name: 'Write chapter one' })).toBeInTheDocument();
    expect(screen.getByText('0 of 2 placed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove Paint the fence from this week' }));
    expect(screen.getByRole('dialog', { name: 'Remove Paint the fence from this week' })).toHaveTextContent(
      "Remove Paint the fence from this week's plan? It stays in One offs.",
    );
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(async () => expect((await getRecord(t.db, 'week_pick', weekPickId(WEEK, 'o1')))?.deleted_at).toBeTruthy());
    expect((await getRecord(t.db, 'task', 'o1'))?.deleted_at).toBeFalsy();
  });

  it('with nothing picked, says so and moves on to Review', async () => {
    await open({ seed: async () => undefined });
    expect(await screen.findByRole('heading', { name: 'Nothing is picked yet' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue to review' }));
    expect(await screen.findByRole('button', { name: 'Finish plan' })).toBeInTheDocument();
  });
});

describe('Schedule on phone', () => {
  const phone = (options: Parameters<typeof open>[0] = {}) => open({ layout: 'phone', ...options });

  it('compares days in the strip, shows the current task in the dock, and places it', async () => {
    const t = await phone();
    const strip = await screen.findByRole('group', { name: 'Compare days' });
    expect(within(strip).getByRole('button', { name: /^Mon Nov 2, .* free, suggested 2pm$/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(strip).getByRole('button', { name: /^Tue Nov 3, .* free, suggested 7am$/ })).toHaveTextContent('7am');
    expect(screen.getByRole('button', { name: 'All picked tasks, 0 of 3 placed' })).toBeInTheDocument();
    expect(screen.getByText('Collect the sources', { selector: '.strong' })).toBeInTheDocument();
    expect(screen.getByText('Mon Nov 2, 2pm to 4pm (2h)')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Mon Nov 2' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: /^Time for Collect the sources/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Place here' }));
    await waitFor(async () => expect(await blocks(t, 't1')).toEqual([[at(WEEK, 14), at(WEEK, 16)]]));
    expect(await screen.findByRole('button', { name: 'All picked tasks, 1 of 3 placed' })).toBeInTheDocument();
  });

  it('marks the current time on today', async () => {
    await phone();
    const line = await screen.findByRole('img', { name: 'Current time' });
    expect(line.closest('.dragday')).not.toBeNull();
    // 8 hours after 6am, at 48px an hour.
    expect(line).toHaveStyle({ top: `${8 * 48}px` });
  });

  it('says a day looked at is packed, as on Week', async () => {
    await phone({
      seed: async (w) => {
        await picked(w);
        await w.create('time_block', { task_id: 't2', start: at(WEEK, 14), end: at(WEEK, 21, 30), tz: ZONE });
      },
    });
    const days = within(await screen.findByRole('group', { name: 'Compare days' })).getAllByRole('button');
    expect(days[0]).toHaveAccessibleName(/^Mon Nov 2, 30m free, packed/);
    expect(days[0]).toHaveClass('tight');
    await userEvent.click(days[0]!);
    expect(await screen.findByText('Mon Nov 2 is packed')).toBeVisible();
    expect(screen.getByText('30m free of 8h available that day.')).toBeVisible();
  });

  it('mid-week, a day gone by shows no free time, as on Week', async () => {
    await phone({ now: '2026-11-04T18:00:00Z' });
    const days = within(await screen.findByRole('group', { name: 'Compare days' })).getAllByRole('button');
    expect(days[0]!.getAttribute('aria-label')).toMatch(/^Mon Nov 2(,|$)/);
    expect(days[0]!.getAttribute('aria-label')).not.toMatch(/free/);
    expect(days[0]!.querySelector('.wfree')).toBeEmptyDOMElement();
    expect(days[2]).toHaveAccessibleName(/^Wed Nov 4, .* free/);
  });

  it('looking at another day offers Move to that day, and a suggested time there takes the block', async () => {
    await phone();
    await userEvent.click(await screen.findByRole('button', { name: /^Tue Nov 3,/ }));
    expect(screen.getByRole('heading', { name: 'Tue Nov 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move to Tue Nov 3' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back to Mon Nov 2' }));
    expect(screen.getByRole('heading', { name: 'Mon Nov 2' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Tue Nov 3,/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Use suggested time, Tue Nov 3, 7am' }));
    expect(screen.getByText('Tue Nov 3, 7am to 9am (2h)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Place here' })).toBeInTheDocument();
  });

  it('the Length slider changes the block, and says what stays to place', async () => {
    await phone();
    fireEvent.change(await screen.findByRole('slider', { name: 'Length' }), { target: { value: '60' } });
    expect(screen.getByText('Mon Nov 2, 2pm to 3pm (1h)')).toBeInTheDocument();
    expect(screen.getByText('1h more of this task stays to place')).toBeInTheDocument();
  });

  it('All tasks lists every practice first, then every picked task, with Place the rest and Skip a practice', async () => {
    await phone({ seed: async (w) => (await picked(w), stretch(w)) });
    await userEvent.click(await screen.findByRole('button', { name: 'All picked tasks, 0 of 4 placed' }));
    const sheet = screen.getByRole('dialog', { name: 'All picked tasks' });
    const practices = within(sheet).getByRole('list', { name: 'Practices' });
    const tasks = within(sheet).getByRole('list', { name: 'Tasks' });
    expect(practices.compareDocumentPosition(tasks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Practices are up first.
    expect(within(practices).getByRole('button', { name: /^Morning stretch/ })).toHaveAttribute('aria-current', 'step');
    expect(within(practices).getByRole('listitem')).toHaveClass('is-practice');
    expect(within(tasks).getAllByRole('button', { name: /^(?!Remove)/ }).map((b) => b.textContent)).toEqual(['1Collect the sources', '2Write chapter one', '3Paint the fence']);
    expect(within(sheet).getByText('Paint the fence').closest('.mhead')).not.toBeNull();
    expect(within(sheet).getByRole('heading', { name: 'Skip a practice this week' })).toBeInTheDocument();
    expect(await within(sheet).findByText('0 sessions, 0m')).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole('button', { name: /^Write chapter one/ }));
    expect(screen.queryByRole('dialog', { name: 'All picked tasks' })).toBeNull();
    expect(screen.getByText('Write chapter one', { selector: '.strong' })).toBeInTheDocument();
  });

  it('tapping a placed block selects it, with Done and Remove from calendar', async () => {
    await phone({
      seed: async (w) => {
        await picked(w);
        await w.create('time_block', { task_id: 't1', start: at(WEEK, 18), end: at(WEEK, 20), tz: ZONE }, 'b1');
      },
    });
    const block = await screen.findByRole('slider', { name: /^Collect the sources\./ });
    fireEvent.keyDown(block, { key: 'Enter' });
    expect(screen.getByText('Mon Nov 2, 6pm to 8pm (2h)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    // The app's toast sits under the flow, so Undo shows above the dock.
    await userEvent.click(screen.getByRole('button', { name: 'Remove from calendar' }));
    const said = await screen.findByText('Removed Collect the sources');
    await userEvent.click(within(said.closest('.pktoast')!).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('slider', { name: /^Collect the sources\./ })).toBeInTheDocument();
  });

  it('a press on a practice session selects it, and dragging it asks at the end', async () => {
    await phone({
      seed: async (w) => {
        await picked(w);
        await stretch(w);
        await w.create('time_block', { practice_id: 'pr', start: at('2026-11-03', 7), end: at('2026-11-03', 7, 30), tz: ZONE }, 's1');
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: /^Tue Nov 3,/ }));
    const session = () => screen.getByRole('slider', { name: /^Morning stretch\./ });
    await waitFor(() => expect(session()).toBeInTheDocument());
    fireEvent.pointerDown(session(), { clientY: 300, button: 0 });
    fireEvent.pointerUp(window, { clientY: 300 });
    expect(await screen.findByText('Practice, 30m on Tue and Wed, around 7am')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Use this in future weeks too?' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove from calendar' })).toBeInTheDocument();

    // The drawn day is 17 hours over 816px, so 48px is an hour.
    fireEvent.pointerDown(session(), { clientY: 300, button: 0 });
    fireEvent.pointerMove(window, { clientY: 348 });
    fireEvent.pointerUp(window, { clientY: 348 });
    const ask = await screen.findByRole('dialog', { name: 'Use this in future weeks too?' });
    expect(within(ask).getByRole('group', { name: 'Use 8am in future weeks too?' })).toHaveAccessibleDescription('Morning stretch moved to Tue 8am.');
    await userEvent.click(within(ask).getByRole('button', { name: 'No, just this week' }));
    expect(screen.queryByRole('dialog', { name: 'Use this in future weeks too?' })).toBeNull();
  });

  // Paint the fence sits on Tuesday from 8am, so the task's best time there is 9:30am.
  const fenceTue = async (w: Writer) => {
    await picked(w);
    await w.create('time_block', { task_id: 'o1', start: at('2026-11-03', 8), end: at('2026-11-03', 9, 30), tz: ZONE }, 'b1');
  };

  it('Place here over a placed block takes it off to place again, says so first, and Undo puts it all back', async () => {
    const t = await phone({ seed: fenceTue });
    await userEvent.click(await screen.findByRole('button', { name: /^Tue Nov 3,/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Move to Tue Nov 3' }));
    const handle = screen.getByRole('slider', { name: /^Time for Collect the sources, being placed\./ });
    expect(handle).toHaveAttribute('aria-valuetext', 'Tue Nov 3, 9:30am to 11:30am');
    const under = () => screen.getByRole('slider', { name: /^Paint the fence\./ });
    const was = under().getAttribute('style');
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(screen.getByText('Tue Nov 3, 9am to 11am (2h)')).toBeInTheDocument();
    expect(screen.getByText('Placing here takes Paint the fence off the calendar to place again.')).toBeInTheDocument();
    // The draft sits beside the block, which keeps its place and size.
    expect(handle).toHaveClass('draft', 'beside');
    expect(under().getAttribute('style')).toBe(was);
    expect(under()).toHaveAttribute('aria-valuetext', 'Tue Nov 3, 8am to 9:30am');

    await userEvent.click(screen.getByRole('button', { name: 'Place here' }));
    await waitFor(async () => expect(await blocks(t, 't1')).toEqual([[at('2026-11-03', 9), at('2026-11-03', 11)]]));
    expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBe(true);
    expect(screen.queryByRole('slider', { name: /^Paint the fence\./ })).toBeNull();
    const said = await screen.findByText('Took Paint the fence off the calendar to place again');
    await userEvent.click(within(said.closest('.pktoast')!).getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBeFalsy());
    expect(await blocks(t, 't1')).toEqual([]);
  });

  it('dragging a placed block only moves it; a tap selects it', async () => {
    const t = await phone({ seed: fenceTue });
    await userEvent.click(await screen.findByRole('button', { name: /^Tue Nov 3,/ }));
    const placed = () => screen.getByRole('slider', { name: /^Paint the fence\./ });
    // The drawn day is 17 hours over 816px, so 48px is an hour.
    fireEvent.pointerDown(placed(), { clientY: 300, button: 0 });
    fireEvent.pointerMove(window, { clientY: 348 });
    fireEvent.pointerUp(window, { clientY: 348 });
    await waitFor(async () => expect(await blocks(t, 'o1')).toEqual([[at('2026-11-03', 9), at('2026-11-03', 10, 30)]]));
    expect(screen.getByText('Collect the sources', { selector: '.strong' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove from calendar' })).toBeNull();
    expect(placed()).toHaveClass('calm');

    fireEvent.pointerDown(placed(), { clientY: 300, button: 0 });
    fireEvent.pointerUp(window, { clientY: 300 });
    expect(await screen.findByRole('button', { name: 'Remove from calendar' })).toBeInTheDocument();
    expect(screen.getByText('Paint the fence', { selector: '.strong' })).toBeInTheDocument();
    expect(placed()).not.toHaveClass('calm');
  });

  it('switching to another task or block never places the one waiting', async () => {
    const t = await phone({ seed: fenceTue });
    await userEvent.click(await screen.findByRole('button', { name: /^Tue Nov 3,/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Move to Tue Nov 3' }));
    const handle = screen.getByRole('slider', { name: /^Time for Collect the sources/ });
    fireEvent.pointerDown(handle, { clientY: 300, button: 0 });
    fireEvent.pointerMove(window, { clientY: 348 });
    fireEvent.pointerUp(window, { clientY: 348 });
    expect(screen.getByText('Tue Nov 3, 10:30am to 12:30pm (2h)')).toBeInTheDocument();

    const placed = screen.getByRole('slider', { name: /^Paint the fence\./ });
    fireEvent.pointerDown(placed, { clientY: 300, button: 0 });
    fireEvent.pointerUp(window, { clientY: 300 });
    expect(await screen.findByRole('button', { name: 'Remove from calendar' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'All picked tasks, 1 of 3 placed' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'All picked tasks' })).getByRole('button', { name: /^Write chapter one/ }));
    expect(screen.getByText('Write chapter one', { selector: '.strong' })).toBeInTheDocument();
    expect(await blocks(t, 't1')).toEqual([]);
    expect(await blocks(t, 't2')).toEqual([]);
    expect(screen.getByRole('button', { name: 'All picked tasks, 1 of 3 placed' })).toBeInTheDocument();
  });

  it("a task's Remove from this week asks in a sheet over All tasks; Remove closes both and offers Undo above the dock", async () => {
    const t = await phone();
    await userEvent.click(await screen.findByRole('button', { name: 'All picked tasks, 0 of 3 placed' }));
    const list = screen.getByRole('dialog', { name: 'All picked tasks' });
    const action = within(list).getByRole('button', { name: 'Remove Write chapter one from this week' });
    await userEvent.click(action);
    const ask = screen.getByRole('dialog', { name: 'Remove Write chapter one from this week' });
    expect(ask).toHaveTextContent("Remove Write chapter one from this week's plan? It stays in its project.");
    expect(within(ask).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Remove Write chapter one from this week' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'All picked tasks' })).toBeInTheDocument();
    expect(action).toHaveFocus();

    await userEvent.click(action);
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Remove Write chapter one from this week' })).getByRole('button', { name: 'Remove' }));
    await waitFor(async () => expect((await getRecord(t.db, 'week_pick', weekPickId(WEEK, 't2')))?.deleted_at).toBeTruthy());
    expect(screen.queryByRole('dialog')).toBeNull();
    const said = await screen.findByText('Removed Write chapter one from this week.');
    expect(screen.getByRole('button', { name: 'All picked tasks, 0 of 2 placed' })).toBeInTheDocument();
    await userEvent.click(within(said.closest('.pktoast')!).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: 'All picked tasks, 0 of 3 placed' })).toBeInTheDocument();
  });
});
