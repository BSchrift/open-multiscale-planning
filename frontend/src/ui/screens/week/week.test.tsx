import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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

// On phone the week is Today's: these are in today/weekOnToday.test.tsx.
describe('this week before it is planned, on desktop', () => {
  afterEach(() => localStorage.clear());

  it('asks to plan instead of offering to edit, as Today does, and Start planning opens planning', async () => {
    const t = await open();
    expect(await screen.findByText("This week isn't planned yet. About 30m.")).toBeVisible();
    expect(screen.queryByRole('button', { name: "Edit this week's plan" })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Start planning' }));
    expect(t.nav().flow).toMatchObject({ area: 'planning' });
  });

  it('asks before its estimate is read, so nothing under the question moves when the estimate arrives', async () => {
    // The estimate is its own read, which on a long history waits behind Week's: on 19 November it came seconds after
    // To schedule, and the question it brought moved a card from under the mouse.
    estimate.read = false;
    await open();
    expect(await screen.findByText("This week isn't planned yet.")).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start planning' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Choose a time to plan this week' })).toBeVisible();
  });

  it('Skip for now puts it away for the week on every device, and offers Edit again', async () => {
    const t = await open();
    // Option D on desktop: × is Skip for now.
    await userEvent.click(await screen.findByRole('button', { name: 'Skip planning this week' }));
    expect(await screen.findByRole('button', { name: "Edit this week's plan" })).toBeVisible();
    expect(screen.queryByText(/This week isn't planned yet/)).toBeNull();
    expect((await getRecord(t.db, 'week_plan', weekPlanId('2026-11-02')))?.planning_skipped_at).toBeTruthy();
  });

  it('says when planning is set for later, in place of the prompt, with Start now', async () => {
    const t = await open({
      seed: async (w) => {
        await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 2' }, 'planning:week:2026-11-02');
        await w.create('time_block', { task_id: 'planning:week:2026-11-02', start: '2026-11-04T00:00:00Z', end: '2026-11-04T00:30:00Z', tz: 'America/Chicago' }, 'p1');
      },
    });
    const set = await screen.findByRole('region', { name: 'Planning is set for Tue 6pm.' });
    expect(screen.queryByText(/This week isn't planned yet/)).toBeNull();
    await userEvent.click(within(set).getByRole('button', { name: 'Start now' }));
    expect(t.nav().flow).toEqual({ area: 'planning', params: { week: '2026-11-02' } });
  });

  it('Plan next week starts planning it, with a block from now', async () => {
    const t = await open({ seed: planned });
    await userEvent.click(await screen.findByRole('button', { name: 'Plan next week' }));
    expect(t.nav().flow).toEqual({ area: 'planning', params: { week: '2026-11-09' } });
    await waitFor(async () =>
      expect((await listRecords(t.db, 'time_block')).filter((b) => b.task_id === 'planning:week:2026-11-09')).toMatchObject([{ started_at: '2026-11-02T20:00:00Z' }]),
    );
    expect(await screen.findByText('Planning until 2:30pm.')).toBeVisible();
  });

  it('once planned, offers Edit and no prompt', async () => {
    await open({ seed: planned });
    expect(await screen.findByRole('button', { name: "Edit this week's plan" })).toBeVisible();
    expect(screen.queryByText(/This week isn't planned yet/)).toBeNull();
  });
});

describe("next week's planning task", () => {
  // Friday, Nov 6: the app has saved the planning task for the week of Nov 9, with no time.
  const friday = (layout: 'desktop' | 'phone' = 'desktop') =>
    open({
      layout,
      now: at('10:00', '2026-11-06'),
      seed: async (w) => {
        await planned(w);
        await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 9', plans: ['week:2026-11-09'], estimate_min: 30 }, 'planning:week:2026-11-09');
      },
    });

  it('heads To schedule in the days before its week, and opens the times on click', async () => {
    await friday();
    const card = await screen.findByRole('button', { name: 'Planning: Plan the week of Nov 9, Nov 6 to Nov 8, 30m to schedule' });
    await userEvent.click(card);
    expect(await screen.findByRole('dialog', { name: 'When will you plan next week?' })).toBeVisible();
  });

  it('once scheduled, shows as Planning on the week, and next week says when', async () => {
    const t = await friday();
    await t.write((w) => w.create('time_block', { task_id: 'planning:week:2026-11-09', start: at('17:00', '2026-11-08'), end: at('17:30', '2026-11-08'), tz: ZONE }));
    expect(await screen.findByRole('button', { name: /^Plan the week of Nov 9, Sun Nov 8, 5pm to 5:30pm, Planning\./ })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(await screen.findByText('Planning: Sun Nov 8, 5pm')).toBeVisible();
  });
});

// This morning on Monday, after Paint the fence's block at 7:30 went unanswered: one done, one not done and one partly.
const morning = async (w: Writer) => {
  const answers = [
    ['Sketch the outline', 'done'],
    ['Read the notes', 'not'],
    ['Email the editor', 'partly'],
  ] as const;
  for (const [i, [title, result]] of answers.entries()) {
    await w.create('task', { kind: 'project', project_id: 'p', title, estimate_min: 60 }, `m${i}`);
    await w.create('time_block', { task_id: `m${i}`, start: at(`${9 + i}:00`), end: at(`${10 + i}:00`), tz: ZONE }, `mb${i}`);
    await w.create('block_outcome', { result, answered_at: at(`${10 + i}:00`) }, outcomeId(`mb${i}`));
  }
};

describe('a block landing on another while editing, on desktop', () => {
  // Draft the summary is Tuesday 6pm to 7pm, beside Quiz night, a calendar event; Paint the fence follows at 7pm.
  const seed = async (w: Writer) => {
    await planned(w);
    await w.create('time_block', { task_id: 't2', start: at('19:00', TUE), end: at('20:00', TUE), tz: ZONE }, 'b4');
  };
  const step = async () => {
    await userEvent.click(await screen.findByRole('button', { name: "Edit this week's plan" }));
    const el = await screen.findByRole('group', { name: /^Draft the summary, Tue Nov 3, 6pm to 7pm/ });
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

describe("a task's block made shorter while editing, on desktop", () => {
  // Paint the fence, estimated at an hour, picked for 1h this week and placed Monday 5pm to 6pm.
  const fence = async (w: Writer) => {
    await planned(w);
    await setWeekPick(w, MON, 't2', 60);
    await w.create('time_block', { task_id: 't2', start: at('17:00'), end: at('18:00'), tz: ZONE }, 'b4');
  };
  const shorten = async () => {
    await userEvent.click(await screen.findByRole('button', { name: "Edit this week's plan" }));
    // Shift and an arrow change a block's length: twice is half an hour off.
    const el = await screen.findByRole('group', { name: /^Paint the fence, Mon Nov 2, 5pm to 6pm/ });
    el.focus();
    await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}');
    await screen.findByRole('group', { name: 'What about the other 15m?' });
    (await screen.findByRole('group', { name: /^Paint the fence, Mon Nov 2, 5pm to 5:45pm/ })).focus();
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
    await open({ seed: fence });
    await userEvent.click(await screen.findByRole('button', { name: "Edit this week's plan" }));
    const el = await screen.findByRole('group', { name: /^Paint the fence, Mon Nov 2, 5pm to 6pm/ });
    el.focus();
    await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(await screen.findByRole('group', { name: /^Paint the fence, Mon Nov 2, 5pm to 6:15pm/ })).toBeVisible();
    expect(screen.queryByRole('group', { name: /^What about the other/ })).toBeNull();
  });
});

describe('Week on desktop', () => {
  it('shows this week: blocks in their colours, calendar events behind, a conflict named, and the time left', async () => {
    await open();
    expect(await screen.findByRole('heading', { name: 'This week' })).toBeVisible();
    expect(screen.getByText('Nov 2 to Nov 8')).toBeVisible();
    const report = await screen.findByRole('button', { name: /^Draft the summary, Tue Nov 3, 6pm to 7pm, Project\. Conflicts with Quiz night\./ });
    expect(report).toHaveClass('k-project');
    expect(screen.getByRole('button', { name: /^Piano practice, Wed/ })).toHaveClass('k-practice');
    expect(screen.getByRole('button', { name: /^Paint the fence/ })).toHaveClass('k-oneoff');
    expect(screen.getByText('Quiz night')).toHaveClass('k-event');
    expect(screen.getByText('Street fair')).toHaveClass('k-info');
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
    // A day gone by and today say what was finished instead, and open Done.
    const heads = document.querySelectorAll('.colhead');
    expect(heads[0]).not.toHaveClass('tight');
    expect(heads[0]!.querySelector('.free')).toHaveTextContent('Nothing finished');
    expect(heads[2]).toHaveClass('tight');
    expect(heads[2]!.querySelector('.free')).toHaveTextContent('Nothing finished');
    expect(heads[3]!.querySelector('.free')).toHaveTextContent('7h free');
    expect(screen.getByRole('button', { name: /^Paint the fence, Mon Nov 2, 5pm to 10pm, One off\./ })).toBeVisible();
  });

  it('opens Done from the heading of a day gone by or today, with what was finished; a later day keeps its free time', async () => {
    const t = await midweek();
    await t.write(async (w) => {
      await w.create('task', { kind: 'project', project_id: 'p', title: 'Draft the methods', done_at: at('10:00', TUE) }, 't3');
      await w.create('task', { kind: 'one_off', title: 'Renew passport photos', done_at: at('11:00', TUE) }, 't4');
      await w.create('task_completion', { task_id: 't4', done_at: at('11:00', TUE) }, 'c4');
    });
    const tuesday = await screen.findByRole('button', { name: 'Done on Tue Nov 3: 2 finished' });
    expect(tuesday).toHaveTextContent('Tue Nov 32 finished');
    expect(screen.getByRole('button', { name: 'Done on Wed Nov 4: nothing finished' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Done on Thu Nov 5/ })).toBeNull();
    await userEvent.click(tuesday);
    expect(t.nav().route).toMatchObject({ area: 'done', params: { day: TUE } });
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
    expect([...document.querySelectorAll('.colhead .free')].map((el) => el.textContent!.trim())).toEqual(Array(7).fill('Nothing finished'));

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

  it('arrows clicked before a week loads each still count', async () => {
    await open();
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

  it("a task's block opens the task's popup, with the block's time, what it belongs to and its actions above the task's fields", async () => {
    await open({ seed: planned });
    const opener = await screen.findByRole('button', { name: /^Draft the summary/ });
    expect(opener).toHaveAttribute('aria-haspopup', 'dialog');
    await userEvent.click(opener);
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    await waitFor(() => expect(within(popup).getByRole('heading', { name: 'Draft the summary' })).toHaveFocus());
    const section = within(popup).getByRole('region', { name: 'Time block' });
    expect(within(section).getByText('Tue Nov 3, 6pm to 7pm')).toBeVisible();
    expect(await within(section).findByText('Write the report')).toBeVisible();
    expect(within(section).getByRole('button', { name: 'Move…' })).toBeVisible();
    expect(within(section).getByRole('button', { name: 'Remove from calendar' })).toBeVisible();
    // Still to come and not today, so nothing to start or answer yet.
    expect(within(section).queryByRole('button', { name: /^Start/ })).toBeNull();
    expect(within(section).queryByRole('group', { name: 'How did it go?' })).toBeNull();
    // The section comes first, then the task's own fields.
    expect(section.compareDocumentPosition(within(popup).getByRole('slider', { name: 'Time estimate' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Draft the summary' })).toBeNull();

    // Esc closes it, and focus goes back to the block, not the page.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: /^Draft the summary/ })).toHaveFocus();
  });

  it("a task's block beside another at the same time still opens its own popup", async () => {
    await open({ seed: async (w) => { await planned(w); await w.create('time_block', { task_id: 't2', start: at('18:30', TUE), end: at('19:30', TUE), tz: ZONE }, 'b4'); } });
    const draft = await screen.findByRole('button', { name: /^Draft the summary, Tue Nov 3, 6pm to 7pm/ });
    const fence = screen.getByRole('button', { name: /^Paint the fence, Tue Nov 3, 6:30pm to 7:30pm/ });
    expect(draft.style.left).not.toBe(fence.style.left);
    for (const [el, title, when] of [[fence, 'Paint the fence', 'Tue Nov 3, 6:30pm to 7:30pm'], [draft, 'Draft the summary', 'Tue Nov 3, 6pm to 7pm']] as const) {
      expect(el).toHaveAttribute('aria-haspopup', 'dialog');
      await userEvent.click(el);
      const popup = await screen.findByRole('dialog', { name: title });
      expect(within(within(popup).getByRole('region', { name: 'Time block' })).getByText(when)).toBeVisible();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
  });

  it("Remove from calendar in a block's popup takes the block off, with Undo, and leaves the task open", async () => {
    const t = await open({ seed: planned });
    await userEvent.click(await screen.findByRole('button', { name: /^Draft the summary/ }));
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    await userEvent.click(within(popup).getByRole('button', { name: 'Remove from calendar' }));
    expect(await screen.findByText('Removed Draft the summary')).toBeVisible();
    await waitFor(async () => expect((await block('b1')(t))?.cancelled).toBe(true));
    await waitFor(() => expect(within(popup).queryByRole('region', { name: 'Time block' })).toBeNull());
    expect(within(popup).getByRole('button', { name: 'Delete task' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await block('b1')(t))?.cancelled).toBeNull());
  });

  it("Move… in a block's popup moves it to the next free time that day or the next day, as Today's does, each with Undo", async () => {
    const t = await open({ seed: planned });
    await userEvent.click(await screen.findByRole('button', { name: /^Draft the summary/ }));
    const section = within(await screen.findByRole('dialog', { name: 'Draft the summary' })).getByRole('region', { name: 'Time block' });
    await userEvent.click(within(section).getByRole('button', { name: 'Move…' }));
    const menu = await screen.findByRole('menu', { name: 'Move to' });
    // Quiz night runs to 7:30pm. Tuesday is tomorrow, so the toast says so, and Wednesday goes by its date.
    expect([...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((el) => (el.getAttribute('role') === 'separator' ? '-' : el.textContent))).toEqual([
      'Next free time, 7:30pm',
      'Wed Nov 4, 6pm',
      'Back to To schedule',
      '-',
      'Choose a time…',
    ]);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Next free time, 7:30pm' }));
    expect(await screen.findByText('Moved Draft the summary to tomorrow, 7:30pm.')).toBeVisible();
    await waitFor(async () => expect((await block('b1')(t))?.start).toBe(at('19:30', TUE)));
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await block('b1')(t))?.start).toBe(at('18:00', TUE)));

    await userEvent.click(within(section).getByRole('button', { name: 'Move…' }));
    await userEvent.click(within(await screen.findByRole('menu', { name: 'Move to' })).getByRole('menuitem', { name: 'Wed Nov 4, 6pm' }));
    expect(await screen.findByText('Moved Draft the summary to Wed Nov 4, 6pm.')).toBeVisible();
    await waitFor(async () => expect((await block('b1')(t))).toMatchObject({ start: at('18:00', WED), end: at('19:00', WED) }));
  });

  it("Move…'s Choose a time in a block's popup opens the week for editing with that block ready for the arrow keys", async () => {
    const t = await open({ seed: planned });
    await userEvent.click(await screen.findByRole('button', { name: /^Draft the summary/ }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Draft the summary' })).getByRole('button', { name: 'Move…' }));
    await userEvent.click(within(await screen.findByRole('menu', { name: 'Move to' })).getByRole('menuitem', { name: 'Choose a time…' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('heading', { name: 'Editing this week' })).toBeVisible();
    await waitFor(() => expect(screen.getByRole('group', { name: /^Draft the summary/ })).toHaveFocus());
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(async () => expect((await block('b1')(t))?.start).toBe(at('18:15', TUE)));
  });

  it("while editing, a click or Enter on a task's block opens its popup too, as a practice's session opens its own", async () => {
    await open({ seed: planned });
    await userEvent.click(await screen.findByRole('button', { name: /^Piano practice, Wed Nov 4/ }));
    const practice = await screen.findByRole('dialog', { name: 'Piano practice' });
    expect(within(practice).getByRole('region', { name: 'Time block' })).toBeVisible();
    await userEvent.click(within(practice).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: "Edit this week's plan" }));
    screen.getByRole('group', { name: /^Draft the summary/ }).focus();
    await userEvent.keyboard('{Enter}');
    const popup = await screen.findByRole('dialog', { name: 'Draft the summary' });
    expect(within(popup).getByRole('region', { name: 'Time block' })).toBeVisible();
    await userEvent.click(within(popup).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('group', { name: /^Draft the summary/ })).toHaveFocus();
  });

  it("Edit this week's plan: keys move a block and save, the past stays put, and × removes with Undo", async () => {
    const t = await open({ seed: planned });
    await userEvent.click(await screen.findByRole('button', { name: "Edit this week's plan" }));
    expect(await screen.findByRole('heading', { name: 'Editing this week' })).toBeVisible();
    // The button pressed has gone, so focus moves to the one that ends editing, and back again after.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done editing' })).toHaveFocus());
    expect(screen.getByText(/^Hold anything from now on, then drag to move or resize it, or click/)).toBeVisible();
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
    const ask = await screen.findByRole('group', { name: 'Use 7:15am in future weeks too?' });
    expect(ask).toHaveAccessibleDescription('Piano practice moved to Wed 7:15am.');
    expect(await within(ask).findByRole('status')).toHaveTextContent('Piano practice moved to Wed 7:15am. Use 7:15am in future weeks too?');
    expect(within(ask).getAllByRole('button').map((b) => b.textContent)).toEqual(['No, just this week', 'Yes, on Wednesdays', 'Yes, every day']);
    await userEvent.click(within(ask).getByRole('button', { name: 'Yes, every day' }));
    await waitFor(async () => expect((await getRecord(t.db, 'practice', 'pr'))?.preferred_times).toEqual([7 * 60 + 15]));
    // Set to a time now, its days still ahead land at it, in the same Undo.
    expect(await screen.findByText('Piano practice is now 7:15am every day. Placed 5 sessions at their set times.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'practice', 'pr'))?.preferred_times).toBeNull());
    expect((await getRecord(t.db, 'time_block', 'session:pr:2026-11-05'))?.cancelled).toBe(true);
  });

  it('Yes to a new time moves the other sessions at the old set time, as editing the practice does', async () => {
    const t = await open({
      seed: async (w) => {
        await planned(w);
        await w.set('practice', 'pr', { days: [2, 3, 4], preferred_times: [7 * 60] });
        for (const d of ['2026-11-05', '2026-11-06']) await w.create('time_block', { practice_id: 'pr', start: at('07:00', d), end: at('07:30', d), tz: ZONE }, `session:pr:${d}`);
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: "Edit this week's plan" }));
    (await screen.findByRole('group', { name: /^Piano practice, Wed/ })).focus();
    await userEvent.keyboard('{ArrowDown}');
    const ask = await screen.findByRole('group', { name: 'Use 7:15am in future weeks too?' });
    await userEvent.click(within(ask).getByRole('button', { name: 'Yes, on Wednesdays, Thursdays and Fridays' }));
    expect(await screen.findByText(/^Piano practice is now 7:15am .*\. Moved 2 sessions to 7:15am\.$/)).toBeVisible();
    expect((await getRecord(t.db, 'time_block', 'session:pr:2026-11-06'))?.start).toBe(at('07:15', '2026-11-06'));
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'session:pr:2026-11-06'))?.start).toBe(at('07:00', '2026-11-06')));
  });

  it('a practice moved to another day stays the session of its own day, for this week only, and a day with one refuses it', async () => {
    const t = await open({
      seed: async (w) => {
        await planned(w);
        await w.create('time_block', { practice_id: 'pr', start: at('07:00', '2026-11-05'), end: at('07:30', '2026-11-05'), tz: ZONE }, 'session:pr:2026-11-05');
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: "Edit this week's plan" }));
    // Wednesday's session onto Thursday, which has one: refused, and nothing moves.
    (await screen.findByRole('group', { name: /^Piano practice, Wed/ })).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(await screen.findByText('Piano practice is already on Thursday.')).toBeVisible();
    expect((await block('b2')(t))?.start).toBe(at('07:00', WED));
    // Thursday's onto Friday: moved this week only, no question, and Thursday doesn't come back to To schedule.
    screen.getByRole('group', { name: /^Piano practice, Thu/ }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(await screen.findByText("Moved Thursday's Piano practice to Fri 7am, this week only.")).toBeVisible();
    expect(screen.queryByRole('group', { name: /future weeks/ })).toBeNull();
    expect((await getRecord(t.db, 'time_block', 'session:pr:2026-11-05'))?.start).toBe(at('07:00', '2026-11-06'));
    expect(screen.queryByRole('button', { name: /^Piano practice, Practice, 30 minutes on Thursday/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Piano practice, Practice, 30 minutes on Friday/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'session:pr:2026-11-05'))?.start).toBe(at('07:00', '2026-11-05')));
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

  it('a block gone by says how it went, and is struck through only when done', async () => {
    await open({ seed: morning });
    const named = (name: string) => screen.findByRole('button', { name });
    expect(await named('Sketch the outline, Mon Nov 2, 9am to 10am, Project. Done.')).toHaveClass('s-done');
    const not = await named('Read the notes, Mon Nov 2, 10am to 11am, Project. Not done.');
    expect(not).toHaveClass('s-notdone');
    expect(not).not.toHaveClass('s-done');
    expect(within(not).getByText('Not done')).toBeVisible();
    const partly = await named('Email the editor, Mon Nov 2, 11am to 12pm, Project. Partly.');
    expect(partly).toHaveClass('s-partly');
    expect(partly).not.toHaveClass('s-done');
    expect(within(partly).getByText('Partly')).toBeVisible();
    // One with no answer yet is dashed, with an empty ring.
    const unanswered = await named('Paint the fence, Mon Nov 2, 7:30am to 8:30am, One off.');
    expect(unanswered).toHaveClass('s-goneby');
    expect(unanswered).not.toHaveClass('s-done');
  });

  it("marks the current time across today's column only", async () => {
    await open();
    const container = document.body;
    const line = await screen.findByRole('img', { name: 'Current time' });
    expect(container.querySelectorAll('.nowline')).toHaveLength(1);
    expect(container.querySelectorAll('.colbody')[0]).toContainElement(line);
    // 2pm is 8 hours after 6am, at 26px an hour.
    expect(line).toHaveStyle({ top: `${8 * 26}px` });
    await userEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(await screen.findByText('Nov 9 to Nov 15')).toBeVisible();
    expect(container.querySelectorAll('.nowline')).toHaveLength(0);
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
    expect(group.querySelector('.schedmark svg.ico')).not.toBeNull();
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
  // Held first, as a card or block lifts to drag only after a hold.
  const drag = (el: Element, to: { x: number; y: number }) => {
    holdDown(el, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: to.x, clientY: to.y });
    fireEvent.pointerUp(window, { clientX: to.x, clientY: to.y });
  };
  afterEach(() => Reflect.deleteProperty(document, 'elementFromPoint'));

  it('lists picked work less what is placed, and practices short of their target, with a count', async () => {
    await open({ seed: picks });
    const lane = await screen.findByRole('region', { name: 'To schedule' });
    // Piano practice counts a session for each day still without one: Monday, Tuesday, and Thursday to Sunday.
    expect(within(lane).getByText('7 · 5h')).toBeVisible();
    expect(within(lane).getByRole('button', { name: 'Draft the summary, Project, 2h of 3h left, to schedule' })).toBeVisible();
    for (const day of ['Monday', 'Tuesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
      expect(screen.getByRole('button', { name: `Piano practice, Practice, 30 minutes on ${day}, to schedule` })).toBeVisible();
    }
    expect(screen.queryByRole('button', { name: /^Piano practice, Practice, 30 minutes on Wednesday/ })).toBeNull();
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
    const times = within(within(panel).getByRole('group', { name: 'Suggested times for Draft the summary' })).getAllByRole('button');
    expect(times[0]).toHaveAccessibleName(times[0]!.textContent!);
    // Each says its day and time, with no number before it.
    for (const time of times) expect(time).toHaveAccessibleName(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d/);
    expect(times).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: /^Use suggested time/ })).toHaveLength(3);
    await userEvent.click(times[0]!);
    await waitFor(async () => expect(await live(t, (b) => b.task_id === 't1')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Draft the summary, Project/ })).toBeNull());
    expect(screen.getByText('6 · 3h')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: /^Draft the summary, Project, 2h of 3h left/ })).toBeVisible();
  });

  it('a card dragged onto a day is placed where it is let go', async () => {
    const t = await open({ seed: picks });
    const card = await screen.findByRole('button', { name: 'Piano practice, Practice, 30 minutes on Thursday, to schedule' });
    // Thursday's 6am to 11pm drawn 442px tall from y 100, 26px an hour, so y 152 is 8am.
    const thu = document.querySelector('[data-drop-date="2026-11-05"]')!;
    rect(thu, 442, 100);
    pointAt(() => thu);
    drag(card, { x: 50, y: 152 });
    await waitFor(async () => expect((await live(t, (b) => b.practice_id === 'pr')).map((b) => b.start).sort()).toEqual([at('07:00', WED), at('08:00', '2026-11-05')]));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Piano practice, Practice, 30 minutes on Thursday/ })).toBeNull());
    expect(await getRecord(t.db, 'time_block', 'session:pr:2026-11-05')).toMatchObject({ practice_id: 'pr' });
  });

  it('a set day waiting because its set time is taken says so on its card, and one with its time free says its usual time', async () => {
    const seed = async (w: Writer) => (await picks(w), w.set('practice', 'pr', { preferred_times: [18 * 60 + 30] }));
    await open({ seed });
    // Tuesday's 6:30pm is under Quiz night. On desktop it waits above Tuesday, with the warning.
    const tue = await screen.findByRole('button', { name: 'Piano practice, Practice, 30 minutes on Tuesday, 6:30 PM is taken, to schedule' });
    expect(tue.querySelector('[data-icon="warning"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Piano practice, Practice, 30 minutes on Thursday around 6:30 PM, to schedule' }).querySelector('[data-icon="warning"]')).toBeNull();
    await userEvent.click(tue);
    expect(within(screen.getByRole('group', { name: 'Piano practice' })).getByText('6:30pm is taken by Quiz night, so 7:30pm')).toBeVisible();
    cleanup();

    // On phone, where Week is Today's, Tuesday's card in the strip footer's sheet says so in words.
    await renderScreen('today', { zone: ZONE, layout: 'phone', seed: async (w) => (await week(w), await seed(w)) });
    const day = async (name: RegExp) => {
      await userEvent.click(within(await screen.findByRole('group', { name: 'Choose a day' }, { timeout: 5000 })).getByRole('button', { name }));
      await userEvent.click(await screen.findByRole('button', { name: /^\d+ to schedule/ }));
      return screen.findByRole('dialog', { name: 'To schedule' });
    };
    let sheet = await day(/^Tue/);
    const card = within(sheet).getByRole('button', { name: 'Piano practice, Practice, 30 minutes on Tuesday, 6:30 PM is taken, to schedule' });
    expect(within(card).getByText('Tue · 6:30pm is taken')).toBeVisible();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    sheet = await day(/^Thu/);
    const thu = within(sheet).getByRole('button', { name: 'Piano practice, Practice, 30 minutes on Thursday around 6:30 PM, to schedule' });
    expect(within(thu).getByText('30m · usually 6:30pm')).toBeVisible();
  });

  it('a day away has no set-day session waiting', async () => {
    await open({ seed: async (w) => (await picks(w), w.create('away_period', { start: '2026-11-05', end: '2026-11-06' })) });
    await screen.findByRole('button', { name: /^Piano practice, Practice, 30 minutes on Tuesday/ });
    expect(screen.queryByRole('button', { name: /^Piano practice, Practice, 30 minutes on (Thursday|Friday)/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Piano practice, Practice, 30 minutes on Saturday/ })).toBeVisible();
  });

  it('Skip Thursday skips that one session this week, with Undo, and a suggestion says why it moved', async () => {
    const t = await open({ seed: async (w) => (await picks(w), w.set('practice', 'pr', { preferred_times: [18 * 60 + 30] })) });
    await userEvent.click(await screen.findByRole('button', { name: 'Piano practice, Practice, 30 minutes on Tuesday, 6:30 PM is taken, to schedule' }));
    // Tuesday's 6:30pm is under Quiz night and the summary's block, so it moves.
    const panel = screen.getByRole('group', { name: 'Piano practice' });
    expect(within(panel).getByText('6:30pm is taken by Quiz night, so 7:30pm')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Piano practice, Practice, 30 minutes on Thursday around 6:30 PM, to schedule' }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Piano practice' })).getByRole('button', { name: 'Skip Thursday' }));
    expect(await screen.findByText('Skipped Piano practice on Thursday this week.')).toBeVisible();
    expect((await getRecord(t.db, 'week_plan', weekPlanId(MON)))?.skipped_sessions).toEqual(['pr:2026-11-05']);
    expect(screen.queryByRole('button', { name: /^Piano practice, Practice, 30 minutes on Thursday/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Piano practice, Practice, 30 minutes on Friday/ })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: /^Piano practice, Practice, 30 minutes on Thursday/ })).toBeVisible();
  });

  it('a count waits above the week as sessions still to place, and a drop on a day with one is refused', async () => {
    const t = await open({ seed: async (w) => (await picks(w), w.set('practice', 'pr', { per: 'week', target_min: 90, sessions: 3 })) });
    const card = await screen.findByRole('button', { name: 'Piano practice, Practice, 2 more this week, 30m each, to schedule' });
    expect(within(screen.getByRole('region', { name: 'To schedule' })).getByText('3 · 3h')).toBeVisible();
    const wed = document.querySelector('[data-drop-date="2026-11-04"]')!;
    rect(wed, 442, 100);
    pointAt(() => wed);
    drag(card, { x: 50, y: 360 });
    expect(await screen.findByText('Piano practice is already on Wednesday.')).toBeVisible();
    expect(await live(t, (b) => b.practice_id === 'pr')).toHaveLength(1);
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
    await userEvent.click(await screen.findByRole('button', { name: /^Piano practice, Practice, 30 minutes on Thursday/ }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Piano practice' })).getByRole('button', { name: 'Take out of this week' }));
    expect(await screen.findByText('Everything this week is on the calendar.')).toBeVisible();
    expect((await getRecord(t.db, 'week_plan', weekPlanId(MON)))?.skipped_practices).toEqual(['pr']);
    // Wednesday's session was still to come, so it went with it.
    expect((await block('b2')(t))?.deleted_at).toBeTruthy();
  });

  it("Choose a time on a practice's card puts its session on the calendar to place by hand", async () => {
    const t = await open({ seed: picks });
    await userEvent.click(await screen.findByRole('button', { name: 'Piano practice, Practice, 30 minutes on Monday, to schedule' }));
    const panel = screen.getByRole('group', { name: 'Piano practice' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Choose a time' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Place here' }));
    await waitFor(async () => expect((await block('session:pr:2026-11-02')(t))?.deleted_at).toBeFalsy());
    expect(await block('session:pr:2026-11-02')(t)).toBeTruthy();
  });

  it("Choose a time from Today places a set day's session by hand, for its own day", async () => {
    const close = vi.fn();
    const t = await open({ seed: picks, params: { place: 'pr:2026-11-05' }, close });
    expect(await screen.findByRole('group', { name: 'Placing Piano practice' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Place here' }));
    await waitFor(async () => expect(await block('session:pr:2026-11-05')(t)).toBeTruthy());
    expect(await live(t, (b) => b.practice_id === 'pr')).toHaveLength(2);
    expect(close).not.toHaveBeenCalled();
  });

});

describe('an Inbox item’s block on Week, on desktop', () => {
  it('has no kind’s colour yet: Planning’s wash, a dashed edge, the inbox icon and the word Inbox, and it opens the item', async () => {
    await open({
      seed: async (w) => {
        await planned(w);
        await w.create('task', { kind: 'inbox', title: 'Book dentist' }, 'i1');
        await w.create('time_block', { task_id: 'i1', start: at('17:45'), end: at('18:45'), tz: ZONE }, 'bi');
      },
    });
    const el = await screen.findByRole('button', { name: 'Book dentist, Mon Nov 2, 5:45pm to 6:45pm, Inbox.' });
    expect(el).toHaveClass('blk', 'k-inbox', 's-planned');
    expect(el.querySelector('svg[data-icon="inbox"]')).not.toBeNull();
    expect(el).toHaveAttribute('aria-haspopup', 'dialog');
    await userEvent.click(el);
    expect(await screen.findByRole('dialog', { name: 'Book dentist' })).toBeVisible();
  });
});

describe('placing planning from Choose another time, on desktop', () => {
  // Friday, Nov 6 at 10am, the week planned: next week's planning task waits for a time, and Choose another time in
  // its sheet brought it here, 45 minutes long, waiting at 6pm today.
  const FRI = '2026-11-06';
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
  const handle = (title = 'Plan the week of Nov 9') => screen.findByRole('group', { name: new RegExp(`^${title}, .*Enter places it\\.$`) });
  const blocksOf = async (t: { db: Parameters<typeof listRecords>[0] }, id = PLAN) => (await listRecords(t.db, 'time_block')).filter((b) => b.task_id === id && !b.deleted_at);

  it('waits at its best time beside the rest of the week, with focus on it; keys move it, and Place here schedules it with Undo', async () => {
    const close = vi.fn();
    const t = await placing(later, close);
    expect(await handle()).toHaveFocus();
    expect(screen.getByText('Plan the week of Nov 9')).toBeVisible();
    // Nothing else is edited while it's placed.
    expect(screen.queryByRole('button', { name: "Edit this week's plan" })).toBeNull();
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');
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
    expect(await handle()).toHaveAccessibleName(/^Plan the week of Nov 9, Fri Nov 13, 6pm to 6:45pm, /);
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
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(await screen.findByText('Too late: plan it by Sat Nov 7.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Place here' })).toBeDisabled();
    await userEvent.keyboard('{ArrowLeft}');
    await userEvent.click(screen.getByRole('button', { name: 'Place here' }));
    expect(await screen.findByText(/^Planning scheduled for Sat /)).toBeVisible();
    await waitFor(async () => expect(await blocksOf(t, 'planning:stretch:2026-10-26')).toHaveLength(1));
    expect((await getRecord(t.db, 'task', 'planning:stretch:2026-10-26'))?.plans).toEqual(['stretch:2026-10-26', 'week:2026-11-09']);
  });
});

describe('hold to create on Week', () => {
  beforeEach(holdTimers);
  afterEach(() => void vi.useRealTimers());
  const draft = () => document.querySelector<HTMLElement>('.holddraft');
  const kind = (layout: 'desktop' | 'phone') => (layout === 'phone' ? 'touch' : 'mouse');
  const press = (el: Element, y: number, layout: 'desktop' | 'phone', x = 20) => fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, pointerType: kind(layout), pointerId: 1 });
  const letGo = (y: number, layout: 'desktop' | 'phone', x = 20) => fireEvent.pointerUp(window, { clientX: x, clientY: y, pointerType: kind(layout), pointerId: 1 });
  // jsdom has no layout. The desktop grid starts at 6am at the top of each day's column, 26px an hour, or 40px while
  // editing.
  const column = (date: string) => document.querySelector<HTMLElement>(`.colbody[data-drop-date="${date}"]`)!;
  const gridY = (minutes: number, hr = 26) => ((minutes - 360) * hr) / 60;

  describe('on desktop', () => {
    it('a mouse held on empty time drafts an hour there with a ring, and letting go opens Capture on it; Save puts an Inbox item and its block there, with Undo', async () => {
      const t = await open({ seed: planned });
      await screen.findByRole('group', { name: 'Week calendar' });
      const thu = column('2026-11-05');
      press(thu, gridY(16 * 60) + 1, 'desktop');
      await pass(450);
      expect(draft()).toHaveAttribute('title', '4pm to 5pm');
      expect(draft()).toHaveClass('ev', 'blk', 's-placing', 'pop');
      expect(draft()).toHaveTextContent('New task, 4pm');
      expect(thu.contains(draft())).toBe(true);
      expect(document.querySelector('.holdring')).not.toBeNull();
      expect(t.platform.haptics).toEqual(['light']);
      letGo(gridY(16 * 60) + 1, 'desktop');
      const capture = await screen.findByRole('dialog', { name: 'Capture' });
      expect(within(capture).getByText('Thu Nov 5, 4pm to 5pm')).toBeVisible();
      const field = within(capture).getByRole('combobox', { name: 'Capture to Inbox' });
      await waitFor(() => expect(field).toHaveFocus());
      await userEvent.type(field, 'Book dentist');
      expect(draft()).toHaveTextContent('Book dentist, 4pm');
      await userEvent.keyboard('{Enter}');
      expect(await screen.findByText('Saved to Inbox, Thu Nov 5, 4pm to 5pm')).toBeVisible();
      expect(draft()).toBeNull();
      expect(await screen.findByRole('button', { name: 'Book dentist, Thu Nov 5, 4pm to 5pm, Inbox.' })).toHaveClass('k-inbox');
      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await waitFor(() => expect(screen.queryByRole('button', { name: /^Book dentist,/ })).toBeNull());
    });

    it('Capture’s search lists To schedule, and picking a task there places it in the drafted time instead, with Undo', async () => {
      const t = await open({ seed: async (w) => { await planned(w); await setWeekPick(w, MON, 't1', 180); } });
      await screen.findByRole('group', { name: 'Week calendar' });
      press(column('2026-11-05'), gridY(16 * 60) + 1, 'desktop');
      await pass(450);
      letGo(gridY(16 * 60) + 1, 'desktop');
      const capture = await screen.findByRole('dialog', { name: 'Capture' });
      await userEvent.click(await within(capture).findByRole('option', { name: 'Draft the summary, Project · 2h of 3h left, Fits' }));
      expect(await screen.findByText(/^Placed Draft the summary, .*4pm$/)).toBeVisible();
      expect(draft()).toBeNull();
      const placed = async () => (await listRecords(t.db, 'time_block')).filter((b) => b.task_id === 't1' && !b.deleted_at && b.start === at('16:00', '2026-11-05'));
      await waitFor(async () => expect(await placed()).toMatchObject([{ end: at('18:00', '2026-11-05') }]));
      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await waitFor(async () => expect(await placed()).toEqual([]));
    });

    it('a draft that overlaps keeps its hour and sits beside it, Capture says by how much, moving takes it to another day in quarter hours, and Esc takes it away', async () => {
      await open({ seed: planned });
      await screen.findByRole('group', { name: 'Week calendar' });
      press(column(TUE), gridY(17 * 60 + 45) + 1, 'desktop');
      await pass(450);
      expect(draft()).toHaveAttribute('title', '5:45pm to 6:45pm');
      expect(draft()).toHaveClass('beside');
      // A column is 100px wide where jsdom measures none, so 102px over, with the gap, is the next day.
      fireEvent.pointerMove(window, { clientX: 122, clientY: gridY(18 * 60 + 45) + 1, pointerType: 'mouse', pointerId: 1 });
      await waitFor(() => expect(column(WED).contains(draft())).toBe(true));
      expect(draft()).toHaveAttribute('title', '6:45pm to 7:45pm');
      letGo(gridY(18 * 60 + 45) + 1, 'desktop', 122);
      const capture = await screen.findByRole('dialog', { name: 'Capture' });
      expect(within(capture).getByText('Wed Nov 4, 6:45pm to 7:45pm')).toBeVisible();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(draft()).toBeNull());
      expect(screen.queryByRole('dialog', { name: 'Capture' })).toBeNull();
    });

    it('a mouse pressed on empty time and dragged draws the draft at once, down or up, in its own day however far it strays, with no ring or tap; letting go opens Capture with that time', async () => {
      const t = await open({ seed: planned });
      await screen.findByRole('group', { name: 'Week calendar' });
      const thu = column('2026-11-05');
      const moveTo = (minutes: number, x = 20) => fireEvent.pointerMove(window, { clientX: x, clientY: gridY(minutes) + 1, pointerType: 'mouse', pointerId: 1 });
      press(thu, gridY(16 * 60) + 1, 'desktop');
      moveTo(17 * 60 + 20);
      await waitFor(() => expect(draft()).toHaveAttribute('title', '4pm to 5:30pm'));
      expect(thu.contains(draft())).toBe(true);
      expect(draft()).not.toHaveClass('pop');
      expect(document.querySelector('.holdring')).toBeNull();
      // Up past the press, and over Friday's column: it stays on Thursday.
      moveTo(14 * 60 + 50, 122);
      await waitFor(() => expect(draft()).toHaveAttribute('title', '2:45pm to 4:15pm'));
      expect(thu.contains(draft())).toBe(true);
      letGo(gridY(14 * 60 + 50) + 1, 'desktop', 122);
      const capture = await screen.findByRole('dialog', { name: 'Capture' });
      expect(within(capture).getByText('Thu Nov 5, 2:45pm to 4:15pm')).toBeVisible();
      expect(t.platform.haptics).toEqual([]);
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(draft()).toBeNull());

      // Esc while dragging takes it away.
      press(thu, gridY(16 * 60) + 1, 'desktop');
      moveTo(17 * 60);
      await waitFor(() => expect(draft()).not.toBeNull());
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(draft()).toBeNull());
      letGo(gridY(17 * 60) + 1, 'desktop');
      await pass(100);
      expect(screen.queryByRole('dialog', { name: 'Capture' })).toBeNull();
    });

    it('a hold on a calendar event, on time gone by, or while a block is open drafts nothing; a click on empty time does nothing either', async () => {
      const t = await open({ seed: planned });
      await screen.findByRole('group', { name: 'Week calendar' });
      const quiz = [...column(TUE).querySelectorAll('.ev')].find((el) => el.textContent === 'Quiz night')!;
      press(quiz, gridY(19 * 60), 'desktop');
      await pass(450);
      letGo(gridY(19 * 60), 'desktop');
      expect(draft()).toBeNull();

      press(column(MON), gridY(10 * 60), 'desktop');
      await pass(450);
      letGo(gridY(10 * 60), 'desktop');
      expect(draft()).toBeNull();
      expect(await screen.findByText('That time has gone by. Hold on a later time.')).toBeVisible();

      press(column('2026-11-05'), gridY(16 * 60), 'desktop');
      await pass(100);
      letGo(gridY(16 * 60), 'desktop');
      await pass(400);
      expect(draft()).toBeNull();

      // Piano practice's session, opened in its popup.
      await userEvent.click(screen.getByRole('button', { name: /^Piano practice, Wed Nov 4, 7am to 7:30am/ }));
      press(column('2026-11-05'), gridY(16 * 60), 'desktop');
      await pass(450);
      expect(draft()).toBeNull();
      expect(t.platform.haptics).toEqual([]);
    });

    it('while editing, a block held still lifts to move and drafts nothing, and a hold on empty time still drafts', async () => {
      await open({ seed: planned });
      await userEvent.click(await screen.findByRole('button', { name: "Edit this week's plan" }));
      const b1 = await screen.findByRole('group', { name: /^Draft the summary, Tue Nov 3, 6pm to 7pm/ });
      fireEvent.pointerDown(b1, { clientX: 20, clientY: gridY(18 * 60 + 30, 40), button: 0, pointerType: 'mouse', pointerId: 1 });
      await pass(450);
      expect(b1).toHaveClass('lifted');
      expect(draft()).toBeNull();
      letGo(gridY(18 * 60 + 30, 40), 'desktop');
      await waitFor(() => expect(b1).not.toHaveClass('lifted'));

      press(column('2026-11-05'), gridY(16 * 60, 40) + 1, 'desktop');
      await pass(450);
      expect(draft()).toHaveAttribute('title', '4pm to 5pm');
    });
  });
});
