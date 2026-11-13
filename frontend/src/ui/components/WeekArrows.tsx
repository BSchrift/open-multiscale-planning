// Arrows to any week, with no limit either way unless given one, and This week whenever another week is showing.

import { addWeeks } from '../../core/dates';
import type { LocalDate } from '../../core/types';

/** first and last: the only weeks to go to, by their Mondays, such as while placing planning. */
export function WeekArrows(props: { week: LocalDate; current: LocalDate; onWeek(week: LocalDate): void; first?: LocalDate; last?: LocalDate }) {
  const { week, current, onWeek, first, last } = props;
  return (
    <span className="row wkarrows" role="group" aria-label="Change week">
      <button className="icon" type="button" aria-label="Previous week" title="Previous week" disabled={!!first && week <= first} onClick={() => onWeek(addWeeks(week, -1))}>
        ‹
      </button>
      <button className="icon" type="button" aria-label="Next week" title="Next week" disabled={!!last && week >= last} onClick={() => onWeek(addWeeks(week, 1))}>
        ›
      </button>
      {week !== current && (
        <button className="btn sm" type="button" onClick={() => onWeek(current)}>
          This week
        </button>
      )}
    </span>
  );
}
