// Opening a task's popup, from anywhere a task shows: its name as a button, with a mark when it has details. Rows
// whose tap already does something keep it, and their name opens the popup.

import { useCallback } from 'react';
import { useNav } from '../../app/nav';
import { NoteMark } from '../notes/NoteMark';
import './task.css';

/** Opens the task popup over everything. The note is a line under its heading, such as why a task is suggested. */
export function useOpenTask() {
  const { openOverlay } = useNav();
  return useCallback((id: string, note?: string) => openOverlay('task', note ? { task: id, note } : { task: id }), [openOverlay]);
}

export function TaskName(props: { id: string; title: string; details?: boolean; className?: string; label?: string; note?: string }) {
  const open = useOpenTask();
  return (
    <button className={`taskname${props.className ? ` ${props.className}` : ''}`} type="button" aria-label={props.label} onClick={() => open(props.id, props.note)}>
      {props.title}
      {props.details && <NoteMark />}
    </button>
  );
}
