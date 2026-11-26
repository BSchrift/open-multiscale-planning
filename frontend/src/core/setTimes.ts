// Practices and one offs at their set times. A practice on set days with a time lands at that time on each of its days by
// itself, from today to the end of this week, and next week from when its planning appears, whenever that time, or one
// of the practice's other listed times, is free. So does a one off with a time of day, on its one date or a repeating
// one's next. Everything else still waits to be placed: a practice at any time, a counted one, a one off with a range
// or a window, and a day whose times are all taken, which waits in To schedule saying why.
//
// Each session is an ordinary block under the day's id (practiceSessionId, or dueBlockId for a one off), written as an
// automatic write, and only where no record has that id, deleted or not, and no block of it is on or for that day. So two devices make
// one session, any explicit write from any device wins over it, and a session taken off or deleted is never made again.
// Its start and end come only from the practice, the day, the zone and which listed time is free, so two devices that
// both place it write the same record, and where they saw different calendars one device's values win every field.
//
// The explicit changes that follow from a practice's schedule are here too: a new or edited practice placed, pausing and
// resuming, and away dates. Each returns its exact reverse for Undo, with what it did to say in its toast.
//
// Its own module, loaded after the app has drawn (ui/app/setTimes.ts) or with the screens that change practices, so it
// adds nothing to the first load.

import { keepPracticeChange } from './blocks';
import type { PracticeKeep } from './blocks';
import type { Clock } from './clock';
import { addDays, addWeeks, blockMinutes, dayRange, formatDate, formatMinutes, formatTimeOfDay, formatWeekday, instantMs, localDate, localMinutes, nowInstant, thisWeek, today, weekday, weekRange, weekStart } from './dates';
import type { Sql } from './db';
import { applyPlanChange, minutesLeft, NO_ESTIMATE_MIN } from './plan';
import type { PlanChange, RecordWrite } from './plan';
import { PLANNING_LEAD_DAYS } from './planning';
import { blocksInRange, weekPractices } from './queries';
import type { BlockRow } from './queries';
import { CALENDAR_ID, getRecord, getSettings, listRecords, practiceSessionId, sessionDay, weekPlanId } from './records';
import type { Writer } from './records';
import { existingTime, fits, practiceDays, practiceTime, sessionLength, skippedSessionKey, slotContext, slotInstants, takenBy, whyNot } from './slots';
import type { SlotContext, Span } from './slots';
import type { LocalDate, Minutes, Practice, Task, TimeOfDay } from './types';

/** The days set times fill in by themselves: today to the end of this week, and next week once its planning appears. */
export function setTimesDays(clock: Clock): LocalDate[] {
  const on = today(clock);
  const next = addWeeks(thisWeek(clock), 1);
  const last = on >= addDays(next, -PLANNING_LEAD_DAYS) ? addDays(next, 6) : addDays(next, -1);
  const days: LocalDate[] = [];
  for (let d = on; d <= last; d = addDays(d, 1)) days.push(d);
  return days;
}

/** The time a practice is set to on a day: on one of a daily practice's days with a time, else null. */
export function setTime(p: Practice, date: LocalDate): TimeOfDay | null {
  if (p.per !== 'day' || !practiceDays(p).includes(weekday(date))) return null;
  return practiceTime(p, weekday(date));
}

/** The day's set time, then the practice's other listed times, as times that exist that day. */
function listedTimes(p: Practice, date: LocalDate, zone: string | undefined): TimeOfDay[] {
  const own = setTime(p, date);
  if (own === null) return [];
  return [...new Set([own, ...(p.preferred_times ?? []).slice(1)].map((t) => existingTime(date, t, zone)))];
}

/** Why a set time can't be used: 'is taken', with what takes it, 'has passed' or 'is outside your available hours'. */
export interface SetTimeWhy {
  time: TimeOfDay;
  why: ReturnType<typeof whyNot>;
  by?: string;
}

/**
 * Where a practice's session goes at its set time on a day: the day's time, or else the first of its other listed times
 * that's free. When none is, why the day's time isn't. Null on a day with no set time.
 */
