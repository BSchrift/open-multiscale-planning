// A day's blocks as they happen: which one is now, the end-of-block answers, Mark done now, Start, Start early,
// Do next block instead and Still going, plus the week's edits: move, remove, place, keeping a practice change and
// placing the week's practices.
// The in-app prompts and notification actions both write through here.
// Each write runs inside a transaction and returns its exact reverse, for Undo.

import type { Clock } from './clock';
import { blockMinutes, instantMs, localDate, localMinutes, nowInstant, toInstant, weekRange } from './dates';
import { applyPlanChange, minutesLeft } from './plan';
import type { PlanChange, RecordWrite } from './plan';
import { blocksInRange, futureBlocks, weekPractices } from './queries';
import type { BlockRow } from './queries';
import { CALENDAR_ID, getRecord, getSettings, listRecords, outcomeId, practiceSessionId, weekPlanId } from './records';
import type { Writer } from './records';
import { blockFinish, tickFromBlock } from './schedule';
import { placePractices, slotContext, slotInstants } from './slots';
import { closeTask, tickOneOff } from './tasks';
import type { BlockResult, Instant, LocalDate, Minutes, Task, TaskCompletion, TimeBlock } from './types';

const MINUTE_MS = 60_000;
const unanswered = (b: BlockRow) => !b.result && !b.ended_at;

/** The unanswered block under the clock. */
export function currentBlock(blocks: readonly BlockRow[], clock: Clock): BlockRow | undefined {
  const now = clock.now();
  return blocks.find((b) => unanswered(b) && instantMs(b.start) <= now && now < instantMs(b.end));
}

/** The first unanswered block still to start. */
export function nextBlock(blocks: readonly BlockRow[], clock: Clock): BlockRow | undefined {
  const now = clock.now();
  return blocks.filter((b) => unanswered(b) && instantMs(b.start) > now).sort((a, b) => instantMs(a.start) - instantMs(b.start))[0];
}

/** Where Partly's slider starts: the estimate less this block, or the block's own length once that's used up. */
export function partlyLeft(task: Pick<Task, 'remaining_min' | 'estimate_min'>, block: { start: Instant; end: Instant }): Minutes {
  const length = blockMinutes(block);
  const left = (task.remaining_min ?? task.estimate_min ?? 0) - length;
  return left > 0 ? left : length;
}

export interface BlockAnswer {
  result: BlockResult;
  /** Partly: the time still to do. */
  remaining_min?: Minutes | null;
  /** A practice: the minutes done. Left out, analytics counts the block's span. */
  logged_min?: Minutes | null;
}

async function readBlock(w: Writer, id: string): Promise<TimeBlock> {
  const block = await getRecord(w.sql, 'time_block', id);
  if (!block) throw new Error(`No block ${id}`);
  return block;
}

const change = (w: Writer, type: RecordWrite['type'], id: string, fields: Record<string, unknown>) =>
  applyPlanChange(w, { writes: [{ type, id, fields }] });

/**
 * Done finishes the task once, when its block ended: a one off ticks at most once a day from its blocks, and anything
 * else closes.
 */
async function finishTask(w: Writer, block: TimeBlock, clock: Clock): Promise<PlanChange> {
  const task = block.task_id ? await getRecord(w.sql, 'task', block.task_id) : undefined;
  if (!task || task.done_at || task.cancelled_at || task.deleted_at) return { writes: [] };
  if (task.kind !== 'one_off') return closeTask(w, task.id, 'done', clock, blockFinish(block, clock));
  const completions = await w.sql.all<TaskCompletion>('SELECT * FROM task_completion WHERE task_id = :task AND deleted_at IS NULL', { task: task.id });
  const finish = tickFromBlock(task, completions, block, clock);
  return finish ? tickOneOff(w, task.id, clock, finish.completion.fields.done_at) : { writes: [] };
}

/**
 * Records the answer to a block's end prompt. Done finishes the task and frees its later time, Partly keeps it open
 * with the time left, and Partly or Not done puts it in Needs a new time. A second answer replaces the first.
 */
