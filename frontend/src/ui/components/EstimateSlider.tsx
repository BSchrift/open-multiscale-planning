// The one way to set a time estimate or an aim: 15-minute steps to 2h, coarser to 16h. All the way left is none.
//
// The thumb follows a drag step by step, but the value is passed on only once it's let go, and on each arrow key. Many
// callers save it, and every save re-reads each screen's data, so saving each step made a drag lag behind the mouse.

import { useEffect, useId, useRef, useState } from 'react';
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
  /** When a drag is let go, and on each arrow key. Not for a drag that ends where it started. */
  onChange(minutes: Minutes): void;
  label: string;
  /** Hides the label visually, for when the row already says what it's for. */
  hideLabel?: boolean;
  /** What the leftmost position reads as. */
  noneLabel?: string;
}) {
  const id = useId();
  const value = props.value ?? 0;
  // The step under the thumb while it moves. It holds until the value it was dragged from changes, so the thumb stays
  // where it was let go while a save reads back, and a value from elsewhere, such as a sync, still shows at once.
  const [moving, setMoving] = useState<{ step: number; from: Minutes } | null>(null);
  const held = moving && moving.from === value ? moving.step : null;
  const step = held ?? estIndex(value);
  // A value between steps, such as a block's length, reads as it is until the thumb moves.
  const shown = held === null ? value : (EST_STEPS[held] ?? 0);
  const text = shown ? formatMinutes(shown) : (props.noneLabel ?? 'No estimate');
  const input = useRef<HTMLInputElement>(null);
  const onChange = useRef(props.onChange);
  onChange.current = props.onChange;
  // The step last passed on, or the value's own, so letting go and then losing focus passes it on once.
  const passed = useRef({ value, step: estIndex(value) });
  if (passed.current.value !== value) passed.current = { value, step: estIndex(value) };
  // React's onChange comes at every step, as the input event does. The native change event comes when a drag is let
  // go and on each key; losing focus covers a drag whose change event never came.
  useEffect(() => {
    const el = input.current!;
    const pass = () => {
      const at = Number(el.value);
      // Back on the value's own step, it reads as the value again.
      if (at === estIndex(passed.current.value)) setMoving(null);
      if (at === passed.current.step) return;
      passed.current = { ...passed.current, step: at };
      onChange.current(EST_STEPS[at] ?? 0);
    };
    el.addEventListener('change', pass);
    el.addEventListener('blur', pass);
    return () => {
      el.removeEventListener('change', pass);
      el.removeEventListener('blur', pass);
    };
  }, []);
  return (
    <div className="estslider">
      <label className={props.hideLabel ? 'sr' : 'small'} htmlFor={id}>
        {props.label}
      </label>
      <input
        ref={input}
        id={id}
        type="range"
        min={0}
        max={EST_STEPS.length - 1}
        step={1}
        value={step}
        aria-valuetext={text}
        onChange={(event) => setMoving({ step: Number(event.target.value), from: value })}
      />
      <span className="small estval">{text}</span>
    </div>
  );
}
