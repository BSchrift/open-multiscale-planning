// The phone's Week, now Today's: the week's strip over the day, editing and placing on Today, and the week's jobs in
// Today's menu and on the Plan tab. These were Week's phone tests until its tab went; desktop's stay in week.test.tsx.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localToInstant } from '../../../core/dates';
import { CALENDAR_ID, getRecord, listRecords, outcomeId, setWeekPick, updateSettings, weekPickId, weekPlanId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { holdDown, holdTimers, pass, renderScreen } from '../../app/testing';
import type { HarnessOptions } from '../../app/testing';
import { placePlanningParams } from '../../components/planning/usePlanning';
import type { PlanningPlace } from '../../components/planning/usePlanning';

afterEach(cleanup);
afterEach(() => localStorage.clear());

// Whether planning's estimate has been read, which a test can hold back.
const estimate = vi.hoisted(() => ({ read: true }));
vi.mock('../../components/planning/usePlanning', async (actual) => {
  const real = await actual<typeof import('../../components/planning/usePlanning')>();
  return { ...real, usePlanningTimes: (...args: Parameters<typeof real.usePlanningTimes>) => (estimate.read ? real.usePlanningTimes(...args) : null) };
});
afterEach(() => void (estimate.read = true));

// The harness clock reads Monday, Nov 2 at 2pm in Chicago.
const ZONE = 'America/Chicago';
const MON = '2026-11-02';
const TUE = '2026-11-03';
const WED = '2026-11-04';
const at = (time: string, date = MON) => {
  const [h, m] = time.split(':').map(Number);
  return localToInstant(date, h! * 60 + (m ?? 0), ZONE);
};

/** The week Week's tests use: closed overnight and on weekday working hours, with a block on Monday to Wednesday. */
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
  renderScreen('today', { zone: ZONE, layout: 'phone', ...options, seed: async (w) => { await week(w); await options.seed?.(w); } });

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
      await options.seed?.(w);
    },
  });

/** Chooses from Today's title menu, which holds the view, the zoom and the week's jobs. */
const fromMenu = async (name: string) => {
  await userEvent.click(await screen.findByRole('button', { name: 'View and week' }));
  await userEvent.click(within(await screen.findByRole('menu', { name: 'View and week' })).getByRole('menuitem', { name }));
};
const menuItems = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'View and week' }));
  const menu = await screen.findByRole('menu', { name: 'View and week' });
  const names = within(menu).getAllByRole('menuitem').map((el) => el.textContent);
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  return names;
};
const edit = async () => {
  await fromMenu("Edit this week's plan");
  expect(await screen.findByRole('button', { name: 'Done editing' })).toBeVisible();
};
// The first render in a run also loads Today's and the week's modules, so the first look waits longer.
const FIRST = { timeout: 5000 };
const strip = async () => within(await screen.findByRole('group', { name: 'Choose a day' }, FIRST)).getAllByRole('button');
const heading = (name: string) => screen.findByRole('heading', { level: 1, name }, FIRST);
/** Opens a block from the day: on Today the first tap selects it, raising it as a card, and a second opens it. */
const openFromDay = async (el: HTMLElement) => {
  await userEvent.click(el);
  await waitFor(() => expect(el.getAttribute('aria-label')).toMatch(/Selected\.$/));
  await userEvent.click(el);
};

describe('this week before it is planned, on Today', () => {
  it('asks to plan from the strip footer instead of offering to edit, and Start planning opens planning', async () => {
    const t = await open();
    expect(await screen.findByText('Not planned yet')).toBeVisible();
    expect(await menuItems()).not.toContain("Edit this week's plan");
    await userEvent.click(screen.getByRole('button', { name: 'Plan this week' }));
    const sheet = await screen.findByRole('dialog', { name: 'Plan this week' });
    expect(within(sheet).getByText("This week isn't planned yet")).toBeVisible();
    expect(await within(sheet).findByText('About 30m to plan')).toBeVisible();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Start planning' }));
    await waitFor(() => expect(t.nav().flow).toMatchObject({ area: 'planning' }));
  });

  it('asks before its estimate is read, so nothing under the question moves when the estimate arrives', async () => {
    // The estimate is its own read, which on a long history waits behind the week's: on 19 November it came seconds
    // after To schedule, and the question it brought moved a card from under the finger.
    estimate.read = false;
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Plan this week' }));
    const sheet = await screen.findByRole('dialog', { name: 'Plan this week' });
    expect(within(sheet).getByText("This week isn't planned yet")).toBeVisible();
    expect(within(sheet).getByRole('button', { name: 'Start planning' })).toBeDisabled();
    expect(within(sheet).getByRole('button', { name: 'Choose a time to plan this week' })).toBeVisible();
  });

  it("Skip puts it away for the week on every device, and the menu offers Edit this week's plan again", async () => {
    const t = await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Plan this week' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Plan this week' })).getByRole('button', { name: 'Skip planning this week' }));
    await waitFor(async () => expect((await getRecord(t.db, 'week_plan', weekPlanId(MON)))?.planning_skipped_at).toBeTruthy());
    await waitFor(() => expect(screen.queryByText('Not planned yet')).toBeNull());
    expect(await menuItems()).toContain("Edit this week's plan");
  });

  it('says when planning is set for later, in place of the prompt, with Start now', async () => {
    const t = await open({
      seed: async (w) => {
        await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 2' }, 'planning:week:2026-11-02');
        await w.create('time_block', { task_id: 'planning:week:2026-11-02', start: '2026-11-04T00:00:00Z', end: '2026-11-04T00:30:00Z', tz: 'America/Chicago' }, 'p1');
      },
    });
    const set = await screen.findByRole('region', { name: 'Planning is set for Tue 6pm.' });
    expect(screen.queryByRole('button', { name: 'Plan this week' })).toBeNull();
    await userEvent.click(within(set).getByRole('button', { name: 'Start now' }));
    expect(t.nav().flow).toEqual({ area: 'planning', params: { week: '2026-11-02' } });
  });

  it("Plan next week, on the Plan tab's Next week, starts planning it, with a block from now", async () => {
    const t = await renderScreen('plan', { zone: ZONE, layout: 'phone', seed: async (w) => { await week(w); await planned(w); } });
    // The Plan page is a module of its own, loaded on its first render in a run.
    await userEvent.click(within(await screen.findByRole('region', { name: 'Next week' }, FIRST)).getByRole('button', { name: 'Plan next week' }));
    await waitFor(() => expect(t.nav().flow).toEqual({ area: 'planning', params: { week: '2026-11-09' } }));
    await waitFor(async () =>
      expect((await listRecords(t.db, 'time_block')).filter((b) => b.task_id === 'planning:week:2026-11-09')).toMatchObject([{ started_at: '2026-11-02T20:00:00Z' }]),
    );
    expect(await screen.findByText('Planning until 2:30pm.')).toBeVisible();
  });

  it("once planned, the menu offers Edit this week's plan and the footer no prompt", async () => {
    await open({ seed: planned });
    expect(await menuItems()).toContain("Edit this week's plan");
    expect(screen.queryByRole('button', { name: 'Plan this week' })).toBeNull();
    expect(screen.queryByText('Not planned yet')).toBeNull();
  });
});

