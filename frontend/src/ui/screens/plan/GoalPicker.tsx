// Goals, projects and practices made or linked while planning: a picker of goals, a select for a practice, and a New
// goal field beside either that makes the goal and links it in one write. Every write goes through act, so each has
// Undo.

import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { formatDate, nowInstant } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import { newId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import type { Fields, Objective } from '../../../core/types';
import { useApp } from '../../app/store';
import { Popover } from '../../components/Popover';
import type { Act } from './model';

/** What can be linked: the goal of a project or of a practice. */
export interface Linked {
  type: 'project' | 'practice';
  id: string;
  title: string;
  goal: string | null;
}

/** + New goal is a quiet link on desktop, and a button you can tap on phone. */
const newGoalClass = (layout: string) => (layout === 'phone' ? 'btn' : 'link small');

/** Goals a practice or project can link to: any that isn't archived. */
export const linkable = (goals: readonly Objective[]) => goals.filter((g) => g.state !== 'archived' && !g.deleted_at);

/** A goal, project or practice made in one write, whose Undo deletes it again. Each resolves to the new id once saved. */
export function useAdd(act: Act) {
  const { clock } = useApp();
  const add = async <T extends 'objective' | 'project' | 'practice'>(type: T, fields: Fields<T>, text: string) => {
    const id = newId(clock);
    const saved = await act(`add-${id}`, text, async (w) => {
      await w.create(type, fields, id);
      return { writes: [{ type, id, fields: { deleted_at: nowInstant(clock) } }] };
    });
    return saved ? id : undefined;
  };
  return {
    goal: (title: string) => add('objective', { title, state: 'active' }, `Added goal ${title}.`),
    project: (fields: Fields<'project'>) =>
      add('project', fields, `Added project ${fields.title}, ${formatDate(fields.start!)} to ${formatDate(fields.end!)}.`),
    practice: (fields: Fields<'practice'>) => add('practice', fields, `Added practice ${fields.title}.`),
  };
}

/** The writes behind every link: to a goal there is, or to a new one made in the same write. */
export function useLink(act: Act, goals: readonly Objective[]) {
  const { clock } = useApp();
  const name = (id: string | null) => goals.find((g) => g.id === id)?.title;
  const relink = (w: Writer, item: Linked, goal: string | null): Promise<PlanChange> =>
    applyPlanChange(w, { writes: [{ type: item.type, id: item.id, fields: { objective_id: goal } }] });
  return {
    pick: (item: Linked, goal: string | null) =>
      act(`link-${item.id}`, goal ? `${item.title} now under ${name(goal)}.` : `${item.title} has no goal now.`, (w) => relink(w, item, goal)),
    make: (item: Linked, title: string) =>
      act(`link-${item.id}`, `Added goal ${title} and linked ${item.title}.`, async (w) => {
        const id = newId(clock);
        await w.create('objective', { title, state: 'active' }, id);
        const back = await relink(w, item, id);
        return { writes: [...back.writes, { type: 'objective', id, fields: { deleted_at: nowInstant(clock) } }] };
      }),
  };
}

/** A goal's name, added with Enter or its button. Esc goes back, without closing whatever it sits in. */
export function NewGoalForm(props: { label: string; submit: string; onAdd(title: string): Promise<boolean>; onCancel?(): void; autoFocus?: boolean }) {
  const { layout } = useApp();
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const btn = layout === 'phone' ? 'btn' : 'btn sm';
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) return setError('Give it a name.');
    if (await props.onAdd(name)) setTitle('');
  };
  return (
    <form
      className="stack8 newgoal"
      aria-label={props.submit}
      onSubmit={save}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !props.onCancel) return;
        event.stopPropagation();
        props.onCancel();
      }}
    >
      <div className={layout === 'phone' ? 'row' : 'row nowrap'}>
        <input
          className="field grow"
          aria-label={props.label}
          placeholder={props.label}
          autoFocus={props.autoFocus ?? true}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setError('');
          }}
        />
        <button className={`${btn} pri`} type="submit">
          {props.submit}
        </button>
        {props.onCancel && (
          <button className={btn} type="button" onClick={props.onCancel}>
            Cancel
          </button>
        )}
      </div>
      {error && (
        <div className="fielderr" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}

/** Every goal, No goal, and + New goal. A choice applies at once and closes it. */
export function GoalPicker(props: { item: Linked; goals: readonly Objective[]; act: Act; onClose(): void }) {
  const { item } = props;
  const { layout } = useApp();
  const link = useLink(props.act, props.goals);
  const [adding, setAdding] = useState(false);
  const btn = layout === 'phone' ? 'btn' : 'btn sm';
  const rows = [...linkable(props.goals).map((g) => ({ id: g.id as string | null, title: g.title })), { id: null, title: 'No goal' }];
  const pick = async (goal: string | null) => {
    props.onClose();
    if (goal !== item.goal) await link.pick(item, goal);
  };
  return (
    <Popover label={`Goal for ${item.title}`} onClose={props.onClose}>
      {layout === 'phone' && <h2>Goal for {item.title}</h2>}
      <div className="stack8 goalpick">
        {rows.map((r) => (
          <button key={r.id ?? 'none'} className={`${btn} pickrow`} type="button" aria-pressed={r.id === item.goal} onClick={() => void pick(r.id)}>
            {r.title}
          </button>
        ))}
      </div>
      {adding ? (
        <NewGoalForm
          label="New goal name"
          submit="Add and link"
          onCancel={() => setAdding(false)}
          onAdd={async (title) => {
            const saved = await link.make(item, title);
            if (saved) props.onClose();
            return saved;
          }}
        />
      ) : (
        <div>
          <button className={newGoalClass(layout)} type="button" onClick={() => setAdding(true)}>
            + New goal
          </button>
        </div>
      )}
    </Popover>
  );
}

/** A practice's goal, as a select named for it, with + New goal after it. */
export function GoalField(props: { item: Linked; goals: readonly Objective[]; act: Act }) {
  const { item } = props;
  const { layout } = useApp();
  const link = useLink(props.act, props.goals);
  const [adding, setAdding] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const back = () => {
    setAdding(false);
    setTimeout(() => selectRef.current?.focus());
  };
  return (
    <div className="stack8">
      <label className="popfield">
        Goal
        <select
          ref={selectRef}
          className="field"
          aria-label={`Goal for ${item.title}`}
          value={item.goal ?? ''}
          onChange={(event) => void link.pick(item, event.target.value || null)}
        >
          <option value="">No goal</option>
          {linkable(props.goals).map((g) => (
            <option key={g.id} value={g.id}>
              {g.title}
            </option>
          ))}
        </select>
      </label>
      {adding ? (
        <NewGoalForm
          label="New goal name"
          submit="Add and link"
          onCancel={back}
          onAdd={async (title) => {
            const saved = await link.make(item, title);
            if (saved) back();
            return saved;
          }}
        />
      ) : (
        <div>
          <button className={newGoalClass(layout)} type="button" aria-label={`New goal for ${item.title}`} onClick={() => setAdding(true)}>
            + New goal
          </button>
        </div>
      )}
    </div>
  );
}
