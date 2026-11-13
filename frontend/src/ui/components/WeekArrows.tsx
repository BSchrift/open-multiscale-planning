// Arrows to any week, with no limit either way unless given one, and This week whenever another week is showing. Done's
// arrows step a day in the same way, with Today.

import { addDays, addWeeks } from '../../core/dates';
import type { LocalDate } from '../../core/types';

interface Steps {
  unit: 'week' | 'day';
  at: LocalDate;
  current: LocalDate;
  go(to: LocalDate): void;
  first?: LocalDate | undefined;
  last?: LocalDate | undefined;
}

function Arrows(props: Steps) {
  const { unit, at, current, go, first, last } = props;
  const step = (n: number) => (unit === 'week' ? addWeeks(at, n) : addDays(at, n));
  return (
    <span className="row wkarrows" role="group" aria-label={`Change ${unit}`}>
      <button className="icon" type="button" aria-label={`Previous ${unit}`} title={`Previous ${unit}`} disabled={!!first && at <= first} onClick={() => go(step(-1))}>
        ‹
      </button>
      <button className="icon" type="button" aria-label={`Next ${unit}`} title={`Next ${unit}`} disabled={!!last && at >= last} onClick={() => go(step(1))}>
        ›
      </button>
      {at !== current && (
        <button className="btn sm" type="button" onClick={() => go(current)}>
          {unit === 'week' ? 'This week' : 'Today'}
        </button>
      )}
    </span>
  );
}

/** first and last: the only weeks to go to, by their Mondays, such as while placing planning. */
export function WeekArrows(props: { week: LocalDate; current: LocalDate; onWeek(week: LocalDate): void; first?: LocalDate; last?: LocalDate }) {
  return <Arrows unit="week" at={props.week} current={props.current} go={props.onWeek} first={props.first} last={props.last} />;
}

/** Any day up to last, such as today. */
export function DayArrows(props: { day: LocalDate; today: LocalDate; onDay(day: LocalDate): void; last?: LocalDate }) {
  return <Arrows unit="day" at={props.day} current={props.today} go={props.onDay} last={props.last} />;
}