describe("a block landing on another while editing this week's plan on Today", () => {
  // Draft the summary is Tuesday 6pm to 7pm, beside Quiz night, a calendar event; Paint the fence follows at 7pm.
  const seed = async (w: Writer) => {
    await planned(w);
    await w.create('time_block', { task_id: 't2', start: at('19:00', TUE), end: at('20:00', TUE), tz: ZONE }, 'b4');
  };
  const step = async () => {
    await edit();
    await userEvent.click((await strip())[1]!);
    const el = await screen.findByRole('slider', { name: /^Draft the summary\./ });
    el.focus();
    // A quarter hour later it runs into Paint the fence. Quiz night, another calendar's, never asks.
    await userEvent.keyboard('{ArrowDown}');
    return screen.findByRole('dialog', { name: 'Schedule both at the same time?' });
  };

  it('asks, and Replace sends the block landed on back to To schedule', async () => {
    const t = await open({ seed });
    await userEvent.click(within(await step()).getByRole('button', { name: 'Replace' }));
    await waitFor(async () => expect((await block('b1')(t))?.start).toBe(at('18:15', TUE)));
    await waitFor(async () => expect((await block('b4')(t))?.cancelled).toBe(true));
    expect(await screen.findByText('Took Paint the fence off the calendar')).toBeVisible();
  });

  it("Replace takes nothing off when the block's own save fails", async () => {
    const t = await open({ seed });
    const ask = await step();
    vi.spyOn(t.db, 'transaction').mockRejectedValueOnce(new Error('disk full'));
    await userEvent.click(within(ask).getByRole('button', { name: 'Replace' }));
    await waitFor(() => expect(screen.getByText("Couldn't save that. Try again.")).toBeVisible());
    expect((await block('b1')(t))?.start).toBe(at('18:00', TUE));
    expect((await block('b4')(t))?.cancelled).toBeFalsy();
  });

  it('Keep both, with Enter, keeps both; Cancel leaves it where it was', async () => {
    const t = await open({ seed });
    await step();
    await userEvent.keyboard('{Enter}');
    await waitFor(async () => expect((await block('b1')(t))?.start).toBe(at('18:15', TUE)));
    expect((await block('b4')(t))?.cancelled).toBeFalsy();
    cleanup();

    const again = await open({ seed });
    await userEvent.click(within(await step()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Schedule both at the same time?' })).toBeNull());
    expect((await block('b1')(again))?.start).toBe(at('18:00', TUE));
  });
});

describe("a task's block made shorter while editing this week's plan on Today", () => {
  // Paint the fence, estimated at an hour, picked for 1h this week and placed Monday 5pm to 6pm.
  const fence = async (w: Writer) => {
    await planned(w);
    await setWeekPick(w, MON, 't2', 60);
    await w.create('time_block', { task_id: 't2', start: at('17:00'), end: at('18:00'), tz: ZONE }, 'b4');
  };
  const slider = () => screen.findByRole('slider', { name: /^Paint the fence\./ });
  const shorten = async () => {
    await edit();
    // Shift and an arrow change a block's length: twice is half an hour off.
    (await slider()).focus();
    await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}');
    await screen.findByRole('group', { name: 'What about the other 15m?' });
    (await slider()).focus();
    await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}');
    return screen.findByRole('group', { name: 'What about the other 30m?' });
  };

  it('asks what about the rest, and Change the estimate takes it off the task and its week, with Undo', async () => {
    const t = await open({ seed: fence });
    const ask = await shorten();
    await userEvent.click(within(ask).getByRole('button', { name: 'Change the estimate' }));
    expect(await screen.findByText('Paint the fence is now 30m. Its estimate was 1h.')).toBeVisible();
    await waitFor(async () => expect(await getRecord(t.db, 'task', 't2')).toMatchObject({ estimate_min: 30 }));
    expect(await getRecord(t.db, 'week_pick', weekPickId(MON, 't2'))).toMatchObject({ minutes: 30 });
    expect(screen.queryByRole('group', { name: /^What about the other/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await getRecord(t.db, 'task', 't2')).toMatchObject({ estimate_min: 60 }));
  });

  it('Split it keeps the rest to schedule, as leaving it does, and Undo puts the block back', async () => {
    const t = await open({ seed: fence });
    const ask = await shorten();
    await userEvent.click(within(ask).getByRole('button', { name: 'Split it' }));
    expect(await screen.findByText('Split Paint the fence: 30m stays to schedule.')).toBeVisible();
    expect(await getRecord(t.db, 'task', 't2')).toMatchObject({ estimate_min: 60 });
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await block('b4')(t))?.end).toBe(at('18:00')));
  });

  it("doesn't ask when a block gets longer, or for a practice's session", async () => {
    const t = await open({ seed: fence });
    await edit();
    (await slider()).focus();
    await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');
    await waitFor(async () => expect((await block('b4')(t))?.end).toBe(at('18:15')));
    expect(await slider()).toHaveAttribute('aria-valuetext', 'Mon Nov 2, 5pm to 6:15pm');
    expect(screen.queryByRole('group', { name: /^What about the other/ })).toBeNull();

    // Wednesday's session a quarter hour shorter: a practice has no rest to schedule.
    await userEvent.click((await strip())[2]!);
    (await screen.findByRole('slider', { name: /^Piano practice\./ })).focus();
    await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}');
    await waitFor(async () => expect((await block('b2')(t))?.end).toBe(at('07:15', WED)));
    expect(screen.queryByRole('group', { name: /^What about the other/ })).toBeNull();
  });
});

describe("the week's strip on Today", () => {
  it('arrows clicked before a week loads each still count', async () => {
    await open();
    await heading('Today');
    const previous = screen.getByRole('button', { name: 'Previous week' });
    for (let i = 0; i < 3; i++) fireEvent.click(previous);
    expect(await screen.findByText('Oct 12 to Oct 18')).toBeVisible();
  });
});

