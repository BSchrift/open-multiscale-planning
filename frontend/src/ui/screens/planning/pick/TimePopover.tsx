// A task's time, from its row's time button: how much of it is in this week, and its estimate, or its time left when
// it has some recorded. Both wait for Save, which writes them as one change with Undo; Cancel drops them, and Esc or a
// click outside does when nothing has changed. Already done and Remove from this week act at once.

import { useId, useState } from 'react';
import { formatMinutes } from '../../../../core/dates';
import { minutesLeft } from '../../../../core/plan';
import type { Minutes } from '../../../../core/types';
import { useLeave } from '../../../components/editors';
import { EstimateSlider } from '../../../components/EstimateSlider';
import { Popover } from '../../../components/Popover';
import { stopIndex, weekStops } from './model';
import type { PickTask } from './model';

export function TimePopover(props: { row: PickTask; phone: boolean; onSave(week: Minutes, estimate: Minutes): void; onDone(): void; onRemove(): void; onClose(): void }) {
  const { row } = props;
  const now = minutesLeft(row.c.task);
  const [estimate, setEstimate] = useState(now);
  // What's already on this week's calendar comes off whatever the estimate becomes.
  const left = Math.max(0, estimate - row.c.ahead);
  // Added here, or all of it already, it follows the estimate until its own slider moves.
  const [week, setWeek] = useState<Minutes | null>(row.c.picked && row.c.week < row.c.left ? row.c.week : null);
  const shown = week === null ? left : Math.min(week, left);
  const stops = weekStops(left);
  const changed = estimate !== now || (row.c.picked ? shown !== row.c.week : week !== null);
  const [said, setSaid] = useState('');
  const { saveRef, leave } = useLeave(changed, props.onClose, setSaid);
  const id = useId();
  const btn = props.phone ? 'btn grow' : 'btn sm';
  const save = () => {
    // Not yet in the week, Save is what adds it.
    if (changed || !row.c.picked) props.onSave(shown, estimate);
    props.onClose();
  };
  const text = `${formatMinutes(shown)} of ${formatMinutes(left)}`;
  return (
    <Popover label={row.title} onClose={leave}>
      <h2>{row.title}</h2>
      <div className="estslider">
        <label className="small" htmlFor={id}>
          This week
        </label>
        <input
          id={id}
          type="range"
          autoFocus
          min={0}
          max={stops.length - 1}
          step={1}
          value={stopIndex(stops, shown)}
          aria-valuetext={text}
          onChange={(event) => {
            setWeek(stops[Number(event.target.value)]!);
            setSaid('');
          }}
        />
        <span className="small estval">{text}</span>
      </div>
      <EstimateSlider
        label={row.c.task.remaining_min != null ? 'Time left' : 'Estimate'}
        value={estimate}
        onChange={(m) => {
          setEstimate(m);
          setSaid('');
        }}
      />
      <div className="row timeacts">
        <button className="link small" type="button" onClick={props.onDone}>
          Already done
        </button>
        {row.c.picked && (
          <button className="link small" type="button" onClick={props.onRemove}>
            Remove from this week
          </button>
        )}
      </div>
      {said && (
        <div className="fielderr" role="alert">
          {said}
        </div>
      )}
      <div className="row">
        <button ref={saveRef} className={`${btn} pri`} type="button" onClick={save}>
          Save
        </button>
        <button className={btn} type="button" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </Popover>
  );
}
