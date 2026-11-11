import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extendBlock, moveBlock, swapBlocks } from '../../core/blocks';
import { localToInstant } from '../../core/dates';
import { getRecord, outcomeId } from '../../core/records';
import type { Writer } from '../../core/records';
import { REMINDER_ACTION } from '../../core/reminders';
import type { AppSync } from '../../core/syncRunner';
import type { Reminder } from '../../core/types';
import type { Route } from './nav';
import { renderApp } from './testing';
import type { HarnessOptions } from './testing';
import { noFiles } from '../../core/sync-testing';

afterEach(cleanup);

const ZONE = 'America/Chicago';
const at = (h: number, m = 0) => localToInstant('2026-11-02', h * 60 + m, ZONE);
const NOW = at(14);

const seed = async (w: Writer) => {
  await w.create('week_plan', { week_start: '2026-11-02', finished_at: at(8) }, 'week:2026-11-02');
  await w.create('task', { kind: 'project', project_id: 'p', title: 'Write the report', estimate_min: 120 }, 't1');
  await w.create('time_block', { task_id: 't1', start: at(15), end: at(16), tz: ZONE }, 'b1');
};

async function open(options: HarnessOptions & { initial?: Route } = {}) {
  const t = await renderApp({ now: NOW, zone: ZONE, seed, ...options });
  const scheduled = () => t.platform.notifications.scheduled();
  await waitFor(async () => expect(await scheduled()).toHaveLength(3));
  // The notifications as first scheduled, which stay showing once delivered whatever is scheduled after them.
  const shown = Object.fromEntries((await scheduled()).map((r) => [r.kind, r]));
  return { ...t, scheduled, shown };
}

/** Signed in, where each sync can bring in what another device changed. */
function fakeSync() {
  return {
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    syncNow: vi.fn(async () => undefined),
    connectCalendar: vi.fn(async () => undefined),
    refreshCalendar: vi.fn(async () => undefined),
    disconnectCalendar: vi.fn(async () => undefined),
    stop: vi.fn(),
    email: vi.fn(async () => null),
    eraseAndSignIn: vi.fn(async () => undefined),
    files: noFiles(),
  } satisfies AppSync;
}

/** The app open on Week, signed in, with this change made on another device and not yet synced here. */
async function changedElsewhere(change: (w: Writer) => Promise<unknown>) {
  const sync = fakeSync();
  const t = await open({ sync, initial: { area: 'week', params: {} } });
  sync.syncNow.mockImplementationOnce(async () => void (await t.write(change)));
  return { ...t, sync };
}

const KINDS = { start: 'block_start', check_in: 'check_in', end: 'block_end' } as const;

/** An answer to b1's notification of this kind, as first scheduled. */
const respond = (t: Awaited<ReturnType<typeof open>>, action: string | null, kind: keyof typeof KINDS = 'end') =>
  act(() => t.platform.notifications.respond({ reminder_id: t.shown[KINDS[kind]]!.id, block_id: 'b1', action_id: action }));

