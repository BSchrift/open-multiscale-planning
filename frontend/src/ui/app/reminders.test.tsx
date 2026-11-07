import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localToInstant } from '../../core/dates';
import { getRecord, outcomeId } from '../../core/records';
import type { Writer } from '../../core/records';
import { REMINDER_ACTION } from '../../core/reminders';
import { renderApp } from './testing';

afterEach(cleanup);

const ZONE = 'America/Chicago';
const at = (h: number, m = 0) => localToInstant('2026-11-02', h * 60 + m, ZONE);
const NOW = at(14);

const seed = async (w: Writer) => {
  await w.create('week_plan', { week_start: '2026-11-02', finished_at: at(8) }, 'week:2026-11-02');
  await w.create('task', { kind: 'project', project_id: 'p', title: 'Write the report', estimate_min: 120 }, 't1');
  await w.create('time_block', { task_id: 't1', start: at(15), end: at(16), tz: ZONE }, 'b1');
};

async function open() {
  const t = await renderApp({ now: NOW, zone: ZONE, seed });
  const scheduled = () => t.platform.notifications.scheduled();
  await waitFor(async () => expect(await scheduled()).toHaveLength(3));
  return { ...t, scheduled };
}

const respond = (t: Awaited<ReturnType<typeof open>>, action: string | null, kind = 'end') =>
  act(() => t.platform.notifications.respond({ reminder_id: `reminder:b1:${kind}`, block_id: 'b1', action_id: action }));

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
});
