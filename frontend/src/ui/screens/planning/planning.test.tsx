import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../../../core/clock';
import { getRecord, listRecords, removeWeekPick, setWeekPick, transact, weekPickId, weekPlanId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { runSync } from '../../../core/sync';
import { fakeSyncServer } from '../../../core/sync-testing';
import { openTestDb } from '../../../platform/node-sqlite';
import { planningToPlace } from '../../components/planning/usePlanning';
import { openPlanning, seedWeek } from './testing';

afterEach(cleanup);

describe('the planning frame', () => {
  it('has four steps as tabs with arrows, starting at the Inbox', async () => {
    await openPlanning();
    const steps = await screen.findByRole('navigation', { name: 'Planning steps' });
    expect(within(steps).getAllByRole('button').map((b) => b.textContent)).toEqual(['1. Inbox', '2. Pick tasks', '3. Schedule', '4. Review']);
    expect(within(steps).getByRole('button', { name: '1. Inbox' })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: 'Previous step' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next step' }));
    expect(within(steps).getByRole('button', { name: '2. Pick tasks' })).toHaveAttribute('aria-current', 'step');
    await userEvent.click(within(steps).getByRole('button', { name: '4. Review' }));
    expect(screen.getByRole('button', { name: 'Next step' })).toBeDisabled();
  });

  it('plans this week until it is planned, then next week, with arrows and a This week button', async () => {
    await openPlanning();
    expect(await screen.findByText('Nov 2 to 8')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'This week' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Next week' }));
    expect(await screen.findByText('Nov 9 to 15')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    await userEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(await screen.findByText('Oct 26 to Nov 1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'This week' }));
    expect(await screen.findByText('Nov 2 to 8')).toBeInTheDocument();
    cleanup();

    await openPlanning({ seed: (w) => w.create('week_plan', { week_start: '2026-11-02', finished_at: '2026-11-01T20:00:00Z' }, weekPlanId('2026-11-02')) });
    expect(await screen.findByText('Nov 9 to 15')).toBeInTheDocument();
  });

  it('opens on the week it is given, and Save and exit leaves', async () => {
    const close = vi.fn();
    await openPlanning({ params: { week: '2026-11-16' }, close });
    expect(await screen.findByText('Nov 16 to 22')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save and exit' }));
    expect(close).toHaveBeenCalled();
  });

  it('takes focus on opening, and keeps it on the current step when a step’s own button moves on', async () => {
    await openPlanning();
    const steps = await screen.findByRole('navigation', { name: 'Planning steps' });
    await waitFor(() => expect(within(steps).getByRole('button', { name: '1. Inbox' })).toHaveFocus());
    await userEvent.click(await screen.findByRole('button', { name: 'Continue to picking tasks' }));
    await waitFor(() => expect(within(steps).getByRole('button', { name: '2. Pick tasks' })).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Next step' }));
    expect(screen.getByRole('button', { name: 'Next step' })).toHaveFocus();
  });

  it('resumes the step it was left on', async () => {
    await openPlanning({ step: 3 });
    expect(await screen.findByRole('button', { name: '4. Review' })).toHaveAttribute('aria-current', 'step');
  });

  it('on phone has tappable steps, a Continue button that names the next step, and Capture, which Pick makes Add', async () => {
    const t = await openPlanning({ layout: 'phone' });
    const steps = await screen.findByRole('navigation', { name: 'Planning steps' });
    // Named for screen readers, as on desktop, though phone has no room to show it.
    expect(screen.getByRole('heading', { level: 1, name: 'Plan the week' })).toHaveClass('sr');
    expect(within(steps).getAllByRole('button').map((b) => b.textContent)).toEqual(['Inbox', 'Pick', 'Schedule', 'Review']);
    expect(screen.getByRole('button', { name: 'Previous step' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Continue to picking tasks' }));
    expect(within(steps).getByRole('button', { name: 'Pick' })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: 'Continue to scheduling' })).toBeInTheDocument();
    // On Pick, + adds where you are, and Task to Inbox keeps capture one tap away.
    await userEvent.click(await screen.findByRole('button', { name: 'Add a task, one off, milestone or project' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Add' })).getByRole('button', { name: 'Task to Inbox' }));
    expect(t.nav().overlay?.area).toBe('capture');
    await userEvent.click(within(steps).getByRole('button', { name: 'Inbox' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Capture a task' }));
    expect(t.nav().overlay?.area).toBe('capture');
  });

  it('starts a one off dated inside the week as picked', async () => {
    const t = await openPlanning({ seed: seedWeek });
    await waitFor(async () => expect((await getRecord(t.db, 'week_pick', weekPickId('2026-11-02', 'o1')))?.minutes).toBe(90));
    expect(await getRecord(t.db, 'week_pick', weekPickId('2026-11-02', 'o2'))).toBeUndefined();
  });

  it('leaves the week’s practices to place on opening, and Pick tasks counts their time', async () => {
    const t = await openPlanning({
      step: 1,
      seed: (w) => w.create('practice', { title: 'Morning stretch', target_min: 15, per: 'day', days: [2, 3], preferred_times: [7 * 60], state: 'active' }, 'pr'),
    });
    expect(await screen.findByText('Practices and repeating work 30m')).toBeInTheDocument();
    expect(await listRecords(t.db, 'time_block')).toEqual([]);
  });

  it('opens on Schedule when asked to, for the week it is given', async () => {
    await openPlanning({ params: { week: '2026-11-02', step: 'schedule' } });
    expect(await screen.findByRole('button', { name: '3. Schedule' })).toHaveAttribute('aria-current', 'step');
  });

  it('opens on Pick tasks when stretch planning has just sorted the Inbox, even where it was left elsewhere', async () => {
    await openPlanning({ step: 3, params: { step: 'pick' } });
    expect(await screen.findByRole('button', { name: '2. Pick tasks' })).toHaveAttribute('aria-current', 'step');
  });

  it('on a device that has not pulled yet, what opening fills in never overwrites another device’s removed pick', async () => {
    const WEEK = '2026-11-02';
    const server = fakeSyncServer({ now: () => Date.parse('2026-11-03T00:00:00Z') });
    const seed = (w: Writer) => w.create('task', { kind: 'one_off', title: 'Paint the fence', estimate_min: 90, schedule: { type: 'once', from: '2026-11-04' } }, 'o1');
    // The other device planned the week earlier today and took the one off out.
    const other = await openTestDb();
    const earlier = fixedClock('2026-11-02T15:00:00Z', 'America/Chicago');
    await transact(other, earlier, async (w) => {
      await seed(w);
      await setWeekPick(w, WEEK, 'o1', 90);
    });
    await transact(other, earlier, (w) => removeWeekPick(w, WEEK, 'o1'));
    await runSync(other, server.send);

    const t = await openPlanning({ seed });
    await waitFor(async () => expect(await getRecord(t.db, 'week_pick', weekPickId(WEEK, 'o1'))).toBeDefined());
    for (const db of [t.db, other, t.db]) await runSync(db, server.send);
    for (const db of [t.db, other]) {
      expect((await getRecord(db, 'week_pick', weekPickId(WEEK, 'o1')))?.deleted_at).toEqual(expect.any(String));
    }
  });
});

describe('Does it fit?', () => {
  const fit = () => screen.getByRole('region', { name: 'Does it fit?' });

  it('stays under the steps on every step, and shows each change beside it', async () => {
    await openPlanning({ step: 1, seed: seedWeek });
    // Paint the fence is dated this week, so it starts picked: 1h 30m of the 98h left.
    await waitFor(() => expect(fit()).toHaveTextContent('1h 30m of 98h · 96h 30m free'));
    await userEvent.click(screen.getByRole('button', { name: 'Add 2h to this week: Collect the sources' }));
    await waitFor(() => expect(fit()).toHaveTextContent('3h 30m of 98h · 94h 30m free'));
    const delta = within(fit()).getByText('+2h');
    expect(delta).toHaveAttribute('aria-hidden', 'true');
    for (const step of ['1. Inbox', '3. Schedule', '4. Review']) {
      await userEvent.click(within(screen.getByRole('navigation', { name: 'Planning steps' })).getByRole('button', { name: step }));
      await waitFor(() => expect(fit()).toHaveTextContent('3h 30m of 98h · 94h 30m free'));
    }
  });

  it('says how far over the week goes, and what happens to the rest', async () => {
    const big = async (w: Writer) => {
      await seedWeek(w);
      await w.create('task', { kind: 'one_off', title: 'Paint the house', estimate_min: 6000, schedule: { type: 'once', from: '2026-11-03' } }, 'o9');
    };
    await openPlanning({ step: 0, seed: big });
    await waitFor(() => expect(fit()).toHaveTextContent('101h 30m of 98h · 3h 30m over'));
    expect(within(fit()).getByText('101h 30m of 98h · 3h 30m over')).toHaveClass('over');
    expect(within(fit()).getByText("What doesn't fit stays on its project or in One offs.")).toBeInTheDocument();
  });

  it('on phone, sits in the top bar, and on Pick shows This week', async () => {
    await openPlanning({ step: 0, layout: 'phone', seed: seedWeek });
    await waitFor(() => expect(fit()).toHaveTextContent('1h 30m of 98h · 96h 30m free'));
    expect(fit().closest('.flowtop')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Pick' }));
    const open = await screen.findByRole('button', { name: 'Does it fit? 1h 30m of 98h, 96h 30m free. Show This week' });
    expect(open.closest('.flowtop')).not.toBeNull();
    await userEvent.click(open);
    expect(await screen.findByRole('button', { name: 'This week, 1 task', pressed: true })).toBeInTheDocument();
  });
});

describe('the Inbox step', () => {
  it('lists what is waiting, and Process opens the cards for the week being planned', async () => {
    const t = await openPlanning({
      seed: async (w) => {
        await w.create('task', { kind: 'inbox', title: 'Return the library books', estimate_min: 30 }, 'i1');
        await w.create('task', { kind: 'inbox', title: 'Paint the fence' }, 'i2');
      },
    });
    expect(await screen.findByText('Return the library books')).toBeInTheDocument();
    expect(screen.getByText('30m estimate')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Process 2 items' }));
    expect(t.nav().overlay).toEqual({ area: 'process', params: { planning: '2026-11-02' } });
    await userEvent.click(screen.getByRole('button', { name: 'Assign Paint the fence' }));
    expect(t.nav().overlay).toEqual({ area: 'process', params: { planning: '2026-11-02', item: 'i2' } });
    await userEvent.click(screen.getByRole('button', { name: 'Continue to picking tasks' }));
    expect(await screen.findByRole('heading', { name: 'Pick tasks for the week' })).toBeInTheDocument();
  });

  it('says when the Inbox is empty', async () => {
    await openPlanning();
    expect(await screen.findByText('Inbox is empty.')).toBeInTheDocument();
  });

  it('on phone lists rows as the Inbox does, each name opening its popup and each › the cards on it', async () => {
    const t = await openPlanning({
      layout: 'phone',
      seed: (w) => w.create('task', { kind: 'inbox', title: 'Return the library books', estimate_min: 30 }, 'i1'),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Process Return the library books' }));
    expect(t.nav().overlay).toEqual({ area: 'process', params: { planning: '2026-11-02', item: 'i1' } });
    await userEvent.click(screen.getByRole('button', { name: 'Return the library books' }));
    expect(t.nav().overlay).toEqual({ area: 'task', params: { task: 'i1' } });
  });

  it("has the Inbox's select mode, to give many items a home at once", async () => {
    const t = await openPlanning({
      seed: async (w) => {
        await w.create('task', { kind: 'inbox', title: 'Return the library books' }, 'i1');
        await w.create('task', { kind: 'inbox', title: 'Paint the fence' }, 'i2');
        await w.create('task', { kind: 'inbox', title: 'Call the bank' }, 'i3');
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Return the library books' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Call the bank' }));
    await userEvent.click(screen.getByRole('button', { name: 'Make one offs' }));
    expect(await screen.findByText('Made 2 one offs.')).toBeVisible();
    expect((await getRecord(t.db, 'task', 'i3'))?.kind).toBe('one_off');
    expect(await screen.findByRole('button', { name: 'Process 1 item' })).toBeInTheDocument();
  });
});

describe('the Schedule step', () => {
  it('with nothing picked, moves on to Review', async () => {
    await openPlanning({ step: 2 });
    await userEvent.click(await screen.findByRole('button', { name: 'Continue to review' }));
    expect(await screen.findByRole('button', { name: 'Finish plan' })).toBeInTheDocument();
  });
});

describe('the Review step', () => {
  it('names aims not reached and work not yet scheduled, and Finish plan marks the week planned', async () => {
    const close = vi.fn();
    const t = await openPlanning({ step: 3, seed: seedWeek, close });
    expect(await screen.findByRole('heading', { name: '2 aims not reached' })).toBeInTheDocument();
    expect(screen.getByText('Write the report: 0m of 4h aim')).toBeInTheDocument();
    expect(screen.getByText('Learn to bake bread: 0m of 2h aim')).toBeInTheDocument();
    expect(await screen.findByText("1h 30m of what you picked isn't scheduled. It stays on its project or in One offs.")).toBeInTheDocument();
    expect(screen.getByText('98h free')).toBeInTheDocument();
    // The same card as Week's, with each part of the bar named on hover.
    const used = screen.getByRole('region', { name: "How this week's time is used" });
    expect(within(used).getByRole('img', { name: '0m projects, 0m practices, 0m one offs, 98h free' })).toBeInTheDocument();
    expect(used.querySelector('.capbar .seg-project')).toHaveAttribute('title', 'Projects: 0m');
    expect(within(used).getByText('Free 98h').querySelector('.seg-free')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Finish plan' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect((await getRecord(t.db, 'week_plan', weekPlanId('2026-11-02')))?.finished_at).toBe('2026-11-02T20:00:00Z');
  });

  it("counts what isn't scheduled as Week and Schedule do: a block running into next week counts only its hour in this one", async () => {
    await openPlanning({
      step: 3,
      seed: async (w) => {
        await w.create('project', { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-15' }, 'report');
        await w.create('task', { kind: 'project', project_id: 'report', title: 'Write chapter one', estimate_min: 240 }, 't2');
        await setWeekPick(w, '2026-11-02', 't2', 240);
        // Sunday 11pm to Monday 1am in Chicago.
        await w.create('time_block', { task_id: 't2', start: '2026-11-09T05:00:00Z', end: '2026-11-09T07:00:00Z', tz: 'America/Chicago' });
      },
    });
    expect(await screen.findByText("3h of what you picked isn't scheduled. It stays on its project or in One offs.")).toBeInTheDocument();
  });

  it('counts placed blocks toward aims, and skipped aims do not count', async () => {
    await openPlanning({
      step: 3,
      seed: async (w) => {
        await seedWeek(w);
        await w.create('time_block', { task_id: 't2', start: '2026-11-03T15:00:00Z', end: '2026-11-03T19:00:00Z', tz: 'America/Chicago' }, 'b-t2');
        await w.create('week_plan', { week_start: '2026-11-02', skipped_aims: ['bread'] }, weekPlanId('2026-11-02'));
      },
    });
    expect(await screen.findByRole('heading', { name: 'Ready to finish' })).toBeInTheDocument();
    expect(screen.getByText('All weekly aims are reached.')).toBeInTheDocument();
  });

  describe('the time spent planning', () => {
    it('counts the minutes you were active, and closing the flow adds them to the week with when it began', async () => {
      const close = vi.fn();
      const t = await openPlanning({ params: { week: '2026-11-09' }, close });
      await userEvent.click(await screen.findByRole('button', { name: 'Continue to picking tasks' }));
      // Active for 3 minutes, then away for 15: only 5 of those count.
      t.clock.set('2026-11-02T20:03:00Z');
      await userEvent.click(screen.getByRole('button', { name: 'Previous step' }));
      t.clock.set('2026-11-02T20:18:00Z');
      await userEvent.click(screen.getByRole('button', { name: 'Save and exit' }));
      await waitFor(async () =>
        expect(await getRecord(t.db, 'week_plan', weekPlanId('2026-11-09'))).toMatchObject({ planning_min: 8, planning_started_at: '2026-11-02T20:00:00Z' }),
      );
    });

    it('Finish plan says how long planning took', async () => {
      const t = await openPlanning({ step: 3, params: { week: '2026-11-09' } });
      localStorage.setItem('multiscale.planning.step.2026-11-09', '3');
      await screen.findByRole('button', { name: 'Finish plan' });
      t.clock.set('2026-11-02T20:04:00Z');
      await userEvent.click(screen.getByRole('button', { name: 'Finish plan' }));
      expect(await screen.findByText('Week planned in 4m.')).toBeVisible();
    });
  });

  describe("Review's next planning row", () => {
    // Sunday, Nov 8 at 5:05pm in Chicago, planning the week of Nov 9.
    const SUNDAY = '2026-11-08T23:05:00Z';

    it('offers the same time a week on, and schedules it in one tap with Undo in the row', async () => {
      const t = await openPlanning({ now: SUNDAY, step: 3, params: { week: '2026-11-09' } });
      const next = await screen.findByRole('region', { name: 'Next planning' });
      expect(within(next).getByText('Sun Nov 15, 5pm')).toBeVisible();
      expect(within(next).getByText('Same time as today')).toBeVisible();
      await userEvent.click(within(next).getByRole('button', { name: 'Schedule planning for Sunday, Nov 15 at 5pm' }));
      expect(await within(next).findByText('Scheduled for Sun Nov 15, 5pm.')).toBeVisible();
      const blocks = async () => (await listRecords(t.db, 'time_block')).filter((b) => b.task_id === 'planning:week:2026-11-16' && !b.deleted_at);
      expect(await blocks()).toMatchObject([{ start: '2026-11-15T23:00:00Z', end: '2026-11-15T23:30:00Z' }]);
      await userEvent.click(within(next).getByRole('button', { name: 'Undo' }));
      await waitFor(async () => expect(await blocks()).toEqual([]));
      expect(await screen.findByRole('button', { name: 'Schedule planning for Sunday, Nov 15 at 5pm' })).toBeVisible();
    });

    it('offers Choose a time for next week too', async () => {
      await openPlanning({ now: SUNDAY, step: 3, params: { week: '2026-11-09' } });
      const next = await screen.findByRole('region', { name: 'Next planning' });
      await userEvent.click(within(next).getByRole('button', { name: 'Choose a time to plan the week after' }));
      expect(await screen.findByRole('dialog', { name: 'When will you plan the week after?' })).toBeVisible();
    });

    it('Choose another time goes to Week to place the block, and Week comes back to this week of planning after', async () => {
      const t = await openPlanning({ now: SUNDAY, step: 3, params: { week: '2026-11-09' } });
      await userEvent.click(within(await screen.findByRole('region', { name: 'Next planning' })).getByRole('button', { name: 'Choose a time to plan the week after' }));
      const sheet = await screen.findByRole('dialog', { name: 'When will you plan the week after?' });
      await userEvent.click(within(sheet).getByRole('button', { name: 'Choose another time' }));
      const route = t.nav().route;
      expect(route).toMatchObject({ area: 'week', params: { place: 'planning:week:2026-11-16' } });
      expect(planningToPlace(route.params)).toMatchObject({ for: '2026-11-16', minutes: 30, flow: '2026-11-09' });
    });
  });

  describe('with a planning task', () => {
    const PLAN = 'planning:week:2026-11-09';
    const seed = (block: { start: string; end: string; started_at?: string }) => async (w: Writer) => {
      await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 9', plans: ['week:2026-11-09'] }, PLAN);
      await w.create('time_block', { task_id: PLAN, ...block, tz: 'America/Chicago' }, 'p1');
    };

    it('Finish plan ahead of its block finishes the task and frees the block, with Undo', async () => {
      const close = vi.fn();
      // Sunday, Nov 8 at 5pm in Chicago.
      const t = await openPlanning({ step: 3, params: { week: '2026-11-09' }, close, seed: seed({ start: '2026-11-08T23:00:00Z', end: '2026-11-08T23:30:00Z' }) });
      await userEvent.click(await screen.findByRole('button', { name: 'Finish plan' }));
      expect(await screen.findByText('Week planned. Sun 5pm is free again.')).toBeVisible();
      expect((await getRecord(t.db, 'task', PLAN))?.done_at).toBe('2026-11-02T20:00:00Z');
      expect((await getRecord(t.db, 'time_block', 'p1'))?.cancelled).toBe(true);
      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'p1'))?.cancelled).toBeFalsy());
      expect((await getRecord(t.db, 'task', PLAN))?.done_at).toBeNull();
      expect((await getRecord(t.db, 'week_plan', weekPlanId('2026-11-09')))?.finished_at).toBeNull();
    });

    it('Save and exit ends the planning block under way at that minute', async () => {
      const close = vi.fn();
      const t = await openPlanning({ params: { week: '2026-11-09' }, close, seed: seed({ start: '2026-11-02T19:50:00Z', end: '2026-11-02T20:20:00Z', started_at: '2026-11-02T19:50:00Z' }) });
      await userEvent.click(await screen.findByRole('button', { name: 'Save and exit' }));
      await waitFor(() => expect(close).toHaveBeenCalled());
      expect(await getRecord(t.db, 'time_block', 'p1')).toMatchObject({ end: '2026-11-02T20:00:00Z', ended_at: '2026-11-02T20:00:00Z' });
    });
  });

  it('on phone, Finish plan is the bottom button', async () => {
    const close = vi.fn();
    await openPlanning({ step: 3, layout: 'phone', close });
    await userEvent.click(await screen.findByRole('button', { name: 'Finish plan' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
  });
});

