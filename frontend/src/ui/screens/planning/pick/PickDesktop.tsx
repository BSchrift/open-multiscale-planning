// Pick tasks on desktop: one list, this stretch first. Each project's name is over its tasks, with its overdue
// question on the milestone's line, then One offs, with the week's shape beside it. The lede line says how much is
// outside this stretch and where, and is the toggle; the end of the list repeats it. Select ticks rows that show to act
// on together.

import { useEffect, useId, useRef } from 'react';
import { asking, EmptyCard, OneOffsSection, Others, ProjectSection } from './Cards';
import type { ListProps } from './Cards';
import { ProjectAdder, useAdding, usePickAddMenu } from './Adders';
import { EndToggle, Lede, StretchLine, useOutside } from './Outside';
import type { Outside } from './Outside';
import { PastEnd } from './PastEnd';
import type { PickProps } from './PickStep';
import { SelectBar, useSelection } from './Select';
import { WeekShape } from './WeekShape';

/** Every row that can be selected: open, showing, and not asking for a new time. A folded row never is. */
export const selectable = (props: PickProps, out: Outside) =>
  [
    ...props.view.projects.filter((s) => out.visible(s)).flatMap((s) => s.groups.filter((g) => out.isOpen(s, g)).flatMap((g) => g.rows)),
    ...props.view.oneOffs.rows,
  ].filter((r) => !props.isDone(r) && !asking(r, false));

/** The list itself, the same at both sizes: projects, One offs, what can't be planned now, then the toggle again. */
export function PickList(props: ListProps & { descId: string }) {
  const { view, model, out } = props;
  return (
    <>
      {view.pastEnd.map(({ plan, status }) => (
        <div key={plan.project.id} className="card stack8" data-ask={plan.project.id} tabIndex={-1}>
          <PastEnd plan={plan} status={status} ctx={model.ctx} onSkip={() => props.skipPastEnd(plan.project.id)} />
        </div>
      ))}
      <div className="card plist">
        {view.projects.map((s) => (
          <ProjectSection key={s.plan.project.id} {...props} s={s} />
        ))}
        <OneOffsSection {...props} />
        <Others {...props} />
      </div>
      <EndToggle view={view} out={out} descId={props.descId} />
      <div className="sr" role="status" data-outside>
        {out.said}
      </div>
    </>
  );
}

export function PickDesktop(props: PickProps) {
  const { view } = props;
  const sel = useSelection();
  const adder = useAdding();
  const out = useOutside(view, props.week);
  const descId = useId();
  // + Add's task and milestone go to the first project that shows.
  usePickAddMenu(props, adder, view.projects.find((s) => out.visible(s))?.plan.project.id, sel.exit);
  const root = useRef<HTMLDivElement>(null);
  const selectRef = useRef<HTMLButtonElement>(null);
  const empty = view.projects.length === 0 && view.pastEnd.length === 0;
  const rows = selectable(props, out);
  const adding = rows.filter((r) => sel.has(r) && !r.c.picked);
  const preview = { project: adding.filter((r) => !r.oneOff).reduce((sum, r) => sum + r.adds, 0), oneOff: adding.filter((r) => r.oneOff).reduce((sum, r) => sum + r.adds, 0) };
  // Starting select mode puts focus on the first checkbox.
  useEffect(() => {
    if (sel.on) root.current?.querySelector<HTMLElement>('.selbox')?.focus();
  }, [sel.on]);
  const list = { ...props, phone: false, select: sel, adder, out };
  const projectAdder = <ProjectAdder {...props} adder={adder} onAdded={(id) => adder.setAdding({ kind: 'task', project: id })} />;

  return (
    <div ref={root} className="colC">
      <div className="cleft">
        <div className="between pickhead">
          <h2>Pick tasks for the week</h2>
          {!empty && (
            <button ref={selectRef} className="btn sm selbtn" type="button" aria-pressed={sel.on} onClick={() => (sel.on ? sel.exit() : sel.start())}>
              Select
            </button>
          )}
        </div>
        <Lede view={view} out={out} phone={false} descId={descId} />
        <StretchLine view={view} />
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
        {empty && <EmptyCard>{projectAdder}</EmptyCard>}
        <PickList {...list} descId={descId} />
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
