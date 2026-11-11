import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localToInstant } from '../../../core/dates';
import { stretchPlanningId } from '../../../core/planning';
import { getRecord, getSettings, listRecords, updateSettings, weekPlanId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderScreen } from '../../app/testing';
import { writeFlow } from './flowState';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// Quarters, Oct 1 to Dec 31 planned: the stretch from Jan 1 is next, and its planning opens on Thursday, Dec 24.
const ZONE = 'America/Chicago';
const at = (date: string, time: string) => localToInstant(date, Number(time.slice(0, 2)) * 60 + Number(time.slice(3)), ZONE);
const ID = stretchPlanningId('2027-01-01');
const THURSDAY = at('2026-12-24', '10:00');
const planned = async (w: Writer) => {
  await updateSettings(w, { plan_stretch: { last_planned: '2026-10-01' } });
  await w.create('week_plan', { week_start: '2026-12-21', finished_at: at('2026-12-21', '08:00') }, weekPlanId('2026-12-21'));
};
const blocksOf = async (t: { db: Parameters<typeof listRecords>[0] }) => (await listRecords(t.db, 'time_block')).filter((b) => b.task_id === ID && !b.cancelled);

describe("the stretch's planning row on Today", () => {
  it.each(['desktop', 'phone'] as const)('on %s, says how long, and schedules in one tap with Undo, in place of the old alert', async (layout) => {
    const t = await renderScreen('today', { now: THURSDAY, zone: ZONE, layout, seed: planned });
    const row = await screen.findByRole('region', { name: 'Plan the next stretch' });
    expect(within(row).getByText(/Jan 1 to Mar 31 · About 45m/)).toBeVisible();
    expect(screen.queryByText(/Plan the next stretch\. It starts/)).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: /^Schedule planning for / }));
    expect(await screen.findByText(/^Planning scheduled for /)).toBeVisible();
    expect(await blocksOf(t)).toHaveLength(1);
    expect(await getRecord(t.db, 'task', ID)).toMatchObject({ kind: 'planning', title: 'Plan Jan 1 to Mar 31' });
  });

  it('Delete takes it away for that stretch, with Undo', async () => {
    const t = await renderScreen('today', { now: THURSDAY, zone: ZONE, seed: planned });
    const row = await screen.findByRole('region', { name: 'Plan the next stretch' });
    await userEvent.click(within(row).getByRole('button', { name: 'Delete planning task: Plan Jan 1 to Mar 31' }));
    expect(await screen.findByText('Planning for Jan 1 to Mar 31 deleted.')).toBeVisible();
    expect((await getRecord(t.db, 'task', ID))?.deleted_at).toBe(THURSDAY);
  });

  it('for a first plan, says when the stretch ends and guesses an hour', async () => {
    await renderScreen('today', {
      now: at('2026-11-05', '10:00'),
      zone: ZONE,
      seed: (w) => w.create('week_plan', { week_start: '2026-11-02', finished_at: at('2026-11-02', '08:00') }, weekPlanId('2026-11-02')),
    });
    const row = await screen.findByRole('region', { name: 'Plan your first stretch' });
    expect(within(row).getByText(/Ends Dec 31 · About 1h/)).toBeVisible();
  });

  it("waits behind next week's row", async () => {
    // Friday, Dec 25: next week's row is due too.
    await renderScreen('today', { now: at('2026-12-25', '10:00'), zone: ZONE, seed: planned });
    expect(await screen.findByRole('region', { name: 'Plan next week' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Plan the next stretch' })).toBeNull();
  });
});

describe('the stretch flow and its planning task', () => {
  const open = async (seed: (w: Writer) => Promise<unknown>) => {
    writeFlow({ begun: true, step: 4 });
    const close = vi.fn();
    const t = await renderScreen('plan', { now: THURSDAY, zone: ZONE, seed, presentation: 'flow', close });
    return { t, close };
  };

  it('Finish ahead of its block finishes the task and frees the block, with Undo', async () => {
    const { t, close } = await open(async (w) => {
      await planned(w);
      await w.create('task', { kind: 'planning', title: 'Plan Jan 1 to Mar 31', plans: ['stretch:2027-01-01'] }, ID);
      await w.create('time_block', { task_id: ID, start: at('2026-12-26', '09:00'), end: at('2026-12-26', '09:45'), tz: ZONE }, 'sb');
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(await screen.findByText('Your plan for Jan 1 to Mar 31 is set. Sat 9am is free again.')).toBeVisible();
    expect((await getRecord(t.db, 'task', ID))?.done_at).toBe(THURSDAY);
    expect((await getRecord(t.db, 'time_block', 'sb'))?.cancelled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'sb'))?.cancelled).toBeFalsy());
    expect((await getRecord(t.db, 'task', ID))?.done_at).toBeNull();
    expect((await getSettings(t.db)).plan_stretch.last_planned).toBe('2026-10-01');
  });

  it('counts the minutes spent planning, and Save and exit adds them', async () => {
    const { t } = await open(planned);
    await screen.findByRole('button', { name: 'Finish' });
    t.clock.set(at('2026-12-24', '10:04'));
    await userEvent.click(screen.getByRole('button', { name: 'Save and exit' }));
    await waitFor(async () => expect((await getSettings(t.db)).stretch_planning).toEqual({ start: '2027-01-01', started_at: THURSDAY, min: 4 }));
  });
});

describe('the Plan page', () => {
  it('says when the stretch’s planning is set, and opening planning places a block from now', async () => {
    const t = await renderScreen('plan', {
      now: THURSDAY,
      zone: ZONE,
      seed: async (w) => {
        await planned(w);
        await w.create('task', { kind: 'planning', title: 'Plan Jan 1 to Mar 31', plans: ['stretch:2027-01-01'] }, ID);
        await w.create('time_block', { task_id: ID, start: at('2026-12-26', '09:00'), end: at('2026-12-26', '09:45'), tz: ZONE });
      },
    });
    expect(await screen.findByText('Planning: Sat Dec 26, 9am')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /^Plan the next stretch|^Start planning/ }));
    expect(t.nav().flow?.area).toBe('plan');
    await waitFor(async () => expect((await blocksOf(t)).some((b) => b.started_at === THURSDAY)).toBe(true));
  });
});

describe("a stretch's planning block", () => {
  it('on the Now card, Start planning opens the stretch flow', async () => {
    const t = await renderScreen('today', {
      now: at('2026-12-24', '17:05'),
      zone: ZONE,
      seed: async (w) => {
        await planned(w);
        await w.create('task', { kind: 'planning', title: 'Plan Jan 1 to Mar 31', plans: ['stretch:2027-01-01'] }, ID);
        await w.create('time_block', { task_id: ID, start: at('2026-12-24', '17:00'), end: at('2026-12-24', '17:45'), tz: ZONE }, 'sb');
      },
    });
    const card = await screen.findByRole('region', { name: 'Current block' });
    await userEvent.click(within(card).getByRole('button', { name: 'Start planning' }));
    await waitFor(() => expect(t.nav().flow?.area).toBe('plan'));
  });
});
