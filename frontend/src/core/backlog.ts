// A goal's backlog: tasks that serve the goal but belong to no project. It is stored as a project whose id is
// backlog:<goal id>, made by its first task, so released apps see an ordinary project whose tasks keep working, and two
// devices making it offline make one record. The id alone says it's a backlog. Its title and dates are for those older
// apps: the dates are real ones every released screen can draw, rewritten as automatic writes, and this app never
// reads them.

import { parseClock } from './clock';
import type { Clock } from './clock';
import { addMonths, today } from './dates';
import type { Sql } from './db';
import { applyPlanChange, currentStretch, nextStretch } from './plan';
import type { CadenceSettings, PlanChange, RecordWrite } from './plan';
import { getRecord, getSettings } from './records';
import type { Writer } from './records';
import type { Fields, LocalDate, Objective, Project, Task } from './types';

const PREFIX = 'backlog:';

export const backlogId = (goalId: string) => `${PREFIX}${goalId}`;
export const isBacklog = (p: { id: string }) => p.id.startsWith(PREFIX);
export const backlogGoal = (p: { id: string }) => p.id.slice(PREFIX.length);
/** How lists and selects name it, as Belongs to names "{Project}, Done". */
export const backlogTitle = (goalTitle: string) => `${goalTitle}, Backlog`;

/** A project's name as this app shows it: a backlog's from its goal's current title, so a stale stored one never shows. */
export function projectLabel(p: Project, goals: readonly Pick<Objective, 'id' | 'title'>[]): string {
  if (!isBacklog(p)) return p.title;
  const goal = goals.find((g) => g.id === backlogGoal(p));
  return goal ? backlogTitle(goal.title) : 'Backlog of a removed goal';
}

/** This stretch's start and the next stretch's end, or with no cadence today and the end of the window after next. */
export function backlogDates(settings: CadenceSettings, on: LocalDate): { start: LocalDate; end: LocalDate } {
  const end = nextStretch(settings, on).end;
  return { start: currentStretch(settings, on)?.start ?? on, end: settings.plan_cadence ? end : addMonths(end, 3) };
}

/**
 * Makes a goal's backlog, or brings it back to how this app keeps it: live, under its own goal, with its title and
 * dates current. The fields that make it live are real writes, so filing reopens one an older app closed, paused or
 * moved; title and dates are automatic, so any explicit write wins and two devices converge. Returns its id.
 */
export async function ensureBacklog(w: Writer, goalId: string, clock: Clock): Promise<string> {
  const id = backlogId(goalId);
  const [goal, settings, held] = await Promise.all([getRecord(w.sql, 'objective', goalId), getSettings(w.sql), getRecord(w.sql, 'project', id)]);
  const live: Fields<'project'> = { objective_id: goalId, state: 'active', deleted_at: null, ...(held?.paused_on ? { paused_on: null } : {}) };
  await w.create('project', live, id);
  // Written only where they differ, so an unchanged backlog writes nothing here.
  await w.automatic.create('project', { title: backlogTitle(goal?.title ?? 'Goal'), ...backlogDates(settings, today(clock)) }, id);
  return id;
}

/** Arrival order: each way in stamps a task's order with the time it arrived, and the backlog lists by it. */
export function arrivalOrder(a: Pick<Task, 'id' | 'order'>, b: Pick<Task, 'id' | 'order'>): number {
  // An older app adds tasks with no order; they come last, in the order they were made, which their ids keep.
  const ka = a.order ?? Number.MAX_VALUE;
  const kb = b.order ?? Number.MAX_VALUE;
  return ka !== kb ? ka - kb : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The order that puts a task at an index of a list in arrival order, between its new neighbours. */
export function orderBetween(list: readonly Pick<Task, 'id' | 'order'>[], id: string, index: number): number {
  const rest = list.filter((t) => t.id !== id);
  // Tasks with no order sit at the end, so give each a place after the last stamped one.
  const last = Math.max(0, ...rest.map((t) => t.order ?? 0));
  const keys = rest.map((t, i) => t.order ?? last + i + 1);
  const before = keys[index - 1];
  const after = keys[index];
  if (before === undefined) return (after ?? 0) - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

const arrival = (clock: Clock, i = 0): Fields<'task'> => ({ order: clock.now() + i });

/**
 * Moves tasks into a goal's backlog, making it if it's new: no milestone, no date and no repeat, stamped as arriving
 * now in the order given. Returns the exact reverse of the tasks' writes. The backlog itself stays, even empty.
 */
export async function fileToBacklog(w: Writer, goalId: string, taskIds: readonly string[], clock: Clock, extra: Fields<'task'> = {}): Promise<PlanChange> {
  const project_id = await ensureBacklog(w, goalId, clock);
  const writes = taskIds.map(
    (id, i): RecordWrite => ({
      type: 'task',
      id,
      fields: { kind: 'project', project_id, milestone_id: null, moved_from: null, schedule: null, next_due: null, ...arrival(clock, i), ...extra },
    }),
  );
  return applyPlanChange(w, { writes });
}

/** Adds a new task at the end of a goal's backlog, making the backlog if it's new. Resolves to the task's id. */
export async function addToBacklog(w: Writer, goalId: string, fields: Fields<'task'>, clock: Clock): Promise<string> {
  const project_id = await ensureBacklog(w, goalId, clock);
  return w.create('task', { ...fields, kind: 'project', project_id, milestone_id: null, ...arrival(clock) });
}

/** A task untouched this long gets a quiet line, and planning a stretch asks Keep or Delete. */
export const UNTOUCHED_MONTHS = 6;

/**
 * When each open backlog task was last touched, in epoch ms: the newest of its own field writes (leaving out the app's
 * automatic writes and expiry), its latest pick's week and its latest block's start. Arrival counts, since moving a
 * task in writes project_id, and so does Keep, which writes kept_at.
 */
export async function backlogTouches(sql: Sql): Promise<Record<string, number>> {
  const rows = await sql.all<{ id: string; clocks: string; picked: string | null; placed: string | null }>(
    `SELECT r.id, r.clocks,
       (SELECT MAX(p.week_start) FROM week_pick p WHERE p.task_id = r.id AND p.deleted_at IS NULL) AS picked,
       (SELECT MAX(b.start) FROM time_block b WHERE b.task_id = r.id AND b.deleted_at IS NULL) AS placed
     FROM records r
     WHERE r.type = 'task' AND json_extract(r.data, '$.project_id') >= :from AND json_extract(r.data, '$.project_id') < :to
       AND json_extract(r.data, '$.done_at') IS NULL AND json_extract(r.data, '$.cancelled_at') IS NULL
       AND json_extract(r.data, '$.deleted_at') IS NULL`,
    { from: PREFIX, to: 'backlog;' },
  );
  const out: Record<string, number> = {};
  for (const row of rows) {
    const walls = Object.entries(JSON.parse(row.clocks) as Record<string, string>)
      .filter(([field]) => field !== 'expires_at')
      .map(([, c]) => parseClock(c).wall);
    out[row.id] = Math.max(...walls, row.picked ? Date.parse(`${row.picked}T00:00:00Z`) : 0, row.placed ? Date.parse(row.placed) : 0);
  }
  return out;
}

/** The day a task was last touched, if that's more than UNTOUCHED_MONTHS before today, else null. */
export function untouchedSince(touched: number | undefined, on: LocalDate): LocalDate | null {
  if (touched === undefined) return null;
  const day = new Date(touched).toISOString().slice(0, 10);
  return day < addMonths(on, -UNTOUCHED_MONTHS) ? day : null;
}