describe("To schedule, from Today's strip footer and while editing", () => {
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
  // Held first, as a card or block lifts to drag only after a hold.
  const drag = (el: Element, to: { x: number; y: number }) => {
    holdDown(el, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: to.x, clientY: to.y });
    fireEvent.pointerUp(window, { clientX: to.x, clientY: to.y });
  };
  const waitingSheet = async () => {
    await userEvent.click(await screen.findByRole('button', { name: /^\d+ to schedule/ }));
    return screen.findByRole('dialog', { name: 'To schedule' });
  };
  afterEach(() => Reflect.deleteProperty(document, 'elementFromPoint'));

  it("a card in the footer's sheet opens its suggested times in a sheet of its own, and one places it", async () => {
    const t = await open({ seed: picks });
    // Today is Monday, so the sheet shows Monday's session.
    const waiting = within(await waitingSheet()).getByRole('region', { name: 'Waiting for a day' });
    await userEvent.click(within(waiting).getByRole('button', { name: 'Piano practice, Practice, 30 minutes on Monday, to schedule' }));
    const sheet = await screen.findByRole('dialog', { name: 'Piano practice' });
    await userEvent.click(within(within(sheet).getByRole('group', { name: 'Suggested times for Piano practice' })).getAllByRole('button')[0]!);
    await waitFor(async () => expect(await live(t, (b) => b.practice_id === 'pr')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Piano practice, Practice, 30 minutes on Monday/ })).toBeNull());
  });

  it("while editing, Choose a time on a practice's card puts its session on the calendar to place by hand", async () => {
    const t = await open({ seed: picks });
    await edit();
    await userEvent.click(within(screen.getByRole('region', { name: 'To schedule' })).getByRole('button', { name: 'Piano practice, Practice, 30 minutes on Monday, to schedule' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Piano practice' })).getByRole('button', { name: 'Choose a time' }));
    expect(await screen.findByText('Placing Piano practice, 30m')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Place here' }));
    await waitFor(async () => expect((await block('session:pr:2026-11-02')(t))?.deleted_at).toBeFalsy());
    expect(await block('session:pr:2026-11-02')(t)).toBeTruthy();
  });

  it("Choose a time from a card places a set day's session by hand, for its own day", async () => {
    const close = vi.fn();
    const t = await open({ seed: picks, params: { place: 'pr:2026-11-05' }, close });
    expect(await screen.findByText('Placing Piano practice, 30m')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Place here' }));
    await waitFor(async () => expect(await block('session:pr:2026-11-05')(t)).toBeTruthy());
    expect(await live(t, (b) => b.practice_id === 'pr')).toHaveLength(2);
    expect(close).not.toHaveBeenCalled();
  });

  it("a card in the footer's sheet held then dragged onto the day is placed at the time under the finger, which its ghost says", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const t = await open({ seed: picks });
      const card = within(await waitingSheet()).getByRole('button', { name: /^Piano practice, Practice/ });
      // jsdom has no layout: the day is drawn 450px tall from the minute it opens at to the one it ends at.
      const day = document.querySelector<HTMLElement>('.day[data-drop-date="2026-11-02"]')!;
      const [from, to] = [Number(day.dataset.dropFrom), Number(day.dataset.dropTo)];
      const y = ((18 * 60 - from) / (to - from)) * 450;
      rect(day, 450);
      pointAt(() => day);
      fireEvent.pointerDown(card, { clientX: 10, clientY: 10, button: 0, pointerType: 'touch' });
      act(() => void vi.advanceTimersByTime(450));
      expect(document.querySelector('.cardghost')).not.toBeNull();
      fireEvent.pointerMove(window, { clientX: 50, clientY: y, pointerType: 'touch' });
      expect(document.querySelector('.cardghost .ghostwhen')).toHaveTextContent('6pm');
      fireEvent.pointerUp(window, { clientX: 50, clientY: y, pointerType: 'touch' });
      await waitFor(async () => expect((await live(t, (b) => b.practice_id === 'pr')).map((b) => b.start)).toContain(at('18:00')));
    } finally {
      vi.useRealTimers();
    }
  });

  it('while editing, cards drag onto the day and blocks drag back up', async () => {
    const t = await open({ seed: async (w) => { await picks(w); await w.create('time_block', { task_id: 't2', start: at('17:00'), end: at('18:00'), tz: ZONE }, 'b4'); } });
    await edit();
    // Monday's 6am to 11pm drawn 1224px tall, 72px an hour, so y 936 is 7pm.
    const day = document.querySelector('.dragday[data-drop-date="2026-11-02"]')!;
    rect(day, 1224);
    pointAt(() => day);
    drag(await screen.findByRole('button', { name: /^Piano practice, Practice/ }), { x: 50, y: 936 });
    await waitFor(async () => expect((await live(t, (b) => b.practice_id === 'pr')).map((b) => b.start)).toContain(at('19:00')));

    pointAt(() => screen.getByRole('region', { name: 'To schedule' }));
    holdDown(screen.getByRole('slider', { name: /^Paint the fence\. Hold, then drag/ }), { clientY: 300 });
    fireEvent.pointerMove(window, { clientY: 0 });
    fireEvent.pointerUp(window, { clientY: 0 });
    await waitFor(async () => expect((await block('b4')(t))?.cancelled).toBe(true));
    expect(await screen.findByRole('button', { name: /^Paint the fence, One off, 1h/ })).toBeVisible();
  });
});

describe("the week's strip and figures on Today", () => {
  it("a strip of seven days over the chosen day, with today marked; another day tapped shows its blocks and its calendar's events", async () => {
    await open();
    const days = await strip();
    expect(days).toHaveLength(7);
    expect(days[0]).toHaveAttribute('aria-pressed', 'true');
    expect(days[0]).toHaveAccessibleName(/^Mon Nov 2, .* free/);
    await heading('Today');

    await userEvent.click(days[1]!);
    await heading('Tomorrow');
    const day = screen.getByRole('region', { name: "Today's timeline" });
    expect(await within(day).findByRole('slider', { name: 'Draft the summary, 6pm to 7pm, Project. Conflicts with Quiz night.' })).toBeVisible();
    expect(within(day).getByText('Quiz night').closest('.cev')).toHaveClass('k-event');
    // Today stays marked with another day chosen.
    expect(days[0]).toHaveAttribute('aria-current', 'date');
    expect(days[0]).toHaveClass('today');
    expect(days[1]).not.toHaveAttribute('aria-current');
  });

  it('a day gone by has a row that opens Done on that day; today and a later day have none', async () => {
    const t = await midweek();
    await heading('Today');
    expect(screen.queryByRole('button', { name: /^Done on/ })).toBeNull();
    await userEvent.click((await strip())[3]!);
    await heading('Tomorrow');
    expect(screen.queryByRole('button', { name: /^Done on/ })).toBeNull();
    await userEvent.click((await strip())[1]!);
    await heading('Yesterday');
    await userEvent.click(await screen.findByRole('button', { name: 'Done on Tue Nov 3: nothing finished' }));
    expect(t.nav().route).toMatchObject({ area: 'done', params: { day: TUE } });
  });

  it('mid-week, counts only time still ahead: a past day shows what happened, never free or packed', async () => {
    await midweek({ seed: planned });
    const days = await strip();
    expect(screen.getByText('12h planned')).toBeVisible();
    expect(screen.getByText('44h 30m free')).toBeVisible();
    // Today has only its evening left, so it's packed. Under each day, its hours planned.
    expect(days[2]).toHaveAttribute('aria-pressed', 'true');
    expect(days[2]).toHaveAccessibleName('Wed Nov 4, 30m free, packed, 5h planned');
    expect(days[2]).toHaveClass('tight');
    expect(screen.getByText('Wed Nov 4 is packed')).toBeVisible();
    expect(screen.getByText('30m free of 5h available that day.')).toBeVisible();
    expect(days[3]).toHaveAccessibleName('Thu Nov 5, 7h free');
    // Monday was full, but it has gone by, so it says only what was planned.
    expect(days[0]).toHaveAccessibleName('Mon Nov 2, 6h planned');
    expect(days[0]).not.toHaveClass('tight');
    // The strip draws open time gone by like closed time, never in the free colour; Thursday's is still free.
    const freeLook = (day: Element) => day.querySelectorAll('.wshape .sl.free').length;
    expect(freeLook(days[0]!)).toBe(0);
    expect(freeLook(days[3]!)).toBeGreaterThan(0);

    await userEvent.click(days[0]!);
    await heading('Monday');
    expect(screen.queryByText('Mon Nov 2 is packed')).toBeNull();
    const day = screen.getByRole('region', { name: "Today's timeline" });
    expect((await within(day).findByRole('button', { name: /^Paint the fence, 5pm to 10pm, One off\./ })).className).toMatch(/\bs-(done|partly|notdone|goneby)\b/);
  });

  it("the Plan tab's This week says, mid-week, what's planned by kind and the time still free", async () => {
    await renderScreen('plan', {
      zone: ZONE,
      layout: 'phone',
      now: '2026-11-04T18:00:00Z',
      seed: async (w) => {
        await week(w);
        await planned(w);
        await w.create('time_block', { task_id: 't2', start: at('17:00'), end: at('22:00'), tz: ZONE }, 'b4');
        await w.create('time_block', { task_id: 't1', start: at('17:00', WED), end: at('21:30', WED), tz: ZONE }, 'b5');
      },
    });
    // The Plan page is a module of its own, loaded on its first render in a run.
    const card = await screen.findByRole('region', { name: 'This week' }, FIRST);
    expect(within(card).getByText(/^12h planned, 44h 30m free\b/)).toBeVisible();
    expect(within(card).getByText('5h 30m projects, 30m practices, 6h one offs.')).toBeVisible();
  });

  it('a past week still shows what was planned in it', async () => {
    // Tuesday's block was started, so the app was in use since Monday's went unanswered: Today doesn't open on Welcome
    // back a week later.
    await open({ now: '2026-11-09T20:00:00Z', seed: (w) => w.set('time_block', 'b1', { started_at: at('18:00', TUE) }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Previous week' }));
    expect(await screen.findByText('Nov 2 to Nov 8')).toBeVisible();
    expect(screen.getByText('2h 30m planned')).toBeVisible();
  });

  it('a past week shows no free time, and a future week all of its own', async () => {
    await midweek();
    await userEvent.click(await screen.findByRole('button', { name: 'Previous week' }));
    expect(await screen.findByText('Oct 26 to Nov 1')).toBeVisible();
    expect(screen.getByText('0m free')).toBeVisible();
    expect((await strip())[0]).toHaveAccessibleName('Mon Oct 26');

    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    await heading('Today');
    await userEvent.click(await screen.findByRole('button', { name: 'Next week' }));
    expect(await screen.findByText('Nov 9 to Nov 15')).toBeVisible();
    expect(screen.getByText('65h free')).toBeVisible();
  });

  it('the strip draws each kind of block in its own colour', async () => {
    await open();
    const days = await strip();
    // Monday has a one off, Tuesday project work, and Wednesday a practice.
    expect(days[0]!.querySelectorAll('.sl.planned.maint').length).toBeGreaterThan(0);
    expect(days[1]!.querySelectorAll('.sl.planned:not(.maint):not(.practice)').length).toBeGreaterThan(0);
    expect(days[2]!.querySelectorAll('.sl.planned.practice').length).toBeGreaterThan(0);
    expect(days[2]!.querySelectorAll('.sl.planned:not(.practice)')).toHaveLength(0);
  });

  it("the strip draws a day's free time as free, never in busy's colour, in the colours planning's legend keys", async () => {
    await open();
    const days = await strip();
    // Tuesday is open 7am to 9am and 5pm to 10pm, with project work at 6pm and Quiz night until 7:30pm.
    const tue = [...days[1]!.querySelectorAll('.wshape .sl')].map((s) => s.className.replace(/^sl /, ''));
    expect(new Set(tue)).toEqual(new Set(['closed', 'free', 'planned', 'busy']));
    expect(tue.filter((c) => c === 'free')).toHaveLength(11);
    expect(tue.filter((c) => c === 'busy')).toHaveLength(1);
    // Planning's Schedule step keys the strip's colours in a legend, so each is drawn the same in both.
    const sheet = readFileSync(join(import.meta.dirname, '../../styles/phone.css'), 'utf8');
    const fill = (selector: string) => sheet.match(new RegExp(`${selector.replaceAll('.', '\\.')}\\{[^}]*background:([^;}]+)`))?.[1];
    for (const look of ['free', 'planned', 'busy', 'closed']) expect(fill(`.sl.${look}`), look).toBe(fill(`.skey.${look}`));
    expect(fill('.sl.free')).not.toBe(fill('.sl.busy'));
    // Free is the light track desktop's time bar draws it as.
    expect(fill('.sl.free')).toBe('var(--wash)');
    expect(fill('.sl.closed')).toBe('transparent');
  });
});

/**
 * One finger swiped sideways across Today's day from `el`, by `dx`, as pointer events. jsdom has no layout, so the
 * day is given a width, and reduced motion settles the swipe at once rather than by a spring.
 */
function swipeDay(el: Element, dx: number, y = 10) {
  const frame = el.closest<HTMLElement>('.dpager')!;
  Object.defineProperty(frame, 'clientWidth', { value: 300, configurable: true });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} }));
  try {
    const at = (i: number) => ({ clientX: 200 + (dx * i) / 10, clientY: y, pointerType: 'touch', pointerId: 7 });
    fireEvent.pointerDown(el, { ...at(0), button: 0 });
    for (let i = 1; i <= 10; i++) fireEvent.pointerMove(window, at(i));
    fireEvent.pointerUp(window, at(10));
  } finally {
    vi.unstubAllGlobals();
  }
}

