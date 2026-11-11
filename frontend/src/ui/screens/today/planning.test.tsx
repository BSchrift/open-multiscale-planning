import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { localToInstant } from '../../../core/dates';
import { weekPlanningId } from '../../../core/planning';
import { getRecord, listRecords, weekPlanId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import type { Layout } from '../../app/registry';
import { renderScreen } from '../../app/testing';
import type { HarnessOptions } from '../../app/testing';

afterEach(cleanup);

// Friday, Nov 6 in Chicago: the week of Nov 2 is planned, and the week of Nov 9 is next.
const ZONE = 'America/Chicago';
const THIS = '2026-11-02';
const NEXT = '2026-11-09';
const at = (date: string, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return localToInstant(date, h! * 60 + (m ?? 0), ZONE);
};
const FRIDAY = at('2026-11-06', '10:00');
const NEXT_ID = weekPlanningId(NEXT);
const THIS_ID = weekPlanningId(THIS);

const planned = (w: Writer, week = THIS) => w.create('week_plan', { week_start: week, finished_at: at(week, '08:00') }, weekPlanId(week));
const inbox = (w: Writer) => w.create('task', { kind: 'inbox', title: 'Rake the leaves' }, 'i1');

function open(options: HarnessOptions & { seed?(w: Writer): Promise<unknown> } = {}) {
  return renderScreen('today', {
    now: FRIDAY,
    zone: ZONE,
    ...options,
    seed: async (w) => {
      await planned(w);
      await inbox(w);
      await options.seed?.(w);
    },
  });
}

const row = () => screen.findByRole('region', { name: 'Plan next week' });
const blocksOf = async (t: { db: Parameters<typeof listRecords>[0] }, id: string) =>
  (await listRecords(t.db, 'time_block')).filter((b) => b.task_id === id && !b.cancelled);

describe("next week's planning row", () => {
  it('appears three days before, once the app has saved the task, with how long planning takes and the Inbox', async () => {
    const t = await open();
    const r = await row();
    expect(within(r).getByText('Plan next week')).toBeVisible();
    expect(within(r).getByText(/About 30m · 1 in your Inbox/)).toBeVisible();
    expect(await getRecord(t.db, 'task', NEXT_ID)).toMatchObject({ kind: 'planning', title: 'Plan the week of Nov 9' });
    expect(await blocksOf(t, NEXT_ID)).toEqual([]);
  });

  it('is not there before then', async () => {
    const t = await open({ now: at('2026-11-05', '10:00') });
    await screen.findByRole('heading', { level: 1, name: 'Today' });
    expect(screen.queryByRole('region', { name: 'Plan next week' })).toBeNull();
    expect(await getRecord(t.db, 'task', NEXT_ID)).toBeUndefined();
  });

  it.each(['desktop', 'phone'] as Layout[])('on %s, one tap schedules the best time, with Undo, and the row goes', async (layout) => {
    const t = await open({ layout });
    const r = await row();
    await userEvent.click(within(r).getByRole('button', { name: 'Schedule planning for Friday, Nov 6 at 5pm' }));
    expect(await screen.findByText('Planning scheduled for Fri 5pm.')).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Plan next week' })).toBeNull());
    expect(await blocksOf(t, NEXT_ID)).toMatchObject([{ start: at('2026-11-06', '17:00'), end: at('2026-11-06', '17:30') }]);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await row()).toBeVisible();
    expect((await blocksOf(t, NEXT_ID)).filter((b) => !b.deleted_at)).toEqual([]);
  });

  it('Delete takes the task away with Undo, and it is not made again', async () => {
    const t = await open();
    await userEvent.click(within(await row()).getByRole('button', { name: 'Delete planning task: Plan the week of Nov 9' }));
    expect(await screen.findByText('Planning for the week of Nov 9 deleted.')).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Plan next week' })).toBeNull());
    expect((await getRecord(t.db, 'task', NEXT_ID))?.deleted_at).toBe(FRIDAY);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await row()).toBeVisible();
    cleanup();
    // Deleted on another device: the next day, this one doesn't make it again.
    const later = await open({ now: at('2026-11-07', '10:00'), seed: (w) => w.create('task', { kind: 'planning', title: 'Plan the week of Nov 9', deleted_at: FRIDAY }, NEXT_ID) });
    await screen.findByRole('heading', { level: 1, name: 'Today' });
    expect(screen.queryByRole('region', { name: 'Plan next week' })).toBeNull();
    expect((await getRecord(later.db, 'task', NEXT_ID))?.deleted_at).toBe(FRIDAY);
  });

  it('becomes Start now when the best time is within 15 minutes', async () => {
    await open({ now: at('2026-11-06', '16:50') });
    expect(within(await row()).getByRole('button', { name: 'Start planning now' })).toHaveTextContent('Start now');
  });

  it('Choose a time lists Now and the next free times, says where the estimate comes from, and Now starts planning', async () => {
    const t = await open();
    await userEvent.click(within(await row()).getByRole('button', { name: 'Choose a time to plan next week' }));
    const sheet = await screen.findByRole('dialog', { name: 'When will you plan next week?' });
    expect(within(sheet).getByText('About 30m, a first guess.')).toBeVisible();
    expect(within(sheet).getByRole('button', { name: 'Start planning now' })).toHaveTextContent('Now, until 10:30am');
    expect(within(sheet).getByRole('button', { name: 'Schedule planning for Saturday, Nov 7 at 9am' })).toBeVisible();
    expect(document.activeElement).toBe(within(sheet).getByRole('button', { name: 'Start planning now' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Start planning now' }));
    expect(await screen.findByText('Planning until 10:30am.')).toBeVisible();
    expect(t.nav().flow).toEqual({ area: 'planning', params: { week: NEXT } });
    expect(await blocksOf(t, NEXT_ID)).toMatchObject([{ start: FRIDAY, end: at('2026-11-06', '10:30'), started_at: FRIDAY }]);
  });

  it('Change length changes this block only, in 15-minute steps', async () => {
    const t = await open();
    await userEvent.click(within(await row()).getByRole('button', { name: 'Choose a time to plan next week' }));
    const sheet = await screen.findByRole('dialog', { name: 'When will you plan next week?' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Change length' }));
    fireEvent.change(within(sheet).getByRole('slider', { name: 'Length' }), { target: { value: '45' } });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Schedule planning for Saturday, Nov 7 at 9am' }));
    expect(await screen.findByText('Planning scheduled for Sat 9am.')).toBeVisible();
    expect(await blocksOf(t, NEXT_ID)).toMatchObject([{ start: at('2026-11-07', '09:00'), end: at('2026-11-07', '09:45') }]);
  });

  it('Choose another time takes any day and time', async () => {
    const t = await open();
    await userEvent.click(within(await row()).getByRole('button', { name: 'Choose a time to plan next week' }));
    const sheet = await screen.findByRole('dialog', { name: 'When will you plan next week?' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Choose another time' }));
    fireEvent.change(within(sheet).getByLabelText('Day'), { target: { value: '2026-11-08' } });
    fireEvent.change(within(sheet).getByLabelText('Time'), { target: { value: '19:15' } });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Schedule planning for Sunday, Nov 8 at 7:15pm' }));
    expect(await screen.findByText('Planning scheduled for Sun 7:15pm.')).toBeVisible();
    expect(await blocksOf(t, NEXT_ID)).toMatchObject([{ start: at('2026-11-08', '19:15'), end: at('2026-11-08', '19:45') }]);
  });

  it('stays away while the week is planned already', async () => {
    const t = await open({ seed: (w) => planned(w, NEXT) });
    await screen.findByRole('heading', { level: 1, name: 'Today' });
    expect(screen.queryByRole('region', { name: 'Plan next week' })).toBeNull();
    expect(await getRecord(t.db, 'task', NEXT_ID)).toBeUndefined();
  });
});

describe('the prompt to plan this week', () => {
  const MONDAY = at(THIS, '09:00');
  const unplanned = (options: HarnessOptions = {}) => renderScreen('today', { now: MONDAY, zone: ZONE, ...options, seed: inbox });

  it('says how long planning takes, and offers Start planning, Choose a time and Skip for now, stacked on phone', async () => {
    await unplanned({ layout: 'phone' });
    expect(await screen.findByRole('heading', { name: 'Plan your week' })).toBeVisible();
    expect(screen.getByText("This week isn't planned yet. About 30m.")).toBeVisible();
    for (const name of ['Start planning', 'Choose a time to plan this week', 'Skip for now']) expect(screen.getByRole('button', { name })).toBeVisible();
  });

  it('on desktop keeps to one line, with × as Skip for now, whose toast has Undo; the skip is saved for every device', async () => {
    const t = await unplanned();
    await userEvent.click(await screen.findByRole('button', { name: 'Skip planning this week' }));
    expect(await screen.findByText('Skipped planning this week.')).toBeVisible();
    expect(await screen.findByText("This week isn't planned")).toBeVisible();
    expect((await getRecord(t.db, 'week_plan', weekPlanId(THIS)))?.planning_skipped_at).toBe(MONDAY);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('heading', { name: 'Plan your week' })).toBeVisible();
  });

  it("the skipped week's banner starts planning with a block from now", async () => {
    const t = await renderScreen('today', {
      now: MONDAY,
      zone: ZONE,
      seed: (w) => w.create('week_plan', { week_start: THIS, planning_skipped_at: MONDAY }, weekPlanId(THIS)),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Start planning' }));
    expect(t.nav().flow).toEqual({ area: 'planning', params: { week: THIS } });
    expect(await blocksOf(t, THIS_ID)).toMatchObject([{ start: MONDAY, started_at: MONDAY }]);
  });

  it('a skip from another device is kept here', async () => {
    await renderScreen('today', {
      now: MONDAY,
      zone: ZONE,
      seed: (w) => w.create('week_plan', { week_start: THIS, planning_skipped_at: MONDAY }, weekPlanId(THIS)),
    });
    expect(await screen.findByText("This week isn't planned")).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Plan your week' })).toBeNull();
  });

  it('Start planning places a block from now with Undo, and opens planning', async () => {
    const t = await unplanned();
    await userEvent.click(await screen.findByRole('button', { name: 'Start planning' }));
    expect(await screen.findByText('Planning until 9:30am.')).toBeVisible();
    expect(t.nav().flow).toEqual({ area: 'planning', params: { week: THIS } });
    expect(await blocksOf(t, THIS_ID)).toMatchObject([{ start: MONDAY, end: at(THIS, '09:30'), started_at: MONDAY }]);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await blocksOf(t, THIS_ID)).filter((b) => !b.deleted_at)).toEqual([]));
  });

  it("Choose a time asks when you'll plan this week and offers the next free times", async () => {
    await unplanned();
    await userEvent.click(await screen.findByRole('button', { name: 'Choose a time to plan this week' }));
    const sheet = await screen.findByRole('dialog', { name: 'When will you plan this week?' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Schedule planning for Monday, Nov 2 at 5pm' }));
    expect(await screen.findByText('Planning scheduled for Mon 5pm.')).toBeVisible();
    expect(await screen.findByText('Planning is set for Mon 5pm.')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Plan your week' })).toBeNull();
  });

  it('with planning set for later, Today shows as usual with Start now', async () => {
    const t = await renderScreen('today', {
      now: MONDAY,
      zone: ZONE,
      seed: async (w) => {
        await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 2', plans: [`week:${THIS}`] }, THIS_ID);
        await w.create('time_block', { task_id: THIS_ID, start: at(THIS, '18:00'), end: at(THIS, '18:30'), tz: ZONE }, 'p1');
      },
    });
    const set = await screen.findByRole('region', { name: 'Planning is set for Mon 6pm.' });
    await userEvent.click(within(set).getByRole('button', { name: 'Start now' }));
    expect(t.nav().flow).toEqual({ area: 'planning', params: { week: THIS } });
  });
});

describe('a planning block on the Now card', () => {
  it('offers Start planning, which starts it and opens planning, and never Mark done now', async () => {
    const t = await renderScreen('today', {
      now: at(THIS, '18:05'),
      zone: ZONE,
      seed: async (w) => {
        await inbox(w);
        await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 2', plans: [`week:${THIS}`] }, THIS_ID);
        await w.create('time_block', { task_id: THIS_ID, start: at(THIS, '18:00'), end: at(THIS, '18:30'), tz: ZONE }, 'p1');
      },
    });
    const card = await screen.findByRole('region', { name: 'Current block' });
    expect(within(card).getByText('Plan the week of Nov 2')).toBeVisible();
    expect(within(card).getByText('6pm to 6:30pm · 1 in your Inbox')).toBeVisible();
    expect(within(card).queryByRole('button', { name: 'Mark done now' })).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'Start planning' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'p1'))?.started_at).toBe(at(THIS, '18:05')));
    expect(t.nav().flow).toEqual({ area: 'planning', params: { week: THIS } });
    await act(() => t.nav().closeFlow());
    expect(within(await screen.findByRole('region', { name: 'Current block' })).getByRole('button', { name: 'Keep going' })).toBeVisible();
  });
});

describe('the row learns', () => {
  // Four weeks planned in 22 to 46 minutes, each begun on Sunday at 5pm.
  const history = async (w: Writer) => {
    for (const [week, minutes] of [['2026-10-12', 22], ['2026-10-19', 31], ['2026-10-26', 40], ['2026-11-02', 46]] as const) {
      await w.create(
        'week_plan',
        { week_start: week, finished_at: at(week, '08:00'), planning_min: minutes, planning_started_at: at(weekBefore(week), '17:05') },
        weekPlanId(week),
      );
    }
  };
  const weekBefore = (week: string) => new Date(Date.parse(`${week}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

  it('how long planning takes from your last plans, and offers your usual time first', async () => {
    await open({ seed: history });
    const r = await row();
    expect(within(r).getByText(/About 45m · 1 in your Inbox/)).toBeVisible();
    expect(within(r).getByRole('button', { name: 'Schedule planning for Sunday, Nov 8 at 5pm' })).toBeVisible();
    await userEvent.click(within(r).getByRole('button', { name: 'Choose a time to plan next week' }));
    const sheet = await screen.findByRole('dialog', { name: 'When will you plan next week?' });
    expect(within(sheet).getByText('About 45m, from your last 4 plans.')).toBeVisible();
    expect(within(sheet).getByRole('button', { name: 'Schedule planning for Sunday, Nov 8 at 5pm, your usual time' })).toHaveTextContent('Sun 5pm, your usual time');
  });

  it('says when planning stopped part way, with the step and the time left, and Keep going places a block for it', async () => {
    localStorage.setItem(`multiscale.planning.step.${NEXT}`, '2');
    const t = await open({ seed: (w) => w.create('week_plan', { week_start: NEXT, planning_min: 16, planning_started_at: at('2026-11-05', '20:00') }, weekPlanId(NEXT)) });
    const r = await screen.findByRole('region', { name: 'Finish planning next week' });
    expect(within(r).getByText('You stopped on the Schedule step. About 15m left.')).toBeVisible();
    await userEvent.click(within(r).getByRole('button', { name: 'Keep going' }));
    expect(t.nav().flow).toEqual({ area: 'planning', params: { week: NEXT } });
    expect(await blocksOf(t, NEXT_ID)).toMatchObject([{ start: FRIDAY, end: at('2026-11-06', '10:15') }]);
    localStorage.clear();
  });

  it('on a device that can’t know the step, says planning started and isn’t finished', async () => {
    await open({ seed: (w) => w.create('week_plan', { week_start: NEXT, planning_min: 16, planning_started_at: at('2026-11-05', '20:00') }, weekPlanId(NEXT)) });
    const r = await screen.findByRole('region', { name: 'Finish planning next week' });
    expect(within(r).getByText('Started, not finished. About 15m left.')).toBeVisible();
  });

  it('says when its time passed unopened, and offers the next free time', async () => {
    await open({
      now: at('2026-11-07', '12:00'),
      seed: async (w) => {
        await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 9', plans: [`week:${NEXT}`] }, NEXT_ID);
        await w.create('time_block', { task_id: NEXT_ID, start: at('2026-11-07', '09:00'), end: at('2026-11-07', '09:30'), tz: ZONE });
      },
    });
    const r = await row();
    expect(within(r).getByText('Your planning time passed. About 30m.')).toBeVisible();
    expect(within(r).getByRole('button', { name: /^Schedule planning for / })).toBeVisible();
  });
});

describe('a planning block for a week planned on an older app', () => {
  it('says the week is planned already, and offers Free this time in place of Start', async () => {
    const t = await renderScreen('today', {
      now: at(THIS, '18:05'),
      zone: ZONE,
      seed: async (w) => {
        await planned(w);
        await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 2', plans: [`week:${THIS}`] }, THIS_ID);
        await w.create('time_block', { task_id: THIS_ID, start: at(THIS, '18:00'), end: at(THIS, '18:30'), tz: ZONE }, 'p1');
      },
    });
    const card = await screen.findByRole('region', { name: 'Current block' });
    expect(within(card).getByText('This week is already planned.')).toBeVisible();
    expect(within(card).queryByRole('button', { name: 'Start planning' })).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'Free this time' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'p1'))?.cancelled).toBe(true));
    expect(await screen.findByText('Freed 6pm to 6:30pm.')).toBeVisible();
  });
});

describe('a skipped week with only planning over today', () => {
  it('offers Next up, as an empty day does', async () => {
    await renderScreen('today', {
      now: at(THIS, '11:00'),
      zone: ZONE,
      seed: async (w) => {
        await w.create('week_plan', { week_start: THIS, planning_skipped_at: at(THIS, '08:00') }, weekPlanId(THIS));
        await w.create('task', { kind: 'one_off', title: 'Paint the fence', estimate_min: 30 }, 't1');
        await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 2', plans: [`week:${THIS}`] }, THIS_ID);
        await w.create('time_block', { task_id: THIS_ID, start: at(THIS, '09:00'), end: at(THIS, '09:30'), tz: ZONE, ended_at: at(THIS, '09:20') });
      },
    });
    expect(within(await screen.findByRole('region', { name: 'Next up' })).getByText('Paint the fence')).toBeVisible();
  });
});
