import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localToInstant } from '../../../core/dates';
import { CALENDAR_ID, getRecord, listRecords, outcomeId, setWeekPick, updateSettings, weekPickId, weekPlanId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderScreen } from '../../app/testing';
import type { HarnessOptions } from '../../app/testing';

afterEach(cleanup);

// The harness clock reads Monday, Nov 2 at 2pm in Chicago.
const ZONE = 'America/Chicago';
const MON = '2026-11-02';
const TUE = '2026-11-03';
const WED = '2026-11-04';
const at = (time: string, date = MON) => {
  const [h, m] = time.split(':').map(Number);
  return localToInstant(date, h! * 60 + (m ?? 0), ZONE);
};

async function week(w: Writer) {
  await updateSettings(w, {
    availability: [
      { days: 'all', from: 22 * 60, to: 7 * 60, projects: true, one_offs: true },
      { days: 'weekdays', from: 9 * 60, to: 17 * 60, projects: true, one_offs: true },
    ],
  });
  await w.create('project', { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p');
  await w.create('task', { kind: 'project', project_id: 'p', title: 'Draft the summary', estimate_min: 120 }, 't1');
  await w.create('task', { kind: 'one_off', title: 'Paint the fence', estimate_min: 60 }, 't2');
  await w.create('practice', { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' }, 'pr');
  await w.create('time_block', { task_id: 't1', start: at('18:00', TUE), end: at('19:00', TUE), tz: ZONE }, 'b1');
  await w.create('time_block', { practice_id: 'pr', start: at('07:00', WED), end: at('07:30', WED), tz: ZONE }, 'b2');
  await w.create('time_block', { task_id: 't2', start: at('07:30'), end: at('08:30'), tz: ZONE }, 'b3');
  await w.create('calendar_source', { google_id: 'family', name: 'Family', mode: 'info' }, 'family');
  await w.create(
    'calendar',
    {
      connected: true,
      events: [
        { id: 'e1', calendar: 'work', title: 'Quiz night', start: at('18:30', TUE), end: at('19:30', TUE) },
        { id: 'e2', calendar: 'family', title: 'Street fair', start: at('12:00', '2026-11-05'), end: at('13:00', '2026-11-05') },
      ],
    },
    CALENDAR_ID,
  );
}

const open = (options: HarnessOptions & { params?: Record<string, string>; close?(): void } = {}) =>
  renderScreen('week', { zone: ZONE, ...options, seed: async (w) => { await week(w); await options.seed?.(w); } });

const planned = (w: Writer) => w.create('week_plan', { week_start: '2026-11-02', finished_at: at('08:00', '2026-11-02') }, weekPlanId('2026-11-02'));

const block = (id: string) => (t: { db: Parameters<typeof getRecord>[0] }) => getRecord(t.db, 'time_block', id);

// Wednesday at noon, after Monday's open evening went to a one off, with 5pm to 9:30pm today planned.
// From now on that leaves 5h today, 7h on Thursday and Friday and 15h each weekend day: 49h, 44h 30m of it free.
const midweek = (options: Parameters<typeof open>[0] = {}) =>
  open({
    now: '2026-11-04T18:00:00Z',
    ...options,
    seed: async (w) => {
      await w.create('time_block', { task_id: 't2', start: at('17:00'), end: at('22:00'), tz: ZONE }, 'b4');
      await w.create('time_block', { task_id: 't1', start: at('17:00', WED), end: at('21:30', WED), tz: ZONE }, 'b5');
    },
  });

describe.each(['desktop', 'phone'] as const)('this week before it is planned, on %s', (layout) => {
  afterEach(() => localStorage.clear());

  it('asks to plan instead of offering to edit, as Today does, and Start planning opens planning', async () => {
    const t = await open({ layout });
    expect(await screen.findByText("This week isn't planned yet.")).toBeVisible();
    expect(screen.queryByRole('button', { name: "Edit this week's plan" })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Start planning' }));
    expect(t.nav().flow).toMatchObject({ area: 'planning' });
  });

  it('Skip for now puts it away for the week and offers Edit again', async () => {
    await open({ layout });
    await userEvent.click(await screen.findByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByRole('button', { name: "Edit this week's plan" })).toBeVisible();
    expect(screen.queryByText("This week isn't planned yet.")).toBeNull();
    cleanup();
    await open({ layout });
    expect(await screen.findByRole('button', { name: "Edit this week's plan" })).toBeVisible();
  });

  it('once planned, offers Edit and no prompt', async () => {
    await open({ layout, seed: planned });
    expect(await screen.findByRole('button', { name: "Edit this week's plan" })).toBeVisible();
    expect(screen.queryByText("This week isn't planned yet.")).toBeNull();
  });
});

describe('Week on desktop', () => {
  it('shows this week: blocks in their colours, calendar events behind, a conflict named, and the time left', async () => {
    await open();
    expect(await screen.findByRole('heading', { name: 'This week' })).toBeVisible();
    expect(screen.getByText('Nov 2 to Nov 8')).toBeVisible();
    const report = await screen.findByRole('button', { name: /^Draft the summary, Tue Nov 3, 6pm to 7pm, Project\. Conflicts with Quiz night\./ });
    expect(report).toHaveClass('ev-project');
    expect(screen.getByRole('button', { name: /^Piano practice, Wed/ })).toHaveClass('ev-practice');
    expect(screen.getByRole('button', { name: /^Paint the fence/ })).toHaveClass('ev-maint');
    expect(screen.getByText('Quiz night')).toHaveClass('ev-busy');
    expect(screen.getByText('Street fair')).toHaveClass('ev-info');
    expect(screen.getByText(/ free$/, { selector: '.capnum' })).toBeVisible();
    expect(screen.getByText(/^of \d+h( \d+m)? available$/)).toBeVisible();
  });

  it('mid-week, counts only time still ahead: a past day shows what happened, never free or packed', async () => {
    await midweek();
    const used = await screen.findByRole('region', { name: "How this week's time is used" });
    expect(within(used).getByText('44h 30m free')).toBeVisible();
    expect(within(used).getByText('of 49h available')).toBeVisible();
    // What's planned is the whole week's, past days included, as they show what happened.
    expect(within(used).getByRole('img', { name: '5h 30m projects, 30m practices, 6h one offs, 44h 30m free' })).toBeVisible();
    expect(within(used).getByText('Free 44h 30m')).toBeVisible();
    expect(within(used).getByText('Free 44h 30m').querySelector('.seg-free')).toBeInTheDocument();
    // Today has only its evening left, so it's packed; Monday was full, but it has gone by.
    expect(within(used).getByText('Wed Nov 4 is packed')).toBeVisible();
    expect(within(used).getByText('30m free of 5h available that day.')).toBeVisible();
    expect(within(used).queryByText('Mon Nov 2 is packed')).toBeNull();
    const heads = document.querySelectorAll('.colhead');
    expect(heads[0]).not.toHaveClass('tight');
    expect(heads[0]!.querySelector('.free')).toBeEmptyDOMElement();
    expect(heads[2]).toHaveClass('tight');
    expect(heads[2]!.querySelector('.free')).toHaveTextContent('30m free');
    expect(heads[3]!.querySelector('.free')).toHaveTextContent('7h free');
    expect(screen.getByRole('button', { name: /^Paint the fence, Mon Nov 2, 5pm to 10pm, One off\./ })).toBeVisible();
  });

  it('a past week still shows what was planned in it', async () => {
    await open({ now: '2026-11-09T20:00:00Z' });
    await userEvent.click(await screen.findByRole('button', { name: 'Previous week' }));
    expect(await screen.findByText('Nov 2 to Nov 8')).toBeVisible();
    const used = screen.getByRole('region', { name: "How this week's time is used" });
    expect(within(used).getByRole('img', { name: '1h projects, 30m practices, 1h one offs, 0m free' })).toBeVisible();
    expect(within(used).getByText('One offs 1h')).toBeVisible();
  });

  it('a past week shows no free time, and a future week all of its own', async () => {
    await midweek();
    await userEvent.click(await screen.findByRole('button', { name: 'Previous week' }));
    expect(await screen.findByText('Oct 26 to Nov 1')).toBeVisible();
    expect(screen.getByText('0m free', { selector: '.capnum' })).toBeVisible();
    expect(screen.getByText('of 0m available')).toBeVisible();
    expect([...document.querySelectorAll('.colhead .free')].every((el) => el.textContent === '')).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'This week' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Next week' }));
    expect(await screen.findByText('Nov 9 to Nov 15')).toBeVisible();
    expect(screen.getByText('65h free', { selector: '.capnum' })).toBeVisible();
    expect(screen.getByText('of 65h available')).toBeVisible();
  });

  it('arrows reach any week, This week comes back, and a past week is read only with its analytics', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'This week' });
    expect(screen.queryByRole('button', { name: 'This week' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(await screen.findByRole('heading', { name: 'Past week' })).toBeVisible();
    expect(screen.getByText('Oct 26 to Nov 1')).toBeVisible();
    expect(screen.getByText('Past weeks can be viewed but not changed.')).toBeVisible();
    expect(screen.queryByRole('button', { name: "Edit this week's plan" })).toBeNull();
    for (let i = 0; i < 9; i++) await userEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(await screen.findByText('Aug 24 to Aug 30')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: "See this week's analytics" }));
    expect(t.nav().route).toMatchObject({ area: 'analytics', params: { week: '2026-08-24' } });
  });

  it.each(['desktop', 'phone'] as const)('on %s, arrows clicked before a week loads each still count', async (layout) => {
    await open({ layout });
    await screen.findByRole('heading', { name: 'This week' });
    const previous = screen.getByRole('button', { name: 'Previous week' });
    for (let i = 0; i < 3; i++) fireEvent.click(previous);
    expect(await screen.findByText('Oct 12 to Oct 18')).toBeVisible();
  });

  it('left on this week, follows it when the week turns over; another week stays put', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'This week' });
    t.clock.set('2026-11-09T15:00:00Z');
    await t.write((w) => w.create('task', { kind: 'inbox', title: 'Anything' }));
    expect(await screen.findByText('Nov 9 to Nov 15')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'This week' })).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(await screen.findByText('Nov 2 to Nov 8')).toBeVisible();
    t.clock.set('2026-11-16T15:00:00Z');
    await t.write((w) => w.create('task', { kind: 'inbox', title: 'Anything else' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next week' })).toBeEnabled());
    expect(screen.getByText('Nov 2 to Nov 8')).toBeVisible();
  });

  it('next week offers to plan it, and a later week is a future week', async () => {
    const t = await open();
    await screen.findByRole('heading', { name: 'This week' });
    await userEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(await screen.findByRole('heading', { name: 'Next week' })).toBeVisible();
    expect(screen.getByText('Nov 9 to Nov 15')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Start planning' }));
    // Planning chooses the week itself: this one until it's planned, then the next.
    expect(t.nav().flow).toMatchObject({ area: 'planning' });
    await userEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(await screen.findByRole('heading', { name: 'Future week' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'This week' }));
    expect(await screen.findByRole('heading', { name: 'This week' })).toBeVisible();
  });

  it('a block opens its details', async () => {
    await open();
    const opener = await screen.findByRole('button', { name: /^Draft the summary/ });
    expect(opener).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(opener);
    const details = await screen.findByRole('region', { name: 'Draft the summary' });
    expect(opener).toHaveAttribute('aria-expanded', 'true');
    expect(await within(details).findByText('Write the report')).toBeVisible();
    await userEvent.click(within(details).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Draft the summary' })).toBeNull();
    // Focus goes back to the block, not the page.
    expect(screen.getByRole('button', { name: /^Draft the summary/ })).toHaveFocus();
  });

  it("Edit this week's plan: keys move a block and save, the past stays put, and × removes with Undo", async () => {
    const t = await open({ seed: planned });
    await userEvent.click(await screen.findByRole('button', { name: "Edit this week's plan" }));
    expect(await screen.findByRole('heading', { name: 'Editing this week' })).toBeVisible();
    // The button pressed has gone, so focus moves to the one that ends editing, and back again after.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done editing' })).toHaveFocus());
    expect(screen.getByText('Drag or resize anything from now on, or click × to remove it. Changes save as you go.')).toBeVisible();
    // Monday morning has passed.
    expect(screen.queryByRole('group', { name: /^Paint the fence/ })).toBeNull();

    screen.getByRole('group', { name: /^Draft the summary/ }).focus();
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(async () => expect((await block('b1')(t))?.start).toBe(at('18:15', TUE)));
    // Any spot is allowed, with a note.
    const moved = await screen.findByRole('status', { name: 'Last change' });
    expect(within(moved).getByText('Draft the summary, Tue Nov 3, 6:15pm to 7:15pm')).toBeVisible();
    expect(within(moved).getByText('That overlaps busy time on your calendar.')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Remove Draft the summary' }));
    expect(await screen.findByText('Removed Draft the summary')).toBeVisible();
    await waitFor(async () => expect((await block('b1')(t))?.cancelled).toBe(true));
    // The × went with its block, so focus goes to Undo rather than the page.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await block('b1')(t))?.cancelled).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: 'Done editing' }));
    expect(await screen.findByRole('heading', { name: 'This week' })).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: "Edit this week's plan" })).toHaveFocus());
  });

  it('a practice moved asks whether to keep it, and Yes changes the practice', async () => {
    const t = await open({ seed: planned });
    await userEvent.click(await screen.findByRole('button', { name: "Edit this week's plan" }));
    (await screen.findByRole('group', { name: /^Piano practice/ })).focus();
    await userEvent.keyboard('{ArrowDown}');
    const ask = await screen.findByRole('status', { name: 'Make this change permanent?' });
    expect(within(ask).getByText('Piano practice is now Wed Nov 4, 7:15am to 7:45am.')).toBeVisible();
    await userEvent.click(within(ask).getByRole('button', { name: 'Yes, every week' }));
    await waitFor(async () => expect((await getRecord(t.db, 'practice', 'pr'))?.preferred_times).toEqual([7 * 60 + 15]));
    expect(await screen.findByText('Piano practice changed for every week. Edit it any time in Goals.')).toBeVisible();
  });

  it('adds a task: its block waits at the best time, with other suggestions, until Place here', async () => {
    const t = await open({ seed: planned });
    await userEvent.click(await screen.findByRole('button', { name: "Edit this week's plan" }));
    expect(await screen.findByText('Add a task to this week')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /^Paint the fence/ }));
    const draft = await screen.findByRole('group', { name: /^Paint the fence, .*Enter places it\.$/ });
    expect(draft).toHaveClass('evdraft');
    expect(screen.getAllByRole('button', { name: /^Use suggested time, / }).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Place here' }));
    expect(await screen.findByText(/^Placed Paint the fence, /)).toBeVisible();
    const placed = (await listRecords(t.db, 'time_block')).filter((b) => b.task_id === 't2' && b.start > at('14:00'));
    expect(placed).toHaveLength(1);
    expect(placed[0]!.end > placed[0]!.start).toBe(true);
  });

  it('lists work that needs a new time under its own heading, not as placed by its past block', async () => {
    await open({
      seed: async (w) => {
        await planned(w);
        await w.create('task', { kind: 'project', project_id: 'p', title: 'Rake the leaves', estimate_min: 60, remaining_min: 30 }, 't3');
        await w.create('time_block', { task_id: 't3', start: at('10:00'), end: at('11:00'), tz: ZONE }, 'b4');
        await w.create('block_outcome', { result: 'partly', answered_at: at('11:00') }, outcomeId('b4'));
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: "Edit this week's plan" }));
    const heading = await screen.findByRole('heading', { name: 'Needs a new time' });
    const group = heading.closest('div')!;
    // Its Monday block is over, so it reads as still to place, with what is left.
    expect(within(group).getByRole('button', { name: /^Rake the leaves\s*30m$/ })).toBeVisible();
    expect(group.querySelector('.schedmark')).toHaveTextContent('+');
  });

  it('Find a time from Today opens this week with that task ready to place', async () => {
    const t = await open({ params: { place: 't1' } });
    expect(await screen.findByRole('heading', { name: 'Editing this week' })).toBeVisible();
    expect(await screen.findByRole('group', { name: /^Draft the summary, .*Enter places it\.$/ })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Place here' }));
    await waitFor(async () => expect((await listRecords(t.db, 'time_block')).filter((b) => b.task_id === 't1')).toHaveLength(2));
  });

  it('Edit from Shift rest of today opens this week ready to edit', async () => {
    await open({ params: { edit: 'this' } });
    expect(await screen.findByRole('heading', { name: 'Editing this week' })).toBeVisible();
  });

  it('a dated one off with no time yet waits above its days, and Mark done finishes it with Undo', async () => {
    const t = await open({
      seed: (w) => w.create('task', { kind: 'one_off', title: 'Renew the passport', estimate_min: 30, schedule: { type: 'once', from: WED, to: '2026-11-06' } }, 't3'),
    });
    const chip = await screen.findByRole('button', { name: 'One off: Renew the passport, Nov 4 to Nov 6, 30m to schedule' });
    await userEvent.click(chip);
    const panel = screen.getByRole('group', { name: 'Renew the passport' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Mark done' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't3'))?.done_at).toBeTruthy());
    await waitFor(() => expect(screen.queryByRole('button', { name: /^One off: Renew the passport/ })).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: 'One off: Renew the passport, Nov 4 to Nov 6, 30m to schedule' })).toBeVisible();
  });
});