export async function answerBlock(w: Writer, blockId: string, answer: BlockAnswer, clock: Clock): Promise<PlanChange> {
  const block = await readBlock(w, blockId);
  const id = outcomeId(blockId);
  const now = nowInstant(clock);
  const fields = {
    result: answer.result,
    remaining_min: answer.remaining_min ?? null,
    logged_min: answer.logged_min ?? null,
    answered_at: now,
    deleted_at: null,
  };
  const reverse: RecordWrite[] = [];
  if (await getRecord(w.sql, 'block_outcome', id)) {
    reverse.push({ type: 'block_outcome', id, fields: await w.set('block_outcome', id, fields) });
  } else {
    await w.create('block_outcome', fields, id);
    reverse.push({ type: 'block_outcome', id, fields: { deleted_at: now } });
  }
  if (block.task_id && answer.result === 'done') reverse.unshift(...(await finishTask(w, block, clock)).writes);
  if (block.task_id && answer.result === 'partly' && answer.remaining_min != null) {
    reverse.unshift(...(await change(w, 'task', block.task_id, { remaining_min: answer.remaining_min })).writes);
  }
  return { writes: reverse };
}

/** Ends the block in progress now and answers Done, so the rest of its time is free again. */
export async function markDoneNow(w: Writer, blockId: string, clock: Clock): Promise<PlanChange> {
  const ended = await change(w, 'time_block', blockId, { ended_at: nowInstant(clock) });
  const answered = await answerBlock(w, blockId, { result: 'done' }, clock);
  return { writes: [...answered.writes, ...ended.writes] };
}

export function startBlock(w: Writer, blockId: string, clock: Clock): Promise<PlanChange> {
  return change(w, 'time_block', blockId, { started_at: nowInstant(clock) });
}

/** Moves a block to start now, keeping its length, and starts it. */
export async function startEarly(w: Writer, blockId: string, clock: Clock): Promise<PlanChange> {
  const block = await readBlock(w, blockId);
  const start = Math.floor(clock.now() / MINUTE_MS) * MINUTE_MS;
  const end = start + instantMs(block.end) - instantMs(block.start);
  return change(w, 'time_block', blockId, { start: toInstant(start), end: toInstant(end), started_at: nowInstant(clock) });
}

/** Do next block instead: the two blocks trade their work and keep their times. */
export async function swapBlocks(w: Writer, aId: string, bId: string): Promise<PlanChange> {
  const [a, b] = [await readBlock(w, aId), await readBlock(w, bId)];
  const work = (x: TimeBlock) => ({ task_id: x.task_id ?? null, practice_id: x.practice_id ?? null });
  return applyPlanChange(w, {
    writes: [
      { type: 'time_block', id: aId, fields: work(b) },
      { type: 'time_block', id: bId, fields: work(a) },
    ],
  });
}

/** Longest block a task gets when started with nothing planned, the same cap planning uses. */
const LONGEST_START_MIN = 120;

/** Puts a task on the clock now, for its time left (or 30 minutes with no estimate), and starts it. Returns its block. */
export async function startTaskNow(w: Writer, taskId: string, clock: Clock): Promise<string> {
  const task = await getRecord(w.sql, 'task', taskId);
  if (!task) throw new Error(`No task ${taskId}`);
  const start = Math.floor(clock.now() / MINUTE_MS) * MINUTE_MS;
  const minutes = Math.min(minutesLeft(task) || 30, LONGEST_START_MIN);
  return w.create('time_block', {
    task_id: taskId,
    start: toInstant(start),
    end: toInstant(start + minutes * MINUTE_MS),
    tz: clock.zone(),
    started_at: nowInstant(clock),
  });
}

/** Still going: the block runs longer. */
export async function extendBlock(w: Writer, blockId: string, minutes: Minutes): Promise<PlanChange> {
  const block = await readBlock(w, blockId);
  return change(w, 'time_block', blockId, { end: toInstant(instantMs(block.end) + minutes * MINUTE_MS) });
}

/** A move or resize, written once on drop. A practice session moved is this week's only, so re-placing leaves it alone. */
export async function moveBlock(w: Writer, blockId: string, times: { start: Instant; end: Instant }): Promise<PlanChange> {
  const block = await readBlock(w, blockId);
  return change(w, 'time_block', blockId, block.practice_id ? { ...times, edited: true } : times);
}

/** Takes a block off the week; its task keeps the time to place again. */
export function removeBlock(w: Writer, blockId: string): Promise<PlanChange> {
  return change(w, 'time_block', blockId, { cancelled: true });
}

/**
 * Puts a task on the calendar. A block longer than the time left raises the estimate. The reverse deletes the new
 * block, whose id is the reverse's first write.
 */
