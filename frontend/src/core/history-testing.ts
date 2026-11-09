// A made-up five-year account for the history-scale test (make test-history), and the code that seeds it through the
// sync API. The same records on every run: about 40,000 in a heavy user's weekly mix, about 400 bytes each as sent, a
// fifth of them deleted. The app never imports this file.

import { protocol } from '@multiscale/config';
import { formatClock } from './clock';
import { addDays, localDate, localToMs, toInstant, weekStart } from './dates';
import { occurrenceId, outcomeId, practiceSessionId, SETTINGS_ID, weekPickId, weekPlanId } from './records';
import { addPeriod } from './retention';
import type { Period } from './retention';
import type { BlockResult, LocalDate, RecordChange, RecordMap, RecordType, TaskSchedule, Weekday } from './types';

export const HISTORY = {
  /** When the history ends, a Wednesday noon, and the moment Today and Week are timed at. */
  now: '2026-11-04T18:00:00Z',
  zone: 'America/Chicago',
  weeks: 260,
  /**
   * Every clock's counter. Raise it when the records change, so a reseed's clocks beat those already on a server.
   * Records a new version no longer makes stay there.
   */
  version: 1,
} as const;

const DAY_MS = 86_400_000;
const NOW_MS = Date.parse(HISTORY.now);
/** Captures newer than this are still in the Inbox, and tasks newer than this are still open. */
const RECENT_MS = 14 * DAY_MS;
/** Each record that can be deleted is, with this chance: a fifth of all records once blocks take their answers along. */
const DELETED = 0.189;

/** Deterministic randomness (mulberry32), so every run makes the same records. */
function random(seed: number) {
  let s = seed;
  const next = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!,
  };
}

const VERBS = ['Draft', 'Review', 'Fix', 'Plan', 'Write', 'Call about', 'Book', 'Sort out', 'Finish', 'Outline', 'Research', 'Clean up', 'Order', 'Schedule', 'Test'];
const THINGS = [
  'the quarterly budget',
  'the garden fence',
  'the onboarding guide',
  'the tax return',
  'the kitchen shelves',
  'the conference talk',
  'the client proposal',
  'the bike brakes',
  'the photo archive',
  'the reading list',
  'the team offsite',
  'the insurance claim',
  'the release notes',
  'the newsletter',
  'the spare room',
];
const DETAILS = ['', '', ' for next week', ' before Friday', ' with Sam', ' and send it round', ', second pass', ' notes'];
const GOALS = ['Run a half marathon', 'Ship the side project', 'Learn Spanish', 'Renovate the house', 'Grow the consulting work', 'Read 40 books', 'Get the finances in order'];
const PRACTICES = ['Guitar practice', 'Morning run', 'Spanish lessons', 'Strength training', 'Writing hour', 'Meditation'];
const REPEATS = ['Water the plants', 'Take out the recycling', 'Weekly review', 'Pay the bills', 'Call Mum', 'Back up the laptop', 'Clean the bathroom'];

type DraftOf<T extends RecordType> = { type: T; id: string; at: number; fields: Omit<RecordMap[T], 'id'> };
type Draft = { [T in RecordType]: DraftOf<T> }[RecordType];

