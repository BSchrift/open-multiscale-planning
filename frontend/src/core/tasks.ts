// Closing a task from anywhere in the app. Deletes don't cascade in queries, so a closed task must give up its
// future blocks and picks here, or it would keep its time and fire reminders. Also making a home for an Inbox item,
// which can close it.

import { fileToBacklog } from './backlog';
import type { Clock } from './clock';
import { formatDate, instantMs, nowInstant, thisWeek, today } from './dates';
import type { Params, Sql } from './db';
import { applyPlanChange, undoLastChange } from './plan';
import type { PlanChange, ProjectPlan, RecordWrite, ScheduledWork } from './plan';
import { futureBlocks, futurePicks } from './queries';
import { getRecord } from './records';
import type { Writer } from './records';
import { blocksToRelease, isRepeating, retick, tick, untick } from './schedule';
import type { Fields, Instant, LocalDate, Minutes, Practice, Project, SlipEntry, Task, TaskCompletion, TimeBlock, WeekPick } from './types';

export type TaskClose = 'done' | 'cancelled' | 'deleted';

const FIELD = { done: 'done_at', cancelled: 'cancelled_at', deleted: 'deleted_at' } as const;

/**
 * Finishes, cancels or deletes a task inside a transaction. Blocks not yet started are cancelled, and picks from
 * this week on are removed; past ones stay as history. Returns the exact reverse, for Undo.
 * A repeating one off finishes through schedule.tick instead, since it stays open for its next date.
 * `at` is when it happened, if not now, such as the end of a block answered later.
 */
export async function closeTask(w: Writer, taskId: string, how: TaskClose, clock: Clock, at?: Instant): Promise<PlanChange> {
  const task = await getRecord(w.sql, 'task', taskId);
  if (!task) throw new Error(`No task ${taskId}`);
  if (how === 'done' && isRepeating(task)) throw new Error('A repeating task finishes through schedule.tick');
  const now = nowInstant(clock);
  const blocks = await futureBlocks(w.sql, { task_id: taskId, now });
  const picks = await futurePicks(w.sql, { task_id: taskId, week_start: thisWeek(clock) });
  const writes: RecordWrite[] = [
    { type: 'task', id: taskId, fields: { [FIELD[how]]: (at ?? now) satisfies Instant } },
    ...blocks.map(({ id }): RecordWrite => ({ type: 'time_block', id, fields: { cancelled: true } })),
    ...picks.map(({ id }): RecordWrite => ({ type: 'week_pick', id, fields: { deleted_at: now } })),
  ];
  return applyPlanChange(w, { writes });
}

/** What's still scheduled or picked for some tasks, so a plan change that closes them can free it, as closeTask does. */
export async function scheduledWork(sql: Sql, taskIds: readonly string[], clock: Clock): Promise<Required<ScheduledWork>> {
  const now = nowInstant(clock);
  const week_start = thisWeek(clock);
  const blocks: TimeBlock[] = [];
  const picks: WeekPick[] = [];
  for (const task_id of taskIds) {
    blocks.push(...(await futureBlocks(sql, { task_id, now })));
    picks.push(...(await futurePicks(sql, { task_id, week_start })));
  }
  return { blocks, picks };
}

/**
 * Finishes or drops a project, cancelling its open tasks through closeTask, or with moveToBacklog and a goal, moving
 * them to the goal's backlog. Returns the exact reverse, for Undo.
 */
