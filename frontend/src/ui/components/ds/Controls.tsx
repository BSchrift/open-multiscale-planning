// The design system's smaller controls (docs/design.md): a toggle chip, a switch, a segmented control and a labelled
// text field. Each keeps the native element and its keyboard behaviour; the look is in ds.css.

import { useId } from 'react';
import type { ComponentPropsWithRef, ReactNode } from 'react';

/** A toggle chip, such as a day or a filter: a button that says whether it's on. */
export function Chip(props: Omit<ComponentPropsWithRef<'button'>, 'type'> & { pressed: boolean }) {
  const { pressed, className, ...rest } = props;
  return <button {...rest} type="button" className={`chip${className ? ` ${className}` : ''}`} aria-pressed={pressed} />;
}

/** An on-off setting, such as Add to this week: a switch named by its label, the track and thumb drawn beside it. */
export function Switch(props: { checked: boolean; onChange(next: boolean): void; label: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      className={`switch${props.className ? ` ${props.className}` : ''}`}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="switchlabel">{props.label}</span>
      {props.children}
      <span className="switchtrack" aria-hidden="true">
        <span className="switchthumb" />
      </span>
    </button>
  );
}

/** Two or three views of one thing, such as Calendar and List: a group of buttons with the chosen one pressed. */
export function Segmented<T extends string>(props: { label: string; options: readonly (readonly [NoInfer<T>, string])[]; value: T; onChange(value: T): void }) {
  return (
    <div className="seg" role="group" aria-label={props.label}>
      {props.options.map(([value, text]) => (
        <button key={value} type="button" aria-pressed={props.value === value} onClick={() => props.onChange(value)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** A text field with its label above, and help and error text tied to it for screen readers. */
export function TextField(props: Omit<ComponentPropsWithRef<'input'>, 'onChange'> & { label: string; onChange(value: string): void; help?: string; error?: string }) {
  const { label, onChange, help, error, className, ...rest } = props;
  const id = useId();
  const described = [help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`textfield${className ? ` ${className}` : ''}`}>
      <label htmlFor={id}>{label}</label>
      <input {...rest} id={id} className="field" aria-describedby={described} aria-invalid={error ? true : undefined} onChange={(e) => onChange(e.target.value)} />
      {help && (
        <span id={`${id}-help`} className="fieldhelp">
          {help}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} className="fielderr">
          {error}
        </span>
      )}
    </div>
  );
}