function build(): Draft[] {
  const r = random(20211108);
  const { zone } = HISTORY;
  const out: Draft[] = [];
  /** Adds a record last written at `at`, deleted then by chance unless told. Returns it, or null if it's after the end. */
  const add = <T extends RecordType>(type: T, id: string, at: number, fields: Omit<RecordMap[T], 'id'>, deleted?: boolean): DraftOf<T> | null => {
    if (at > NOW_MS) return null;
    const draft: DraftOf<T> = { type, id, at, fields };
    if (deleted ?? r.chance(DELETED)) {
      draft.at = Math.min(NOW_MS, at + r.int(1, 10) * DAY_MS);
      (draft.fields as { deleted_at?: string | null }).deleted_at = toInstant(draft.at);
    }
    out.push(draft as unknown as Draft);
    return draft;
  };
  // Noon's offset holds for the whole working day: daylight saving changes at 2am.
  const noons = new Map<LocalDate, number>();
  const at = (date: LocalDate, minutes: number) => {
    let noon = noons.get(date);
    if (noon === undefined) noons.set(date, (noon = localToMs(date, 720, zone)));
    return noon + (minutes - 720) * 60_000;
  };
  /** A UUID version 7 for a record made at ms, as newId makes them, from this run's randomness. */
  const uuid = (ms: number) => {
    const bytes = Array.from({ length: 16 }, () => r.int(0, 255));
    for (let i = 5, rest = ms; i >= 0; i--, rest = Math.floor(rest / 256)) bytes[i] = rest % 256;
    bytes[6] = 0x70 | (bytes[6]! & 0x0f);
    bytes[8] = 0x80 | (bytes[8]! & 0x3f);
    const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const title = () => `${r.pick(VERBS)} ${r.pick(THINGS)}${r.pick(DETAILS)}`;
  const estimate = () => 15 * r.int(2, 12);

  const first = addDays(weekStart(localDate(NOW_MS, zone)), -7 * (HISTORY.weeks - 1));
  const objectives: string[] = [];
  const practices: { id: string; from: number; until: number }[] = [];
  const projects: { id: string; end: LocalDate; milestones: string[] }[] = [];
  const repeating: DraftOf<'task'>[] = [];
  let order = 0;
  let other = 0;

  for (let w = 0; w < HISTORY.weeks; w++) {
    const week = addDays(first, 7 * w);
    const day = (d: number) => addDays(week, d);
    const sometime = () => at(day(r.int(0, 6)), r.int(8 * 60, 21 * 60));
    const settled = (made: number) => made < NOW_MS - RECENT_MS;

    // Planned on the Sunday before, with this week's aims.
    const planned = at(day(-1), 18 * 60);
    const live = projects.filter((p) => p.end >= week).slice(-4);
    add('week_plan', weekPlanId(week), planned, {
      week_start: week,
      finished_at: toInstant(planned),
      aims: Object.fromEntries([...live.map((p) => [p.id, 60 * r.int(2, 6)]), ['one_offs', 120]]),
    }, false);

    // Goals, time off, practices and calendars, two a week between them.
    for (let j = 0; j < 2; j++, other++) {
      const made = sometime();
      if (other % 26 === 2) {
        const id = uuid(made);
        const ends = made + r.int(26, 80) * 7 * DAY_MS;
        const added = add('practice', id, made, {
          objective_id: objectives.length ? r.pick(objectives) : null,
          title: r.pick(PRACTICES),
          target_min: 30 * r.int(1, 4),
          per: 'week',
          days: [1, 3, 5] as Weekday[],
          state: ends < NOW_MS ? 'ended' : 'active',
        }, false);
        if (added) practices.push({ id, from: made, until: ends });
      } else if (other % 104 === 5) {
        add('calendar_source', `history-calendar-${other}@group.calendar.google.com`, made, { google_id: `history-calendar-${other}@group.calendar.google.com`, name: r.pick(['Family', 'Work', 'Holidays', 'Football club']), mode: r.pick(['block', 'info', 'ignore'] as const) }, false);
      } else if (other % 2 === 0) {
        const id = uuid(made);
        if (add('objective', id, made, { title: r.pick(GOALS), state: settled(made) && r.chance(0.6) ? 'archived' : 'active', order: other })) objectives.push(id);
      } else {
        const start = day(r.int(7, 60));
        add('away_period', uuid(made), made, { start, end: addDays(start, r.int(1, 14)) });
      }
    }

    // A project a week, with six milestones across its weeks.
    const projectMade = at(day(0), 9 * 60);
    const project = { id: uuid(projectMade), end: addDays(week, 7 * r.int(6, 16)), milestones: [] as string[] };
    const ended = at(project.end, 17 * 60);
    const state = ended >= NOW_MS ? 'active' : r.pick(['finished', 'finished', 'finished', 'dropped', 'paused'] as const);
    if (add('project', project.id, state === 'active' ? projectMade : Math.min(ended, NOW_MS), {
      objective_id: objectives.length ? r.pick(objectives) : null,
      title: `${r.pick(['Launch', 'Rebuild', 'Finish', 'Prepare', 'Organise'])} ${r.pick(THINGS)}`,
      state,
      start: week,
      end: project.end,
      weekly_aim: 60 * r.int(2, 6),
    }, false)) {
      projects.push(project);
      for (let m = 0; m < 6; m++) {
        const due = addDays(week, Math.round(((m + 1) / 6) * (Date.parse(project.end) - Date.parse(week)) / DAY_MS));
        const dueMs = at(due, 17 * 60);
        const id = uuid(projectMade + m);
        const met = dueMs < NOW_MS && state !== 'dropped';
        if (add('milestone', id, met ? dueMs : projectMade, { project_id: project.id, title: `${r.pick(['Draft', 'First cut of', 'Sign-off on', 'Review of'])} ${r.pick(THINGS)}`, due, added_on: week, met_at: met ? toInstant(dueMs) : null })) {
          project.milestones.push(id);
        }
      }
    }

    // Forty tasks: twenty for projects, ten one offs (now and then a repeating one), ten Inbox captures.
    const picked: { id: string; minutes: number }[] = [];
    const task = (made: number, fields: Omit<RecordMap['task'], 'id'>, deleted?: boolean) => {
      const est = fields.estimate_min ?? null;
      const done = !fields.schedule || fields.schedule.type === 'once' ? (settled(made) && r.chance(0.85) ? made + r.int(1, 21) * DAY_MS : null) : null;
      const doneAt = done !== null && done <= NOW_MS ? done : null;
      return add('task', uuid(made), doneAt ?? made, { ...fields, order: order++, remaining_min: doneAt ? null : est, done_at: doneAt ? toInstant(doneAt) : null }, deleted);
    };
    for (let i = 0; i < 20; i++) {
      const owner = live.length ? r.pick(live) : project;
      const made = sometime();
      const t = task(made, { kind: 'project', project_id: owner.id, milestone_id: owner.milestones.length ? r.pick(owner.milestones) : null, title: title(), estimate_min: estimate() });
      if (t && i < 14) picked.push({ id: t.id, minutes: t.fields.estimate_min ?? 60 });
    }
    for (let i = 0; i < 10; i++) {
      const made = sometime();
      const repeats = w === 0 ? i < 6 : (w * 10 + i) % 50 === 0;
      const schedule: TaskSchedule = repeats
        ? r.chance(0.5)
          ? { type: 'recurring', every: 1, unit: 'week', anchor: week, days: [r.int(0, 6) as Weekday] }
          : { type: 'float', every: r.int(1, 3), unit: 'week' }
        : { type: 'once', from: day(r.int(0, 13)), to: null };
      const t = task(made, { kind: 'one_off', title: repeats ? r.pick(REPEATS) : title(), estimate_min: estimate(), schedule, next_due: repeats ? week : null }, repeats ? false : undefined);
      if (!t) continue;
      if (repeats) repeating.push(t);
      else if (i < 6) picked.push({ id: t.id, minutes: t.fields.estimate_min ?? 60 });
    }
    for (let i = 0; i < 10; i++) {
      const made = sometime();
      if (!settled(made)) {
        task(made, { kind: 'inbox', title: title() });
        continue;
      }
      // Sorted since: into a one off or a project, or let go.
      const fate = r.next();
      if (fate < 0.25) task(made, { kind: 'inbox', title: title() }, true);
      else if (fate < 0.75) task(made, { kind: 'one_off', title: title(), estimate_min: estimate(), schedule: { type: 'once', from: null, to: null } });
      else task(made, { kind: 'project', project_id: (live.length ? r.pick(live) : project).id, title: title(), estimate_min: estimate() });
    }

    // Twenty picks for the week, made while planning it.
    for (const [i, p] of picked.entries()) add('week_pick', weekPickId(week, p.id), planned + i * 1000, { week_start: week, task_id: p.id, minutes: p.minutes, deleted_at: null });

    // Thirty-five blocks, five a day, a practice session first where one is under way, each answered once it ended.
    const practice = practices.find((p) => p.from < at(week, 0) && p.until > at(week, 0));
    for (let d = 0; d < 7; d++) {
      for (let s = 0; s < 5; s++) {
        const start = at(day(d), 8 * 60 + s * 120 + 15 * r.int(0, 3));
        const end = start + 15 * r.int(2, 7) * 60_000;
        if (end > NOW_MS) continue;
        const forPractice = s === 0 && !!practice;
        const work = picked.length ? picked[(d * 5 + s) % picked.length]! : null;
        if (!forPractice && !work) continue;
        const id = forPractice ? practiceSessionId(practice.id, day(d)) : uuid(start - DAY_MS);
        const started = r.chance(0.7);
        const block = add('time_block', id, started ? end : planned, {
          ...(forPractice ? { practice_id: practice.id } : { task_id: work!.id }),
          start: toInstant(start),
          end: toInstant(end),
          tz: zone,
          ...(started ? { started_at: toInstant(start), ended_at: toInstant(end) } : {}),
        });
        if (!block) continue;
        const result: BlockResult = r.pick(['done', 'done', 'done', 'done', 'done', 'done', 'done', 'partly', 'partly', 'not']);
        const answered = end + 5 * 60_000;
        // As answerBlock writes it: minutes logged only for a practice.
        add('block_outcome', outcomeId(id), Math.min(answered, NOW_MS), {
          result,
          remaining_min: result === 'partly' ? 15 * r.int(1, 4) : null,
          logged_min: forPractice ? (result === 'not' ? 0 : (end - start) / 60_000) : null,
          answered_at: toInstant(Math.min(answered, NOW_MS)),
          deleted_at: null,
        }, !!block.fields.deleted_at);
      }
    }

    // Ten finishes of repeating tasks, each moving its task's next date on.
    const due = repeating.filter((t) => !t.fields.deleted_at).slice(-10);
    const finished = new Set<string>();
    for (let i = 0; i < 10 && due.length; i++) {
      const t = due[i % due.length]!;
      const date = day(i % 7);
      const id = occurrenceId(t.id, date);
      const done = at(date, 19 * 60);
      if (finished.has(id) || done > NOW_MS) continue;
      finished.add(id);
      add('task_completion', id, done, { task_id: t.id, done_at: toInstant(done), previous_next: t.fields.next_due ?? date, undo: null });
      t.fields.next_due = addDays(date, 7);
      t.at = Math.max(t.at, done);
    }
  }

  // Settings, changed now and then all along, so last of all.
  const began = at(first, 8 * 60);
  add(
    'settings',
    SETTINGS_ID,
    NOW_MS,
    {
      availability: [
        { days: 'all', from: 22 * 60, to: 7 * 60, projects: true, one_offs: true },
        { days: 'weekdays', from: 12 * 60, to: 13 * 60, projects: true, one_offs: false },
      ],
      one_offs_weekly_aim: 120,
      plan_cadence: { every: 1, unit: 'quarters' },
      plan_stretch: { last_planned: '2026-10-01', last_note: 'Keep Fridays light' },
      reminders: { block_start: true, check_in: true, check_in_delay_min: 5, block_end: true },
      avoided_slots: [{ day: 4, from: 16 * 60, to: 18 * 60 }],
      setup_done_at: toInstant(began),
    },
    false,
  );
  return out;
}

/** The history in sync form, in the order its last writes happened: what a sync from 0 brings down, oldest first. */
export function historyChanges(): RecordChange[] {
  const drafts = build();
  // Stable, so records written in the same millisecond keep the order they were made in.
  const order = drafts.map((d, i) => ({ d, i })).sort((a, b) => a.d.at - b.d.at || a.i - b.i);
  return order.map(({ d }) => {
    const c = formatClock({ wall: d.at, counter: HISTORY.version, device: 'history' });
    const fields = Object.fromEntries(Object.entries(d.fields).filter(([, v]) => v !== undefined).map(([k, v]) => [k, { v, c }]));
    return { type: d.type, id: d.id, fields };
  });
}

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * The history as a server with retention keeps it at `at`: without the deleted records whose deleted period has passed,
 * which the API drops (docs/retention.md). The rest carry no expiry, as records from before retention do, so the account
 * still spans five years. Pass a time a little after the seed, so nothing counted goes while it runs.
 */
export function keptHistory(deleted: Period, at: number, changes = historyChanges()): RecordChange[] {
  return changes.filter((c) => {
    const when = c.fields.deleted_at?.v;
    return typeof when !== 'string' || addPeriod(Date.parse(when), deleted) > at;
  });
}

/** What the tests check the apps against. */
export function historyFacts(changes = historyChanges()) {
  const v = (c: RecordChange, field: string) => c.fields[field]?.v ?? null;
  return {
    records: changes.length,
    deleted: changes.filter((c) => v(c, 'deleted_at') !== null).length,
    /** What Inbox counts once the history is down: captures not yet sorted, finished or deleted. */
    openInbox: changes.filter((c) => c.type === 'task' && v(c, 'kind') === 'inbox' && !v(c, 'done_at') && !v(c, 'cancelled_at') && !v(c, 'deleted_at')).length,
    /** Each record's fields with their clocks, as JSON: what the server measures and stores. */
    meanBytes: Math.round(changes.reduce((sum, c) => sum + byteLength(c.fields), 0) / changes.length),
  };
}

/** The sync API's limits on one request, from config/protocol.yaml: 99 records, and the 4 MB a device's batch stops at. */
const BATCH_RECORDS = protocol.sync.maxChanges;
const BATCH_BYTES = protocol.sync.clientBatchBytes;

export function historyBatches(changes: readonly RecordChange[]): RecordChange[][] {
  const batches: RecordChange[][] = [];
  let batch: RecordChange[] = [];
  let bytes = 0;
  for (const change of changes) {
    const size = byteLength(change) + 1;
    if (batch.length === BATCH_RECORDS || (batch.length > 0 && bytes + size > BATCH_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = 2;
    }
    batch.push(change);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/**
 * The write units DynamoDB charges for a record in a transaction: two per kilobyte of item, rounded up. The item is
 * the record's fields and clocks, plus its keys and sequence number.
 */
const writeUnits = (change: RecordChange) => 2 * Math.ceil((byteLength(change) + 100) / 1024);

const TRIES = 5;

/**
 * Pushes the history in order, in batches the sync API takes, pacing them to the write units one user's partition can
 * take (about 1,000 a second). Each record merges by its fixed id and clocks, so a rerun writes nothing, and only
 * what was written is paced. A failed request is sent again after a wait, up to five tries. It sends as an up-to-date
 * app does, so the API takes each record's old clocks as they are: from an app before retention, it drops a record it
 * doesn't hold whose clocks are all older than the deleted period.
 */
export async function seedHistory(
  send: (request: { cursor: number; changes: RecordChange[]; expiry_reset?: boolean }) => Promise<{ cursor: number; more: boolean }>,
  options: {
    changes?: readonly RecordChange[];
    unitsPerSecond: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    progress?: (done: number, total: number, written: number) => void;
  },
): Promise<{ batches: number; written: number }> {
  const { unitsPerSecond, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now } = options;
  const batches = historyBatches(options.changes ?? historyChanges());
  const call = async (request: { cursor: number; changes: RecordChange[] }) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await send({ ...request, expiry_reset: true });
      } catch (err) {
        if (attempt === TRIES) throw err;
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
  };
  // A cursor past the server's counter writes nothing, and is answered with the counter.
  let cursor = (await call({ cursor: Number.MAX_SAFE_INTEGER, changes: [] })).cursor;
  let written = 0;
  for (const [i, batch] of batches.entries()) {
    const started = now();
    let res = await call({ cursor, changes: batch });
    if (res.cursor < cursor) throw new Error(`The server's counter went back from ${cursor} to ${res.cursor}`);
    // The cursor moves by one for each record the server wrote, and a record it already held as sent isn't written.
    const wrote = Math.min(res.cursor - cursor, batch.length);
    written += wrote;
    cursor = res.cursor;
    while (res.more) {
      res = await call({ cursor, changes: [] });
      cursor = res.cursor;
    }
    if (wrote > 0) {
      // A transaction writes the counter too.
      const units = (wrote / batch.length) * batch.reduce((sum, c) => sum + writeUnits(c), 0) + 2;
      const wait = (units / unitsPerSecond) * 1000 - (now() - started);
      if (wait > 0) await sleep(wait);
    }
    options.progress?.(i + 1, batches.length, written);
  }
  return { batches: batches.length, written };
}