export async function closeProject(
  w: Writer,
  projectId: string,
  state: 'finished' | 'dropped',
  clock: Clock,
  options: { moveToBacklog?: boolean } = {},
): Promise<PlanChange> {
  const open = await w.sql.all<{ id: string; milestone_id: string | null }>(
    'SELECT id, milestone_id FROM task WHERE project_id = :project AND done_at IS NULL AND cancelled_at IS NULL AND deleted_at IS NULL',
    { project: projectId },
  );
  const project = await getRecord(w.sql, 'project', projectId);
  if (!project) throw new Error(`No project ${projectId}`);
  if (options.moveToBacklog && project.objective_id) return closeMovingTasks(w, project, state, open, clock);
  const reverses: PlanChange[] = [];
  for (const { id } of open) reverses.unshift(await closeTask(w, id, 'cancelled', clock));
  // Each task is marked, so Restore can reopen it later; the time it gave up stays free. The entry is history, and
  // what Restore goes by for an older app or a close from before the marks.
  const entry: SlipEntry = {
    at: nowInstant(clock),
    kind: 'close',
    text: `${formatDate(today(clock))}: ${state === 'finished' ? 'Finished' : 'Dropped'}.`,
    undo: [
      { type: 'project', id: projectId, fields: { state: project.state } },
      ...open.map(({ id }): RecordWrite => ({ type: 'task', id, fields: { cancelled_at: null, cancelled_by: null } })),
    ] satisfies RecordWrite[],
  };
  const writes: RecordWrite[] = [
    { type: 'project', id: projectId, fields: { state, slip_log: [...(project.slip_log ?? []), entry] } },
    ...open.map(({ id }): RecordWrite => ({ type: 'task', id, fields: { cancelled_by: projectId } })),
  ];
  reverses.unshift(await applyPlanChange(w, { writes }));
  return { writes: reverses.flatMap((r) => r.writes) };
}

/**
 * Closes a project and moves its open tasks to its goal's backlog, each remembering its milestone in moved_from. A
 * milestone they leave with nothing open would read as met, so it is dropped, as cancelling would have left it. Only
 * the state goes in the close's log entry, since Restore in any app version only reopens the project; the toast's Undo
 * reverses the rest from the change returned.
 */
async function closeMovingTasks(w: Writer, project: Project, state: 'finished' | 'dropped', open: readonly { id: string; milestone_id: string | null }[], clock: Clock): Promise<PlanChange> {
  const now = nowInstant(clock);
  const losing = [...new Set(open.map((t) => t.milestone_id).filter((m): m is string => !!m))];
  const milestones = (await Promise.all(losing.map((id) => getRecord(w.sql, 'milestone', id)))).filter((m) => m && !m.met_at && !m.dropped_at);
  const reverses: PlanChange[] = [await fileToBacklog(w, project.objective_id!, open.map((t) => t.id), clock)];
  const from = open.filter((t) => t.milestone_id).map((t): RecordWrite => ({ type: 'task', id: t.id, fields: { moved_from: t.milestone_id } }));
  reverses.unshift(await applyPlanChange(w, { writes: from }));
  const entry: SlipEntry = {
    at: now,
    kind: 'close',
    text: `${formatDate(today(clock))}: ${state === 'finished' ? 'Finished' : 'Dropped'}.`,
    undo: [{ type: 'project', id: project.id, fields: { state: project.state } }] satisfies RecordWrite[],
  };
  const writes: RecordWrite[] = [
    { type: 'project', id: project.id, fields: { state, slip_log: [...(project.slip_log ?? []), entry] } },
    ...milestones.map((m): RecordWrite => ({ type: 'milestone', id: m!.id, fields: { dropped_at: now } })),
  ];
  reverses.unshift(await applyPlanChange(w, { writes }));
  return { writes: reverses.flatMap((r) => r.writes) };
}

const under = (type: 'project' | 'milestone' | 'task' | 'practice', parent: 'objective_id' | 'project_id') =>
  `SELECT id, title FROM ${type} WHERE ${parent} = :id AND deleted_at IS NULL ORDER BY id`;
const ids = async (sql: Sql, query: string, params: Params) => (await sql.all<{ id: string }>(query, params)).map((r) => r.id);

/** Everything deleting a goal takes with it: its projects with their milestones and tasks, and its practices. */
export async function goalContents(sql: Sql, goalId: string) {
  const projects = [];
  for (const { id, title } of await sql.all<{ id: string; title: string }>(under('project', 'objective_id'), { id: goalId })) {
    projects.push({ id, title, milestones: await ids(sql, under('milestone', 'project_id'), { id }), tasks: await ids(sql, under('task', 'project_id'), { id }) });
  }
  return { projects, practices: await sql.all<{ id: string; title: string }>(under('practice', 'objective_id'), { id: goalId }) };
}

