// The one way to set a time estimate or an aim: 15-minute steps to 2h, coarser to 16h. All the way left is none.

import { useId } from 'react';
import { formatMinutes } from '../../core/dates';
import type { Minutes } from '../../core/types';

export const EST_STEPS: readonly Minutes[] = [0, 15, 30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240, 300, 360, 420, 480, 600, 720, 960];

/** The nearest step to a value that may have come from elsewhere, such as a block's length. */
export function estIndex(minutes: Minutes): number {
  return EST_STEPS.reduce((best, step, i) => (Math.abs(step - minutes) < Math.abs(EST_STEPS[best]! - minutes) ? i : best), 0);
}

export function EstimateSlider(props: {
  /** Minutes, with 0 or null for none. */
  value: Minutes | null | undefined;
  onChange(minutes: Minutes): void;
  label: string;
  /** Hides the label visually, for when the row already says what it's for. */
  hideLabel?: boolean;
  /** What the leftmost position reads as. */
  noneLabel?: string;
}) {
  const id = useId();
  const value = props.value ?? 0;
  const text = value ? formatMinutes(value) : (props.noneLabel ?? 'No estimate');
  return (
    <div className="estslider">
      <label className={props.hideLabel ? 'sr' : 'small'} htmlFor={id}>
        {props.label}
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={EST_STEPS.length - 1}
        step={1}
        value={estIndex(value)}
        aria-valuetext={text}
        onChange={(event) => props.onChange(EST_STEPS[Number(event.target.value)] ?? 0)}
      />
      <span className="small estval">{text}</span>
    </div>
  );
}
