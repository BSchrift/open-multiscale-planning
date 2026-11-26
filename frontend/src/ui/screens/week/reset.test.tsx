import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { localToInstant } from '../../../core/dates';
import { getRecord, listRecords, weekPickId, weekPlanId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderScreen } from '../../app/testing';
import type { HarnessOptions } from '../../app/testing';

afterEach(cleanup);
afterEach(() => localStorage.clear());

// The harness clock reads Monday, Nov 2 at 2pm in Chicago.
const ZONE = 'America/Chicago';
const WEEK = '2026-11-02';
const NEXT = '2026-11-09';
const at = (date: string, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return localToInstant(date, h! * 60 + (m ?? 0), ZONE);
};

/** Two tasks and a practice, with this morning's block gone by and two blocks still to come, one a practice session. */
async function base(w: Writer) {
  await w.create('task', { kind: 'one_off', title: 'Paint the fence', estimate_min: 60 }, 't1');
  await w.create('task', { kind: 'one_off', title: 'Call the bank', estimate_min: 60 }, 't2');
  await w.create('practice', { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' }, 'pr');
  await w.create('time_block', { task_id: 't1', start: at(WEEK, '07:30'), end: at(WEEK, '08:30'), tz: ZONE }, 'past');
  await w.create('time_block', { task_id: 't1', start: at('2026-11-03', '18:00'), end: at('2026-11-03', '19:00'), tz: ZONE }, 'tue');
  await w.create('time_block', { practice_id: 'pr', start: at('2026-11-04', '07:00'), end: at('2026-11-04', '07:30'), tz: ZONE }, 'wed');
}

/** This week planned, with both tasks picked. */
async function planned(w: Writer) {
  await base(w);
  await w.create('week_plan', { week_start: WEEK, finished_at: at(WEEK, '08:00') }, weekPlanId(WEEK));
  await w.create('week_pick', { week_start: WEEK, task_id: 't1', minutes: 60 }, weekPickId(WEEK, 't1'));
  await w.create('week_pick', { week_start: WEEK, task_id: 't2', minutes: 60 }, weekPickId(WEEK, 't2'));
}

const open = (options: HarnessOptions = {}) => renderScreen('week', { zone: ZONE, seed: planned, ...options });
const resetButton = () => screen.findByRole('button', { name: "Reset this week's plan" });

// On phone the week is Today's, whose menu resets it: those are in today/weekOnToday.test.tsx.
describe("Reset this week's plan, on desktop", () => {
  it('shows only while the week has something to reset, and never on a past week', async () => {
    await open();
    await userEvent.click(await resetButton());
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    await screen.findByText('Past weeks can be viewed but not changed.');
    expect(screen.queryByRole('button', { name: /^Reset/ })).toBeNull();
  });

  it('is not there with nothing planned: only what has already happened', async () => {
    await open({ seed: async (w) => w.create('task', { kind: 'one_off', title: 'Paint the fence' }, 't1').then(() => w.create('time_block', { task_id: 't1', start: at(WEEK, '07:30'), end: at(WEEK, '08:30'), tz: ZONE })) });
    await screen.findByText(/This week isn't planned yet/);
    expect(screen.queryByRole('button', { name: /^Reset/ })).toBeNull();
  });

  it('asks first, saying what goes and what stays, and Cancel changes nothing', async () => {
    const t = await open();
    const button = await resetButton();
    await userEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: "Reset this week's plan?" });
    expect(dialog).toHaveAccessibleDescription(
      'This takes out: 2 tasks picked for this week. 2 blocks still to come, 1 of them a practice session. ' +
        'It keeps: 1 block already started, answered or gone by. Your tasks and practices themselves. ' +
        'This week then shows as not planned, so you can plan it again. You can undo this.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button).toHaveFocus();
    expect(await listRecords(t.db, 'week_pick')).toHaveLength(2);
    expect(await getRecord(t.db, 'week_plan', weekPlanId(WEEK))).toMatchObject({ finished_at: at(WEEK, '08:00') });
  });

  it('takes the plan out on Reset plan, says so with Undo, and Undo puts it all back', async () => {
    localStorage.setItem(`multiscale.planning.step.${WEEK}`, '3');
    const t = await open();
    await userEvent.click(await resetButton());
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset plan' }));

    expect(await screen.findByText("Reset this week's plan: 2 tasks and 2 blocks removed.")).toBeVisible();
    const undo = screen.getByRole('button', { name: 'Undo' });
    // The button that did it has gone, so focus is on Undo.
    await waitFor(() => expect(undo).toHaveFocus());
    expect(await listRecords(t.db, 'week_pick')).toEqual([]);
    expect((await getRecord(t.db, 'time_block', 'tue'))?.deleted_at).toBeTruthy();
    expect((await getRecord(t.db, 'time_block', 'wed'))?.deleted_at).toBeTruthy();
    expect((await getRecord(t.db, 'time_block', 'past'))?.deleted_at ?? null).toBeNull();
    expect((await getRecord(t.db, 'week_plan', weekPlanId(WEEK)))?.finished_at ?? null).toBeNull();
    // The week asks to be planned again, and planning opens on its first step.
    expect((await screen.findAllByText(/This week isn't planned yet/))[0]).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Reset/ })).toBeNull();
    expect(localStorage.getItem(`multiscale.planning.step.${WEEK}`)).toBe('0');

    await userEvent.click(undo);
    await waitFor(async () => expect(await listRecords(t.db, 'week_pick')).toHaveLength(2));
    expect((await getRecord(t.db, 'time_block', 'tue'))?.deleted_at ?? null).toBeNull();
    expect((await getRecord(t.db, 'time_block', 'wed'))?.deleted_at ?? null).toBeNull();
    expect(await getRecord(t.db, 'week_plan', weekPlanId(WEEK))).toMatchObject({ finished_at: at(WEEK, '08:00') });
    expect(localStorage.getItem(`multiscale.planning.step.${WEEK}`)).toBe('3');
    // The button comes back, with focus.
    await waitFor(() => expect(screen.getByRole('button', { name: "Reset this week's plan" })).toHaveFocus());
  });

  it("offers Reset next week's plan on next week, which leaves this week alone", async () => {
    const t = await open({
      seed: async (w) => {
        await planned(w);
        await w.create('week_plan', { week_start: NEXT, finished_at: at(WEEK, '09:00') }, weekPlanId(NEXT));
        await w.create('week_pick', { week_start: NEXT, task_id: 't2', minutes: 60 }, weekPickId(NEXT, 't2'));
      },
    });
    await resetButton();
    await userEvent.click(screen.getByRole('button', { name: 'Next week' }));
    await userEvent.click(await screen.findByRole('button', { name: "Reset next week's plan" }));
    const dialog = screen.getByRole('dialog', { name: "Reset next week's plan?" });
    expect(dialog).toHaveAccessibleDescription(
      'This takes out: 1 task picked for next week. It keeps: Your tasks and practices themselves. ' +
        'Next week then shows as not planned, so you can plan it again. You can undo this.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset plan' }));
    expect(await screen.findByText("Reset next week's plan: 1 task removed.")).toBeVisible();
    expect((await listRecords(t.db, 'week_pick')).map((p) => p.week_start)).toEqual([WEEK, WEEK]);
    expect(await getRecord(t.db, 'week_plan', weekPlanId(WEEK))).toMatchObject({ finished_at: at(WEEK, '08:00') });
  });
});