/** Takes a practice's sessions still to come off the calendar, so it keeps no time ahead. Returns the reverse. */
async function dropSessionsAhead(w: Writer, practiceId: string, clock: Clock): Promise<PlanChange> {
  const sessions = await ids(
    w.sql,
    'SELECT id FROM time_block WHERE practice_id = :id AND start > :now AND started_at IS NULL AND cancelled IS NOT 1 AND deleted_at IS NULL',
    { id: practiceId, now: nowInstant(clock) },
  );
  return applyPlanChange(w, { writes: sessions.map((id): RecordWrite => ({ type: 'time_block', id, fields: { cancelled: true } })) });
}

/** Ends a practice. Its past and what's under way stay as history; its sessions still to come go. Returns the exact reverse. */
export async function endPractice(w: Writer, practiceId: string, clock: Clock): Promise<PlanChange> {
  const dropped = await dropSessionsAhead(w, practiceId, clock);
  const ended = await applyPlanChange(w, { writes: [{ type: 'practice', id: practiceId, fields: { state: 'ended' } }] });
  return { writes: [...ended.writes, ...dropped.writes] };
}

/**
 * Deletes a goal and everything goalContents lists. Tasks close through closeTask, and practices give up their
 * sessions still to come, so nothing deleted keeps time on the week. Past blocks and their answers stay, as a deleted
 * task's do. Returns the exact reverse, for Undo.
 */
// shortcut: an edit on another device before this syncs can be caught by it (a project moved to another goal is
// deleted) or miss it (a task added there lives on without its project, keeping its blocks); sweep orphans after a pull if that shows up.
export async function deleteGoal(w: Writer, goalId: string, clock: Clock): Promise<PlanChange> {
  const { projects, practices } = await goalContents(w.sql, goalId);
  const now = nowInstant(clock);
  const gone = (type: RecordWrite['type'], id: string): RecordWrite => ({ type, id, fields: { deleted_at: now } });
  const reverses: PlanChange[] = [];
  const writes: RecordWrite[] = [];
  for (const project of projects) {
    for (const id of project.tasks) reverses.unshift(await closeTask(w, id, 'deleted', clock));
    writes.push(...project.milestones.map((id) => gone('milestone', id)), gone('project', project.id));
  }
  for (const { id } of practices) {
    reverses.unshift(await dropSessionsAhead(w, id, clock));
    writes.push(gone('practice', id));
  }
  writes.push(gone('objective', goalId));
  reverses.unshift(await applyPlanChange(w, { writes }));
  return { writes: reverses.flatMap((r) => r.writes) };
}

/**
 * Applies a one off's finish. A one-time one closes through closeTask, keeping the finish's own time; a repeating one
 * moves on to its next date, and the occurrence it used up gives up its time left and its blocks still to come.
 * Returns the exact reverse.
 */
async function finish(w: Writer, task: Task, fields: Fields<'task'>, clock: Clock): Promise<RecordWrite[]> {
  if (!isRepeating(task)) {
    const reverse = (await closeTask(w, task.id, 'done', clock)).writes;
    await w.set('task', task.id, fields);
    return reverse;
  }
  const blocks = await w.sql.all<TimeBlock>('SELECT * FROM time_block WHERE task_id = :task', { task: task.id });
  const released = blocksToRelease(blocks, { ...task, ...fields } as Task, clock);
  const writes: RecordWrite[] = [
    { type: 'task', id: task.id, fields: { ...fields, remaining_min: null } },
    ...released.map(({ id }): RecordWrite => ({ type: 'time_block', id, fields: { cancelled: true } })),
  ];
  return (await applyPlanChange(w, { writes })).writes;
}

