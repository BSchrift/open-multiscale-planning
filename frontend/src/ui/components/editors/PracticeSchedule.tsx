// When a practice happens: How often (set days, or a number of times a week on any days or some first), each
// session's length, and its time, the same every day or one of its own on some days. The editor holds it as a draft and
// writes it as the practice's fields; practiceRule reads those fields back in plain words, and keepQuestion asks
// whether a session's new time or length is for future weeks too.

import { useId, useRef, useState } from 'react';
import type { Ref } from 'react';
import { formatMinutes, formatTimeOfDay } from '../../../core/dates';
import type { PracticeKeep } from '../../../core/blocks';
import { practiceDays, practiceTime, sessionLength, storedDayTimes, weeklySessions } from '../../../core/slots';
import type { Fields, LocalDate, Minutes, Practice, TimeOfDay, Weekday } from '../../../core/types';
import { useApp } from '../../app/store';
import { DayChips } from '../DayChips';

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ALL: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
const same = (a: readonly number[], b: readonly number[]) => a.join() === b.join();
const isAll = (days: readonly Weekday[]) => same(days, ALL);
const isWeekdays = (days: readonly Weekday[]) => same(days, [0, 1, 2, 3, 4]);
const isWeekends = (days: readonly Weekday[]) => same(days, [5, 6]);
const list = (xs: readonly string[]) => new Intl.ListFormat('en-GB').format(xs);
const sorted = (days: readonly Weekday[]) => [...new Set(days)].sort((a, b) => a - b);

/** '30 minutes', '1 hour 30 minutes': what a screen reader says for formatMinutes. */
export function sayMinutes(m: Minutes): string {
  const h = Math.floor(m / 60);
  const r = m % 60;
  return [h ? `${h} ${h === 1 ? 'hour' : 'hours'}` : '', r ? `${r} ${r === 1 ? 'minute' : 'minutes'}` : ''].filter(Boolean).join(' ');
}

