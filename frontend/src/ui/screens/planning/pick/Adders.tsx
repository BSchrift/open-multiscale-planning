// Adding while you pick: one adder at the foot of each project's tasks, "+ Task · + Milestone", "+ One off" at the
// foot of One offs, and "+ Add project" after the list, as the stretch flow adds while it plans. The task form is
// TaskEditor, with a This week tick that starts on and its milestone on the last one used; + Milestone takes a name
// and an optional date, then opens the task form under it; + Add project is ProjectAdd with its goal. Each add saves at
// once with a toast whose Undo deletes it, so the forms close with Close, not Cancel.

import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { isDay } from '../../../../core/dates';
import type { ProjectPlan } from '../../../../core/plan';
import { ProjectAdd, TaskEditor } from '../../../components/editors';
import { SheetOnPhone } from '../../../components/editors/SheetOnPhone';
import { OneOffForm } from '../../../components/oneoff';
import { useNav } from '../../../app/nav';
import type { AddItem } from '../../../components/AddMenu';
import { useAddItems } from '../WeekFit';
import type { PickProps } from './PickStep';

/** What's being added, and where. */
export type Adding = { kind: 'task'; project: string; milestone?: string | null } | { kind: 'milestone'; project: string } | { kind: 'project' } | { kind: 'oneoff' } | null;

export function useAdding() {
  const [adding, setAdding] = useState<Adding>(null);
  // The milestone each project's task form starts on: the last one used there.
  const [last, setLast] = useState<Record<string, string | null>>({});
  return { adding, setAdding, last, setLast };
}
export type AddingState = ReturnType<typeof useAdding>;

/**
 * What + Add offers on Pick: a task or milestone in the project in view, a one off, a project, or a task to the Inbox,
 * where + used to capture on phone. before() runs first, such as to show the list.
 */
export function usePickAddMenu(props: PickProps, adder: AddingState, inView: string | undefined, before: () => void) {
  const nav = useNav();
  const project = props.view.projects.find((p) => p.plan.project.id === inView)?.plan.project;
  const go = (run: () => void) => () => {
    before();
    run();
  };
  const items: AddItem[] = [
    ...(project ? [{ label: `Task in ${project.title}`, onPick: go(() => adder.setAdding({ kind: 'task', project: project.id })) }] : []),
    { label: 'One off', onPick: go(() => adder.setAdding({ kind: 'oneoff' })) },
    ...(project ? [{ label: `Milestone in ${project.title}`, onPick: go(() => adder.setAdding({ kind: 'milestone', project: project.id })) }] : []),
    { label: 'Project', onPick: go(() => adder.setAdding({ kind: 'project' })) },
    { label: 'Task to Inbox', onPick: () => nav.openOverlay('capture') },
  ];
  useAddItems(items);
}

/** The foot of a project's tasks: its adder, or the form it opened. */
export function CardAdder(props: PickProps & { plan: ProjectPlan; phone: boolean; adder: AddingState }) {
  const { plan, adder: add, model } = props;
  const { project } = plan;
  const a = add.adding;
  const here = a && 'project' in a && a.project === project.id ? a : null;
  const back = (id: string) => () => {
    add.setAdding(null);
    setTimeout(() => document.getElementById(id)?.focus());
  };
  const taskId = `addtask-${project.id}`;
  const msId = `addms-${project.id}`;
  if (here?.kind === 'task') {
    const start = here.milestone !== undefined ? here.milestone : (add.last[project.id] ?? firstMilestone(plan));
    return (
      <TaskEditor
        plan={plan}
        ctx={model.ctx}
        milestoneId={start}
        inPlace
        label={`New task in ${project.title}`}
        week
        write={(fields, inWeek) => props.addTask(plan, fields, inWeek)}
        onAdded={(_, milestone) => add.setLast((l) => ({ ...l, [project.id]: milestone }))}
        onClose={back(taskId)}
      />
    );
  }
  if (here?.kind === 'milestone') {
    return (
      <MilestoneForm
        {...props}
        onAdded={(id) => add.setAdding({ kind: 'task', project: project.id, milestone: id })}
        onClose={back(msId)}
      />
    );
  }
  return (
    <div className="pkadd">
      <button id={taskId} className="addlink" type="button" aria-label={`Add task to ${project.title}`} onClick={() => add.setAdding({ kind: 'task', project: project.id })}>
        + Task
      </button>
      <span className="dot" aria-hidden="true">
        ·
      </span>
      <button id={msId} className="addlink" type="button" aria-label={`Add milestone to ${project.title}`} onClick={() => add.setAdding({ kind: 'milestone', project: project.id })}>
        + Milestone
      </button>
    </div>
  );
}

