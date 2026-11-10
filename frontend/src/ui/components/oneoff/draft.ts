// What the one off form holds while it's being filled in, and the task it becomes. The rules for dates live in
// core/schedule.ts; this only turns the form's choices into a schedule.

import { firstDue, setOnceDates, validateSchedule } from '../../../core/schedule';
import type { Fields, LocalDate, Minutes, RepeatUnit, Task, TaskSchedule } from '../../../core/types';

export type RepeatType = TaskSchedule['type'];

export const REPEAT_TYPES: readonly { value: RepeatType; label: string }[] = [
  { value: 'once', label: 'Does not repeat' },
  { value: 'recurring', label: 'On a regular schedule' },
  { value: 'float', label: 'A set time after I last did it' },
  { value: 'window', label: 'Within a flexible window' },
  { value: 'seasonal', label: 'In certain months' },
  { value: 'rule', label: 'By a calendar rule' },
];

/** Which one of the days in a rule: 1st to 4th, or -1 for the last. */
export type RulePos = 1 | 2 | 3 | 4 | -1;
/** A weekday in RRULE form, any weekday, or any day of the month. */
export type RuleDay = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU' | 'weekday' | 'day';
export type RuleOf = 'month' | 'quarter' | 'year';

export interface OneOffDraft {
  title: string;
  type: RepeatType;
  /** Once: the date, or the start of a range, as an <input type="date"> value. */
  from: string;
  to: string;
  ranged: boolean;
  /** Regular schedule. */
  unit: RepeatUnit;
  starts: LocalDate;
  /** Float. */
  weeks: number;
  /** Flexible window, in months. */
  winMin: number;
  winMax: number;
  /** Seasonal, 1 for January. */
  months: number[];
  rulePos: RulePos;
  ruleDay: RuleDay;
  ruleOf: RuleOf;
  estimate: Minutes;
  /** The description, once the form has one: without it the fields leave a task's description alone. */
  notes?: string;
}

export function emptyDraft(today: LocalDate): OneOffDraft {
  return {
    title: '',
    type: 'once',
    from: '',
    to: '',
    ranged: false,
    unit: 'week',
    starts: today,
    weeks: 6,
    winMin: 2,
    winMax: 3,
    months: [],
    rulePos: 1,
    ruleDay: 'MO',
    ruleOf: 'month',
    estimate: 30,
  };
}

/**
 * The form filled in from a saved one off, to change it.
 * shortcut: the form shows only what it can make (every 1 day, week, month or year; floats in weeks; windows in months),
 * so a schedule with more, such as every 2 weeks, is replaced by the nearest one the form offers when saved; add those
 * controls to the form if such schedules start coming from somewhere.
 */
export function draftOf(task: Task, today: LocalDate): OneOffDraft {
  const d: OneOffDraft = { ...emptyDraft(today), title: task.title, estimate: task.estimate_min ?? 0, notes: task.notes ?? '' };
  const s = task.schedule ?? { type: 'once' };
  switch (s.type) {
    case 'once':
      return { ...d, from: s.from ?? '', to: s.to ?? '', ranged: !!s.to };
    case 'recurring':
      return { ...d, type: s.type, unit: s.unit, starts: s.anchor };
    case 'float':
      return { ...d, type: s.type, weeks: s.every };
    case 'window':
      return { ...d, type: s.type, winMin: s.min, winMax: s.max };
    case 'seasonal':
      return { ...d, type: s.type, months: s.months };
    case 'rule': {
      const part = (key: string) => new RegExp(`${key}=([^;]+)`).exec(s.rrule)?.[1];
      const months = part('BYMONTH');
      const ruleOf: RuleOf = !months ? 'month' : months.includes(',') ? 'quarter' : 'year';
      const nth = /^([+-]?\d)(\w\w)$/.exec(part('BYDAY') ?? '');
      const [rulePos, ruleDay] = part('BYMONTHDAY')
        ? [Number(part('BYMONTHDAY')), 'day']
        : part('BYSETPOS')
          ? [Number(part('BYSETPOS')), 'weekday']
          : [Number(nth?.[1] ?? 1), nth?.[2] ?? 'MO'];
      return { ...d, type: s.type, starts: s.anchor, rulePos: rulePos as RulePos, ruleDay: ruleDay as RuleDay, ruleOf };
    }
  }
}

/** An RRULE for "the Nth day of each month, quarter or year". A quarter's first days are in its first month, its last in its last. */
function ruleText(d: OneOffDraft): string {
  const first = d.rulePos > 0;
  const months = { month: '', quarter: first ? ';BYMONTH=1,4,7,10' : ';BYMONTH=3,6,9,12', year: first ? ';BYMONTH=1' : ';BYMONTH=12' }[d.ruleOf];
  const day =
    d.ruleDay === 'day'
      ? `BYMONTHDAY=${d.rulePos}`
      : d.ruleDay === 'weekday'
        ? `BYDAY=MO,TU,WE,TH,FR;BYSETPOS=${d.rulePos}`
        : `BYDAY=${d.rulePos > 0 ? '+' : ''}${d.rulePos}${d.ruleDay}`;
  return `FREQ=MONTHLY${months};${day}`;
}

export function draftSchedule(d: OneOffDraft): TaskSchedule {
  switch (d.type) {
    case 'once':
      return setOnceDates(d.from || null, d.ranged ? d.to || null : null).schedule!;
    case 'recurring':
      return { type: 'recurring', every: 1, unit: d.unit, anchor: d.starts };
    case 'float':
      return { type: 'float', every: d.weeks, unit: 'week' };
    case 'window':
      return { type: 'window', min: d.winMin, max: d.winMax, unit: 'month' };
    case 'seasonal':
      return { type: 'seasonal', months: [...d.months].sort((a, b) => a - b) };
    case 'rule':
      return { type: 'rule', rrule: ruleText(d), anchor: d.starts };
  }
}

/** Why the draft can't be saved yet, or null. */
export function draftError(d: OneOffDraft): string | null {
  if (!d.title.trim()) return 'Give it a title.';
  if (d.type === 'once' && d.ranged && d.to && !d.from) return 'Pick a date.';
  return validateSchedule(draftSchedule(d));
}

/**
 * The fields of a new one off task, ready for Writer.create('task', ...) or to turn an Inbox item into one. Fields merge
 * one by one, so it clears a project's too: another device may have sent the same item to a project.
 */
export function oneOffFields(d: OneOffDraft, today: LocalDate): Fields<'task'> {
  const schedule = draftSchedule(d);
  return {
    kind: 'one_off',
    project_id: null,
    milestone_id: null,
    title: d.title.trim(),
    schedule,
    next_due: firstDue(schedule, today),
    estimate_min: d.estimate || null,
    ...(d.notes === undefined ? {} : { notes: d.notes.trim() ? d.notes : null }),
  };
}
