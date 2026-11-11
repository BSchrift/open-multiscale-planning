// Choose a time: when to plan a week, as a sheet on phone and a centred dialog on desktop. Now (when a block fits from
// this minute), then the times offered, each one button that says what it does. Choose another time takes any day and
// time; Change length sets this block's length only.

import { useId, useState } from 'react';
import { addDays, formatMinutes, formatTime, localMinutes, today } from '../../../core/dates';
import { GRID } from '../../../core/slots';
import type { Slot } from '../../../core/slots';
import type { LocalDate } from '../../../core/types';
import { useApp } from '../../app/store';
import { Sheet } from '../Sheet';
import { About } from './About';
import { longTime, shortTime, usePlanningActions, usePlanningTimes } from './usePlanning';
import './planning.css';

/** The longest planning block, the same cap a first block and Start have. */
const LONGEST_MIN = 120;

const toMinutes = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const toTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export function PlanningTimes(props: { week: LocalDate; which: 'this' | 'next'; onClose(): void }) {
  const { week, onClose } = props;
  const { clock } = useApp();
  const planning = usePlanningTimes(week);
  const act = usePlanningActions();
  const [length, setLength] = useState<number | null>(null);
  const [changing, setChanging] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const title = `When will you plan ${props.which} week?`;
  if (!planning) return null;
  const { estimate } = planning;
  const minutes = length ?? estimate.minutes;
  const now = planning.now(minutes);
  const times = planning.times(minutes);
  const done = (slot: Slot) => {
    onClose();
    void act.schedule(week, slot);
  };

  return (
    <Sheet label={title} onClose={onClose}>
      <h2>{title}</h2>
      <p className="quiet">
        <About minutes={estimate.minutes} after={estimate.guess ? ', a first guess.' : '.'} />
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
              void act.start(week, minutes);
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
            aria-label={`Schedule planning for ${longTime(s)}`}
            autoFocus={!now && i === 0}
            onClick={() => done(s)}
          >
            <span>{shortTime(s)}</span>
            <span className="small">Schedule</span>
          </button>
        ))}
        {!now && times.length === 0 && <p className="small">No free time fits. Choose another time.</p>}
      </div>
      {choosing ? (
        <AnyTime week={week} minutes={minutes} onSchedule={done} />
      ) : (
        <button className="btn" type="button" onClick={() => setChoosing(true)}>
          Choose another time
        </button>
      )}
      {changing ? (
        <Length minutes={minutes} onChange={setLength} />
      ) : (
        <button className="btn" type="button" onClick={() => setChanging(true)}>
          Change length
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

/** Any day from today to the week's end, and any time on the quarter hour. */
function AnyTime(props: { week: LocalDate; minutes: number; onSchedule(slot: Slot): void }) {
  const { clock } = useApp();
  const ids = useId();
  const first = today(clock);
  const next = Math.min(23 * 60 + 45, Math.ceil(localMinutes(clock.now(), clock.zone()) / GRID) * GRID);
  const [date, setDate] = useState<LocalDate>(first);
  const [time, setTime] = useState(toTime(next));
  const start = toMinutes(time);
  const slot: Slot = { date, start, end: Math.min(1440, start + props.minutes) };
  const valid = date >= first && date <= addDays(props.week, 6) && !!time;
  return (
    <div className="row planany">
      <label className="stack4">
        <span className="small quiet" id={`${ids}d`}>
          Day
        </span>
        <input className="field" type="date" aria-labelledby={`${ids}d`} min={first} max={addDays(props.week, 6)} value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label className="stack4">
        <span className="small quiet" id={`${ids}t`}>
          Time
        </span>
        <input className="field" type="time" aria-labelledby={`${ids}t`} step={GRID * 60} value={time} onChange={(e) => setTime(e.target.value)} />
      </label>
      <button className="btn pri" type="button" disabled={!valid} aria-label={`Schedule planning for ${longTime(slot)}`} onClick={() => props.onSchedule(slot)}>
        Schedule
      </button>
    </div>
  );
}