/** The next milestone not yet met, for a project's first task form. */
const firstMilestone = (plan: ProjectPlan) => plan.milestones.find((m) => !m.dropped_at && !plan.tasks.every((t) => t.milestone_id !== m.id || t.done_at))?.id ?? plan.milestones.find((m) => !m.dropped_at)?.id ?? null;

/** A milestone's name and, if it has one yet, its date. Add makes it and opens the task form under it. */
function MilestoneForm(props: PickProps & { plan: ProjectPlan; phone: boolean; onAdded(id: string): void; onClose(): void }) {
  const { plan } = props;
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [error, setError] = useState('');
  const btn = props.phone ? 'btn' : 'btn sm';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) return setError('Give it a name.');
    if (due && !isDay(due)) return setError('Pick a date, or leave it empty.');
    const id = await props.addMilestone(plan, name, due || null);
    if (id) props.onAdded(id);
  };
  return (
    <SheetOnPhone label={`New milestone in ${plan.project.title}`} onClose={props.onClose}>
      <form className="addform stack8" aria-label={`New milestone in ${plan.project.title}`} noValidate onSubmit={submit}>
        <span className="small strong">New milestone in {plan.project.title}</span>
        <div className={props.phone ? 'stack8' : 'row'}>
          <input
            className="field grow"
            autoFocus
            aria-label="Milestone name"
            placeholder="Milestone name"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setError('');
            }}
          />
          <label className={props.phone ? 'popfield' : 'row small'}>
            Date (optional)
            <input className="field datefield" type="date" value={due} onChange={(event) => setDue(event.target.value)} />
          </label>
        </div>
        {error && (
          <div className="fielderr" role="alert">
            {error}
          </div>
        )}
        <div className="row">
          <button className={`${btn} pri`} type="submit">
            Add
          </button>
          <button className={btn} type="button" onClick={props.onClose}>
            Close
          </button>
        </div>
      </form>
    </SheetOnPhone>
  );
}

/** One offs' foot: + One off, or its form, with a This week tick that starts on. */
export function OneOffAdder(props: PickProps & { phone: boolean; adder: AddingState }) {
  const { adder: add } = props;
  const [inWeek, setInWeek] = useState(true);
  const close = () => {
    add.setAdding(null);
    setTimeout(() => document.getElementById('addoneoff')?.focus());
  };
  if (add.adding?.kind === 'oneoff') {
    return (
      <SheetOnPhone label="Add a one off" onClose={close}>
        <OneOffForm
          onSave={(fields) => props.addOneOff(fields, inWeek)}
          onCancel={close}
          extra={
            <label className="row small weektick">
              <input type="checkbox" checked={inWeek} onChange={(event) => setInWeek(event.target.checked)} />
              This week
            </label>
          }
        />
      </SheetOnPhone>
    );
  }
  return (
    <div className="pkadd">
      <button id="addoneoff" className="addlink oo" type="button" aria-label="Add a one off" onClick={() => add.setAdding({ kind: 'oneoff' })}>
        + One off
      </button>
    </div>
  );
}

/** The dashed card after the projects: + Add project, or ProjectAdd with its goal. */
export function ProjectAdder(props: PickProps & { adder: AddingState; onAdded(id: string): void }) {
  const { adder: add } = props;
  const added = useRef(false);
  if (add.adding?.kind === 'project') {
    return (
      <ProjectAdd
        objectiveId={null}
        goals={props.goals}
        write={props.addProject}
        onAdded={(id) => {
          added.current = true;
          props.onAdded(id);
        }}
        onClose={() => {
          // Once added, the new project's task form has taken over, and focus with it.
          if (added.current) return;
          add.setAdding(null);
          setTimeout(() => document.getElementById('addproject')?.focus());
        }}
      />
    );
  }
  return (
    <button
      id="addproject"
      className="btn sm"
      type="button"
      onClick={() => {
        added.current = false;
        add.setAdding({ kind: 'project' });
      }}
    >
      + Add project
    </button>
  );
}
