import { describe, expect, it } from 'vitest';
import { recentPace } from './analytics';
import type { AnalyticsData } from './analytics';
import { fixedClock } from './clock';
import { localToInstant } from './dates';
import { outcomeId } from './records';
import type { BlockResult } from './types';

const ZONE = 'America/Chicago';
const clock = fixedClock(localToInstant('2026-11-04', 12 * 60, ZONE), ZONE); // Wednesday of the week of Nov 2.

function data(): AnalyticsData {
  return {
    objectives: [{ id: 'g1', title: 'Write the report', state: 'active' }],
    projects: [{ id: 'p1', objective_id: 'g1', title: 'First draft', state: 'active', start: '2026-09-01', end: '2026-12-31' }],
    milestones: [],
    tasks: [
      { id: 't1', kind: 'project', project_id: 'p1', title: 'Outline' },
      { id: 'o1', kind: 'one_off', title: 'Clean the windows' },
    ],
    blocks: [],
    outcomes: [],
    practices: [{ id: 'pr1', objective_id: 'g1', title: 'Stretch', target_min: 15, per: 'day', state: 'active' }],
    away: [],
    avoided_slots: [],
  };
}

let seq = 0;
function block(d: AnalyticsData, owner: { task?: string; practice?: string }, date: string, mins: number, result: BlockResult, logged?: number) {
  const id = `b${++seq}`;
  d.blocks.push({
    id,
    task_id: owner.task ?? null,
    practice_id: owner.practice ?? null,
    start: localToInstant(date, 9 * 60, ZONE),
    end: localToInstant(date, 9 * 60 + mins, ZONE),
    tz: ZONE,
  });
  d.outcomes.push({ id: outcomeId(id), result, answered_at: localToInstant(date, 12 * 60, ZONE), ...(logged === undefined ? {} : { logged_min: logged }) });
}

describe('recentPace', () => {
  it('averages project work over the last four whole weeks, leaving out one offs, practices and this week', () => {
    const d = data();
    block(d, { task: 't1' }, '2026-10-27', 60, 'done');
    block(d, { task: 't1' }, '2026-10-29', 60, 'done');
    block(d, { task: 't1' }, '2026-10-20', 120, 'partly', 90);
    block(d, { task: 't1' }, '2026-10-21', 60, 'not');
    block(d, { task: 'o1' }, '2026-10-28', 60, 'done');
    block(d, { practice: 'pr1' }, '2026-10-28', 30, 'done');
    block(d, { task: 't1' }, '2026-11-02', 300, 'done');
    block(d, { task: 't1' }, '2026-09-28', 600, 'done');
    expect(recentPace(d, clock)).toBe(Math.round((60 + 60 + 90) / 4));
  });

  it('is null with no project work in those weeks to go on', () => {
    const d = data();
    block(d, { task: 'o1' }, '2026-10-28', 60, 'done');
    expect(recentPace(d, clock)).toBeNull();
  });
});
