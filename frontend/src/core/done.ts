// A day's done list: what was finished that day and the time worked, read from the records the app already keeps.
// Nothing about it is stored, so a day's list shrinks as retention removes what it reads (docs/retention.md). doneOn
// builds one day's list from records; loadDone reads the records for a day, or a week, through indexed queries, never
// the whole history.

import { deliveredMinutes, metAt } from './analytics';
import { workMinutes } from './blocks';
import type { Clock } from './clock';
import { dayRange, instantMs, localDate, toInstant } from './dates';
import type { Sql } from './db';
import { blocksInRange, doneCompletions, doneTasks, metMilestones, tasksOfProject } from './queries';
import type { BlockRow } from './queries';
import { getRecords } from './records';
import type { Instant, LocalDate, Milestone, Minutes, Project, Task, TaskCompletion } from './types';

/** Blue for projects, purple for one offs, teal for practices and grey for planning, as Week draws them. */
export type DoneKind = 'project' | 'one_off' | 'practice' | 'planning';

export interface DoneRecords {
  /** The blocks of the days read, with their answers. */
  blocks: BlockRow[];
  /**
   * The tasks finished in those days, those their blocks and completions name, and the other tasks of a project whose
   * milestone a finish may have reached. Deleted ones too, since a tombstone keeps its task's title for 30 days.
   */
  tasks: Task[];
  completions: TaskCompletion[];
  /** Those marked met in those days, and those of the tasks finished. */
  milestones: Milestone[];
  projects: Project[];
}

export interface DoneBlock {
  block: BlockRow;
  kind: DoneKind;
  /** The project a task's block is for. */
  project: string | null;
  /** The zone its day and times are in: the block's own. */
  zone: string;
  /** Its task was deleted since. */
  deleted: boolean;
}

/** Time worked: a block answered Task finished or Partly, or a practice logged. */
export interface DoneWork extends DoneBlock {
  minutes: Minutes;
  /** After Partly, the time still left. */
  left: Minutes | null;
}

export interface DoneFinish {
  /** A one off's completion, or the task or milestone. */
  id: string;
  type: 'task' | 'milestone';
  task_id: string | null;
  title: string;
  kind: 'project' | 'one_off';
  project: string | null;
  milestone: string | null;
  at: Instant;
  zone: string;
  deleted: boolean;
  /** The day's time worked on the task, shown under its finish rather than twice. */
  work: DoneWork[];
}

export interface DoneDay {
  date: LocalDate;
  /** Each in the order it happened. */
  finished: DoneFinish[];
  worked: DoneWork[];
  /** Blocks that ended that day with no answer yet. */
  unmarked: DoneBlock[];
  total: { finished: number; worked_min: Minutes; by_kind: Record<DoneKind, Minutes> };
}

const kindOf = (b: BlockRow): DoneKind =>
  b.practice_id ? 'practice' : b.task_kind === 'one_off' || b.task_kind === 'planning' ? b.task_kind : 'project';

/** Sorting an Inbox item into a project, practice or goal closes it, and planning finishes, but neither is doing. */
const counts = (t: Task | undefined): t is Task => !!t && !t.became && t.kind !== 'planning';