export async function placeBlock(w: Writer, taskId: string, times: { start: Instant; end: Instant }, clock: Clock): Promise<PlanChange> {
  const task = await getRecord(w.sql, 'task', taskId);
  const ahead = task?.estimate_min != null ? await futureBlocks(w.sql, { task_id: taskId, now: nowInstant(clock) }) : [];
  const id = await w.create('time_block', { task_id: taskId, ...times, tz: clock.zone() });
  const reverse: RecordWrite[] = [{ type: 'time_block', id, fields: { deleted_at: nowInstant(clock) } }];
  if (task?.estimate_min != null) {
    const over = blockMinutes(times) - (minutesLeft(task) - ahead.reduce((sum, b) => sum + blockMinutes(b), 0));
    const raise = { estimate_min: task.estimate_min + over, ...(task.remaining_min != null ? { remaining_min: task.remaining_min + over } : {}) };
    if (over > 0) reverse.push(...(await change(w, 'task', taskId, raise)).writes);
  }
  return { writes: reverse };
}

/**
 * Puts the week's practice sessions on it, each practice once a week: at a preferred time if open, otherwise the
 * first open time that day, around what's already there. A practice skipped this week gives up its sessions still to
 * come. redo re-places one practice's sessions not changed by hand, after its usual time changes or it's included
 * again. Returns the reverse, for Undo.
 */
export async function placeWeekPractices(w: Writer, week: LocalDate, clock: Clock, redo?: string): Promise<PlanChange> {
  const zone = clock.zone();
  const range = weekRange(week, zone);
  const now = nowInstant(clock);
  const skipped = (await getRecord(w.sql, 'week_plan', weekPlanId(week)))?.skipped_practices ?? [];
  // Removed sessions count as placed, so a practice taken off a day stays off.
  const sessions = await weekPractices(w.sql, range);
  const ahead = (b: TimeBlock) => instantMs(b.start) > clock.now() && !b.started_at && !b.cancelled;
  const drop = sessions.filter((b) => ahead(b) && (skipped.includes(b.practice_id!) || (b.practice_id === redo && !b.edited)));
  const kept = sessions.filter((b) => !drop.includes(b));
  const todo = (await listRecords(w.sql, 'practice')).filter((p) => !skipped.includes(p.id) && (p.id === redo || !kept.some((b) => b.practice_id === p.id)));

  const settings = await getSettings(w.sql);
  const ctx = slotContext({
    week,
    availability: settings.availability,
    avoided: settings.avoided_slots,
    sources: await listRecords(w.sql, 'calendar_source'),
    calendar: (await getRecord(w.sql, 'calendar', CALENDAR_ID)) ?? null,
    blocks: (await blocksInRange(w.sql, range)).filter((b) => !drop.some((d) => d.id === b.id)),
    clock,
  });
  // Newest first, since a session dropped here can come back on the same record below.
  const reverse: RecordWrite[] = [];
  for (const b of drop) reverse.unshift(...(await change(w, 'time_block', b.id, { deleted_at: now })).writes);
  const edited = kept.map((b) => ({ practice_id: b.practice_id!, date: localDate(b.start, zone) }));
  for (const s of placePractices(todo, ctx, { edited })) {
    const dayId = practiceSessionId(s.practice_id, s.date);
    const fields = { practice_id: s.practice_id, ...slotInstants(s, zone), tz: zone };
    const existing = await getRecord(w.sql, 'time_block', dayId);
    if (existing?.deleted_at) {
      reverse.unshift({ type: 'time_block', id: dayId, fields: await w.set('time_block', dayId, { ...fields, edited: false, deleted_at: null }) });
    } else {
      // A live record under this day's id is a session moved to another day, which stays put, so this one gets its own id.
      // shortcut: two offline devices re-placing after the same move each add a session here; merge by practice and day if that shows up.
      const id = await w.create('time_block', fields, existing ? undefined : dayId);
      reverse.unshift({ type: 'time_block', id, fields: { deleted_at: now } });
    }
  }
  return { writes: reverse };
}

/**
 * "Yes, every week" after moving or resizing a practice session: its start becomes the preferred time, and its target
 * follows the new length, scaled for a weekly target. wasMin is the session's length before the change.
 */
export async function keepPracticeChange(w: Writer, blockId: string, wasMin: Minutes, clock: Clock): Promise<PlanChange> {
  const block = await readBlock(w, blockId);
  const practice = block.practice_id ? await getRecord(w.sql, 'practice', block.practice_id) : undefined;
  if (!practice) throw new Error(`Block ${blockId} is not a practice session`);
  const length = blockMinutes(block);
  const target = practice.per === 'day' ? length : Math.max(5, Math.round((practice.target_min * length) / (wasMin || length)));
  return change(w, 'practice', practice.id, { preferred_times: [localMinutes(block.start, clock.zone())], target_min: target });
}
