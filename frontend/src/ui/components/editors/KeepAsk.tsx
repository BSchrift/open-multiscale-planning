// "Use 8:30am in future weeks too?" after a practice session moved to a new time on its day, or got a new length, on
// Week and in planning's Schedule step. A group labelled by its question and described by what moved. It's announced
// when it appears rather than taking focus, so arrow keys can go on moving the session; from inside it, Escape is No.

import { useEffect, useId, useState } from 'react';
import type { LocalDate, Minutes, Practice, TimeOfDay, Weekday } from '../../../core/types';
import { useApp } from '../../app/store';
import { keepQuestion } from './PracticeSchedule';
import type { KeepChoice } from './PracticeSchedule';

export function KeepAsk(props: {
  practice: Practice;
  slot: { date: LocalDate; start: TimeOfDay; end: TimeOfDay };
  /** The weekday the session is on. */
  day: Weekday;
  wasMin: Minutes;
  onKeep(choice: KeepChoice): void;
  onNo(): void;
}) {
  const { layout } = useApp();
  const id = useId();
  const q = keepQuestion(props.practice, props.slot, props.day, props.wasMin);
  // Set after it appears, so a screen reader hears it.
  const [said, setSaid] = useState('');
  useEffect(() => setSaid(`${q.what} ${q.question}`), [q.what, q.question]);
  const btn = layout === 'phone' ? 'btn grow' : 'btn sm';
  return (
    <div
      className="panel stack8 wkask"
      role="group"
      aria-labelledby={`${id}-q`}
      aria-describedby={`${id}-what`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        props.onNo();
      }}
    >
      <div id={`${id}-what`}>{q.what}</div>
      <div className="strong small" id={`${id}-q`}>
        {q.question}
      </div>
      <div className={layout === 'phone' ? 'stack8' : 'row'}>
        <button className={`${btn} pri`} type="button" onClick={props.onNo}>
          No, just this week
        </button>
        {q.choices.map((c) => (
          <button key={c.label} className={btn} type="button" onClick={() => props.onKeep(c)}>
            {c.label}
          </button>
        ))}
      </div>
      {q.replaces && <div className="small quiet">{q.replaces}</div>}
      <div className="sr" role="status">
        {said}
      </div>
    </div>
  );
}
