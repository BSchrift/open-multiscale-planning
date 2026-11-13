// Choose a time: when to plan a week, as a sheet on phone and a centred dialog on desktop. Now (when a block fits from
// this minute), then the times offered, each one button that says what it does. Choose another time takes the block to
// Week, to place by hand beside what's busy; Change length sets this block's length only.

import { useId, useState } from 'react';
import { formatMinutes, formatTime } from '../../../core/dates';
import { GRID } from '../../../core/slots';
import type { Slot } from '../../../core/slots';
import { isWeek } from '../../../core/planning';
import type { PlanningFor } from '../../../core/planning';
import type { LocalDate } from '../../../core/types';
import { useNav } from '../../app/nav';
import { useApp } from '../../app/store';
import { Sheet } from '../Sheet';
import { About } from './About';
import { estimateSource, longTime, placePlanningParams, shortTime, usePlanningActions, usePlanningTimes } from './usePlanning';
import './planning.css';

/** The longest planning block, the same cap a first block and Start have. */
const LONGEST_MIN = 120;

/** name is the week as the person reads it: 'this week', 'next week' or 'the week after'. */
export function PlanningTimes(props: {
  for: PlanningFor;
  name: string;
  /** Both plans in one block: the week the stretch's block covers, their combined length, and parting them. */
  both?: { week: LocalDate; minutes: number; onSeparate(): void };
  /** The week of the planning flow this opened in, which Week comes back to after Choose another time. */
  flow?: LocalDate;
  onClose(): void;
}) {
  const { for: week, onClose } = props;
  const { clock } = useApp();
  const nav = useNav();
  const planning = usePlanningTimes(week);
  const act = usePlanningActions();
  const [length, setLength] = useState<number | null>(null);
  const [changing, setChanging] = useState(false);
  const title = `When will you plan ${props.name}?`;
  if (!planning) return null;
  const { estimate } = planning;
  const minutes = length ?? props.both?.minutes ?? estimate.minutes;
  const both = props.both && !isWeek(week) ? { ...props.both, s: week } : null;
  const now = planning.now(minutes);
  const times = planning.times(minutes);
  const done = (slot: Slot) => {
    onClose();
    void (both ? act.scheduleBoth(both.s, both.week, slot) : act.schedule(week, slot));
  };
  // On Week, the block waits at the best time offered, ready to drag beside what's busy, until Place here.
  const another = () => {
    onClose();
    const best = times[0];
    nav.go(
      'week',
      placePlanningParams({
        for: week,
        minutes,
        ...(both ? { both: both.week } : {}),
        ...(best ? { at: { date: best.date, start: best.start, end: best.end } } : {}),
        ...(props.flow ? { flow: props.flow } : {}),
      }),
    );
  };

  return (
    <Sheet label={title} onClose={onClose}>
      <h2>{title}</h2>
      <p className="quiet">
        <About minutes={estimate.minutes} after={estimateSource(estimate)} />
      </p>
      <div className="stack8" role="group" aria-label="Times">
        {now && (
          // Focus lands on the first time, the one most people take.
          <button
            className="offer first"
            type="button"
            aria-label="Start planning now"
            autoFocus
            onClick={() => {
              onClose();
              void (both ? act.startBoth(both.s, both.week, minutes) : act.start(week, minutes));
            }}
          >
            <span>Now, until {formatTime(now.end, clock.zone())}</span>
            <span className="small">Start</span>
          </button>
        )}
        {times.map((s, i) => (
          <button
            key={`${s.date}${s.start}`}
            className={`offer${!now && i === 0 ? ' first' : ''}`}
            type="button"
            aria-label={`Schedule planning for ${longTime(s)}${s.usual ? ', your usual time' : ''}`}
            autoFocus={!now && i === 0}
            onClick={() => done(s)}
          >
            <span>
              {shortTime(s)}
              {s.usual && ', your usual time'}
            </span>
            <span className="small">Schedule</span>
          </button>
        ))}
        {!now && times.length === 0 && <p className="small">No free time fits. Choose another time.</p>}
      </div>
      <button className="btn" type="button" onClick={another}>
        Choose another time
      </button>
      {changing ? (
        <Length minutes={minutes} onChange={setLength} />
      ) : (
        <button className="btn" type="button" onClick={() => setChanging(true)}>
          Change length
        </button>
      )}
      {both && (
        <button
          className="btn"
          type="button"
          onClick={() => {
            onClose();
            both.onSeparate();
          }}
        >
          Plan them at separate times
        </button>
      )}
      <button className="btn" type="button" onClick={onClose}>
        Close
      </button>
    </Sheet>
  );
}

function Length(props: { minutes: number; onChange(minutes: number): void }) {
  const id = useId();
  return (
    <div className="stack8">
      <div className="between">
        <label className="small quiet" htmlFor={id}>
          Length
        </label>
        <span className="strong">{formatMinutes(props.minutes)}</span>
      </div>
      <input
        id={id}
        className="wkrange"
        type="range"
        min={GRID}
        max={LONGEST_MIN}
        step={GRID}
        value={props.minutes}
        aria-valuetext={formatMinutes(props.minutes)}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </div>
  );
}
