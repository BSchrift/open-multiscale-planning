// A task's estimate, or its time left, from its row: a slider that waits for Save, which writes it with Undo. Cancel
// drops it, and Esc or a click outside does when it hasn't changed.

import { useState } from 'react';
import { minutesLeft } from '../../../../core/plan';
import type { Minutes } from '../../../../core/types';
import { useLeave } from '../../../components/editors';
import { EstimateSlider } from '../../../components/EstimateSlider';
import { Popover } from '../../../components/Popover';
import type { PickTask } from './model';

export function EstimatePopover(props: { row: PickTask; phone: boolean; onSave(minutes: Minutes): void; onClose(): void }) {
  const { row } = props;
  const now = minutesLeft(row.c.task);
  const [minutes, setMinutes] = useState(now);
  const [said, setSaid] = useState('');
  const { saveRef, leave } = useLeave(minutes !== now, props.onClose, setSaid);
  const btn = props.phone ? 'btn grow' : 'btn sm';
  const save = () => {
    if (minutes !== now) props.onSave(minutes);
    props.onClose();
  };
  return (
    <Popover label={`Estimate for ${row.title}`} onClose={leave}>
      {props.phone && <h2>{row.title}</h2>}
      <EstimateSlider
        label={row.c.task.remaining_min != null ? 'Time left' : 'Estimate'}
        value={minutes}
        onChange={(m) => {
          setMinutes(m);
          setSaid('');
        }}
      />
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
