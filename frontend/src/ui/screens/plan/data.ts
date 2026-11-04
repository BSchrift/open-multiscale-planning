// What the Plan page and planning ahead read: projects with their milestones and tasks, one offs, practices, goals,
// and the settings that hold the cadence. Looking back reads time worked, which is heavier, so it loads on its own.

import { loadAnalyticsData, recentPace, stretchAnalytics } from '../../../core/analytics';
import type { TimeRow } from '../../../core/analytics';
import type { Clock } from '../../../core/clock';
import { dayRange, today } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { gatherPlans } from '../../../core/plan';
import type { ProjectPlan, Stretch } from '../../../core/plan';
import { oneOffTasks, projectTasks } from '../../../core/queries';
import { getSettings, listRecords } from '../../../core/records';
import type { AwayPeriod, Minutes, Objective, Practice, Settings, Task } from '../../../core/types';

export interface PlanData {
  settings: Settings;
  objectives: Objective[];
  /** Every project in added order. Finished and dropped ones carry no tasks. */
  plans: ProjectPlan[];
  /** Open one offs. */
  oneOffs: Task[];
  practices: Practice[];
  away: AwayPeriod[];
}

export async function loadPlan(sql: Sql, clock: Clock): Promise<PlanData> {
  const [settings, objectives, projects, milestones, tasks, oneOffs, practices, away] = await Promise.all([
    getSettings(sql),
    listRecords(sql, 'objective'),
    listRecords(sql, 'project'),
    listRecords(sql, 'milestone'),
    projectTasks(sql),
    oneOffTasks(sql, { since: dayRange(today(clock), clock.zone()).from_utc }),
    listRecords(sql, 'practice'),
    listRecords(sql, 'away_period'),
  ]);
  return {
    settings,
    objectives,
    plans: gatherPlans(projects, milestones, tasks),
    oneOffs: oneOffs.filter((t) => !t.done_at && !t.cancelled_at),
    practices,
    away,
  };
}

export interface LookBack {
  /** Minutes a week of project work lately, or null with none. */
  pace: Minutes | null;
  met: { met: number; total: number };
  time: TimeRow[];
}

/** How the stretch so far has gone, or the last few weeks with none. */
export async function loadLookBack(sql: Sql, clock: Clock, stretch: Stretch | null): Promise<LookBack> {
  const data = await loadAnalyticsData(sql);
  const looked = stretchAnalytics(data, clock, stretch);
  return { pace: recentPace(data, clock), met: looked.milestones_met, time: looked.time.rows };
}