/** Paint the fence at 5pm today, still to come, with the week planned. */
const fenceAt5 = async (w: Writer) => {
  await planned(w);
  await w.create('time_block', { task_id: 't2', start: at('17:00'), end: at('18:00'), tz: ZONE }, 'b4');
};

describe("the week's blocks on Today's day", () => {
  it('a block in progress opens its popup with Start, and only a finished one reads as ended', async () => {
    await open({ seed: async (w) => { await planned(w); await w.create('time_block', { task_id: 't1', start: at('13:30'), end: at('15:00'), tz: ZONE }, 'b4'); } });
    const now = await screen.findByRole('button', { name: /^Draft the summary, 1:30pm to 3pm, Project\. Now\./ }, FIRST);
    expect(now).toHaveClass('s-now');
    await openFromDay(now);
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    expect(within(popup).getByRole('button', { name: 'Delete task' })).toBeVisible();
    expect(within(popup).getByRole('button', { name: 'Start' })).toBeVisible();
    await userEvent.click(within(popup).getByRole('button', { name: 'Cancel' }));
    // Half an hour in and not started, Today asks once the popup is closed; asked again later, it goes.
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Have you started?' })).getByRole('button', { name: 'Ask again in 10 minutes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // This morning's block is folded into the Earlier row, as the day opens an hour before the one under way.
    await userEvent.click(screen.getByRole('button', { name: /^Earlier, / }));
    expect((await screen.findByRole('button', { name: /^Paint the fence, 7:30am to 8:30am/ })).className).toMatch(/\bs-(done|partly|notdone|goneby)\b/);
  });

  it("a task's block gone by opens its popup too, which asks how it went and saves the answer with Undo", async () => {
    const t = await open({ seed: planned });
    await openFromDay(await screen.findByRole('button', { name: /^Paint the fence, 7:30am to 8:30am/ }, FIRST));
    const popup = await screen.findByRole('dialog', { name: 'Paint the fence' });
    const asks = within(popup).getByRole('group', { name: 'How did it go?' });
    await userEvent.click(within(asks).getByRole('button', { name: 'Not done' }));
    expect(await screen.findByText("Paint the fence: not done. It's in Needs a new time.")).toBeVisible();
    await waitFor(async () => expect((await getRecord(t.db, 'block_outcome', outcomeId('b3')))?.result).toBe('not'));
    // Answered, the question goes and the section says how it went.
    await waitFor(() => expect(within(popup).queryByRole('group', { name: 'How did it go?' })).toBeNull());
    expect(within(within(popup).getByRole('region', { name: 'Time block' })).getByText('Not done')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'block_outcome', outcomeId('b3')))?.deleted_at).toBeTruthy());
  });

  it("a practice's session on another day opens its popup, with its block's Move…", async () => {
    await open();
    await userEvent.click((await strip())[2]!);
    await openFromDay(await screen.findByRole('slider', { name: /^Piano practice, 7am to 7:30am/ }));
    const popup = await screen.findByRole('dialog', { name: 'Piano practice' });
    expect(within(popup).queryByRole('button', { name: 'Delete task' })).toBeNull();
    expect(within(within(popup).getByRole('region', { name: 'Time block' })).getByRole('button', { name: 'Move…' })).toBeVisible();
  });

  it('marks the current time on today, and not on another day', async () => {
    await open();
    await heading('Today');
    const line = screen.getByRole('img', { name: 'Current time' });
    expect(screen.getByRole('region', { name: "Today's timeline" })).toContainElement(line);
    await userEvent.click((await strip())[1]!);
    await heading('Tomorrow');
    expect(screen.queryByRole('img', { name: 'Current time' })).toBeNull();
  });

  it('marks the current time while editing too', async () => {
    await open({ seed: planned });
    await edit();
    const line = await screen.findByRole('img', { name: 'Current time' });
    expect(line.closest('.dragday')).not.toBeNull();
    // 8 hours after 6am, at Today's 72px an hour.
    expect(line).toHaveStyle({ top: `${8 * 72}px` });
  });

  it('while editing, draws the line over closed and gone time but before blocks, so it passes behind the one under way', async () => {
    await open({
      seed: async (w) => {
        await planned(w);
        await w.create('time_block', { task_id: 't1', start: at('13:00'), end: at('15:00'), tz: ZONE }, 'b9');
      },
    });
    await edit();
    const line = await screen.findByRole('img', { name: 'Current time' });
    const day = [...line.parentElement!.children];
    const before = (e: Element) => !!(e.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING);
    const zones = day.filter((e) => e.matches('.dzone'));
    const drawn = day.filter((e) => e.matches('.cev'));
    expect(zones.length).toBeGreaterThan(0);
    expect(drawn.length).toBeGreaterThanOrEqual(2);
    expect(zones.every(before)).toBe(true);
    expect(drawn.some(before)).toBe(false);
  });

  it("a task's block opens the task's popup: Move… carries it to another day, Choose a time… carries it on the strip, Remove from calendar takes it off", async () => {
    const t = await open();
    await userEvent.click((await strip())[1]!);
    const opener = await screen.findByRole('slider', { name: /^Draft the summary, 6pm to 7pm/ });
    expect(opener).toHaveAttribute('aria-haspopup', 'dialog');
    await openFromDay(opener);
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    await waitFor(() => expect(within(popup).getByRole('heading', { name: 'Draft the summary' })).toHaveFocus());
    expect(within(popup).getByRole('button', { name: 'Delete task' })).toBeVisible();
    const section = within(popup).getByRole('region', { name: 'Time block' });
    expect(within(section).getByText('Tue Nov 3, 6pm to 7pm')).toBeVisible();

    // The next day at the same time, as Today's Move to has it, with Undo.
    await userEvent.click(within(section).getByRole('button', { name: 'Move…' }));
    await userEvent.click(within(await screen.findByRole('menu', { name: 'Move to' })).getByRole('menuitem', { name: 'Wed Nov 4, 6pm' }));
    expect(await screen.findByText('Moved Draft the summary to Wed Nov 4, 6pm.')).toBeVisible();
    await waitFor(async () => expect(await block('b1')(t)).toMatchObject({ start: at('18:00', WED), end: at('19:00', WED) }));
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await block('b1')(t))?.start).toBe(at('18:00', TUE)));

    // Choose a time places it by hand, here on Today, and the strip carries it to another day. The popup is Tuesday's,
    // so its block's section went with the block to Wednesday and came back with Undo.
    await userEvent.click(within(await within(popup).findByRole('region', { name: 'Time block' })).getByRole('button', { name: 'Move…' }));
    await userEvent.click(within(await screen.findByRole('menu', { name: 'Move to' })).getByRole('menuitem', { name: 'Choose a time…' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Moving Draft the summary, 1h, from Tue 6pm')).toBeVisible();
    await userEvent.click((await strip())[5]!);
    await userEvent.click(screen.getByRole('button', { name: 'Move here' }));
    await waitFor(async () => expect((await block('b1')(t))?.start).toBe(at('18:00', '2026-11-07')));

    // Its Length slider, in 5-minute steps, as Week's popup had it: the way to change it without a drag.
    await openFromDay(await screen.findByRole('slider', { name: /^Draft the summary, 6pm to 7pm/ }));
    const length = within(await screen.findByRole('dialog', { name: 'Draft the summary' })).getByRole('slider', { name: 'Length' });
    expect(length).toHaveAttribute('step', '5');
    fireEvent.change(length, { target: { value: '45' } });
    await waitFor(async () => expect((await block('b1')(t))?.end).toBe(at('18:45', '2026-11-07')));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Draft the summary' })).getByRole('button', { name: 'Remove from calendar' }));
    expect(await screen.findByText("Took Draft the summary off the calendar. It's in To schedule.")).toBeVisible();
    await waitFor(async () => expect((await block('b1')(t))?.cancelled).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await block('b1')(t))?.cancelled).toBeNull());
  });
});