/** '7 AM', '9:30 PM': what a screen reader says for formatTimeOfDay. */
export function sayTime(t: TimeOfDay): string {
  const h = Math.floor(t / 60) % 24;
  return `${h % 12 || 12}${t % 60 ? `:${String(t % 60).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

const dayWord = (d: Weekday, spoken: boolean) => (spoken ? DAY_NAMES[d]! : DAY_NAMES[d]!.slice(0, 3));
/** 'every day', 'every weekday', 'on weekends' or 'on Mon, Tue and Fri'. */
const onDays = (days: readonly Weekday[], spoken: boolean) =>
  isAll(days) ? 'every day' : isWeekdays(days) ? 'every weekday' : isWeekends(days) ? 'on weekends' : `on ${list(days.map((d) => dayWord(d, spoken)))}`;
const groupWords = (days: readonly Weekday[], spoken: boolean) =>
  isWeekdays(days) ? 'weekdays' : isWeekends(days) ? 'weekends' : list(days.map((d) => dayWord(d, spoken)));

type Rule = Pick<Practice, 'per' | 'target_min' | 'days' | 'preferred_times' | 'sessions' | 'day_times'>;

/**
 * A practice's schedule in plain words: '30m on Mon and Tue around 7am, Fri around 9:30am', '3 times a week, 1h each,
 * around 6pm'. spoken: the form a screen reader gets, with words for days, lengths and times.
 */
export function practiceRule(p: Rule, spoken = false): string {
  const M = spoken ? sayMinutes : formatMinutes;
  const T = spoken ? sayTime : formatTimeOfDay;
  const days = sorted(practiceDays(p as Practice));
  const length = sessionLength(p as Practice);
  if (p.per === 'day' && !days.length) return `${M(length)}, no days chosen`;
  const n = weeklySessions(p as Practice);
  const first = days.length && !isAll(days) ? `, preferably ${isWeekdays(days) ? 'on weekdays' : onDays(days, spoken)}` : '';
  const head = p.per === 'week' ? `${n} ${n === 1 ? 'time' : 'times'} a week, ${M(length)} each${first}` : `${M(length)} ${onDays(days, spoken)}`;
  if (p.preferred_times?.[0] == null) return `${head}, any time`;
  const groups: { t: TimeOfDay; days: Weekday[] }[] = [];
  for (const d of days) {
    const t = practiceTime(p as Practice, d)!;
    const g = groups.find((x) => x.t === t);
    if (g) g.days.push(d);
    else groups.push({ t, days: [d] });
  }
  if (groups.length <= 1) return `${head}, around ${T(groups[0]?.t ?? p.preferred_times[0])}`;
  const parts = groups.map((g) => `${groupWords(g.days, spoken)} around ${T(g.t)}`).join(', ');
  if (p.per === 'week' || isAll(days) || isWeekdays(days)) return `${head}: ${parts}`;
  return `${M(length)} on ${parts}`;
}

/** The schedule as the editor holds it. Days serve both choices: set days, or the days a count goes on first. */
export interface ScheduleDraft {
  mode: 'days' | 'times';
  days: Weekday[];
  /** Times a week, 1 to 7. */
  count: number;
  /** Each session. */
  length: Minutes;
  /** Around a time, or any time. */
  timed: boolean;
  /** The usual time. */
  time: TimeOfDay;
  /** Different time on some days. Off, the days' own times stay here until Save leaves them out. */
  perDay: boolean;
  dayTimes: (TimeOfDay | null)[];
}

const NO_TIMES = (): (TimeOfDay | null)[] => Array<TimeOfDay | null>(7).fill(null);

/** Add practice's start: every day around 7am, 30m a session. */
export const newSchedule = (): ScheduleDraft => ({ mode: 'days', days: ALL, count: 7, length: 30, timed: true, time: 7 * 60, perDay: false, dayTimes: NO_TIMES() });

/** A practice's schedule as the editor shows it. An older weekly target reads as the equal sessions it works out to. */
export function scheduleOf(p: Practice): ScheduleDraft {
  const days = sorted(practiceDays(p));
  const dayTimes = storedDayTimes(p) ?? NO_TIMES();
  return {
    mode: p.per === 'day' ? 'days' : 'times',
    days,
    count: p.per === 'week' ? weeklySessions(p) : Math.min(7, Math.max(1, days.length)),
    length: sessionLength(p),
    timed: p.preferred_times?.[0] != null,
    time: p.preferred_times?.[0] ?? 7 * 60,
    perDay: dayTimes.some((t, d) => t !== null && days.includes(d as Weekday)),
    dayTimes,
  };
}

/**
 * The fields a schedule stores. backups are the times to try after the usual one, kept as stored though the editor
 * doesn't show them. A day's own time is kept only on one of its days, and only where it differs from the usual time.
 */
export function scheduleFields(s: ScheduleDraft, backups: readonly TimeOfDay[] = []): Fields<'practice'> {
  const days = sorted(s.days);
  const own = s.dayTimes.map((t, d) => (s.timed && s.perDay && t !== null && t !== s.time && days.includes(d as Weekday) ? t : null));
  return {
    per: s.mode === 'days' ? 'day' : 'week',
    target_min: s.mode === 'days' ? s.length : s.length * s.count,
    sessions: s.mode === 'times' ? s.count : null,
    days,
    preferred_times: s.timed ? [s.time, ...backups.filter((t) => t !== s.time)] : [],
    day_times: own.some((t) => t !== null) ? own : null,
  };
}

/** A schedule as a practice reads it, for its summary. */
export const scheduleRule = (s: ScheduleDraft, spoken = false) => practiceRule(scheduleFields(s) as Rule, spoken);

export interface KeepChoice {
  label: string;
  keep: PracticeKeep;
  /** The toast once kept. */
  done: string;
}

/**
 * After a practice session moved to a new time on its day, or got a new length: what moved, the question, its Yes
 * choices with the narrowest first, and what the widest replaces. No, just this week, always comes first.
 */
export function keepQuestion(p: Practice, slot: { date: LocalDate; start: TimeOfDay; end: TimeOfDay }, day: Weekday, wasMin: Minutes) {
  const length = slot.end - slot.start;
  const at = formatTimeOfDay(slot.start);
  if (length !== wasMin) {
    const minutes = formatMinutes(length);
    return {
      what: `${p.title} is now ${minutes} on ${DAY_NAMES[day]}.`,
      question: `Use ${minutes} in future weeks too?`,
      choices: [{ label: 'Yes, for every session', keep: { length: true }, done: `${p.title} is now ${minutes} each time.` }] as KeepChoice[],
      replaces: '',
    };
  }
  const what = `${p.title} moved to ${DAY_NAMES[day]!.slice(0, 3)} ${at}.`;
  const question = `Use ${at} in future weeks too?`;
  const days = sorted(practiceDays(p));
  if (p.per === 'week') return { what, question, choices: [{ label: 'Yes, for every session', keep: { time: 'every' }, done: `${p.title} is now ${at} for every session.` }] as KeepChoice[], replaces: '' };
  const plural = (d: Weekday) => `${DAY_NAMES[d]}s`;
  const where = isAll(days) ? 'every day' : isWeekdays(days) ? 'every weekday' : isWeekends(days) ? 'on weekends' : `on ${list(days.map(plural))}`;
  const every: KeepChoice = { label: `Yes, ${where}`, keep: { time: 'every' }, done: `${p.title} is now ${at} ${where}.` };
  const onDay: KeepChoice = { label: `Yes, on ${plural(day)}`, keep: { time: 'day' }, done: `${p.title} is now ${at} on ${plural(day)}.` };
  const choices = !days.includes(day) ? [every] : days.length > 1 ? [onDay, every] : [onDay];
  const own = storedDayTimes(p);
  const others = days.filter((d) => d !== day && own?.[d] != null && own[d] !== slot.start);
  const replaces = choices.length > 1 && others.length ? `The last one replaces ${list(others.map((d) => `${DAY_NAMES[d]}'s ${formatTimeOfDay(own![d]!)}`))}.` : '';
  return { what, question, choices, replaces };
}

const hhmm = (t: TimeOfDay) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
const toMinutes = (text: string) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));

