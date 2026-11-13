// Days of the week as seven checkboxes, Monday first and named in full, with Every day, Weekdays and Weekends to fill
// them in one tap. The one off form's weekly days use it.

import type { Weekday } from '../../core/types';
import { useApp } from '../app/store';
import './daychips.css';

const NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const FILLS: readonly [string, Weekday[]][] = [
  ['Every day', [0, 1, 2, 3, 4, 5, 6]],
  ['Weekdays', [0, 1, 2, 3, 4]],
  ['Weekends', [5, 6]],
];

export function DayChips(props: { legend: string; days: readonly Weekday[]; onChange(days: Weekday[]): void }) {
  const { layout } = useApp();
  const toggle = (d: Weekday) =>
    props.onChange(props.days.includes(d) ? props.days.filter((x) => x !== d) : [...props.days, d].sort((a, b) => a - b));
  return (
    <fieldset className="daychipset stack8">
      <legend className="small quiet">{props.legend}</legend>
      <div className="daychipfill" role="group" aria-label="Fill in days">
        {FILLS.map(([label, days]) => (
          <button key={label} type="button" className={layout === 'phone' ? 'btn' : 'btn sm'} onClick={() => props.onChange(days)}>
            {label}
          </button>
        ))}
      </div>
      <div className="daychipbox">
        <div className="daychips">
          {NAMES.map((name, i) => {
            const d = i as Weekday;
            const on = props.days.includes(d);
            return (
              <label key={name} className={on ? 'dchip daychip on' : 'dchip daychip'}>
                <input type="checkbox" className="chipbox" aria-label={name} checked={on} onChange={() => toggle(d)} />
                <span aria-hidden="true">{name.slice(0, 3)}</span>
              </label>
            );
          })}
        </div>
      </div>
    </fieldset>
  );
}