describe("editing this week's plan on Today's day", () => {
  /** jsdom has no layout: the drawn day from 6am to 11pm is 1224px tall, Today's 72px an hour. */
  const drawnDay = () => {
    const day = document.querySelector('.day.dragday')!;
    vi.spyOn(day, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 1224, top: 0, left: 0, right: 300, bottom: 1224, x: 0, y: 0, toJSON: () => ({}) });
  };
  const handle = () => screen.getByRole('slider', { name: /^Paint the fence\. Hold, then drag/ });

  it('a press opens the block, a drag saves on drop, passed time is locked, the bottom edge resizes', async () => {
    const t = await open({ seed: fenceAt5 });
    await edit();
    drawnDay();
    // Let go before the hold, a press is a tap, wobble and all; a drag is held first.
    const press = (el: Element, dy: number, held = true) => {
      if (held) holdDown(el, { clientY: 300 });
      else fireEvent.pointerDown(el, { clientY: 300, button: 0 });
      if (dy) fireEvent.pointerMove(window, { clientY: 300 + dy });
      fireEvent.pointerUp(window, { clientY: 300 + dy });
    };

    press(await waitFor(handle), 4, false);
    const popup = await screen.findByRole('dialog', { name: 'Paint the fence' });
    expect(within(popup).getByRole('region', { name: 'Time block' })).toBeVisible();
    await userEvent.click(within(popup).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    press(handle(), 72);
    await waitFor(async () => expect((await block('b4')(t))?.start).toBe(at('18:00')));
    press(handle(), -1500);
    await waitFor(async () => expect((await block('b4')(t))?.start).toBe(at('14:00')));
    press(handle().querySelector('.rz')!, 36);
    await waitFor(async () => expect((await block('b4')(t))?.end).toBe(at('15:30')));
    // Monday morning has passed, so its block is drawn but doesn't move.
    expect(screen.queryByRole('slider', { name: /^Paint the fence\. Hold, then drag/ })).toBeVisible();
    expect(screen.getAllByText('Paint the fence').length).toBeGreaterThan(1);
  });

  it('a block dragged, or made shorter, goes back where it was when its save fails, and nothing asks about the rest', async () => {
    const t = await open({ seed: async (w) => { await fenceAt5(w); await setWeekPick(w, MON, 't2', 60); } });
    await edit();
    drawnDay();
    const failing = (el: Element, dy: number) => {
      vi.spyOn(t.db, 'transaction').mockRejectedValueOnce(new Error('disk full'));
      holdDown(el, { clientY: 300 });
      fireEvent.pointerMove(window, { clientY: 300 + dy });
      fireEvent.pointerUp(window, { clientY: 300 + dy });
    };
    // The same toast each time, drawn afresh, so it's looked for until it settles.
    const failed = async () => {
      await waitFor(() => expect(screen.getByText("Couldn't save that. Try again.")).toBeVisible());
      await waitFor(() => expect(handle()).toHaveAttribute('aria-valuetext', 'Mon Nov 2, 5pm to 6pm'));
      expect(await block('b4')(t)).toMatchObject({ start: at('17:00'), end: at('18:00') });
    };

    // An hour later.
    failing(await waitFor(handle), 72);
    await failed();
    // Half an hour shorter: nothing asks about the half hour.
    failing(handle().querySelector('.rz')!, -36);
    await failed();
    expect(screen.queryByRole('group', { name: /^What about the other/ })).toBeNull();
  });

  it('draws a block as early as the desktop grid allows inside the day, where it still drags', async () => {
    await open({ seed: async (w) => { await planned(w); await w.create('time_block', { task_id: 't2', start: at('06:15', WED), end: at('06:45', WED), tz: ZONE }, 'b4'); } });
    await edit();
    await userEvent.click((await strip())[2]!);
    const early = await screen.findByRole('slider', { name: /^Paint the fence\. Hold, then drag/ });
    expect(parseFloat(early.style.top)).toBeGreaterThanOrEqual(0);
  });

  it("Add a task in the tray places one at a suggested time", async () => {
    const t = await open({ seed: planned });
    await edit();
    expect(screen.getByText('Editing this week')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Add a task' }));
    const drawer = await screen.findByRole('dialog', { name: 'Add to this week' });
    await userEvent.click(within(drawer).getByRole('button', { name: /^Paint the fence/ }));
    const offers = within(drawer).getAllByRole('button', { name: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) Nov \d+, / });
    await userEvent.click(offers[0]!);
    expect(await screen.findByText(/^Placed Paint the fence, /)).toBeVisible();
    await waitFor(async () => expect((await listRecords(t.db, 'time_block')).filter((b) => b.task_id === 't2')).toHaveLength(2));
    expect(screen.queryByRole('dialog', { name: 'Add to this week' })).toBeNull();
  });

  it('blocks at the same time sit side by side on the drawn day, each named with what it overlaps', async () => {
    await open({ seed: async (w) => { await planned(w); await together(w); } });
    await edit();
    await userEvent.click((await strip())[4]!);
    const plan = await screen.findByRole('slider', { name: /^Plan the week of Nov 9\. Overlaps Plan meals for the week\. Hold, then drag/ });
    const meals = screen.getByRole('slider', { name: /^Plan meals for the week\. Overlaps Plan the week of Nov 9\. Hold, then drag/ });
    sideBySide([plan, meals]);
    expect(plan).toHaveAttribute('aria-valuetext', 'Fri Nov 6, 5:30pm to 6:45pm');
    expect(plan.style.top).toBe(meals.style.top);
    // Planning is busy time too, but it's drawn once, as its block, so nothing shows between the columns.
    expect(document.querySelectorAll('.dragday .k-event')).toHaveLength(0);
  });
});

