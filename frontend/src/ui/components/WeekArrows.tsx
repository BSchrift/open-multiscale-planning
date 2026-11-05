// Arrows to any week, with no limit either way, and This week whenever another week is showing.

import { addWeeks } from '../../core/dates';
import type { LocalDate } from '../../core/types';

export function WeekArrows(props: { week: LocalDate; current: LocalDate; onWeek(week: LocalDate): void }) {
  const { week, current, onWeek } = props;
  return (
    <span className="row wkarrows" role="group" aria-label="Change week">
      <button className="icon" type="button" aria-label="Previous week" title="Previous week" onClick={() => onWeek(addWeeks(week, -1))}>
        ‹
      </button>
      <button className="icon" type="button" aria-label="Next week" title="Next week" onClick={() => onWeek(addWeeks(week, 1))}>
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