export function setTimeFit(p: Practice, date: LocalDate, ctx: SlotContext): { start: TimeOfDay } | SetTimeWhy | null {
  const times = listedTimes(p, date, ctx.zone);
  if (!times.length) return null;
  const length = sessionLength(p);
  const start = times.find((t) => fits(date, t, length, 'project', ctx));
  if (start !== undefined) return { start };
  const time = times[0]!;
  const why = whyNot(date, time, length, ctx);
  const by = why === 'is taken' ? takenBy(date, time, time + length, ctx) : undefined;
  return { time, why, ...(by ? { by } : {}) };
}

/** "7am is taken by Dentist", or without what takes it, "7am is taken". */
export const whySaid = (w: SetTimeWhy, by = true) => `${formatTimeOfDay(w.time)} ${w.why}${by && w.by ? ` by ${w.by}` : ''}`;

/** Whether a session sits at one of its practice's set times on the day it's for, at the practice's length. */
export function atSetTime(p: Practice, b: { id: string; start: string; end: string }, zone: string): boolean {
  const day = sessionDay(b.id, p.id) ?? localDate(b.start, zone);
  return localDate(b.start, zone) === day && listedTimes(p, day, zone).includes(localMinutes(b.start, zone)) && blockMinutes(b) === sessionLength(p);
}

const isLive = (p: Practice) => p.state === 'active' && !p.deleted_at && p.target_min > 0;
const isTime = (t: unknown): t is TimeOfDay => Number.isInteger(t) && (t as number) >= 0 && (t as number) < 1440;

/** A one off's block for the day it's due, so two devices placing it make one, as a practice's session does. */
export const dueBlockId = (taskId: string, date: LocalDate) => `due:${taskId}:${date}`;

/**
 * The day and time a one off is set to: its one date, or a repeating one's next, with its time of day. Null for one
 * that's finished, has no time, or has a range, a window or months rather than a day.
 */
export function oneOffSetTime(t: Task): { date: LocalDate; time: TimeOfDay } | null {
  const s = t.schedule;
  if (t.kind !== 'one_off' || t.deleted_at || t.done_at || t.cancelled_at || !isTime(t.time) || !s) return null;
  if (s.type === 'once') return s.from && (!s.to || s.to === s.from) ? { date: s.from, time: t.time } : null;
  return (s.type === 'recurring' || s.type === 'float' || s.type === 'rule') && t.next_due ? { date: t.next_due, time: t.time } : null;
}

/** Why a one off can't land at its time on its day, or null when it can or has no time that day. */
export function oneOffWhy(t: Task, date: LocalDate, ctx: SlotContext): SetTimeWhy | null {
  const set = oneOffSetTime(t);
  if (!set || set.date !== date) return null;
  const time = existingTime(date, set.time, ctx.zone);
  const length = oneOffLength(t);
  if (fits(date, time, length, 'one_off', ctx)) return null;
  const why = whyNot(date, time, length, ctx);
  const by = why === 'is taken' ? takenBy(date, time, time + length, ctx) : undefined;
  return { time, why, ...(by ? { by } : {}) };
}

/** A one off's block: its time left, or half an hour with no estimate. */
const oneOffLength = (t: Task) => Math.max(15, minutesLeft(t) || NO_ESTIMATE_MIN);

/** Open one offs with a time of day, by the index on their kind rather than every task. */
const TIMED_ONE_OFFS = `
  SELECT id, data FROM records
  WHERE type = 'task' AND json_extract(data, '$.kind') = 'one_off' AND json_extract(data, '$.time') IS NOT NULL
    AND json_extract(data, '$.done_at') IS NULL AND json_extract(data, '$.deleted_at') IS NULL`;

/** A task's blocks in a range, taken off ones too: a day that has had one is never filled in again. */
const TASK_BLOCKS = `
  SELECT start FROM time_block WHERE task_id = :task AND start >= :from_utc AND start < :to_utc AND deleted_at IS NULL`;
const weeksOf = (days: readonly LocalDate[]) => [...new Set(days.map(weekStart))];