const FRI = '2026-11-06';
// As the owner had it: an hour's practice at 5:30pm on Friday, and planning from 5:30pm to 6:45pm.
async function together(w: Writer, planFrom = '17:30', planTo = '18:45') {
  await w.create('practice', { title: 'Plan meals for the week', target_min: 60, per: 'week', state: 'active' }, 'meals');
  await w.create('time_block', { practice_id: 'meals', start: at('17:30', FRI), end: at('18:30', FRI), tz: ZONE }, 'bm');
  await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 9', plans: ['week:2026-11-09'], estimate_min: 75 }, 'planning:week:2026-11-09');
  await w.create('time_block', { task_id: 'planning:week:2026-11-09', start: at(planFrom, FRI), end: at(planTo, FRI), tz: ZONE }, 'bp');
}
const sideBySide = (els: HTMLElement[]) => {
  expect(new Set(els.map((e) => e.style.width)).size).toBe(1);
  expect(new Set(els.map((e) => e.style.left)).size).toBe(els.length);
};

describe('blocks at the same time on another day of the week on Today', () => {
  const fence = (w: Writer) => w.create('time_block', { task_id: 't2', start: at('18:00', FRI), end: at('18:30', FRI), tz: ZONE }, 'bc');
  const friday = async () => {
    await userEvent.click((await strip())[4]!);
    await heading('Friday');
  };

  it('overlapping in part, the later one sits lower in its column and says when it runs', async () => {
    await open({ seed: (w) => together(w, '18:00', '19:15') });
    await friday();
    const meals = await screen.findByRole('slider', { name: 'Plan meals for the week, 5:30pm to 6:30pm, Practice. Overlaps Plan the week of Nov 9.' });
    const plan = screen.getByRole('slider', { name: 'Plan the week of Nov 9, 6pm to 7:15pm, Planning. Overlaps Plan meals for the week.' });
    sideBySide([meals, plan]);
    // Half an hour lower, at 72px an hour.
    expect(parseFloat(plan.style.top) - parseFloat(meals.style.top)).toBe(36);
    expect(within(plan).getByText('6pm to 7:15pm')).toBeVisible();
  });

  it("three at once get a column each, and a task's block in its column opens the task's popup", async () => {
    await open({ seed: async (w) => { await together(w); await fence(w); } });
    await friday();
    const call = await screen.findByRole('slider', { name: 'Paint the fence, 6pm to 6:30pm, One off. Overlaps Plan the week of Nov 9 and Plan meals for the week.' });
    const plan = screen.getByRole('slider', { name: /^Plan the week of Nov 9, .* Overlaps Plan meals for the week and Paint the fence\.$/ });
    const meals = screen.getByRole('slider', { name: /^Plan meals for the week, .* Overlaps Plan the week of Nov 9 and Paint the fence\.$/ });
    sideBySide([plan, meals, call]);
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
    await openFromDay(call);
    const popup = await screen.findByRole('dialog', { name: 'Paint the fence' });
    expect(within(popup).getByRole('button', { name: 'Delete task' })).toBeVisible();
    expect(within(within(popup).getByRole('region', { name: 'Time block' })).getByText('Fri Nov 6, 6pm to 6:30pm')).toBeVisible();
  });
});

describe("a block held and dragged on Today's day", () => {
  const fence = (time: string) => screen.findByRole('slider', { name: new RegExp(`^Paint the fence, ${time}`) }, FIRST);
  /** Held on the block, then let go `dy` px lower: at Today's 72px an hour, 216px is three hours. */
  const holdAndDrop = async (time: string, dy: number) => {
    const el = await fence(time);
    holdDown(el, { clientX: 10, clientY: 10, pointerType: 'touch' });
    fireEvent.pointerMove(window, { clientX: 10, clientY: 10 + dy, pointerType: 'touch' });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 10 + dy, pointerType: 'touch' });
  };

  it('dragged sideways before it is let go, it moves, and keeps the day rather than swiping to the next', async () => {
    const t = await open({ seed: fenceAt5 });
    const el = await fence('5pm to 6pm');
    await heading('Today');
    // 150px left and 72px down, an hour: far more sideways than down, as a swipe to the next day would be.
    holdDown(el, { clientX: 200, clientY: 10, pointerType: 'touch' });
    fireEvent.pointerMove(window, { clientX: 150, clientY: 46, pointerType: 'touch' });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 82, pointerType: 'touch' });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 82, pointerType: 'touch' });
    await waitFor(async () => expect((await block('b4')(t))?.start).toBe(at('18:00')));
    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();

    // The same sideways move without a hold is still a swipe to the next day.
    swipeDay(await fence('6pm to 7pm'), -200);
    await heading('Tomorrow');
    expect((await strip())[1]).toHaveAttribute('aria-pressed', 'true');
  });

  it('let go lower, it is drawn there at once, while the day has yet to redraw; Undo, or a failed save, puts it back', async () => {
    const t = await open({ seed: fenceAt5 });
    // The day's reads wait until let through, as the web app's database makes them wait on a busy device, so the day
    // doesn't redraw from the save meanwhile. Saves aren't held.
    let gate: Promise<void> | null = null;
    let letThrough = () => undefined as void;
    const slow = () => (gate = new Promise<void>((r) => (letThrough = () => ((gate = null), r()))));
    const [all, get] = [t.db.all.bind(t.db), t.db.get.bind(t.db)];
    vi.spyOn(t.db, 'all').mockImplementation(async (sql, params) => (await gate, all(sql, params)));
    vi.spyOn(t.db, 'get').mockImplementation(async (sql, params) => (await gate, get(sql, params)));

    expect(await fence('5pm to 6pm')).toBeVisible();
    slow();
    await holdAndDrop('5pm to 6pm', 216);
    expect(await screen.findByText(/^Paint the fence is now 8pm to 9pm\./)).toBeVisible();
    expect(await fence('8pm to 9pm')).toBeVisible();
    expect(screen.queryByRole('slider', { name: /^Paint the fence, 5pm/ })).toBeNull();
    // Undo before the day has drawn the move: its next drawing has the block where it started, which wouldn't redraw it.
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await fence('5pm to 6pm')).toBeVisible();
    letThrough();
    await waitFor(async () => expect((await block('b4')(t))?.start).toBe(at('17:00')));
    expect(await fence('5pm to 6pm')).toBeVisible();

    vi.spyOn(t.db, 'transaction').mockRejectedValueOnce(new Error('disk full'));
    await holdAndDrop('5pm to 6pm', 216);
    expect(await screen.findByText("Couldn't save that. Try again.")).toBeVisible();
    expect(await fence('5pm to 6pm')).toBeVisible();
    expect(screen.queryByRole('slider', { name: /^Paint the fence, 8pm/ })).toBeNull();
    expect((await block('b4')(t))?.start).toBe(at('17:00'));
  });

  it('let go over another, it asks first: Cancel leaves it, Replace takes the other off', async () => {
    const t = await open({ seed: async (w) => { await fenceAt5(w); await w.create('time_block', { task_id: 't1', start: at('20:00'), end: at('21:00'), tz: ZONE }, 'b6'); } });
    // Two and a half hours later, 7:30pm, runs into 8pm.
    const drop = async () => {
      await holdAndDrop('5pm to 6pm', 180);
      return screen.findByRole('dialog', { name: 'Schedule both at the same time?' });
    };
    await userEvent.click(within(await drop()).getByRole('button', { name: 'Cancel' }));
    expect((await block('b4')(t))?.start).toBe(at('17:00'));

    await userEvent.click(within(await drop()).getByRole('button', { name: 'Replace' }));
    await waitFor(async () => expect((await block('b4')(t))?.start).toBe(at('19:30')));
    await waitFor(async () => expect((await block('b6')(t))?.cancelled).toBe(true));
  });
});

