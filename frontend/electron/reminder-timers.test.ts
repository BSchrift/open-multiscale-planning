import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reminder } from '../src/core/types';
import { createReminderTimers } from './reminder-timers';

const NOW = Date.parse('2026-11-02T09:00:00Z');
const MINUTE = 60_000;
const DAY = 1440 * MINUTE;

const reminder = (id: string, offsetMs: number): Reminder => ({
  id,
  kind: 'block_start',
  block_id: `block-${id}`,
  at: new Date(NOW + offsetMs).toISOString(),
  title: `Reminder ${id}`,
  actions: [],
});

describe('reminder timers', () => {
  let shown: string[];
  let closed: string[];
  const setup = () =>
    createReminderTimers((r) => {
      shown.push(r.id);
      return { close: () => void closed.push(r.id) };
    });

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    shown = [];
    closed = [];
  });
  afterEach(() => void vi.useRealTimers());

  it('fires each reminder at its time, once', () => {
    const timers = setup();
    timers.replaceAll([reminder('a', 5 * MINUTE), reminder('b', 10 * MINUTE)]);
    vi.advanceTimersByTime(5 * MINUTE - 1);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual(['a']);
    expect(timers.scheduled().map((r) => r.id)).toEqual(['b']);
    vi.advanceTimersByTime(DAY);
    expect(shown).toEqual(['a', 'b']);
  });

  it('replaceAll drops what is no longer in the list', () => {
    const timers = setup();
    timers.replaceAll([reminder('a', MINUTE), reminder('b', MINUTE)]);
    timers.replaceAll([reminder('b', 2 * MINUTE)]);
    vi.advanceTimersByTime(DAY);
    expect(shown).toEqual(['b']);
  });

  it('cancel removes pending reminders and closes one already showing', () => {
    const timers = setup();
    timers.replaceAll([reminder('a', MINUTE), reminder('b', 2 * MINUTE), reminder('c', 3 * MINUTE)]);
    vi.advanceTimersByTime(MINUTE);
    timers.cancel(['a', 'b']);
    expect(closed).toEqual(['a']);
    expect(timers.scheduled().map((r) => r.id)).toEqual(['c']);
    vi.advanceTimersByTime(DAY);
    expect(shown).toEqual(['a', 'c']);
  });

  it('a delay beyond what setTimeout can hold waits instead of firing at once', () => {
    const timers = setup();
    timers.replaceAll([reminder('far', 28 * DAY)]);
    vi.advanceTimersByTime(27 * DAY);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(DAY);
    expect(shown).toEqual(['far']);
  });

  it('after sleep, shows what just came due and drops what is long past', () => {
    const timers = setup();
    timers.replaceAll([reminder('old', MINUTE), reminder('recent', 58 * MINUTE), reminder('later', 2 * 60 * MINUTE)]);
    // Timers don't run while the machine sleeps.
    vi.setSystemTime(NOW + 60 * MINUTE);
    timers.rearm();
    vi.advanceTimersByTime(0);
    expect(shown).toEqual(['recent']);
    expect(timers.scheduled().map((r) => r.id)).toEqual(['later']);
  });

  it('a failure showing one reminder does not stop the next', () => {
    const timers = createReminderTimers((r) => {
      if (r.id === 'bad') throw new Error('no');
      shown.push(r.id);
      return { close: () => undefined };
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    timers.replaceAll([reminder('bad', MINUTE), reminder('good', MINUTE)]);
    vi.advanceTimersByTime(MINUTE);
    expect(shown).toEqual(['good']);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
