// Reset a week's plan, from Week: what was planned and hasn't happened comes off, so the week shows as not planned and
// planning starts fresh. What has happened stays, as history and analytics read it: blocks started, answered, under way
// or gone by. So do the tasks and practices themselves, the time already spent planning, and planning's own blocks,
// which plan the week rather than being part of it. Everything goes by soft delete or a field set back to null, so the
// reverse puts back exactly what was there, and each write syncs as any other does.
//
// Its own module, not planning.ts, so it loads with Week rather than with the app.

import type { Clock } from './clock';
import { instantMs, nowInstant, weekRange } from './dates';
import { applyPlanChange } from './plan';
import type { PlanChange, RecordWrite } from './plan';
import { weekPlanningId } from './planning';
import { blocksInRange } from './queries';
import type { BlockRow } from './queries';
import { getRecord, weekPlanId } from './records';
import type { Writer } from './records';
import type { Fields, LocalDate, WeekPick, WeekPlan } from './types';

/** The week's own aims and skips, which go with a reset. */
const AIMS = ['aims', 'skipped_aims', 'skipped_practices', 'skipped_sessions', 'skipped_past_end'] as const;
/** Planned, or skipped for now: cleared, so the week asks to be planned again. planning_min and planning_started_at stay. */
const STATE = ['finished_at', 'planning_skipped_at'] as const;

/** What a reset of a week would take away, and how many of the week's blocks it keeps. */
export interface WeekReset {
  /** The week's picks. */
  picks: string[];
  /** Blocks still to come, not started or answered, planning's aside. */
  blocks: string[];
  /** How many of those blocks are practice sessions. */
  sessions: number;
  /** The week's blocks that have happened: started, answered, under way or gone by. */
  kept: number;
  /** Whether the week has its own aims or skips. */
  aims: boolean;
  /** The plan's fields to set back to null, or null when none is set. */
  plan: Fields<'week_plan'> | null;
}

const isSet = (value: unknown) => value != null && (typeof value !== 'object' || Object.keys(value).length > 0);
const happened = (b: BlockRow, now: number) => instantMs(b.start) <= now || !!b.started_at || !!b.ended_at || !!b.result;

/** Works out a reset from what Week already reads: the week's plan, picks (any week's) and blocks (blocksInRange). */
export function weekReset(week: LocalDate, plan: WeekPlan | null | undefined, picks: readonly WeekPick[], blocks: readonly BlockRow[], now: number): WeekReset {
  const off = blocks.filter((b) => !happened(b, now) && b.task_kind !== 'planning');
  const set = plan && !plan.deleted_at ? [...STATE, ...AIMS].filter((f) => isSet(plan[f])) : [];
  return {
    picks: picks.filter((p) => p.week_start === week && !p.deleted_at).map((p) => p.id),
    blocks: off.map((b) => b.id),
    sessions: off.filter((b) => b.practice_id).length,
    kept: blocks.filter((b) => happened(b, now)).length,
    aims: set.some((f) => (AIMS as readonly string[]).includes(f)),
    plan: set.length > 0 ? Object.fromEntries(set.map((f) => [f, null])) : null,
  };
}

export const hasReset = (r: WeekReset) => r.picks.length > 0 || r.blocks.length > 0 || r.plan !== null;

const PICKS = `
  SELECT id, week_start, task_id, minutes, deleted_at
  FROM week_pick
  WHERE week_start = :week AND deleted_at IS NULL`;

/**
 * Resets a week's plan: takes out its picks and its blocks still to come, clears its aims, skips and finish, and opens
 * its planning task again if finishing or skipping closed it. A week that has ended is all history, and is left alone.
 * Returns the exact reverse, for Undo.
 */
export async function resetWeek(w: Writer, week: LocalDate, clock: Clock): Promise<PlanChange> {
  const range = weekRange(week, clock.zone());
  if (instantMs(range.to_utc) <= clock.now()) return { writes: [] };
  const r = weekReset(
    week,
    await getRecord(w.sql, 'week_plan', weekPlanId(week)),
    await w.sql.all<WeekPick>(PICKS, { week }),
    await blocksInRange(w.sql, range),
    clock.now(),
  );
  if (!hasReset(r)) return { writes: [] };
  const gone = { deleted_at: nowInstant(clock) };
  const task = await getRecord(w.sql, 'task', weekPlanningId(week));
  // As Schedule and Start bring it back: undeleted and not done.
  const reopen = { ...(task?.deleted_at ? { deleted_at: null } : {}), ...(task?.done_at ? { done_at: null } : {}) };
  const writes: RecordWrite[] = [
    ...r.picks.map((id): RecordWrite => ({ type: 'week_pick', id, fields: gone })),
    ...r.blocks.map((id): RecordWrite => ({ type: 'time_block', id, fields: gone })),
    ...(r.plan ? [{ type: 'week_plan' as const, id: weekPlanId(week), fields: r.plan }] : []),
    ...(task && Object.keys(reopen).length > 0 ? [{ type: 'task' as const, id: task.id, fields: reopen }] : []),
  ];
  return applyPlanChange(w, { writes });
}
