import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moveBlock, placeWeekPractices } from '../../../core/blocks';
import { fixedClock } from '../../../core/clock';
import { getRecord, listRecords, removeWeekPick, setWeekPick, transact, weekPickId, weekPlanId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { runSync } from '../../../core/sync';
import { fakeSyncServer } from '../../../core/sync-testing';
import { openTestDb } from '../../../platform/node-sqlite';
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

  it('on phone has tappable steps, a Continue button that names the next step, and Capture', async () => {
    const t = await openPlanning({ layout: 'phone' });
    const steps = await screen.findByRole('navigation', { name: 'Planning steps' });
    expect(within(steps).getAllByRole('button').map((b) => b.textContent)).toEqual(['Inbox', 'Pick', 'Schedule', 'Review']);
    expect(screen.getByRole('button', { name: 'Previous step' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Continue to picking tasks' }));
    expect(within(steps).getByRole('button', { name: 'Pick' })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: 'Continue to scheduling' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Capture a task' }));
    expect(t.nav().overlay?.area).toBe('capture');
  });

  it('starts a one off dated inside the week as picked', async () => {
    const t = await openPlanning({ seed: seedWeek });
    await waitFor(async () => expect((await getRecord(t.db, 'week_pick', weekPickId('2026-11-02', 'o1')))?.minutes).toBe(90));
    expect(await getRecord(t.db, 'week_pick', weekPickId('2026-11-02', 'o2'))).toBeUndefined();
  });

  it('places the week’s practices on opening, so Pick tasks counts them without visiting Schedule', async () => {
    const t = await openPlanning({
      step: 1,
      seed: (w) => w.create('practice', { title: 'Morning stretch', target_min: 15, per: 'day', days: [2, 3], preferred_times: [7 * 60], state: 'active' }, 'pr'),
    });
    await waitFor(async () => expect((await listRecords(t.db, 'time_block')).filter((b) => b.practice_id === 'pr' && !b.deleted_at)).toHaveLength(2));
    const line = (await screen.findByText('Practices and repeating work')).parentElement!;
    await waitFor(() => expect(line).toHaveTextContent('30m'));
  });

  it('on a device that has not pulled yet, what opening fills in never overwrites another device’s moved session or removed pick', async () => {
    const WEEK = '2026-11-02';
    const server = fakeSyncServer({ now: () => Date.parse('2026-11-03T00:00:00Z') });
    const seed = async (w: Writer) => {
      await w.create('practice', { title: 'Learn to bake bread', target_min: 30, per: 'day', days: [2], preferred_times: [7 * 60], state: 'active' }, 'pr');
      await w.create('task', { kind: 'one_off', title: 'Paint the fence', estimate_min: 90, schedule: { type: 'once', from: '2026-11-04' } }, 'o1');
    };
    // The other device planned the week earlier today: it moved the session to the evening and took the one off out.
    const other = await openTestDb();
    const earlier = fixedClock('2026-11-02T15:00:00Z', 'America/Chicago');
    await transact(other, earlier, async (w) => {
      await seed(w);
      await placeWeekPractices(w, WEEK, earlier);
      await setWeekPick(w, WEEK, 'o1', 90);
    });
    const session = (await listRecords(other, 'time_block')).find((b) => b.practice_id === 'pr')!;
    const evening = { start: '2026-11-04T00:00:00Z', end: '2026-11-04T00:30:00Z' };
    await transact(other, earlier, async (w) => {
      await moveBlock(w, session.id, evening);
      await removeWeekPick(w, WEEK, 'o1');
    });
    await runSync(other, server.send);

    const t = await openPlanning({ seed });
    await waitFor(async () => expect(await getRecord(t.db, 'time_block', session.id)).toBeDefined());
    await waitFor(async () => expect(await getRecord(t.db, 'week_pick', weekPickId(WEEK, 'o1'))).toBeDefined());
    for (const db of [t.db, other, t.db]) await runSync(db, server.send);
    for (const db of [t.db, other]) {
      expect(await getRecord(db, 'time_block', session.id)).toMatchObject({ ...evening, edited: true });
      expect((await getRecord(db, 'week_pick', weekPickId(WEEK, 'o1')))?.deleted_at).toEqual(expect.any(String));
    }
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
    await userEvent.click(screen.getByRole('button', { name: 'Finish plan' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect((await getRecord(t.db, 'week_plan', weekPlanId('2026-11-02')))?.finished_at).toBe('2026-11-02T20:00:00Z');
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

  it('on phone, Finish plan is the bottom button', async () => {
    const close = vi.fn();
    await openPlanning({ step: 3, layout: 'phone', close });
    await userEvent.click(await screen.findByRole('button', { name: 'Finish plan' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
  });
});

