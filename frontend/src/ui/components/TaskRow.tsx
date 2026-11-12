// A task with its check circle. Ticking fills the circle and strikes through the title, and the title opens the task.

import type { ReactNode } from 'react';
import { NoteMark } from './notes/NoteMark';
import './task/task.css';

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
  /** Whether it has details, such as a description, which a mark beside the title shows. */
  details?: boolean;
  /** Opens the task, from its title. */
  onOpen?(): void;
  /** Actions or details under the title. */
  children?: ReactNode;
}) {
  return (
    <div className="maintrow">
      <CheckCircle checked={props.checked} label={`${props.title} done`} onChange={props.onToggle} />
      <div className="grow">
        <div className={props.checked ? 'done' : undefined}>
          {props.onOpen ? (
            <button className="taskname rowname" type="button" onClick={props.onOpen}>
              {props.title}
              {props.details && <NoteMark />}
            </button>
          ) : (
            <>
              {props.title}
              {props.details && <NoteMark />}
            </>
          )}
        </div>
        {props.line && <div className="small quiet">{props.line}</div>}
        {props.children}
      </div>
    </div>
  );
}