/** One day's list, from records loadDone read for a range that covers it. */
export function doneOn(date: LocalDate, records: DoneRecords, clock: Clock): DoneDay {
  const zone = clock.zone();
  const tasks = new Map(records.tasks.map((t) => [t.id, t]));
  const projects = new Map(records.projects.map((p) => [p.id, p]));
  const milestones = new Map(records.milestones.map((m) => [m.id, m]));
  const projectOf = (t: Task | undefined) => (t?.project_id ? (projects.get(t.project_id)?.title ?? null) : null);
  const onDay = (at: Instant, z: string) => localDate(at, z) === date;

  // A block's Done finishes its task at the block's end, or earlier when marked done before then, so within the block,
  // and that finish's day is in the block's zone, as the block's own day is. Any other finish keeps only its instant, so
  // its day is in this device's zone now: after travel, such a finish can move to the day before or after.
  const finishZone = (taskId: string, at: Instant) => {
    const ms = instantMs(at);
    const from = records.blocks.find((b) => b.task_id === taskId && b.result === 'done' && instantMs(b.start) <= ms && ms <= instantMs(b.end));
    return from?.tz || zone;
  };

  const finished: DoneFinish[] = [];
  const finish = (id: string, task: Task, at: Instant) => {
    const z = finishZone(task.id, at);
    if (!onDay(at, z)) return;
    const milestone = task.milestone_id ? (milestones.get(task.milestone_id)?.title ?? null) : null;
    const kind = task.kind === 'project' ? 'project' : 'one_off';
    finished.push({ id, type: 'task', task_id: task.id, title: task.title, kind, project: projectOf(task), milestone, at, zone: z, deleted: !!task.deleted_at, work: [] });
  };
  const completions = records.completions.filter((c) => !c.deleted_at);
  for (const c of completions) {
    const task = tasks.get(c.task_id);
    if (counts(task)) finish(c.id, task, c.done_at);
  }
  // A one off's finish has its completion, listed above.
  for (const t of records.tasks) {
    if (counts(t) && t.done_at && !completions.some((c) => c.task_id === t.id && c.done_at === t.done_at)) finish(t.id, t, t.done_at);
  }
  const kept = records.tasks.filter((t) => !t.deleted_at);
  for (const m of records.milestones) {
    const project = projects.get(m.project_id);
    const at = project && metAt(m, project, kept);
    if (!project || !at) continue;
    // Reached by its last task's finish, it's on that finish's day.
    const last = m.met_at ? undefined : kept.find((t) => t.milestone_id === m.id && t.done_at === at);
    const z = last ? finishZone(last.id, at) : zone;
    if (!onDay(at, z)) continue;
    finished.push({ id: m.id, type: 'milestone', task_id: null, title: m.title, kind: 'project', project: project.title, milestone: null, at, zone: z, deleted: !!m.deleted_at, work: [] });
  }
  // Newest last, and a milestone after the task that reached it.
  finished.sort((a, b) => instantMs(a.at) - instantMs(b.at) || (a.type === b.type ? 0 : a.type === 'task' ? -1 : 1));

  const worked: DoneWork[] = [];
  const unmarked: DoneBlock[] = [];
  const by_kind: Record<DoneKind, Minutes> = { project: 0, practice: 0, one_off: 0, planning: 0 };
  const today = localDate(clock.now(), zone);
  const blocks = [...records.blocks].sort((a, b) => instantMs(a.start) - instantMs(b.start));
  for (const b of blocks) {
    const z = b.tz || zone;
    if (!onDay(b.start, z)) continue;
    const task = b.task_id ? tasks.get(b.task_id) : undefined;
    // Once a deleted task's tombstone has gone, its blocks name nothing and leave with it.
    if (b.task_id ? !task : !b.title) continue;
    const kind = kindOf(b);
    const shown: DoneBlock = { block: b, kind, project: projectOf(task), zone: z, deleted: !!task?.deleted_at };
    if (b.result === 'done' || b.result === 'partly') {
      const minutes = deliveredMinutes(b, { result: b.result, logged_min: b.logged_min ?? null }, workMinutes(b));
      if (minutes <= 0) continue;
      worked.push({ ...shown, minutes, left: b.result === 'partly' ? (b.remaining_min ?? null) : null });
      by_kind[kind] += minutes;
    } else if (!b.result && !b.ended_at && instantMs(b.end) <= clock.now() && !task?.deleted_at) {
      // What Today asks about: work but not planning, and a practice only on its own day (reminders.missedBlocks).
      if (b.task_id ? kind !== 'planning' : date === today) unmarked.push(shown);
    }
  }

  const loose: DoneWork[] = [];
  for (const w of worked) {
    const under = [...finished].reverse().find((f) => f.task_id && f.task_id === w.block.task_id);
    if (under) under.work.push(w);
    else loose.push(w);
  }
  const worked_min = worked.reduce((sum, w) => sum + w.minutes, 0);
  return { date, finished, worked: loose, unmarked, total: { finished: finished.length, worked_min, by_kind } };
}

/** The most two zones' clocks differ by, UTC-12 to UTC+14, and so how far a record's day in its own zone can be from here. */
const ZONES_APART_MS = 26 * 3_600_000;

/** What doneOn needs for the days from `from` to `to`, in this device's zone, with the hours a block's zone can add. */
export async function loadDone(sql: Sql, clock: Clock, from: LocalDate, to: LocalDate = from): Promise<DoneRecords> {
  const zone = clock.zone();
  const range = {
    from_utc: toInstant(instantMs(dayRange(from, zone).from_utc) - ZONES_APART_MS),
    to_utc: toInstant(instantMs(dayRange(to, zone).to_utc) + ZONES_APART_MS),
  };
  const blocks = await blocksInRange(sql, range);
  const completions = await doneCompletions(sql, range);
  const met = await metMilestones(sql, range);
  const tasks = new Map((await doneTasks(sql, range)).map((t) => [t.id, t]));
  const named = [...completions.map((c) => c.task_id), ...blocks.flatMap((b) => (b.task_id ? [b.task_id] : []))];
  for (const t of await getRecords(sql, 'task', named.filter((id) => !tasks.has(id)))) tasks.set(t.id, t);

  // A finish under a milestone may have reached it, which takes all of its project's tasks to tell.
  const inRange = (at: Instant | null | undefined): at is Instant => !!at && at >= range.from_utc && at < range.to_utc;
  const reaching = [...tasks.values()].filter((t) => inRange(t.done_at) && t.milestone_id && t.project_id);
  for (const projectId of new Set(reaching.map((t) => t.project_id!))) {
    for (const t of await tasksOfProject(sql, projectId)) if (!tasks.has(t.id)) tasks.set(t.id, t);
  }
  const milestoneIds = reaching.map((t) => t.milestone_id!).filter((id) => !met.some((m) => m.id === id));
  const milestones = [...met, ...(await getRecords(sql, 'milestone', milestoneIds))];
  const projectIds = [...[...tasks.values()].flatMap((t) => (t.project_id ? [t.project_id] : [])), ...milestones.map((m) => m.project_id)];
  const projects = await getRecords(sql, 'project', projectIds);
  return { blocks, tasks: [...tasks.values()], completions, milestones, projects };
}