/** What a completion keeps of its finish's reverse, for an untick: all but the task's dates, which untick restores itself. */
function undoOf(reverse: readonly RecordWrite[]): RecordWrite[] {
  return reverse.flatMap((r) => {
    if (r.type !== 'task') return [r];
    const fields = Object.fromEntries(Object.entries(r.fields).filter(([field]) => field !== 'done_at' && field !== 'next_due'));
    return Object.keys(fields).length ? [{ ...r, fields }] : [];
  });
}

/**
 * Ticks a one off and logs its completion, which keeps what the finish freed so a later untick can give it back.
 * `done_at` is when it was finished, if not now. Returns the exact reverse, for Undo.
 */
export async function tickOneOff(w: Writer, taskId: string, clock: Clock, done_at?: Instant): Promise<PlanChange> {
  const task = await getRecord(w.sql, 'task', taskId);
  if (!task) throw new Error(`No task ${taskId}`);
  if (!isRepeating(task) && task.done_at) return { writes: [] };
  const { task: fields, completion } = tick(task, clock, done_at);
  const reverse = await finish(w, task, fields, clock);
  await w.create('task_completion', { ...completion.fields, undo: undoOf(reverse) }, completion.id);
  const logged: RecordWrite = { type: 'task_completion', id: completion.id, fields: { deleted_at: nowInstant(clock) } };
  return { writes: [...reverse, logged] };
}

async function readFinish(w: Writer, completionId: string) {
  const completion = await getRecord(w.sql, 'task_completion', completionId);
  const task = completion && (await getRecord(w.sql, 'task', completion.task_id));
  if (!completion || !task) throw new Error(`No completion ${completionId}`);
  const all = await w.sql.all<TaskCompletion>('SELECT * FROM task_completion WHERE task_id = :task', { task: task.id });
  return { completion, task, all };
}

/** What a finish freed that is still worth giving back: blocks yet to start, and picks from this week on. */
async function stillAhead(w: Writer, undo: readonly RecordWrite[], clock: Clock): Promise<RecordWrite[]> {
  const kept: RecordWrite[] = [];
  for (const write of undo) {
    if (write.type === 'time_block') {
      const block = await getRecord(w.sql, 'time_block', write.id);
      if (!block || block.started_at || instantMs(block.start) <= clock.now()) continue;
    }
    if (write.type === 'week_pick') {
      const pick = await getRecord(w.sql, 'week_pick', write.id);
      if (!pick || pick.week_start < thisWeek(clock)) continue;
    }
    kept.push(write);
  }
  return kept;
}

/** Unticks one finish of a one off, from its row or the finished list. Only the latest finish changes the task. */
export async function untickOneOff(w: Writer, completionId: string, clock: Clock): Promise<void> {
  const { completion, task, all } = await readFinish(w, completionId);
  const result = untick(task, completion, all, clock);
  await w.set('task', task.id, result.task);
  await w.set('task_completion', completionId, result.completion);
  if (Object.keys(result.task).length) {
    await applyPlanChange(w, { writes: await stillAhead(w, (completion.undo ?? []) as RecordWrite[], clock) });
  }
}

/**
 * Undo on a project's change line, which can come days later. Like an untick, it gives back only blocks still ahead and
 * picks from this week on, so time that has passed doesn't come back as a missed block. Returns the reverse.
 */
export async function undoProjectChange(w: Writer, plan: ProjectPlan, clock: Clock): Promise<PlanChange> {
  const undo = undoLastChange(plan);
  return undo ? applyPlanChange(w, { writes: await stillAhead(w, undo.writes, clock) }) : { writes: [] };
}

/** A goal for a new project or practice: one there is, or a new one by its name. */
export type GoalPick = { id: string } | { title: string } | null;

/**
 * A new home for an Inbox item. keep: the item stays open on its card, to add next: to the project, as its first task,
 * under the milestone named with it, or anywhere after a practice or goal. Otherwise the item is what was made, and
 * closes with a link to it.
 */