describe('reminders', () => {
  it('asks for permission once there is something to remind about, then schedules the coming blocks', async () => {
    const t = await renderApp({ now: NOW, zone: ZONE });
    const permission = vi.spyOn(t.platform.notifications, 'requestPermission');
    const replace = vi.spyOn(t.platform.notifications, 'replaceAll');
    await waitFor(() => expect(replace).toHaveBeenCalledWith([]));
    expect(permission).not.toHaveBeenCalled();

    await act(() => t.write(seed));
    await waitFor(async () => expect((await t.platform.notifications.scheduled()).map((r) => r.kind)).toEqual(['block_start', 'check_in', 'block_end']));
    await act(() => t.write((w) => w.create('time_block', { task_id: 't1', start: at(17), end: at(18), tz: ZONE }, 'b2')));
    await waitFor(async () => expect(await t.platform.notifications.scheduled()).toHaveLength(6));
    expect(permission).toHaveBeenCalledTimes(1);
  });

  it('follows the records: an answer from anywhere clears that block', async () => {
    const t = await open();
    await act(() => t.write((w) => w.create('block_outcome', { result: 'done', answered_at: NOW }, outcomeId('b1'))));
    await waitFor(async () => expect(await t.scheduled()).toEqual([]));
  });

  it('records Start and Still going from the notification', async () => {
    const t = await open();
    await respond(t, REMINDER_ACTION.start, 'start');
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.started_at).toBe(NOW));
    await respond(t, REMINDER_ACTION.stillGoing);
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.end).toBe(at(16, 30)));
  });

  describe('a pause running to the end', () => {
    const paused = (w: Writer) => w.set('time_block', 'b1', { started_at: at(15), paused_at: at(15, 22) });

    it('the end notification offers Resume with the time left, which resumes it', async () => {
      const t = await open();
      await t.write(paused);
      let end: Reminder | undefined;
      await waitFor(async () => {
        end = (await t.scheduled()).find((r) => r.kind === 'block_end');
        expect(end?.actions.map((a) => a.title)).toEqual(['Resume, 38m left', 'Partly', 'Not done']);
      });
      expect(end!.body).toBe('22m spent. Paused at 3:22pm. Did you finish Write the report?');
      act(() => t.clock.set(at(16, 5)));
      await act(() => t.platform.notifications.respond({ reminder_id: end!.id, block_id: 'b1', action_id: REMINDER_ACTION.resume }));
      await waitFor(async () => expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ paused_at: null, paused_min: 43, end: at(16, 43) }));
    });

    it('Resume on the reminder that the block is still paused resumes it', async () => {
      const t = await open();
      await t.write(paused);
      let still: Reminder | undefined;
      await waitFor(async () => {
        still = (await t.scheduled()).find((r) => r.kind === 'still_paused');
        expect(still?.title).toBe('Still paused: Write the report');
      });
      act(() => t.clock.set(at(15, 40)));
      await act(() => t.platform.notifications.respond({ reminder_id: still!.id, block_id: 'b1', action_id: REMINDER_ACTION.resume }));
      await waitFor(async () => expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ paused_at: null, paused_min: 18, end: at(16, 18) }));
      await waitFor(async () => expect((await t.scheduled()).some((r) => r.kind === 'still_paused')).toBe(false));
    });

    it('a still-paused reminder left showing after the block was resumed changes nothing', async () => {
      const t = await open();
      await t.write(paused);
      let still: Reminder | undefined;
      await waitFor(async () => {
        still = (await t.scheduled()).find((r) => r.kind === 'still_paused');
        expect(still).toBeDefined();
      });
      // Resumed on this device inside 30 seconds, so the end didn't move.
      await t.write((w) => w.set('time_block', 'b1', { paused_at: null }));
      await act(() => t.platform.notifications.respond({ reminder_id: still!.id, block_id: 'b1', action_id: REMINDER_ACTION.resume }));
      await waitFor(async () => expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ paused_at: null, end: at(16) }));
    });

    it('Still going on a notification shown before the pause resumes it rather than adding 30 minutes', async () => {
      const t = await open();
      await t.write(paused);
      act(() => t.clock.set(at(16, 5)));
      await respond(t, REMINDER_ACTION.stillGoing);
      await waitFor(async () => expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ paused_at: null, end: at(16, 43) }));
    });
  });

  it('never finishes a task from a notification: Done left on an old one opens Today to ask', async () => {
    const t = await open();
    t.clock.set(at(16, 5));
    await respond(t, REMINDER_ACTION.done);
    const prompt = await screen.findByRole('dialog', { name: 'Block finished' });
    expect(within(prompt).getByRole('button', { name: 'Task finished' })).toBeVisible();
    await act(() => t.write(async () => {}));
    expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBeFalsy();
    expect(await getRecord(t.db, 'block_outcome', outcomeId('b1'))).toBeUndefined();
  });

  it('ignores a stale notification for a block already answered', async () => {
    const t = await open();
    t.clock.set(at(16, 5));
    await respond(t, REMINDER_ACTION.notDone);
    await waitFor(async () => expect((await getRecord(t.db, 'block_outcome', outcomeId('b1')))?.result).toBe('not'));
    t.clock.set(at(18));
    await respond(t, REMINDER_ACTION.stillGoing);
    // Writes go one at a time, so this one lands after the answer above has been handled.
    await act(() => t.write(async () => {}));
    expect((await getRecord(t.db, 'time_block', 'b1'))?.end).toBe(at(16));
  });

  it('Skip from the check-in takes the block off the calendar to schedule again, not crossed off', async () => {
    const t = await open();
    await respond(t, REMINDER_ACTION.skip);
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBe(true));
    expect(await getRecord(t.db, 'block_outcome', outcomeId('b1'))).toBeUndefined();
  });

  it('Ask again moves the check-in ten minutes on', async () => {
    const t = await open();
    t.clock.set(at(15, 5));
    await respond(t, REMINDER_ACTION.snooze, 'check_in');
    await waitFor(async () => expect((await t.scheduled()).find((r) => r.kind === 'check_in')?.at).toBe(at(15, 15)));
  });

  it('Partly opens Today to ask for the time left', async () => {
    const t = await open();
    t.clock.set(at(16, 5));
    await respond(t, REMINDER_ACTION.partly);
    const prompt = await screen.findByRole('dialog', { name: 'How much is left?' });
    expect(within(prompt).getByRole('slider', { name: 'Time left' })).toHaveAttribute('aria-valuetext', '1h');
  });

  // A notification was scheduled from this device's copy of the plan, which can be behind another device's.
  describe('syncs before acting, and opens Today instead of acting on a block changed since', () => {
    const today = () => screen.findByRole('region', { name: 'Today' });

    it('moved in a sync before the tap, while its notification showed: Start leaves it unstarted', async () => {
      const t = await open({ initial: { area: 'week', params: {} } });
      await act(() => t.write((w) => moveBlock(w, 'b1', { start: at(17), end: at(18) })));
      await waitFor(async () => expect((await t.scheduled()).find((r) => r.kind === 'block_start')?.at).toBe(at(17)));
      t.clock.set(at(15, 5));
      await respond(t, REMINDER_ACTION.start, 'start');
      expect(await today()).toBeVisible();
      expect((await getRecord(t.db, 'time_block', 'b1'))?.started_at).toBeFalsy();
    });

    it('moved on another device, arriving with the sync the tap starts: Start leaves it unstarted', async () => {
      const t = await changedElsewhere((w) => moveBlock(w, 'b1', { start: at(17), end: at(18) }));
      t.clock.set(at(15, 1));
      await respond(t, REMINDER_ACTION.start, 'start');
      expect(await today()).toBeVisible();
      expect(t.sync.syncNow).toHaveBeenCalledOnce();
      const block = await getRecord(t.db, 'time_block', 'b1');
      expect(block?.start).toBe(at(17));
      expect(block?.started_at).toBeFalsy();
    });

    it('Still going answered on another device too: the time is added once', async () => {
      const t = await changedElsewhere((w) => extendBlock(w, 'b1', 30));
      t.clock.set(at(16, 1));
      await respond(t, REMINDER_ACTION.stillGoing);
      expect(await today()).toBeVisible();
      expect((await getRecord(t.db, 'time_block', 'b1'))?.end).toBe(at(16, 30));
    });

    it('swapped with the next block on another device: Not done answers for neither', async () => {
      const t = await changedElsewhere((w) => swapBlocks(w, 'b1', 'b2'));
      await act(() =>
        t.write(async (w) => {
          await w.create('task', { kind: 'one_off', title: 'Paint the fence' }, 't2');
          await w.create('time_block', { task_id: 't2', start: at(17), end: at(18), tz: ZONE }, 'b2');
        }),
      );
      await waitFor(async () => expect(await t.scheduled()).toHaveLength(6));
      t.clock.set(at(16, 1));
      await respond(t, REMINDER_ACTION.notDone);
      expect(await today()).toBeVisible();
      expect(await getRecord(t.db, 'block_outcome', outcomeId('b1'))).toBeUndefined();
    });

    it('started already: a second Start keeps the first start time', async () => {
      const t = await open({ initial: { area: 'week', params: {} } });
      t.clock.set(at(15, 1));
      await respond(t, REMINDER_ACTION.start, 'start');
      await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.started_at).toBe(at(15, 1)));
      t.clock.set(at(15, 5));
      await respond(t, REMINDER_ACTION.started, 'check_in');
      expect(await today()).toBeVisible();
      expect((await getRecord(t.db, 'time_block', 'b1'))?.started_at).toBe(at(15, 1));
    });

    it('shown before notifications said which block they were about: Start leaves it unstarted', async () => {
      const t = await open({ initial: { area: 'week', params: {} } });
      t.clock.set(at(15, 1));
      act(() => t.platform.notifications.respond({ reminder_id: 'reminder:b1:start', block_id: 'b1', action_id: REMINDER_ACTION.start }));
      expect(await today()).toBeVisible();
      expect((await getRecord(t.db, 'time_block', 'b1'))?.started_at).toBeFalsy();
    });

    it("a practice's All, answered for a block that holds a task, finishes nothing", async () => {
      const t = await open({ initial: { area: 'week', params: {} } });
      t.clock.set(at(16, 1));
      await respond(t, REMINDER_ACTION.logAll);
      expect(await today()).toBeVisible();
      expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBeFalsy();
      expect(await getRecord(t.db, 'block_outcome', outcomeId('b1'))).toBeUndefined();
    });
  });

  it("acts as of the tap, without waiting long for a sync that doesn't finish", async () => {
    const sync = fakeSync();
    sync.syncNow.mockImplementation(() => new Promise(() => undefined));
    const t = await open({ sync });
    t.clock.set(at(15, 1));
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      await respond(t, REMINDER_ACTION.start, 'start');
      t.clock.set(at(15, 3));
      await act(() => vi.advanceTimersByTimeAsync(2000));
    } finally {
      vi.useRealTimers();
    }
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.started_at).toBe(at(15, 1)));
  });
});
