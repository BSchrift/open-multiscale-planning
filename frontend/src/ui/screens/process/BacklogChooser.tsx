// A goal's backlog as the item's place. On desktop, B or Goal backlog swaps the picker for "Which goal's backlog?",
// where a goal's number, or a click, adds the item there, and Back or Esc puts the picker back. On phone, Goal backlog
// opens a sheet of goals with the last one used already chosen, so filing a run of items for one goal is two taps each.
// The button says where the item goes, never just "Send".

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Sheet } from '../../components/Sheet';

export interface BacklogGoal {
  id: string;
  title: string;
  /** Open tasks in its backlog. */
  open: number;
}

const tasksLine = (n: number) => (n === 0 ? 'No tasks yet' : n === 1 ? '1 task' : `${n} tasks`);

/** Desktop: the goals in place of the picker, numbered for their keys. */
export function BacklogChooser(props: {
  goals: readonly BacklogGoal[];
  /** Number keys need what every single key needs: the device setting, or Option or Alt held. */
  keysOn: boolean;
  cap(k: string): ReactNode;
  onAdd(goalId: string): void;
  onBack(): void;
}) {
  const { goals, keysOn, cap, onAdd, onBack } = props;
  const head = useId();
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ goals, keysOn, onAdd, onBack });
  latest.current = { goals, keysOn, onAdd, onBack };

  useEffect(() => ref.current?.querySelector<HTMLButtonElement>('button[data-goal]')?.focus(), []);
  // Its own listener, as the picker has, since the card catches Esc before React would.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKey = (event: KeyboardEvent) => {
      const now = latest.current;
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        now.onBack();
        return;
      }
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (!digit || event.metaKey || event.ctrlKey || !(now.keysOn || event.altKey)) return;
      const goal = now.goals[Number(digit) - 1];
      if (!goal) return;
      event.stopPropagation();
      event.preventDefault();
      now.onAdd(goal.id);
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div ref={ref} className="pxbacklogs" role="group" aria-labelledby={head}>
      <div className="between">
        <span id={head} className="strong">
          Which goal's backlog?
        </span>
        <button className="btn sm" type="button" onClick={onBack}>
          Back
          {/* Esc needs nothing held. */}
          <kbd className="keycap" aria-hidden="true">
            Esc
          </kbd>
        </button>
      </div>
      <div className="pxbacklogrows">
        {goals.map((g, i) => (
          <button
            key={g.id}
            className="btn pxbacklogrow"
            type="button"
            data-goal={g.id}
            aria-label={`Add to the backlog for ${g.title}, ${tasksLine(g.open)}`}
            {...(i < 9 ? { 'aria-keyshortcuts': `${i + 1} Alt+${i + 1}` } : {})}
            onClick={() => onAdd(g.id)}
          >
            {i < 9 && cap(String(i + 1))}
            <span className="grow">
              <span className="strong lineblock">{g.title}</span>
              <span className="small quiet lineblock">{tasksLine(g.open)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Phone: a sheet of goals, the last one used already chosen. It's only shown, never saved. */
export function BacklogSheet(props: { goals: readonly BacklogGoal[]; last: string; onAdd(goalId: string): void; onClose(): void }) {
  const { goals, onAdd, onClose } = props;
  const [chosen, setChosen] = useState(goals.some((g) => g.id === props.last) ? props.last : '');
  const goal = goals.find((g) => g.id === chosen);
  return (
    <Sheet label="Which goal's backlog?" tall onClose={onClose}>
      <div className="between">
        <h2>Which goal's backlog?</h2>
        <button className="btn" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="pxbacklogpick">
        {goals.map((g) => (
          <button key={g.id} className="pickrow" type="button" aria-pressed={g.id === chosen} onClick={() => setChosen(g.id)}>
            <span className="kring" aria-hidden="true" />
            <span className="grow">
              <span className="strong lineblock">{g.title}</span>
              <span className="small quiet lineblock">{tasksLine(g.open)}</span>
            </span>
          </button>
        ))}
      </div>
      <button className="btn pri" type="button" disabled={!goal} onClick={() => goal && onAdd(goal.id)}>
        {goal ? `Add to the backlog for ${goal.title}` : 'Choose a goal first'}
      </button>
    </Sheet>
  );
}