export type Home =
  | { kind: 'project'; title: string; goal: GoalPick; start: LocalDate; end: LocalDate; keep: boolean; milestone?: string | null }
  | { kind: 'practice'; title: string; goal: GoalPick; target_min: Minutes; per: Practice['per']; keep: boolean }
  | { kind: 'goal'; title: string; keep: boolean };

/** What makeHome made: the record, and a goal or a project's milestone made with it, for undoHome. */
export interface Made {
  type: 'project' | 'practice' | 'objective';
  id: string;
  goal: string | null;
  milestone?: string | null;
}

/**
 * Makes a project, practice or goal from an Inbox item, with a new goal if asked, all in the caller's one transaction.
 * A project gets the milestone named with it, due at its end. An item that becomes what was made closes as a finish
 * with its completion, as a ticked one off does, so it lists under Finished tasks, and links to it; one kept is left as
 * it is, for the caller to add. Returns what was made and the exact reverse.
 */
export async function makeHome(w: Writer, itemId: string, home: Home, clock: Clock): Promise<{ made: Made; reverse: PlanChange }> {
  const now = nowInstant(clock);
  const pick = home.kind === 'goal' ? null : home.goal;
  const goal = pick && 'title' in pick ? await w.create('objective', { title: pick.title, state: 'active' }) : null;
  const objective_id = goal ?? (pick && 'id' in pick ? pick.id : null);
  const { title } = home;
  let made: Made;
  if (home.kind === 'project') {
    const id = await w.create('project', { objective_id, title, state: 'active', start: home.start, end: home.end, added_on: today(clock) });
    const milestone = home.milestone ? await w.create('milestone', { project_id: id, title: home.milestone, due: home.end, added_on: today(clock) }) : null;
    made = { type: 'project', id, goal, milestone };
  } else if (home.kind === 'practice') {
    made = { type: 'practice', id: await w.create('practice', { objective_id, title, target_min: home.target_min, per: home.per, preferred_times: [], state: 'active' }), goal };
  } else {
    made = { type: 'objective', id: await w.create('objective', { title, state: 'active' }), goal };
  }
  const gone = (type: RecordWrite['type'], id: string): RecordWrite => ({ type, id, fields: { deleted_at: now } });
  const tombstones = [gone(made.type, made.id), ...(made.milestone ? [gone('milestone', made.milestone)] : []), ...(goal ? [gone('objective', goal)] : [])];

  let filed: RecordWrite[] = [];
  if (!home.keep) {
    const closed = await tickOneOff(w, itemId, clock);
    const linked = await applyPlanChange(w, { writes: [{ type: 'task', id: itemId, fields: { became: { type: made.type, id: made.id } } }] });
    filed = [...linked.writes, ...closed.writes];
  }
  return { made, reverse: { writes: [...filed, ...tombstones] } };
}

/**
 * Undoes makeHome. A project another device has put tasks in since stays, with a goal made with it, and only the item
 * comes back. Returns whether it stayed.
 */
export async function undoHome(w: Writer, itemId: string, made: Made, reverse: PlanChange): Promise<boolean> {
  const others =
    made.type === 'project' &&
    !!(await w.sql.get('SELECT id FROM task WHERE project_id = :project AND id != :item AND deleted_at IS NULL', { project: made.id, item: itemId }));
  const kept = new Set(others ? [made.id, made.goal, made.milestone] : []);
  await applyPlanChange(w, { writes: reverse.writes.filter((r) => !kept.has(r.id)) });
  return others;
}

/** Ticks an unticked finish again from the finished list, giving back what it set when it's the latest again. */
export async function retickOneOff(w: Writer, completionId: string, clock: Clock): Promise<void> {
  const { completion, task, all } = await readFinish(w, completionId);
  const result = retick(task, completion, all, clock);
  await w.set('task_completion', completionId, result.completion);
  if (!Object.keys(result.task).length) return;
  const reverse = await finish(w, task, result.task, clock);
  await w.set('task_completion', completionId, { undo: undoOf(reverse) });
}
