// One row of a timeline: the project's bar, the stretch as a faint band behind it, this week as a band, and
// milestones as diamonds. Rows sharing an axis line up, so bars compare at a glance. Give TimelineAxisHead the same
// axis.

import { addDays, addMonths, dayNumber, formatMonth, monthStart } from '../../core/dates';
import type { LocalDate } from '../../core/types';
import { TimelineDiamond } from './MilestoneDiamond';
import type { DiamondState } from './MilestoneDiamond';

/** The dates a row spans, both inclusive. */
export interface TimelineAxis {
  start: LocalDate;
  end: LocalDate;
}

export interface DateSpan {
  start: LocalDate;
  end: LocalDate;
}

/** A date's position along the axis, kept within it. */
export function axisPercent(axis: TimelineAxis, date: LocalDate): number {
  const span = Math.max(1, dayNumber(axis.end) - dayNumber(axis.start) + 1);
  return Math.max(0, Math.min(100, ((dayNumber(date) - dayNumber(axis.start)) / span) * 100));
}

/** The first of each month inside the axis. */
export function axisMonths(axis: TimelineAxis): LocalDate[] {
  const months: LocalDate[] = [];
  for (let d = monthStart(axis.start); d <= axis.end; d = addMonths(d, 1)) {
    if (d >= axis.start) months.push(d);
  }
  return months;
}

function spanStyle(axis: TimelineAxis, span: DateSpan) {
  const left = axisPercent(axis, span.start);
  return { left: `${left}%`, width: `${Math.max(0, axisPercent(axis, addDays(span.end, 1)) - left)}%` };
}

export interface TimelineMark {
  id: string;
  date: LocalDate;
  state?: DiamondState;
}

export function TimelineBar(props: {
  axis: TimelineAxis;
  /** The project's dates. */
  bar?: DateSpan;
  stretch?: DateSpan;
  week?: DateSpan;
  diamonds?: readonly TimelineMark[];
  /** What the row shows, for screen readers, since the drawing itself says nothing to them. */
  alt: string;
}) {
  const { axis, bar, stretch, week, diamonds = [] } = props;
  return (
    <div className="ptrack" role="img" aria-label={props.alt}>
      {stretch && <span className="pband" style={spanStyle(axis, stretch)} />}
      {axisMonths(axis).map((month) => (
        <span key={month} className="ptick" style={{ left: `${axisPercent(axis, month)}%` }} />
      ))}
      {week && <span className="pweekband" style={spanStyle(axis, week)} />}
      {bar && <span className="pspan" style={spanStyle(axis, bar)} />}
      {diamonds.map((mark) => (
        <TimelineDiamond key={mark.id} percent={axisPercent(axis, mark.date)} {...(mark.state ? { state: mark.state } : {})} />
      ))}
    </div>
  );
}

/** Month labels for an axis, with this week marked. */
const LAST_LABEL_PERCENT = 92;

export function TimelineAxisHead(props: { axis: TimelineAxis; week?: DateSpan; weekLabel?: string }) {
  const { axis, week, weekLabel } = props;
  return (
    <div className="paxis" aria-hidden="true">
      {/* A month starting at the very end has no room for its name, which would hang past the edge. */}
      {axisMonths(axis)
        .filter((month) => axisPercent(axis, month) <= LAST_LABEL_PERCENT)
        .map((month) => (
          <span key={month} style={{ left: `${axisPercent(axis, month)}%` }}>
            {formatMonth(month)}
          </span>
        ))}
      {week && weekLabel && (
        <span className="wk" style={{ left: `${axisPercent(axis, week.start)}%` }}>
          {weekLabel}
        </span>
      )}
    </div>
  );
}
