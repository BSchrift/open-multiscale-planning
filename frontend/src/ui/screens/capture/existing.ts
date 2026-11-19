// The tasks you have that a time drafted on a calendar can take instead of a new one, for Capture's search. First this
// week's To schedule, the same work Week's card lists: the ones that fit the free time from the draft, soonest due
// first and then in To schedule's own order, then the longer ones, least over first, and last a practice that already
// has its session that day, which can't go there. Then, once something is typed, every other open task in a project,
// One offs or the Inbox, under where it lives. A task with time left gets a new block; one whose time is all placed
// has its next block moved. Goal backlogs, planning tasks and notes aren't searched. Pure, from Week's data.

import { isBacklog } from '../../../core/backlog';
import { formatMinutes, formatTimeOfDay, weekday } from '../../../core/dates';
import { FIRST_BLOCK_MIN, minutesLeft, NO_ESTIMATE_MIN } from '../../../core/plan';
import type { Slot } from '../../../core/slots';
import type { LocalDate, Minutes, Task } from '../../../core/types';
import { KIND_WORD } from '../../components/blocks/describe';
import type { BlockKind } from '../../components/blocks/describe';
import { DAY_NAMES } from '../../components/editors/PracticeSchedule';
import type { PlacedBlock } from '../../components/weekgrid';
import type { Placeable, WeekData, WeekModel } from '../week/data';
import type { FoundTask } from '.';

/** A task the time can take, with its block's length: placed there as a new block, or its next block moved there. */
export type Found = FoundTask & { group: string; length: Minutes } & ({ item: Placeable } | { block: PlacedBlock });

export interface Findable {
  /** Minutes free from the draft's start to the next block that day, or to the day's end. */
  free: Minutes;
  todo: Found[];
  other: Found[];
}

export const TO_SCHEDULE = 'To schedule';
const PLACES = ['Inbox', 'One offs'];

/** Free minutes from a time's start to the next block that day, or to `to`, the day's end. */
export function freeFrom(slot: Slot, blocks: readonly PlacedBlock[], to: Minutes): Minutes {
  const next = blocks.filter((b) => b.date === slot.date && b.end > slot.start).reduce((m, b) => Math.min(m, Math.max(b.start, slot.start)), to);
  return Math.max(0, next - slot.start);
}

const dayTime = (date: LocalDate, start: Minutes, from: LocalDate) => `${date === from ? '' : `${DAY_NAMES[weekday(date)]} `}${formatTimeOfDay(start)}`;

export function findable(data: WeekData, model: WeekModel, slot: Slot, to: Minutes): Findable {
  const free = freeFrom(slot, model.blocks, to);
  const fit = (length: Minutes) => (length > free ? { tag: `Longer by ${formatMinutes(length - free)}`, quiet: true } : { tag: 'Fits' });

  // shortcut: free time counts only this app's blocks, not other calendars' events; add them if a fit misleads.
  const todo = model.unscheduled
    .filter((x) => x.kind !== 'planning')
    .map((x, order) => {
      const had = x.practice && model.blocks.find((b) => b.practice_id === x.practice!.id && b.date === slot.date);
      // A set day's session waiting for another day says which, since it's moved here for this week only.
      const line = x.practice && x.dates && x.dates.from !== slot.date ? `${DAY_NAMES[weekday(x.dates.from)]}'s session · ${x.line}` : x.line;
      const found: Found = {
        key: x.id,
        title: x.title,
        kind: x.kind,
        meta: `${KIND_WORD[x.kind]} · ${line}`,
        ...(had ? { off: `Already on ${DAY_NAMES[weekday(slot.date)]}, ${formatTimeOfDay(had.start)}` } : fit(x.length)),
        group: TO_SCHEDULE,
        length: x.length,
        item: x,
      };
      return { found, order, due: x.dates?.from ?? '~', rank: had ? 2 : x.length > free ? 1 : 0 };
    })
    .sort((a, b) => a.rank - b.rank || (a.rank === 1 ? a.found.length - b.found.length : before(a.due, b.due)) || a.order - b.order)
    .map((x) => x.found);

  const listed = new Set(todo.map((x) => x.key));
  const projects = new Map(data.records.projects.filter((p) => p.state === 'active' && !isBacklog(p)).map((p) => [p.id, p.title]));
  const where = (t: Task) => (t.kind === 'inbox' ? 'Inbox' : t.kind === 'one_off' ? 'One offs' : t.kind === 'project' ? projects.get(t.project_id ?? '') : undefined);
  const other = data.records.tasks
    .filter((t) => !t.done_at && !t.cancelled_at && !listed.has(t.id))
    .flatMap((t): Found[] => {
      const group = where(t);
      if (!group) return [];
      const kind: BlockKind = t.kind;
      // Its blocks still to come this week, soonest first: the time already placed.
      const ahead = model.blocks.filter((b) => b.task_id === t.id && !b.past).sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
      const estimated = t.estimate_min != null || t.remaining_min != null;
      const left = Math.max(0, minutesLeft(t) - ahead.reduce((sum, b) => sum + b.end - b.start, 0));
      const next = ahead[0];
      if (estimated && left === 0 && next) {
        const length = next.end - next.start;
        return [{ key: `move:${next.id}`, title: t.title, kind, meta: `${KIND_WORD[kind]} · ${formatMinutes(length)}, all placed`, tag: `Moves from ${dayTime(next.date, next.start, slot.date)}`, quiet: true, group, length, block: next }];
      }
      const length = Math.min(estimated && left ? left : NO_ESTIMATE_MIN, FIRST_BLOCK_MIN);
      const meta = estimated ? formatMinutes(left || NO_ESTIMATE_MIN) : `No estimate, so ${formatMinutes(NO_ESTIMATE_MIN)}`;
      const item: Placeable = { id: t.id, title: t.title, kind: t.kind === 'one_off' ? 'one_off' : 'project', work: { kind: 'project' }, task: t };
      return [{ key: t.id, title: t.title, kind, meta: `${KIND_WORD[kind]} · ${meta}`, ...fit(length), group, length, item }];
    })
    .sort((a, b) => place(a.group) - place(b.group) || a.group.localeCompare(b.group) || a.title.localeCompare(b.title));
  return { free, todo, other };
}

/** Earlier days first, and no day ('~') after every day: by code point, where localeCompare puts '~' first. */
const before = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Inbox, then One offs, then projects by name. */
const place = (group: string) => (PLACES.includes(group) ? PLACES.indexOf(group) : PLACES.length);

/**
 * What matches the letters typed, in Capture's groups: To schedule by title, then the other tasks, by title or where
 * they live, only once something is typed.
 */
export function search(f: Findable, typed: string): { label: string; tasks: Found[] }[] {
  const q = typed.trim().toLowerCase();
  const has = (text: string) => text.toLowerCase().includes(q);
  const groups: { label: string; tasks: Found[] }[] = [];
  const todo = f.todo.filter((x) => has(x.title));
  if (todo.length) groups.push({ label: f.free ? `${TO_SCHEDULE} · ${formatMinutes(f.free)} free here` : TO_SCHEDULE, tasks: todo });
  if (!q) return groups;
  for (const x of f.other.filter((o) => has(o.title) || has(o.group))) {
    const last = groups[groups.length - 1];
    if (last && last.label === x.group) last.tasks.push(x);
    else groups.push({ label: x.group, tasks: [x] });
  }
  return groups;
}
