// The last line on Today, which opens Done on today: 'Done today · 4 · 4h 30m', the day's finishes and time worked.

import { formatMinutes } from '../../../core/dates';
import { useNav } from '../../app/nav';
import { useQuery, useToday } from '../../app/store';
import { loadDoneDay, todayLine } from './data';
import './done.css';

export function DoneLine() {
  const nav = useNav();
  const day = useToday();
  const done = useQuery((sql, clock) => loadDoneDay(sql, clock, day), [day]).data;
  if (!done) return null;
  const line = todayLine(done);
  const { finished, worked_min } = done.total;
  const label = finished ? `Done today: ${finished} finished${worked_min ? `, ${formatMinutes(worked_min)} worked` : ''}` : 'Done: nothing finished yet today';
  return (
    <button className="attn doneline" type="button" aria-label={label} onClick={() => nav.go('done', { day })}>
      {line ? (
        <span>
          <span className="strong">Done today</span> <span className="quiet">{line}</span>
        </span>
      ) : (
        <span className="quiet">Nothing finished yet today</span>
      )}
      <span className="chev" aria-hidden="true">
        ›
      </span>
    </button>
  );
}
