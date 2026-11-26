import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../../core/clock';
import { localToInstant } from '../../../core/dates';
import type { BlockRow } from '../../../core/queries';
import { defaultSelection, earlierRow, openMinute, raiseOf, toAnswer } from './selection';

const ZONE = 'America/Chicago';
const DAY = '2026-11-24';
const at = (time: string, date = DAY) => {
  const [h, m] = time.split(':').map(Number);
  return localToInstant(date, h! * 60 + (m ?? 0), ZONE);
};
const clockAt = (time: string) => fixedClock(at(time), ZONE);
const block = (id: string, from: string, to: string, extra: Partial<BlockRow> = {}): BlockRow => ({
  id,
  start: at(from),
  end: at(to),
  tz: ZONE,
  task_id: `t-${id}`,
  practice_id: null,
  started_at: null,
  ended_at: null,
  title: id,
  task_kind: 'project',
  result: null,
  ...extra,
});

describe('the block selected when Today opens', () => {
  it('is the block in progress', () => {
    const blocks = [block('run', '08:00', '08:30', { result: 'done' }), block('write', '13:30', '15:00'), block('passport', '15:30', '16:00', { task_kind: 'one_off' })];
    expect(defaultSelection(blocks, [], clockAt('14:10'))).toBe('write');
  });

  it('else the block that just ended and needs an answer', () => {
    const blocks = [block('write', '13:30', '15:00'), block('passport', '15:30', '16:00')];
    expect(defaultSelection(blocks, [], clockAt('15:04'))).toBe('write');
  });

  it('else the next block, when it starts within the hour, so Start early shows in the morning', () => {
    const blocks = [block('run', '08:00', '08:30', { practice_id: 'p', task_id: null, task_kind: null })];
    expect(defaultSelection(blocks, [], clockAt('07:40'))).toBe('run');
    expect(defaultSelection(blocks, [], clockAt('06:59'))).toBeNull();
  });

  it('is nothing once the day is done', () => {
    const blocks = [block('write', '13:30', '15:00', { result: 'done' })];
    expect(defaultSelection(blocks, [], clockAt('21:15'))).toBeNull();
  });

  it('passes over an older block still to answer once a later one has been answered', () => {
    const blocks = [block('chapter', '09:00', '10:30'), block('draft', '11:00', '12:00', { result: 'done' })];
    expect(defaultSelection(blocks, [], clockAt('12:20'))).toBeNull();
    expect(toAnswer(blocks, [], clockAt('12:20')).map((b) => b.id)).toEqual(['chapter']);
  });

  it('never picks planning that has gone by, which has no answer to give', () => {
    const blocks = [block('plan', '09:00', '09:30', { task_kind: 'planning', task_id: 'planning:2026-11-23' })];
    expect(defaultSelection(blocks, [], clockAt('09:40'))).toBeNull();
  });
});

describe('what a selected block offers', () => {
  const blocks = [block('write', '13:30', '15:00'), block('passport', '15:30', '16:00'), block('bugs', '16:30', '18:00'), block('old', '09:00', '10:00', { result: 'done' })];
  const clock = clockAt('14:10');
  it('says so for each moment', () => {
    expect(raiseOf(blocks[0]!, blocks, clock)).toBe('now');
    // With a block in progress, the next one offers Move rather than Start early.
    expect(raiseOf(blocks[1]!, blocks, clock)).toBe('sel');
    expect(raiseOf(blocks[2]!, blocks, clock)).toBe('sel');
    expect(raiseOf(blocks[1]!, blocks, clockAt('15:05'))).toBe('next');
    expect(raiseOf(blocks[3]!, blocks, clock)).toBe('sel');
    expect(raiseOf(blocks[0]!, blocks, clockAt('15:05'))).toBe('answer');
  });
});

describe('where the day opens, and the row its earlier hours fold into', () => {
  it('opens an hour before the selected block, else now, on the hour', () => {
    expect(openMinute(13 * 60 + 30, 7 * 60)).toBe(12 * 60);
    expect(openMinute(14 * 60 + 10, 7 * 60)).toBe(13 * 60);
    expect(openMinute(7 * 60 + 40, 7 * 60)).toBe(7 * 60);
    expect(openMinute(8 * 60, 7 * 60)).toBe(7 * 60);
  });

  it('folds the hours before it into one row that says what it holds', () => {
    const blocks = [block('run', '08:00', '08:30', { result: 'done' }), block('chapter', '09:00', '10:30'), block('draft', '11:00', '12:00', { result: 'done' }), block('write', '13:30', '15:00')];
    const row = earlierRow(blocks, { from: 7 * 60, open: 12 * 60, zone: ZONE, date: DAY, answer: new Set(['chapter']) });
    expect(row).toEqual({ from: 7 * 60, to: 12 * 60, blocks: 3, toAnswer: 1, label: 'Earlier, 7am to 12pm · 3 blocks · 1 to answer' });
  });

  it('has no row when there is nothing before the opening hour', () => {
    expect(earlierRow([], { from: 7 * 60, open: 7 * 60, zone: ZONE, date: DAY, answer: new Set() })).toBeNull();
    // An hour folded saves less than the row takes.
    expect(earlierRow([], { from: 7 * 60, open: 8 * 60, zone: ZONE, date: DAY, answer: new Set() })).toBeNull();
    const one = earlierRow([block('run', '08:00', '08:30')], { from: 7 * 60, open: 9 * 60, zone: ZONE, date: DAY, answer: new Set() });
    expect(one?.label).toBe('Earlier, 7am to 9am · 1 block');
  });
});