describe('To schedule on Week', () => {
  // Draft the summary is picked for 3h with 1h on Tuesday, so 2h waits; Piano practice has only Wednesday's session.
  const picks = async (w: Writer) => {
    await planned(w);
    await setWeekPick(w, MON, 't1', 180);
  };
  const live = async (t: { db: Parameters<typeof listRecords>[0] }, match: (b: { task_id?: string | null; practice_id?: string | null }) => boolean) =>
    (await listRecords(t.db, 'time_block')).filter((b) => match(b) && !b.cancelled);
  // jsdom has no layout, so the point under the pointer is whatever the test says.
  const pointAt = (el: () => Element | null) => Object.defineProperty(document, 'elementFromPoint', { value: () => el(), configurable: true });
  const rect = (el: Element, height: number, top = 0) =>
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ width: 100, height, top, left: 0, right: 100, bottom: top + height, x: 0, y: top, toJSON: () => ({}) });
  const drag = (el: Element, to: { x: number; y: number }) => {
    fireEvent.pointerDown(el, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerMove(window, { clientX: to.x, clientY: to.y });
    fireEvent.pointerUp(window, { clientX: to.x, clientY: to.y });
  };
  afterEach(() => Reflect.deleteProperty(document, 'elementFromPoint'));

  it('lists picked work less what is placed, and practices short of their target, with a count', async () => {
    await open({ seed: picks });
    const lane = await screen.findByRole('region', { name: 'To schedule' });
    expect(within(lane).getByText('2 · 5h')).toBeVisible();
    expect(within(lane).getByRole('button', { name: 'Draft the summary, Project, 2h of 3h left, to schedule' })).toBeVisible();
    expect(within(lane).getByRole('button', { name: 'Piano practice, Practice, 6 × 30m, to schedule' })).toBeVisible();
  });

  it('Schedule one at a time opens planning on Schedule for the week', async () => {
    const t = await open({ seed: picks });
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule one at a time' }));
    expect(t.nav().flow).toMatchObject({ area: 'planning', params: { week: MON, step: 'schedule' } });
  });

  it('a card offers suggested times; one places it, it leaves the list, and Undo brings it back', async () => {
    const t = await open({ seed: picks });
    await userEvent.click(await screen.findByRole('button', { name: /^Draft the summary, Project, 2h of 3h left/ }));
    const panel = screen.getByRole('group', { name: 'Draft the summary' });
    const times = within(within(panel).getByRole('group', { name: 'Suggested times' })).getAllByRole('button');
    expect(times).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: /^Use suggested time/ })).toHaveLength(3);
    await userEvent.click(times[0]!);
    await waitFor(async () => expect(await live(t, (b) => b.task_id === 't1')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Draft the summary, Project/ })).toBeNull());
    expect(screen.getByText('1 · 3h')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: /^Draft the summary, Project, 2h of 3h left/ })).toBeVisible();
  });

  it('a card dragged onto a day is placed where it is let go', async () => {
    const t = await open({ seed: picks });
    const card = await screen.findByRole('button', { name: /^Piano practice, Practice/ });
    // Thursday's 6am to 11pm drawn 442px tall from y 100, 26px an hour, so y 152 is 8am.
    const thu = document.querySelector('[data-drop-date="2026-11-05"]')!;
    rect(thu, 442, 100);
    pointAt(() => thu);
    drag(card, { x: 50, y: 152 });
    await waitFor(async () => expect((await live(t, (b) => b.practice_id === 'pr')).map((b) => b.start).sort()).toEqual([at('07:00', WED), at('08:00', '2026-11-05')]));
    expect(await screen.findByRole('button', { name: /^Piano practice, Practice, 5 × 30m/ })).toBeVisible();
  });

  it('while editing, a block dragged onto To schedule comes off the calendar and waits there, with Undo', async () => {
    const t = await open({ seed: planned });
    await userEvent.click(await screen.findByRole('button', { name: "Edit this week's plan" }));
    pointAt(() => screen.getByRole('region', { name: 'To schedule' }));
    drag(screen.getByRole('group', { name: /^Draft the summary, Tue/ }), { x: 50, y: 0 });
    await waitFor(async () => expect((await block('b1')(t))?.cancelled).toBe(true));
    expect(await screen.findByRole('button', { name: 'Draft the summary, Project, 1h, to schedule' })).toBeVisible();
    expect(await getRecord(t.db, 'week_pick', weekPickId(MON, 't1'))).toMatchObject({ minutes: 60 });
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await block('b1')(t))?.cancelled).toBeFalsy());
  });

  it('Take out of this week takes a pick out, and a practice is skipped this week', async () => {
    const t = await open({ seed: picks });
    await userEvent.click(await screen.findByRole('button', { name: /^Draft the summary, Project/ }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Draft the summary' })).getByRole('button', { name: 'Take out of this week' }));
    await waitFor(async () => expect((await getRecord(t.db, 'week_pick', weekPickId(MON, 't1')))?.deleted_at).toBeTruthy());
    await userEvent.click(await screen.findByRole('button', { name: /^Piano practice, Practice/ }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Piano practice' })).getByRole('button', { name: 'Take out of this week' }));
    expect(await screen.findByText('Everything this week is on the calendar.')).toBeVisible();
    expect((await getRecord(t.db, 'week_plan', weekPlanId(MON)))?.skipped_practices).toEqual(['pr']);
    // Wednesday's session was still to come, so it went with it.
    expect((await block('b2')(t))?.deleted_at).toBeTruthy();
  });

  it('on phone, a card opens its suggested times in a sheet, and one places it', async () => {
    const t = await open({ layout: 'phone', seed: picks });
    await userEvent.click(await screen.findByRole('button', { name: /^Piano practice, Practice/ }));
    const sheet = screen.getByRole('dialog', { name: 'Piano practice' });
    await userEvent.click(within(sheet).getAllByRole('button', { name: /^Place Piano practice, / })[0]!);
    await waitFor(async () => expect(await live(t, (b) => b.practice_id === 'pr')).toHaveLength(2));
    expect(await screen.findByRole('button', { name: /^Piano practice, Practice, 5 × 30m/ })).toBeVisible();
  });

  it('on phone, a card held then dragged onto a row of the day is placed at that time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const t = await open({ layout: 'phone', seed: picks });
      const card = await screen.findByRole('button', { name: /^Piano practice, Practice/ });
      // The free row from 5pm to 10pm drawn 300px tall, so y 60 is 6pm.
      const free = document.querySelector('.tlrow[data-drop-from="1020"]')!;
      expect(free).toHaveTextContent('Free, 5pm to 10pm');
      rect(free, 300);
      pointAt(() => free);
      fireEvent.pointerDown(card, { clientX: 10, clientY: 10, button: 0, pointerType: 'touch' });
      act(() => void vi.advanceTimersByTime(450));
      expect(document.querySelector('.cardghost')).not.toBeNull();
      fireEvent.pointerMove(window, { clientX: 50, clientY: 60, pointerType: 'touch' });
      expect(document.querySelector('.cardghost .ghostwhen')).toHaveTextContent('6pm');
      fireEvent.pointerUp(window, { clientX: 50, clientY: 60, pointerType: 'touch' });
      await waitFor(async () => expect((await live(t, (b) => b.practice_id === 'pr')).map((b) => b.start)).toContain(at('18:00')));
    } finally {
      vi.useRealTimers();
    }
  });

  it('on phone while editing, cards drag onto the day and blocks drag back up', async () => {
    const t = await open({ layout: 'phone', seed: async (w) => { await picks(w); await w.create('time_block', { task_id: 't2', start: at('17:00'), end: at('18:00'), tz: ZONE }, 'b4'); } });
    await userEvent.click(await screen.findByRole('button', { name: "Edit this week's plan" }));
    // Monday's 6am to 11pm drawn 816px tall, 48px an hour, so y 624 is 7pm.
    const day = document.querySelector('[data-drop-date="2026-11-02"]')!;
    rect(day, 816);
    pointAt(() => day);
    drag(await screen.findByRole('button', { name: /^Piano practice, Practice/ }), { x: 50, y: 624 });
    await waitFor(async () => expect((await live(t, (b) => b.practice_id === 'pr')).map((b) => b.start)).toContain(at('19:00')));

    pointAt(() => screen.getByRole('region', { name: 'To schedule' }));
    fireEvent.pointerDown(screen.getByRole('slider', { name: /^Paint the fence\. Drag/ }), { clientY: 300, button: 0 });
    fireEvent.pointerMove(window, { clientY: 0 });
    fireEvent.pointerUp(window, { clientY: 0 });
    await waitFor(async () => expect((await block('b4')(t))?.cancelled).toBe(true));
    expect(await screen.findByRole('button', { name: /^Paint the fence, One off, 1h/ })).toBeVisible();
  });
});