/** A week's free time as slots.ts sees it, with its blocks, the same context Week and planning work from. */
async function weekContext(sql: Sql, week: LocalDate, clock: Clock): Promise<{ ctx: SlotContext; blocks: BlockRow[] }> {
  const [settings, sources, calendar, blocks, away] = await Promise.all([
    getSettings(sql),
    listRecords(sql, 'calendar_source'),
    getRecord(sql, 'calendar', CALENDAR_ID),
    blocksInRange(sql, weekRange(week, clock.zone())),
    listRecords(sql, 'away_period'),
  ]);
  const ctx = slotContext({ week, availability: settings.availability, avoided: settings.avoided_slots, sources, calendar: calendar ?? null, blocks, clock, away });
  return { ctx, blocks };
}

const sessionSpan = (p: Practice, id: string, date: LocalDate, start: TimeOfDay): Span => ({
  id,
  date,
  start,
  end: start + sessionLength(p),
  title: p.title,
  kind: 'practice',
  practice_id: p.id,
  for: date,
});

export interface PlacedSession {
  id: string;
  /** A practice's session, or a one off's block. */
  practice_id?: string;
  task_id?: string;
  title: string;
  date: LocalDate;
  start: TimeOfDay;
}

/** What placing did, with the writes that take it off again. */
export interface SetTimesChange extends PlanChange {
  placed: PlacedSession[];
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Places each set-time session missing from the days setTimesDays gives, at its set time where that's free, then each
 * one off with a time of day. Pass w.automatic when the app does it on its own. With `only`, places just that practice
 * or one off, as it is given, for a change the person made. The reverse takes each off, so it waits in To schedule and
 * is never placed again.
 */
export async function placeSetTimes(w: Writer, clock: Clock, only?: Practice | Task): Promise<SetTimesChange> {
  const zone = clock.zone();
  const days = setTimesDays(clock);
  const task = only && 'kind' in only ? only : null;
  // The practice made first gets the slot: ids are made in time order. One offs come after the practices.
  const practices = (task ? [] : only ? [only as Practice] : await listRecords(w.sql, 'practice'))
    .filter((p) => isLive(p) && days.some((d) => setTime(p, d) !== null))
    .sort(byId);
  const oneOffs = (task ? [task] : only ? [] : (await w.sql.all<{ id: string; data: string }>(TIMED_ONE_OFFS)).map((r) => ({ ...(JSON.parse(r.data) as Task), id: r.id })))
    .flatMap((t) => {
      const set = oneOffSetTime(t);
      return set && days.includes(set.date) ? [{ task: t, ...set, id: dueBlockId(t.id, set.date) }] : [];
    })
    .sort((a, b) => byId(a.task, b.task));
  if (!practices.length && !oneOffs.length) return { writes: [], placed: [] };
  // Any record under a day's id, deleted ones too, a practice at a time so the list stays short.
  const existing = new Set<string>();
  for (const p of practices) {
    const ids = days.map((d) => practiceSessionId(p.id, d));
    const rows = await w.sql.all<{ id: string }>(`SELECT id FROM records WHERE id IN (${ids.map((_, i) => `:id${i}`).join(', ')})`, Object.fromEntries(ids.map((id, i) => [`id${i}`, id])));
    for (const r of rows) existing.add(r.id);
  }
  for (const o of oneOffs) if (await w.sql.get('SELECT 1 AS found FROM records WHERE id = :id', { id: o.id })) existing.add(o.id);
  const placed: PlacedSession[] = [];
  for (const week of weeksOf(days)) {
    let { ctx } = await weekContext(w.sql, week, clock);
    const plan = await getRecord(w.sql, 'week_plan', weekPlanId(week));
    // Sessions taken off count too: the day has had its session.
    const sessions = await weekPractices(w.sql, weekRange(week, zone));
    for (const p of practices) {
      if (plan?.skipped_practices?.includes(p.id)) continue;
      const had = new Set(sessions.filter((s) => s.practice_id === p.id).flatMap((s) => [sessionDay(s.id, p.id) ?? localDate(s.start, zone), localDate(s.start, zone)]));
      for (const date of days.filter((d) => weekStart(d) === week)) {
        const id = practiceSessionId(p.id, date);
        if (existing.has(id) || had.has(date) || ctx.away?.includes(date) || plan?.skipped_sessions?.includes(skippedSessionKey(p.id, date))) continue;
        const fit = setTimeFit(p, date, ctx);
        if (!fit || !('start' in fit)) continue;
        const span = sessionSpan(p, id, date, fit.start);
        await w.create('time_block', { practice_id: p.id, ...slotInstants(span, zone), tz: zone }, id);
        ctx = { ...ctx, placed: [...ctx.placed, span] };
        placed.push({ id, practice_id: p.id, title: p.title, date, start: fit.start });
      }
    }
    // A one off at its time on its day, where that's free and the day has had no block of it.
    const range = weekRange(week, zone);
    for (const o of oneOffs.filter((x) => weekStart(x.date) === week)) {
      const had = (await w.sql.all<{ start: string }>(TASK_BLOCKS, { task: o.task.id, ...range })).some((b) => localDate(b.start, zone) === o.date);
      const start = existingTime(o.date, o.time, zone);
      const length = oneOffLength(o.task);
      if (existing.has(o.id) || had || !fits(o.date, start, length, 'one_off', ctx)) continue;
      const span: Span = { id: o.id, date: o.date, start, end: start + length, title: o.task.title, kind: 'one_off' };
      await w.create('time_block', { task_id: o.task.id, ...slotInstants(span, zone), tz: zone }, o.id);
      ctx = { ...ctx, placed: [...ctx.placed, span] };
      placed.push({ id: o.id, task_id: o.task.id, title: o.task.title, date: o.date, start });
    }
  }
  return { writes: placed.map((s): RecordWrite => ({ type: 'time_block', id: s.id, fields: { cancelled: true } })).reverse(), placed };
}

const sessions = (n: number) => `${n} ${n === 1 ? 'session' : 'sessions'}`;

/**
 * "Placed 7 practice sessions at their set times next week.", or with one offs, "Placed 7 blocks at their set times next
 * week.", or for one, "Placed Morning run at its set time, Thu 7am."
 */
export function placedMessage(placed: readonly PlacedSession[], clock: Clock): string {
  if (placed.length === 1) return `Placed ${placed[0]!.title} at its set time, ${formatWeekday(placed[0]!.date)} ${formatTimeOfDay(placed[0]!.start)}.`;
  const current = thisWeek(clock);
  const thisOne = placed.some((s) => weekStart(s.date) === current);
  const next = placed.some((s) => weekStart(s.date) !== current);
  const when = thisOne && next ? 'this week and next' : next ? 'next week' : 'this week';
  return `Placed ${placed.length} ${placed.every((s) => s.practice_id) ? 'practice sessions' : 'blocks'} at their set times ${when}.`;
}

/** What following an edited schedule did, with its exact reverse. */
export interface FollowChange extends PlanChange {
  /** Sessions moved to the new set time, and the times they moved to. */
  moved: number;
  to: TimeOfDay[];
  /** Sessions kept at their time with the new length, and that length. */
  resized?: number;
  length?: Minutes;
  /** Sessions whose new time is taken, now waiting in To schedule. */
  waiting: number;
  /** Sessions on days the practice no longer has. */
  dropped: number;
  placed: PlacedSession[];
}

/**
 * After a practice's set days, time or length change: each session still to come that sits at the old set time and
 * hasn't started moves to the new one if that's free, and otherwise comes off to wait in To schedule. Sessions on days it
 * no longer has come off. Sessions moved by hand stay where they are, as do all of them when it's no longer set to a
 * time. Then its new days are placed. Write the practice's new fields first, in the same transaction.
 */
export async function followSetTimes(w: Writer, before: Practice, after: Practice, clock: Clock): Promise<FollowChange> {
  const zone = clock.zone();
  const days = setTimesDays(clock);
  const reverse: RecordWrite[] = [];
  const result = { moved: 0, resized: 0, length: sessionLength(after), waiting: 0, dropped: 0, to: [] as TimeOfDay[] };
  const set = async (id: string, fields: Record<string, unknown>) => reverse.unshift({ type: 'time_block', id, fields: await w.set('time_block', id, fields) });
  if (isLive(after)) {
    for (const week of weeksOf(days)) {
      let { ctx, blocks } = await weekContext(w.sql, week, clock);
      for (const b of blocks) {
        if (b.practice_id !== before.id || b.started_at || b.ended_at || b.result || instantMs(b.start) <= clock.now() || !atSetTime(before, b, zone)) continue;
        const day = sessionDay(b.id, before.id) ?? localDate(b.start, zone);
        const others = { ...ctx, placed: ctx.placed.filter((x) => x.id !== b.id) };
        const fit = setTimeFit(after, day, others);
        if (!fit) {
          // A day dropped from its days comes off; a practice no longer set to a time keeps what's placed.
          if (after.per === 'day' && !practiceDays(after).includes(weekday(day))) {
            await set(b.id, { cancelled: true });
            result.dropped++;
            ctx = others;
          }
          continue;
        }
        if (!('start' in fit)) {
          await set(b.id, { cancelled: true });
          result.waiting++;
          ctx = others;
          continue;
        }
        const span = sessionSpan(after, b.id, day, fit.start);
        const times = slotInstants(span, zone);
        if (times.start === b.start && times.end === b.end) continue;
        await set(b.id, times);
        if (times.start === b.start) result.resized++;
        else {
          result.moved++;
          if (!result.to.includes(fit.start)) result.to.push(fit.start);
        }
        ctx = { ...others, placed: [...others.placed, span] };
      }
    }
  }
  const placed = await placeSetTimes(w, clock, after);
  return { writes: [...placed.writes, ...reverse], ...result, placed: placed.placed };
}

/**
 * "Yes" to a moved session's question, "Use this time in future weeks too?", which edits the practice as its editor would:
 * its other sessions still to come at the old set time follow. Returns the exact reverse, with what they did.
 */
export async function keepSetTime(w: Writer, blockId: string, keep: PracticeKeep, clock: Clock): Promise<FollowChange> {
  const block = await getRecord(w.sql, 'time_block', blockId);
  const before = block?.practice_id ? await getRecord(w.sql, 'practice', block.practice_id) : undefined;
  const kept = await keepPracticeChange(w, blockId, keep, clock);
  const after = before && (await getRecord(w.sql, 'practice', before.id));
  if (!before || !after) return { ...kept, moved: 0, to: [], waiting: 0, dropped: 0, placed: [] };
  const follow = await followSetTimes(w, before, after, clock);
  return { ...follow, writes: [...follow.writes, ...kept.writes] };
}

/** What a schedule's sessions did, for its toast: "Moved 3 sessions to 7:30am. 1 waits in To schedule." */
export function followMessage(r: Omit<FollowChange, 'writes'>): string {
  const said: string[] = [];
  if (r.moved) said.push(`Moved ${sessions(r.moved)} to ${r.to.length === 1 ? formatTimeOfDay(r.to[0]!) : 'their new times'}.`);
  if (r.resized) said.push(`${r.resized === 1 ? 'Made 1 session' : `Made ${r.resized} sessions`} ${formatMinutes(r.length!)}.`);
  if (r.placed.length) said.push(`Placed ${sessions(r.placed.length)} at ${r.placed.length === 1 ? 'its set time' : 'their set times'}.`);
  if (r.dropped) said.push(`Took ${sessions(r.dropped)} off the calendar.`);
  if (r.waiting) said.push(`${r.waiting} ${r.waiting === 1 ? 'waits' : 'wait'} in To schedule.`);
  return said.join(' ');
}

/**
 * After a one off's dates, time or estimate change: its block still to come at the old time on the old day moves to the
 * new time if that's free on the same day, and otherwise comes off to wait in To schedule, as it does on a new day,
 * where it's then placed. Cleared, its time leaves what's placed alone. Write the task's new fields first, in the same
 * transaction. Returns the exact reverse, with what to say: 'Moved Renew passport to Wed 10am.', or ''.
 */
export async function followOneOff(w: Writer, before: Task, after: Task, clock: Clock): Promise<PlanChange & { said: string }> {
  const zone = clock.zone();
  const was = oneOffSetTime(before);
  const now = oneOffSetTime(after);
  const reverse: RecordWrite[] = [];
  const said: string[] = [];
  const b = was && (await getRecord(w.sql, 'time_block', dueBlockId(before.id, was.date)));
  const sits =
    !!b && !!was && !b.deleted_at && !b.cancelled && !b.started_at && instantMs(b.start) > clock.now() && localDate(b.start, zone) === was.date && localMinutes(b.start, zone) === existingTime(was.date, was.time, zone);
  const cleared = !isTime(after.time);
  if (b && sits && !cleared) {
    const set = async (fields: Record<string, unknown>) => reverse.unshift({ type: 'time_block', id: b.id, fields: await w.set('time_block', b.id, fields) });
    const { ctx } = await weekContext(w.sql, weekStart(was!.date), clock);
    const others = { ...ctx, placed: ctx.placed.filter((x) => x.id !== b.id) };
    const start = now && existingTime(now.date, now.time, zone);
    const length = oneOffLength(after);
    if (now && start !== null && now.date === was!.date && fits(now.date, start, length, 'one_off', others)) {
      const times = slotInstants({ date: now.date, start, end: start + length }, zone);
      if (times.start !== b.start || times.end !== b.end) {
        await set(times);
        said.push(`Moved ${after.title} to ${formatWeekday(now.date)} ${formatTimeOfDay(start)}.`);
      }
    } else {
      await set({ cancelled: true });
      if (!now || now.date === was!.date) said.push(`Took ${after.title} off ${formatWeekday(was!.date)} ${formatTimeOfDay(was!.time)}. It's in To schedule.`);
    }
  }
  const placed = await placeSetTimes(w, clock, after);
  if (placed.placed.length) said.push(placedMessage(placed.placed, clock));
  return { writes: [...placed.writes, ...reverse], said: said.join(' ') };
}

/** Each session of a practice still to come and not started, taken off or not. */
const SESSIONS_AHEAD = `
  SELECT id, start, end, cancelled FROM time_block
  WHERE practice_id = :id AND start > :now AND started_at IS NULL AND deleted_at IS NULL`;

/**
 * Pauses a practice: nothing is placed while it's paused, and its sessions still to come come off, as End does. The
 * pause is written first, so Resume can tell what it took off from what was off before. Returns the exact reverse.
 */
export async function pausePractice(w: Writer, practiceId: string, clock: Clock): Promise<PlanChange & { off: number }> {
  const state = await applyPlanChange(w, { writes: [{ type: 'practice', id: practiceId, fields: { state: 'paused' } }] });
  const ahead = (await w.sql.all<{ id: string; cancelled: number | null }>(SESSIONS_AHEAD, { id: practiceId, now: nowInstant(clock) })).filter((b) => !b.cancelled);
  const off = await applyPlanChange(w, { writes: ahead.map((b): RecordWrite => ({ type: 'time_block', id: b.id, fields: { cancelled: true } })) });
  return { writes: [...off.writes, ...state.writes], off: ahead.length };
}

/**
 * Resumes a paused practice: what the pause took off and is still ahead goes back where its time is free, and its set
 * days with no session are placed. A session taken off before the pause stays off. The practice is set active last, so
 * an Undo pauses it first and a later Resume puts these back again. Returns the exact reverse, with how many came back.
 */
export async function resumePractice(w: Writer, practiceId: string, clock: Clock): Promise<PlanChange & { back: number }> {
  const zone = clock.zone();
  const practice = await getRecord(w.sql, 'practice', practiceId);
  if (!practice) return { writes: [], back: 0 };
  const pausedAt = (await w.sql.get<{ clock: string | null }>("SELECT json_extract(clocks, '$.state') AS clock FROM records WHERE id = :id", { id: practiceId }))?.clock ?? '';
  const ahead = (await w.sql.all<{ id: string; start: string; end: string; cancelled: number | null }>(SESSIONS_AHEAD, { id: practiceId, now: nowInstant(clock) })).filter(
    (b) => b.cancelled,
  );
  const clocks = new Map(
    (
      await w.sql.all<{ id: string; clock: string | null }>(
        `SELECT id, json_extract(clocks, '$.cancelled') AS clock FROM records WHERE id IN (${ahead.map((_, i) => `:id${i}`).join(', ') || "''"})`,
        Object.fromEntries(ahead.map((b, i) => [`id${i}`, b.id])),
      )
    ).map((r) => [r.id, r.clock ?? '']),
  );
  const live = { ...practice, state: 'active' as const };
  const reverse: RecordWrite[] = [];
  const contexts = new Map<LocalDate, SlotContext>();
  for (const b of ahead.filter((x) => (clocks.get(x.id) ?? '') >= pausedAt)) {
    const date = localDate(b.start, zone);
    const week = weekStart(date);
    const ctx = contexts.get(week) ?? (await weekContext(w.sql, week, clock)).ctx;
    const start = localMinutes(b.start, zone);
    if (!fits(date, start, blockMinutes(b), 'project', ctx)) {
      contexts.set(week, ctx);
      continue;
    }
    reverse.unshift({ type: 'time_block', id: b.id, fields: await w.set('time_block', b.id, { cancelled: false }) });
    contexts.set(week, { ...ctx, placed: [...ctx.placed, { ...sessionSpan(live, b.id, date, start), end: start + blockMinutes(b) }] });
  }
  const placed = await placeSetTimes(w, clock, live);
  const state = await applyPlanChange(w, { writes: [{ type: 'practice', id: practiceId, fields: { state: 'active' } }] });
  return { writes: [...state.writes, ...placed.writes, ...reverse], back: reverse.length + placed.placed.length };
}

/** "Paused Morning run. Took 4 sessions off the calendar." */
export const pausedMessage = (title: string, off: number) => `Paused ${title}.${off ? ` Took ${sessions(off)} off the calendar.` : ''}`;
/** "Resumed Morning run. 3 sessions are back on the calendar." */
export const resumedMessage = (title: string, back: number) =>
  `Resumed ${title}.${back ? ` ${sessions(back)} ${back === 1 ? 'is' : 'are'} back on the calendar.` : ''}`;

/**
 * Adds away dates, from start to end, and takes every practice's sessions still to come on them off the calendar, since
 * nothing is placed on a day away and nothing asks. Returns the exact reverse, with how many sessions came off.
 */
export async function addAwayDates(w: Writer, start: LocalDate, end: LocalDate, clock: Clock): Promise<PlanChange & { off: number }> {
  const zone = clock.zone();
  const id = await w.create('away_period', { start, end });
  const day = (b: BlockRow) => (b.practice_id && sessionDay(b.id, b.practice_id)) || localDate(b.start, zone);
  // A day either side, for a session moved off the day it's for.
  const range = { from_utc: dayRange(addDays(start, -1), zone).from_utc, to_utc: dayRange(addDays(end, 1), zone).to_utc };
  const ahead = (await blocksInRange(w.sql, range)).filter(
    (b) => b.practice_id && !b.started_at && !b.ended_at && !b.result && instantMs(b.start) > clock.now() && day(b) >= start && day(b) <= end,
  );
  const off = await applyPlanChange(w, { writes: ahead.map((b): RecordWrite => ({ type: 'time_block', id: b.id, fields: { cancelled: true } })) });
  return { writes: [...off.writes, { type: 'away_period', id, fields: { deleted_at: nowInstant(clock) } }], off: ahead.length };
}

/** "Added away dates Dec 1 to Dec 3. Took 3 practice sessions off the calendar." */
export const awayMessage = (start: LocalDate, end: LocalDate, off: number) =>
  `Added away dates ${formatDate(start)} to ${formatDate(end)}.${off ? ` Took ${off} practice ${off === 1 ? 'session' : 'sessions'} off the calendar.` : ''}`;