describe('placing on Today from a link', () => {
  it('Place on calendar opens the day with the block to drag; arrows move it, Place here saves, Cancel goes back', async () => {
    const close = vi.fn();
    const t = await open({ params: { place: 't2' }, close });
    expect(await screen.findByText('Placing Paint the fence, 1h', {}, FIRST)).toBeVisible();
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
    await open({ params: { place: 't1' }, close });
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(close).toHaveBeenCalled();
  });
});

describe('placing planning from Choose another time, on Today', () => {
  // Friday, Nov 6 at 10am, the week planned: next week's planning task waits for a time, and Choose another time in
  // its sheet brought it here, 45 minutes long, waiting at 6pm today.
  const PLAN = 'planning:week:2026-11-09';
  const later: PlanningPlace = { for: '2026-11-09', minutes: 45, at: { date: FRI, start: 18 * 60, end: 18 * 60 + 45 } };
  const placing = (place: PlanningPlace = later, close = vi.fn()) =>
    open({
      now: at('10:00', FRI),
      params: placePlanningParams(place),
      close,
      seed: async (w) => {
        await planned(w);
        await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 9', plans: ['week:2026-11-09'], estimate_min: 30 }, PLAN);
      },
    });
  const handle = (title = 'Plan the week of Nov 9') => screen.findByRole('slider', { name: new RegExp(`^Time for ${title}`) }, FIRST);
  const blocksOf = async (t: { db: Parameters<typeof listRecords>[0] }, id = PLAN) => (await listRecords(t.db, 'time_block')).filter((b) => b.task_id === id && !b.deleted_at);

  it('waits at its best time beside the rest of the week, with focus on it; keys move it, and Place here schedules it with Undo', async () => {
    const close = vi.fn();
    const t = await placing(later, close);
    expect(await handle()).toHaveFocus();
    expect(screen.getByText('Placing Plan the week of Nov 9, 45m')).toBeVisible();
    // Nothing else is edited while it's placed.
    expect(await menuItems()).not.toContain("Edit this week's plan");
    (await handle()).focus();
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.click(screen.getByRole('button', { name: 'Place here' }));
    expect(await screen.findByText('Planning scheduled for Fri 6:15pm.')).toBeVisible();
    await waitFor(async () => expect(await blocksOf(t)).toMatchObject([{ start: at('18:15', FRI), end: at('19:00', FRI) }]));
    expect(screen.queryByRole('button', { name: 'Place here' })).toBeNull();
    expect(close).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await blocksOf(t)).toEqual([]));
  });

  it('carries to next week, as far as the week it plans, and is placed there', async () => {
    const t = await placing();
    await handle();
    expect(screen.getByRole('button', { name: 'Previous week' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(await screen.findByText('Nov 9 to Nov 15')).toBeVisible();
    // It keeps its day of the week and its time.
    expect(await handle()).toHaveAccessibleName(/^Time for Plan the week of Nov 9, being placed\./);
    expect(await handle()).toHaveAttribute('aria-valuetext', 'Fri Nov 13, 6pm to 6:45pm');
    expect(screen.getByRole('button', { name: 'Next week' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Place here' }));
    expect(await screen.findByText('Planning scheduled for Fri 6pm.')).toBeVisible();
    await waitFor(async () => expect(await blocksOf(t)).toMatchObject([{ start: at('18:00', '2026-11-13'), end: at('18:45', '2026-11-13') }]));
  });

  it('Cancel goes back without placing it', async () => {
    const close = vi.fn();
    const t = await placing(later, close);
    await handle();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(close).toHaveBeenCalledOnce();
    expect(await blocksOf(t)).toEqual([]);
  });

  it('from the planning flow, Place here and Cancel each go back to it', async () => {
    const close = vi.fn();
    const t = await placing({ ...later, flow: '2026-11-02' }, close);
    await handle();
    await userEvent.click(screen.getByRole('button', { name: 'Place here' }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(t.nav().flow).toEqual({ area: 'planning', params: { week: '2026-11-02' } });
    expect(await blocksOf(t)).toHaveLength(1);

    cleanup();
    const again = vi.fn();
    const u = await placing({ ...later, flow: '2026-11-02' }, again);
    await handle();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(again).toHaveBeenCalledOnce();
    expect(u.nav().flow).toEqual({ area: 'planning', params: { week: '2026-11-02' } });
  });

  it("a stretch's block can't go after the stretch ends; both plans in one block cover the week too", async () => {
    // The first stretch, under way, ends on Saturday.
    const stretch = { stretch: { start: '2026-10-26', end: '2026-11-07' }, first: true };
    const t = await placing({ for: stretch, minutes: 60, both: '2026-11-09', at: { date: FRI, start: 18 * 60, end: 19 * 60 } });
    await handle('Plan Oct 26 to Nov 7 and the week of Nov 9');
    expect(screen.getByRole('button', { name: 'Next week' })).toBeDisabled();
    await userEvent.click((await strip())[6]!);
    expect(await screen.findByText('Too late: plan it by Sat Nov 7.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Place here' })).toBeDisabled();
    await userEvent.click((await strip())[5]!);
    await userEvent.click(screen.getByRole('button', { name: 'Place here' }));
    expect(await screen.findByText(/^Planning scheduled for Sat /)).toBeVisible();
    await waitFor(async () => expect(await blocksOf(t, 'planning:stretch:2026-10-26')).toHaveLength(1));
    expect((await getRecord(t.db, 'task', 'planning:stretch:2026-10-26'))?.plans).toEqual(['stretch:2026-10-26', 'week:2026-11-09']);
  });
});

describe("hold to create on Today's day", () => {
  beforeEach(holdTimers);
  afterEach(() => void vi.useRealTimers());
  const draft = () => document.querySelector<HTMLElement>('.holddraft');
  const press = (el: Element, y: number, x = 20) => fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, pointerType: 'touch', pointerId: 1 });
  const letGo = (y: number, x = 20) => fireEvent.pointerUp(window, { clientX: x, clientY: y, pointerType: 'touch', pointerId: 1 });

  it('a hold on time gone by drafts nothing and says why; a hold on a block lifts it to move and drafts nothing; a sideways swipe after a hold keeps the day', async () => {
    const t = await open({ seed: fenceAt5 });
    await heading('Today');
    // jsdom has no layout: the day's top is at 0, from the minute it opens at, 72px an hour.
    const day = document.querySelector<HTMLElement>('.day[data-drop-date="2026-11-02"]')!;
    const y = (minutes: number) => ((minutes - Number(day.dataset.dropFrom)) * 72) / 60 + 1;
    press(day, y(10 * 60));
    await pass(450);
    letGo(y(10 * 60));
    expect(draft()).toBeNull();
    expect(await screen.findByText('That time has gone by. Hold on a later time.')).toBeVisible();

    press(screen.getByRole('slider', { name: /^Paint the fence, 5pm to 6pm/ }), y(17 * 60 + 30));
    await pass(450);
    expect(draft()).toBeNull();
    fireEvent.pointerCancel(window, { pointerId: 1, pointerType: 'touch' });
    expect(t.platform.haptics).toEqual(['light']);

    Object.defineProperty(day.closest('.dpager'), 'clientWidth', { value: 300, configurable: true });
    press(day, y(19 * 60));
    await pass(450);
    expect(draft()).not.toBeNull();
    // Dragged sideways after the hold, the draft moves with the finger and the day stays.
    for (const x of [40, 120, 220]) fireEvent.pointerMove(window, { clientX: x, clientY: y(19 * 60) + 10, pointerType: 'touch', pointerId: 1 });
    letGo(y(19 * 60) + 10, 220);
    await screen.findByRole('dialog', { name: 'Capture' });
    expect(screen.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  });

  it("while editing, a hold on empty time on the drawn day drafts there; while a block is being moved, a hold drafts nothing", async () => {
    await open({ seed: planned });
    await edit();
    // The drawn day starts at 6am, 72px an hour.
    const day = () => document.querySelector<HTMLElement>('.day.dragday')!;
    const y = (minutes: number) => ((minutes - 360) * 72) / 60 + 1;
    press(day(), y(18 * 60));
    await pass(450);
    expect(draft()).toHaveAttribute('title', '6pm to 7pm');
    expect(draft()).toHaveClass('cev', 's-placing');
    letGo(y(18 * 60));
    const capture = await screen.findByRole('dialog', { name: 'Capture' });
    expect(within(capture).getByText('Today, 6pm to 7pm')).toBeVisible();
    await userEvent.click(within(capture).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(draft()).toBeNull());

    await userEvent.click((await strip())[1]!);
    await userEvent.click(await screen.findByRole('slider', { name: /^Draft the summary\. / }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Draft the summary' })).getByRole('button', { name: 'Move…' }));
    await userEvent.click(within(await screen.findByRole('menu', { name: 'Move to' })).getByRole('menuitem', { name: 'Choose a time…' }));
    expect(await screen.findByText(/^Moving Draft the summary/)).toBeVisible();
    press(day(), y(10 * 60));
    await pass(450);
    expect(draft()).toBeNull();
  });
});

describe("Reset this week's plan, from Today's menu", () => {
  const WEEK = '2026-11-02';
  const NEXT = '2026-11-09';
  /** Two tasks and a practice, with this morning's block gone by and two blocks still to come, one a practice session. */
  const base = async (w: Writer) => {
    await w.create('task', { kind: 'one_off', title: 'Paint the fence', estimate_min: 60 }, 't1');
    await w.create('task', { kind: 'one_off', title: 'Call the bank', estimate_min: 60 }, 't2');
    await w.create('practice', { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' }, 'pr');
    await w.create('time_block', { task_id: 't1', start: at('07:30'), end: at('08:30'), tz: ZONE }, 'past');
    await w.create('time_block', { task_id: 't1', start: at('18:00', TUE), end: at('19:00', TUE), tz: ZONE }, 'tue');
    await w.create('time_block', { practice_id: 'pr', start: at('07:00', WED), end: at('07:30', WED), tz: ZONE }, 'wed');
  };
  /** This week planned, with both tasks picked. */
  const picked = async (w: Writer) => {
    await base(w);
    await w.create('week_plan', { week_start: WEEK, finished_at: at('08:00') }, weekPlanId(WEEK));
    await w.create('week_pick', { week_start: WEEK, task_id: 't1', minutes: 60 }, weekPickId(WEEK, 't1'));
    await w.create('week_pick', { week_start: WEEK, task_id: 't2', minutes: 60 }, weekPickId(WEEK, 't2'));
  };
  const today = (options: HarnessOptions = {}) => renderScreen('today', { zone: ZONE, layout: 'phone', seed: picked, ...options });
  const resets = async () => (await menuItems()).filter((name) => name?.startsWith('Reset'));

  it('shows only while the week has something to reset, and never on a past week', async () => {
    await today();
    await fromMenu("Reset this week's plan");
    await userEvent.click(within(screen.getByRole('dialog', { name: "Reset this week's plan?" })).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    await screen.findByText('Past weeks can be viewed but not changed.');
    expect(await resets()).toEqual([]);
  });

  it('is not there with nothing planned: only what has already happened', async () => {
    await today({ seed: async (w) => w.create('task', { kind: 'one_off', title: 'Paint the fence' }, 't1').then(() => w.create('time_block', { task_id: 't1', start: at('07:30'), end: at('08:30'), tz: ZONE })) });
    await screen.findByText('Not planned yet', {}, FIRST);
    expect(await resets()).toEqual([]);
  });

  it('asks first, saying what goes and what stays, and Cancel changes nothing', async () => {
    const t = await today();
    await fromMenu("Reset this week's plan");
    const dialog = screen.getByRole('dialog', { name: "Reset this week's plan?" });
    expect(dialog).toHaveAccessibleDescription(
      'This takes out: 2 tasks picked for this week. 2 blocks still to come, 1 of them a practice session. ' +
        'It keeps: 1 block already started, answered or gone by. Your tasks and practices themselves. ' +
        'This week then shows as not planned, so you can plan it again. You can undo this.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'View and week' })).toHaveFocus();
    expect(await listRecords(t.db, 'week_pick')).toHaveLength(2);
    expect(await getRecord(t.db, 'week_plan', weekPlanId(WEEK))).toMatchObject({ finished_at: at('08:00') });
  });

  it('takes the plan out on Reset plan, says so with Undo, and Undo puts it all back', async () => {
    localStorage.setItem(`multiscale.planning.step.${WEEK}`, '3');
    const t = await today();
    await fromMenu("Reset this week's plan");
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset plan' }));

    expect(await screen.findByText("Reset this week's plan: 2 tasks and 2 blocks removed.")).toBeVisible();
    const undo = screen.getByRole('button', { name: 'Undo' });
    // The menu item that did it has gone, so focus is on Undo.
    await waitFor(() => expect(undo).toHaveFocus());
    expect(await listRecords(t.db, 'week_pick')).toEqual([]);
    expect((await getRecord(t.db, 'time_block', 'tue'))?.deleted_at).toBeTruthy();
    expect((await getRecord(t.db, 'time_block', 'wed'))?.deleted_at).toBeTruthy();
    expect((await getRecord(t.db, 'time_block', 'past'))?.deleted_at ?? null).toBeNull();
    expect((await getRecord(t.db, 'week_plan', weekPlanId(WEEK)))?.finished_at ?? null).toBeNull();
    // The week asks to be planned again, and planning opens on its first step.
    expect(await screen.findByText('Not planned yet')).toBeVisible();
    expect(localStorage.getItem(`multiscale.planning.step.${WEEK}`)).toBe('0');

    await userEvent.click(undo);
    await waitFor(async () => expect(await listRecords(t.db, 'week_pick')).toHaveLength(2));
    expect((await getRecord(t.db, 'time_block', 'tue'))?.deleted_at ?? null).toBeNull();
    expect((await getRecord(t.db, 'time_block', 'wed'))?.deleted_at ?? null).toBeNull();
    expect(await getRecord(t.db, 'week_plan', weekPlanId(WEEK))).toMatchObject({ finished_at: at('08:00') });
    expect(localStorage.getItem(`multiscale.planning.step.${WEEK}`)).toBe('3');
    // The menu offers it again.
    await waitFor(() => expect(screen.queryByText('Not planned yet')).toBeNull());
    expect(await resets()).toEqual(["Reset this week's plan"]);
  });

  it("offers Reset next week's plan on next week, which leaves this week alone", async () => {
    const t = await today({
      seed: async (w) => {
        await picked(w);
        await w.create('week_plan', { week_start: NEXT, finished_at: at('09:00') }, weekPlanId(NEXT));
        await w.create('week_pick', { week_start: NEXT, task_id: 't2', minutes: 60 }, weekPickId(NEXT, 't2'));
      },
    });
    await heading('Today');
    await userEvent.click(screen.getByRole('button', { name: 'Next week' }));
    await screen.findByText('Nov 9 to Nov 15');
    await fromMenu("Reset next week's plan");
    const dialog = screen.getByRole('dialog', { name: "Reset next week's plan?" });
    expect(dialog).toHaveAccessibleDescription(
      'This takes out: 1 task picked for next week. It keeps: Your tasks and practices themselves. ' +
        'Next week then shows as not planned, so you can plan it again. You can undo this.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset plan' }));
    expect(await screen.findByText("Reset next week's plan: 1 task removed.")).toBeVisible();
    expect((await listRecords(t.db, 'week_pick')).map((p) => p.week_start)).toEqual([WEEK, WEEK]);
    expect(await getRecord(t.db, 'week_plan', weekPlanId(WEEK))).toMatchObject({ finished_at: at('08:00') });
  });
});
