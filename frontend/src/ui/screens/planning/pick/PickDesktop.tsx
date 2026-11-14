// Pick tasks on desktop: one list, each project's name over its tasks with its overdue question on the milestone's
// line, then One offs, with the week's shape beside it. A link at the top jumps to what's overdue, and Select ticks
// rows to act on together.

import { useEffect, useRef } from 'react';
import { asking, EmptyCard, OneOffsSection, Others, ProjectSection } from './Cards';
import { ProjectAdder, useAdding, usePickAddMenu } from './Adders';
import { PastEnd } from './PastEnd';
import type { PickProps } from './PickStep';
import { SelectBar, useSelection } from './Select';
import { WeekShape } from './WeekShape';

/** Everything still asking a question: overdue milestones, and tasks that need a new time not yet in the week. */
export function overdueCount(props: PickProps) {
  const { view } = props;
  const rows = [...view.projects.flatMap((p) => p.groups.flatMap((g) => g.rows)), ...view.oneOffs.rows];
  return view.projects.filter((p) => p.status.late).length + rows.filter((r) => asking(r, props.isDone(r))).length;
}

/** Every row that can be selected: open, and not asking for a new time. */
export const selectable = (props: PickProps) =>
  [...props.view.projects.flatMap((p) => p.groups.flatMap((g) => g.rows)), ...props.view.oneOffs.rows].filter((r) => !props.isDone(r) && !asking(r, false));

export function PickDesktop(props: PickProps) {
  const { view, model } = props;
  const sel = useSelection();
  const adder = useAdding();
  // + Add's task and milestone go to the first project.
  usePickAddMenu(props, adder, view.projects[0]?.plan.project.id, sel.exit);
  const root = useRef<HTMLDivElement>(null);
  const selectRef = useRef<HTMLButtonElement>(null);
  const overdue = overdueCount(props);
  const empty = view.projects.length === 0 && view.pastEnd.length === 0;
  const rows = selectable(props);
  const adding = rows.filter((r) => sel.has(r) && !r.c.picked);
  const preview = { project: adding.filter((r) => !r.oneOff).reduce((sum, r) => sum + r.adds, 0), oneOff: adding.filter((r) => r.oneOff).reduce((sum, r) => sum + r.adds, 0) };
  // Starting select mode puts focus on the first checkbox.
  useEffect(() => {
    if (sel.on) root.current?.querySelector<HTMLElement>('.selbox')?.focus();
  }, [sel.on]);
  const jump = () => {
    const ask = root.current?.querySelector<HTMLElement>('[data-ask]');
    ask?.scrollIntoView?.({ block: 'center' });
    ask?.focus();
  };
  const list = { ...props, phone: false, select: sel, adder };
  const projectAdder = <ProjectAdder {...props} adder={adder} onAdded={(id) => adder.setAdding({ kind: 'task', project: id })} />;

  return (
    <div ref={root} className="colC">
      <div className="cleft">
        <div className="between pickhead">
          <div>
            <h2>Pick tasks for the week</h2>
            <p className="small quiet">Add what you want to do this week. Nothing is in the plan until you add it.</p>
          </div>
          <div className="row">
            {overdue > 0 && (
              <button className="link small" type="button" onClick={jump}>
                {overdue} overdue
              </button>
            )}
            {!empty && (
              <button ref={selectRef} className="btn sm selbtn" type="button" aria-pressed={sel.on} onClick={() => (sel.on ? sel.exit() : sel.start())}>
                Select
              </button>
            )}
          </div>
        </div>
        {sel.on && (
          <SelectBar
            {...props}
            rows={rows}
            sel={sel}
            phone={false}
            onCancel={() => {
              sel.exit();
              selectRef.current?.focus();
            }}
          />
        )}
        {view.pastEnd.map(({ plan, status }) => (
          <div key={plan.project.id} className="card stack8">
            <PastEnd plan={plan} status={status} ctx={model.ctx} onSkip={() => props.skipPastEnd(plan.project.id)} />
          </div>
        ))}
        {empty && <EmptyCard>{projectAdder}</EmptyCard>}
        <div className="card plist">
          {view.projects.map((s) => (
            <ProjectSection key={s.plan.project.id} {...list} s={s} />
          ))}
          <OneOffsSection {...list} />
          <Others {...list} />
        </div>
        {!empty && !sel.on && <div className="addline">{projectAdder}</div>}
        <div className="sr" role="status">
          {props.said}
        </div>
      </div>
      <div className="cright">
        <WeekShape {...props} phone={false} preview={preview} />
      </div>
    </div>
  );
}
