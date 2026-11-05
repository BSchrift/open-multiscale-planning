// A task with its check circle. Ticking fills the circle and strikes through the title.

import type { ReactNode } from 'react';

/** The circle alone. Its 44pt target surrounds the visible circle. */
export function CheckCircle(props: { checked: boolean; label: string; onChange(checked: boolean, box: HTMLInputElement): void }) {
  return (
    <label className="checktarget">
      <input
        type="checkbox"
        className="checkcircle"
        aria-label={props.label}
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked, event.target)}
      />
    </label>
  );
}

export function TaskRow(props: {
  title: string;
  checked: boolean;
  onToggle(checked: boolean, box: HTMLInputElement): void;
  /** A quiet line under the title, such as its next date. */
  line?: ReactNode;
  /** Actions or details under the title. */
  children?: ReactNode;
}) {
  return (
    <div className="maintrow">
      <CheckCircle checked={props.checked} label={`${props.title} done`} onChange={props.onToggle} />
      <div className="grow">
        <div className={props.checked ? 'done' : undefined}>{props.title}</div>
        {props.line && <div className="small quiet">{props.line}</div>}
        {props.children}
      </div>
    </div>
  );
}
