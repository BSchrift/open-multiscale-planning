// Everything the Goals area shows, read in one query: goals, projects with their milestones and tasks, practices
// with this week's time, and what statuses need (settings and away dates).

import { weekAnalytics } from '../../../core/analytics';
import type { PracticeRow } from '../../../core/analytics';
import type { Clock } from '../../../core/clock';
import { thisWeek, weekRange } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { gatherPlans } from '../../../core/plan';
import type { ProjectPlan } from '../../../core/plan';
import { blocksInRange, goalChanges, projectTasks } from '../../../core/queries';
import { getRecord, getSettings, listRecords, outcomeId } from '../../../core/records';
import type { AwayPeriod, BlockOutcome, Objective, Practice, Settings, TimeBlock } from '../../../core/types';

export interface GoalsData {
  objectives: Objective[];
  /** Every project. Finished and dropped ones carry no tasks, since they only show under Archived. */
  plans: ProjectPlan[];
  practices: Practice[];
  /** This week's time against target, by practice id. */
  practiceWeek: Record<string, PracticeRow>;
  settings: Settings;
  away: AwayPeriod[];
  /** When each goal or anything under it last changed, in epoch ms, by goal id. */
  changed: Record<string, number>;
}

export async function loadGoals(sql: Sql, clock: Clock): Promise<GoalsData> {
  const [objectives, projects, milestones, tasks, practices, settings, away, changed] = await Promise.all([
    listRecords(sql, 'objective'),
    listRecords(sql, 'project'),
    listRecords(sql, 'milestone'),
    projectTasks(sql),
    listRecords(sql, 'practice'),
    getSettings(sql),
    listRecords(sql, 'away_period'),
    goalChanges(sql),
  ]);
  const week = thisWeek(clock);
  const blocks: TimeBlock[] = (await blocksInRange(sql, weekRange(week, clock.zone())))
    .filter((b) => b.practice_id)
    .map((b) => ({ id: b.id, practice_id: b.practice_id, start: b.start, end: b.end, tz: b.tz ?? clock.zone(), started_at: b.started_at, ended_at: b.ended_at }));
  const outcomes = (await Promise.all(blocks.map((b) => getRecord(sql, 'block_outcome', outcomeId(b.id))))).filter(
    (o): o is BlockOutcome => !!o && !o.deleted_at,
  );
  const time = weekAnalytics(
    { objectives, projects: [], milestones: [], tasks: [], blocks, outcomes, practices, away, avoided_slots: [] },
    clock,
    week,
  );
  return {
    objectives,
    plans: gatherPlans(projects, milestones, tasks),
    practices,
    practiceWeek: Object.fromEntries(time.practices.map((row) => [row.id, row])),
    settings,
    away,
    changed,
  };
}
