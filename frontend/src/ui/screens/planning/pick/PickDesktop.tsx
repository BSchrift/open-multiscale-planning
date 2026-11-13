// Pick tasks on desktop: a card per project, each with its overdue question inside it, then One offs, with the
// week's shape beside them. A link at the top jumps to what's overdue, and Select ticks rows to act on together.

import { useEffect, useRef, useState } from 'react';
import { ONE_OFFS_BUCKET } from '../../../../core/types';
import { Pill } from '../../../components/Pill';
import { Popover } from '../../../components/Popover';
import { asking, EmptyCard, Legend, OneOffsCard, OtherCard, ProjectCard, useOpenCards } from './Cards';
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

/** Every row that can be selected: open, in a card that's open. */
export const selectable = (props: PickProps, isOpen: (id: string) => boolean) => [
  ...props.view.projects.filter((p) => isOpen(p.plan.project.id)).flatMap((p) => p.groups.flatMap((g) => g.rows)),
  ...(isOpen(ONE_OFFS_BUCKET) ? props.view.oneOffs.rows : []),
].filter((r) => !props.isDone(r) && !asking(r, false));

export function PickDesktop(props: PickProps) {
  const { view, model } = props;
  const cards = useOpenCards(view);
  const sel = useSelection();
  const adder = useAdding();
  // + Add's task and milestone go to the first open project.
  usePickAddMenu(props, adder, cards, (view.projects.find((p) => cards.isOpen(p.plan.project.id)) ?? view.projects[0])?.plan.project.id, sel.exit);
  const root = useRef<HTMLDivElement>(null);
  const selectRef = useRef<HTMLButtonElement>(null);
  const keyRef = useRef<HTMLButtonElement>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const overdue = overdueCount(props);
  const empty = view.projects.length === 0 && view.pastEnd.length === 0;
  const rows = selectable(props, cards.isOpen);
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
  const card = { ...props, phone: false, select: sel, adder };
  const projectAdder = (
    <ProjectAdder
      {...props}
      adder={adder}
      onAdded={(id) => {
        cards.open(id);
        adder.setAdding({ kind: 'task', project: id });
      }}
    />
  );

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
            <div className="editrow">
              <button ref={keyRef} className="link small" type="button" aria-haspopup="dialog" aria-expanded={keyOpen} onClick={() => setKeyOpen(!keyOpen)}>
                Timeline key
              </button>
              {keyOpen && (
                <Popover
                  label="Timeline key"
                  onClose={() => {
                    setKeyOpen(false);
                    keyRef.current?.focus();
                  }}
                >
                  <Legend stretch={!!view.stretch} className="col" />
                </Popover>
              )}
            </div>
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
        {view.projects.map((s) => (
          <ProjectCard key={s.plan.project.id} {...card} s={s} open={cards.isOpen(s.plan.project.id)} toggle={() => cards.toggle(s.plan.project.id)} />
        ))}
        <OneOffsCard {...card} open={cards.isOpen(ONE_OFFS_BUCKET)} toggle={() => cards.toggle(ONE_OFFS_BUCKET)} />
        {view.others.map((o) => (
          <OtherCard key={o.plan.project.id} title={o.plan.project.title} pill={<Pill tone={o.status.tone}>{o.status.pill}</Pill>} sum={o.sum} />
        ))}
        {!empty && !sel.on && <div className="card pcd emptycard addcard">{projectAdder}</div>}
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