describe('Week on phone', () => {
  const phone = (options: Parameters<typeof open>[0] = {}) => open({ layout: 'phone', ...options });

  it('a strip of seven days over the chosen day, read as blocks, free, closed and busy time', async () => {
    await phone();
    const strip = await screen.findByRole('group', { name: 'Choose a day' });
    const days = within(strip).getAllByRole('button');
    expect(days).toHaveLength(7);
    expect(days[0]).toHaveAttribute('aria-pressed', 'true');
    expect(days[0]).toHaveAccessibleName(/^Mon Nov 2, .* free/);
    expect(screen.getByRole('heading', { name: 'Mon Nov 2' })).toBeVisible();
    // It's 2pm, so the morning has gone by.
    expect(screen.getByText('Gone by, 7am to 7:30am')).toBeVisible();
    expect(screen.getByText('Not available, 9am to 5pm')).toBeVisible();
    expect(screen.getByText('Free, 5pm to 10pm')).toBeVisible();

    await userEvent.click(days[1]!);
    expect(await screen.findByRole('heading', { name: 'Tue Nov 3' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Draft the summary, 6pm to 7pm, Project. Conflicts with Quiz night.' })).toBeVisible();
    expect(screen.getByText('Busy, 6:30pm to 7:30pm')).toBeVisible();
    // Today stays marked with another day chosen.
    expect(days[0]).toHaveAttribute('aria-current', 'date');
    expect(days[0]).toHaveClass('today');
    expect(days[1]).not.toHaveAttribute('aria-current');
  });

  it('mid-week, counts only time still ahead: a past day shows what happened, never free or packed', async () => {
    await midweek({ layout: 'phone' });
    const days = within(await screen.findByRole('group', { name: 'Choose a day' })).getAllByRole('button');
    expect(screen.getByText('44h 30m free')).toBeVisible();
    expect(screen.getByText('of 49h available')).toBeVisible();
    expect(screen.getByText('12h planned')).toBeVisible();
    expect(screen.getByText('5h 30m projects, 30m practices, 6h one offs')).toBeVisible();
    // Today has only its evening left, so it's packed.
    expect(days[2]).toHaveAttribute('aria-pressed', 'true');
    expect(days[2]).toHaveAccessibleName('Wed Nov 4, 30m free, packed');
    expect(days[2]).toHaveClass('tight');
    expect(screen.getByText('Wed Nov 4 is packed')).toBeVisible();
    expect(screen.getByText('30m free of 5h available that day.')).toBeVisible();
    expect(days[3]).toHaveAccessibleName('Thu Nov 5, 7h free');
    // Monday was full, but it has gone by.
    expect(days[0]).toHaveAccessibleName('Mon Nov 2');
    expect(days[0]).not.toHaveClass('tight');
    expect(days[0]!.querySelector('.wfree')).toBeEmptyDOMElement();
    // The strip draws open time gone by like closed time, never in the free colour; Thursday's is still free.
    const freeLook = (day: Element) => [...day.querySelectorAll('.wshape .sl')].filter((c) => c.className.trim() === 'sl').length;
    expect(freeLook(days[0]!)).toBe(0);
    expect(freeLook(days[3]!)).toBeGreaterThan(0);
    // Today's open morning has gone by; only its evening is free.
    expect(screen.queryByText(/^Free, 7:30am/)).toBeNull();
    expect(screen.getByText('Gone by, 7:30am to 9am')).toBeVisible();
    expect(screen.getByText('Free, 9:30pm to 10pm')).toBeVisible();
    await userEvent.click(days[0]!);
    expect(await screen.findByRole('heading', { name: 'Mon Nov 2' })).toBeVisible();
    expect(screen.queryByText('Mon Nov 2 is packed')).toBeNull();
    expect(screen.getByText('One off, 5h').closest('.tlblock')).toHaveClass('c-ended');
    expect(screen.queryAllByText(/^Free, /)).toEqual([]);
    expect(screen.getByText('Gone by, 8:30am to 9am')).toBeVisible();
  });

  it('a past week still shows what was planned in it', async () => {
    await open({ now: '2026-11-09T20:00:00Z', layout: 'phone' });
    await userEvent.click(await screen.findByRole('button', { name: 'Previous week' }));
    expect(await screen.findByText('Nov 2 to Nov 8')).toBeVisible();
    expect(screen.getByText('2h 30m planned')).toBeVisible();
    expect(screen.getByText('1h projects, 30m practices, 1h one offs')).toBeVisible();
  });

  it('a past week shows no free time, and a future week all of its own', async () => {
    await midweek({ layout: 'phone' });
    await userEvent.click(await screen.findByRole('button', { name: 'Previous week' }));
    expect(await screen.findByText('Oct 26 to Nov 1')).toBeVisible();
    expect(screen.getByText('0m free')).toBeVisible();
    expect(screen.getByText('of 0m available')).toBeVisible();
    expect(within(screen.getByRole('group', { name: 'Choose a day' })).getAllByRole('button')[0]).toHaveAccessibleName('Mon Oct 26');

    await userEvent.click(screen.getByRole('button', { name: 'This week' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Next week' }));
    expect(await screen.findByText('Nov 9 to Nov 15')).toBeVisible();
    expect(screen.getByText('65h free')).toBeVisible();
    expect(screen.getByText('of 65h available')).toBeVisible();
  });

  it('the strip draws each kind of block in its own colour', async () => {
    await phone();
    const days = within(await screen.findByRole('group', { name: 'Choose a day' })).getAllByRole('button');
    // Monday has a one off, Tuesday project work, and Wednesday a practice.
    expect(days[0]!.querySelectorAll('.sl.planned.maint').length).toBeGreaterThan(0);
    expect(days[1]!.querySelectorAll('.sl.planned:not(.maint):not(.practice)').length).toBeGreaterThan(0);
    expect(days[2]!.querySelectorAll('.sl.planned.practice').length).toBeGreaterThan(0);
    expect(days[2]!.querySelectorAll('.sl.planned:not(.practice)')).toHaveLength(0);
  });

  it('a block in progress still opens, and only a finished one reads as ended', async () => {
    await phone({ seed: (w) => w.create('time_block', { task_id: 't1', start: at('13:30'), end: at('15:00'), tz: ZONE }, 'b4') });
    const now = await screen.findByRole('button', { name: /^Draft the summary, 1:30pm to 3pm/ });
    expect(now).not.toHaveClass('c-ended');
    await userEvent.click(now);
    const sheet = await screen.findByRole('dialog', { name: 'Draft the summary' });
    expect(within(sheet).queryByRole('button', { name: 'Move' })).toBeNull();
    expect(screen.getByText('Paint the fence').closest('.tlblock')).toHaveClass('c-ended');
  });

  it('a block opens a sheet: the slider changes its length, Move carries it to another day, Remove takes it off', async () => {
    const t = await phone();
    await userEvent.click(within(await screen.findByRole('group', { name: 'Choose a day' })).getAllByRole('button')[1]!);
    await userEvent.click(await screen.findByRole('button', { name: /^Draft the summary, 6pm to 7pm/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Draft the summary' });
    expect(within(sheet).getByText('Tue Nov 3, 6pm to 7pm')).toBeVisible();
    fireEvent.change(within(sheet).getByRole('slider', { name: 'Length' }), { target: { value: '90' } });
    await waitFor(async () => expect((await block('b1')(t))?.end).toBe(at('19:30', TUE)));

    await userEvent.click(within(sheet).getByRole('button', { name: 'Move' }));
    expect(await screen.findByText('Moving Draft the summary, 1h 30m, from Tue 6pm')).toBeVisible();
    await userEvent.click(within(screen.getByRole('group', { name: 'Choose a day' })).getAllByRole('button')[5]!);
    await userEvent.click(screen.getByRole('button', { name: 'Move here' }));
    await waitFor(async () => expect((await block('b1')(t))?.start).toBe(at('18:00', '2026-11-07')));

    await userEvent.click(await screen.findByRole('button', { name: /^Draft the summary, 6pm to 7:30pm/ }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Draft the summary' })).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Removed Draft the summary')).toBeVisible();
    await waitFor(async () => expect((await block('b1')(t))?.cancelled).toBe(true));
  });

  it('editing on the day: a press opens the block, a drag saves on drop, passed time is locked, the bottom edge resizes', async () => {
    const t = await phone({ seed: async (w) => { await planned(w); await w.create('time_block', { task_id: 't2', start: at('17:00'), end: at('18:00'), tz: ZONE }, 'b4'); } });
    await userEvent.click(await screen.findByRole('button', { name: "Edit this week's plan" }));
    const handle = () => screen.getByRole('slider', { name: /^Paint the fence\. Drag/ });
    // jsdom has no layout: the day from 6am to 11pm is drawn 816px tall, 48px an hour.
    const day = document.querySelector('.day')!;
    vi.spyOn(day, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 816, top: 0, left: 0, right: 300, bottom: 816, x: 0, y: 0, toJSON: () => ({}) });
    const press = (el: Element, dy: number) => {
      fireEvent.pointerDown(el, { clientY: 300, button: 0 });
      if (dy) fireEvent.pointerMove(window, { clientY: 300 + dy });
      fireEvent.pointerUp(window, { clientY: 300 + dy });
    };

    press(await waitFor(handle), 4);
    expect(await screen.findByRole('dialog', { name: 'Paint the fence' })).toBeVisible();
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Paint the fence' })).getByRole('button', { name: 'Close' }));

    press(handle(), 48);
    await waitFor(async () => expect((await block('b4')(t))?.start).toBe(at('18:00')));
    press(handle(), -1000);
    await waitFor(async () => expect((await block('b4')(t))?.start).toBe(at('14:00')));
    press(handle().querySelector('.rz')!, 24);
    await waitFor(async () => expect((await block('b4')(t))?.end).toBe(at('15:30')));
    // Monday morning has passed, so its block is drawn but doesn't move.
    expect(screen.queryByRole('slider', { name: /^Paint the fence\. Drag/ })).toBeVisible();
    expect(screen.getAllByText('Paint the fence').length).toBeGreaterThan(1);
  });

  it('draws a block as early as the desktop grid allows inside the day, where it still drags', async () => {
    await phone({ seed: async (w) => { await planned(w); await w.create('time_block', { task_id: 't2', start: at('06:15', WED), end: at('06:45', WED), tz: ZONE }, 'b4'); } });
    await userEvent.click(await screen.findByRole('button', { name: "Edit this week's plan" }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Choose a day' })).getAllByRole('button')[2]!);
    const early = await screen.findByRole('slider', { name: /^Paint the fence\. Drag/ });
    expect(parseFloat(early.style.top)).toBeGreaterThanOrEqual(0);
  });

  it("Edit this week's plan, then Add a task places one at a suggested time", async () => {
    const t = await phone({ seed: planned });
    await userEvent.click(await screen.findByRole('button', { name: "Edit this week's plan" }));
    expect(await screen.findByRole('heading', { name: 'Editing this week' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Done editing' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Add a task' }));
    const drawer = await screen.findByRole('dialog', { name: 'Add to this week' });
    await userEvent.click(within(drawer).getByRole('button', { name: /^Paint the fence/ }));
    const offers = within(drawer).getAllByRole('button', { name: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) Nov \d+, / });
    await userEvent.click(offers[0]!);
    expect(await screen.findByText(/^Placed Paint the fence, /)).toBeVisible();
    await waitFor(async () => expect((await listRecords(t.db, 'time_block')).filter((b) => b.task_id === 't2')).toHaveLength(2));
    expect(screen.queryByRole('dialog', { name: 'Add to this week' })).toBeNull();
  });

  it('Place on calendar opens the day with the block to drag; arrows move it, Place here saves, Cancel goes back', async () => {
    const close = vi.fn();
    const t = await phone({ params: { place: 't2' }, close });
    expect(await screen.findByText('Placing Paint the fence, 1h')).toBeVisible();
    const handle = screen.getByRole('slider', { name: /^Time for Paint the fence/ });
    // It is a vertical slider whose value rises as the block goes up the day, so VoiceOver's swipe up moves it up.
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    const before = Number(handle.getAttribute('aria-valuenow'));
    const said = handle.getAttribute('aria-valuetext');
    handle.focus();
    await userEvent.keyboard('{ArrowDown}');
    const slider = () => screen.getByRole('slider', { name: /^Time for Paint the fence/ });
    expect(Number(slider().getAttribute('aria-valuenow'))).toBe(before - 15);
    expect(slider().getAttribute('aria-valuetext')).not.toBe(said);
    await userEvent.keyboard('{ArrowUp}');
    expect(Number(slider().getAttribute('aria-valuenow'))).toBe(before);
    expect(slider().getAttribute('aria-valuetext')).toBe(said);
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.click(screen.getByRole('button', { name: 'Place here' }));
    await waitFor(async () => expect((await listRecords(t.db, 'time_block')).filter((b) => b.task_id === 't2')).toHaveLength(2));
    expect(close).not.toHaveBeenCalled();

    cleanup();
    await phone({ params: { place: 't1' }, close });
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(close).toHaveBeenCalled();
  });
});