/**
 * The schedule's controls. One live region speaks the stepper; the summary isn't live, so it never talks over the
 * chips, and has a spoken form. daysError shows under the chips, tied to Monday, which mondayRef reaches.
 */
export function ScheduleFields(props: { value: ScheduleDraft; onChange(s: ScheduleDraft): void; daysError?: string; mondayRef?: Ref<HTMLInputElement> }) {
  const s = props.value;
  const { layout } = useApp();
  const id = useId();
  const [said, setSaid] = useState('');
  const dayInputs = useRef<(HTMLInputElement | null)[]>([]);
  const set = (patch: Partial<ScheduleDraft>) => props.onChange({ ...s, ...patch });
  const setDay = (d: Weekday, t: TimeOfDay | null) => set({ dayTimes: s.dayTimes.map((x, i) => (i === d ? t : x)) });
  const sessions = s.mode === 'times' ? s.count : s.days.length;
  const step = (by: number) => {
    const count = s.count + by;
    if (count < 1) return setSaid('1 time a week is the least.');
    if (count > 7) return setSaid('7 times a week is the most.');
    set({ count });
    setSaid(`${count} ${count === 1 ? 'time' : 'times'} a week`);
  };
  const radio = (name: string, checked: boolean, label: string, pick: () => void) => (
    <label className={checked ? 'seg on' : 'seg'}>
      <input type="radio" name={`${id}-${name}`} checked={checked} onChange={pick} />
      <span>{label}</span>
    </label>
  );
  const chips = (legend: string) => <DayChips legend={legend} days={s.days} onChange={(days) => set({ days })} error={props.daysError} firstRef={props.mondayRef} />;
  const btn = layout === 'phone' ? 'btn' : 'btn sm';

  return (
    <div className="stack8 schedfields">
      <fieldset className="plainset stack8">
        <legend className="small quiet">How often</legend>
        <div className="segrow">
          {radio('mode', s.mode === 'days', 'Set days', () => set({ mode: 'days' }))}
          {radio('mode', s.mode === 'times', 'Times a week', () => set({ mode: 'times', count: Math.min(7, Math.max(1, s.days.length)) }))}
        </div>
      </fieldset>
      {s.mode === 'days' ? (
        chips('Days')
      ) : (
        <div className="stack8">
          <div className="small quiet" id={`${id}-count`}>
            How many times
          </div>
          <div className="stepper" role="group" aria-labelledby={`${id}-count`}>
            <button type="button" className="btn step" aria-label="One fewer time a week" aria-disabled={s.count <= 1} onClick={() => step(-1)}>
              −
            </button>
            <span className="stepval">
              <b>{s.count}</b> {s.count === 1 ? 'time' : 'times'} a week
            </span>
            <button type="button" className="btn step" aria-label="One more time a week" aria-disabled={s.count >= 7} onClick={() => step(1)}>
              +
            </button>
          </div>
          {chips('Preferred days')}
          <div className="small quiet">
            {isAll(s.days) || !s.days.length ? 'On any days.' : `${list(s.days.map((d) => dayWord(d, false)))} first.`} Planning spreads them out, one a day at
            most.
          </div>
        </div>
      )}
      <div className="stack8">
        <div className="between">
          <label className="small quiet" htmlFor={`${id}-len`}>
            Each session
          </label>
          <span className="strong" aria-hidden="true">
            {formatMinutes(s.length)}
          </span>
        </div>
        <input
          id={`${id}-len`}
          type="range"
          className="wideslider"
          min={5}
          max={240}
          step={5}
          value={s.length}
          aria-valuetext={sayMinutes(s.length)}
          onChange={(event) => set({ length: Number(event.target.value) })}
        />
        <div className="small quiet">
          {sessions} {sessions === 1 ? 'session' : 'sessions'}, {formatMinutes(sessions * s.length)} a week
        </div>
      </div>
      <fieldset className="plainset stack8">
        <legend className="small quiet">Time</legend>
        <div className="segrow">
          {radio('timed', s.timed, 'Around a time', () => set({ timed: true }))}
          {radio('timed', !s.timed, 'Any time', () => set({ timed: false }))}
        </div>
        {s.timed && (
          <>
            <div className="stack8">
              <label className="small quiet" htmlFor={`${id}-time`}>
                Usual time
              </label>
              <input id={`${id}-time`} className="field tfield" type="time" value={hhmm(s.time)} onChange={(event) => event.target.value && set({ time: toMinutes(event.target.value) })} />
            </div>
            <label className="switchrow">
              <input type="checkbox" role="switch" checked={s.perDay} onChange={() => set({ perDay: !s.perDay })} />
              <span>Different time on some days</span>
            </label>
            {s.perDay && (
              <div className="dayrows" role="group" aria-label="Time on each day">
                {s.days.map((d) => {
                  const own = s.dayTimes[d] ?? null;
                  return (
                    <div className="dayrow" key={d}>
                      <label className="dayrowname" htmlFor={`${id}-day${d}`}>
                        {DAY_NAMES[d]}
                      </label>
                      <div className="dayrowctl">
                        <input
                          id={`${id}-day${d}`}
                          ref={(el) => void (dayInputs.current[d] = el)}
                          className="field tfield"
                          type="time"
                          value={hhmm(own ?? s.time)}
                          aria-describedby={own === null ? `${id}-usual${d}` : undefined}
                          // Cleared, a day goes back to the usual time. Whether it has its own is settled on blur.
                          onChange={(event) => setDay(d, event.target.value ? toMinutes(event.target.value) : null)}
                          onBlur={() => own === s.time && setDay(d, null)}
                        />
                        {own === null ? (
                          <span className="small quiet usual" id={`${id}-usual${d}`}>
                            Usual time
                          </span>
                        ) : (
                          <button
                            type="button"
                            className={`${btn} usebtn`}
                            aria-label={`Use the usual time, ${sayTime(s.time)}, on ${DAY_NAMES[d]}`}
                            onClick={() => {
                              setDay(d, null);
                              dayInputs.current[d]?.focus();
                            }}
                          >
                            Use {formatTimeOfDay(s.time)}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </fieldset>
      <p className="rulebox">
        <span aria-hidden="true">
          <span className="rulelabel">Summary</span> <span className="ruletext">{scheduleRule(s)}</span>
        </span>
        <span className="sr">{`Summary: ${scheduleRule(s, true)}`}</span>
      </p>
      <p className="small quiet">Sessions you've placed stay put. Sessions still to place follow this schedule.</p>
      <div className="sr" aria-live="polite">
        {said}
      </div>
    </div>
  );
}
