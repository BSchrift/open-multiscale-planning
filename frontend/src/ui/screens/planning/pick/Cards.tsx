// Pick's list, the same at both sizes: one list, not a card per project. A project's name is a heading over its tasks,
// which sit under their milestones, and a project outside this stretch says why it shows, in words, inside the
// heading. An overdue question sits on its milestone's line and a task that needs a new time asks on its own row. Then
// One offs, the projects that can't be planned now, and a dashed card when there's nothing to plan from. Nothing here
// opens or closes: a project's tasks are always listed under its name.

import type { ReactNode } from 'react';
import { useNav } from '../../../app/nav';
import { MilestoneDiamond } from '../../../components/MilestoneDiamond';
import { Pill } from '../../../components/Pill';
import { useToast } from '../../../components/Toast';
import type { PickGroup, PickProject, PickTask } from './model';
import { CardAdder, OneOffAdder } from './Adders';
import type { AddingState } from './Adders';
import { AskRow, MilestoneLine } from './Overdue';
import { PickRow } from './PickRow';
import type { PickProps } from './PickStep';
import type { Selection } from './Select';

export interface ListProps extends PickProps {
  phone: boolean;
  select: Selection;
  adder: AddingState;
}

/** Needs a new time and not yet in the week: its row asks, rather than offering its time. */
export const asking = (r: PickTask, done: boolean) => r.c.carried && !r.c.picked && !done;

function Rows(props: ListProps & { rows: PickTask[]; describedBy?: string; source?: string }) {
  return (
    <ul className="picklist">
      {props.rows.map((r) =>
        asking(r, props.isDone(r)) ? <AskRow key={r.c.task.id} {...props} row={r} /> : <PickRow key={r.c.task.id} {...props} row={r} />,
      )}
    </ul>
  );
}

function Group(props: ListProps & { s: PickProject; group: PickGroup; head: string }) {
  const { group: g, s } = props;
  const ask = !!g.milestone && s.status.late?.id === g.milestone.id;
  if (!g.rows.length && !ask) return null;
  // A row of a project in this stretch is described by the project's heading; one outside it says where it's from.
  const where = g.outside ? { source: `, ${s.plan.project.title}, outside this stretch` } : { describedBy: props.head };
  return (
    <div className="pgroup">
      {ask ? (
        <MilestoneLine {...props} plan={s.plan} milestone={g.milestone!} group={g} outside={!s.inStretch} />
      ) : (
        g.key !== 'carried' && (
          <h4 className={`gh${g.late ? ' late' : ''}`} aria-label={`${g.isMs ? 'Milestone: ' : ''}${g.head}`}>
            {g.isMs && <MilestoneDiamond {...(g.state ? { state: g.state } : {})} />}
            {g.head}
          </h4>
        )
      )}
      {g.rows.length > 0 && <Rows {...props} rows={g.rows} {...where} />}
    </div>
  );
}

/** A project's name, with the reason it shows when it's outside this stretch: shown as a tag, read as part of the name. */
export function ProjectSection(props: ListProps & { s: PickProject }) {
  const { s, phone } = props;
  const { project } = s.plan;
  const head = `ph-${project.id}`;
  return (
    <section className="pproj" aria-label={project.title} data-project={project.id}>
      <h3 className="pph" id={head}>
        <span className="pn">{project.title}</span>
        {s.reason && (
          <>
            <span className={`rtag ${s.reason.tone}`.trim()} aria-hidden="true">
              {phone ? s.reason.short : s.reason.long}
            </span>
            <span className="sr">, {s.reason.sr}</span>
          </>
        )}
      </h3>
      {s.groups.map((g) => (
        <Group key={g.key} {...props} group={g} head={head} />
      ))}
      {s.groups.length === 0 && <p className="small quiet emptyline">No open tasks.</p>}
      {!props.select.on && <CardAdder {...props} plan={s.plan} />}
    </section>
  );
}

/** One offs, never filtered: those this week, then the rest, and what's still in the Inbox, with a way back to it. */
export function OneOffsSection(props: ListProps) {
  const { view } = props;
  const n = view.inbox;
  return (
    <section className="pproj oo" aria-label="One offs">
      <h3 className="pph">
        <span className="pn">One offs</span>
        <span className="ppr small">Not part of a project</span>
      </h3>
      {view.oneOffs.groups.map((g) => (
        <div key={g.key} className="pgroup">
          <h4 className="gh">{g.head}</h4>
          <Rows {...props} rows={g.rows} />
        </div>
      ))}
      {!view.oneOffs.rows.length && <p className="small quiet emptyline">Nothing due this week.</p>}
      {n > 0 && (
        <p className="pinbox small">
          {n} still in your Inbox. Sort them to pick them here.{' '}
          <button className="link small" type="button" onClick={props.onInbox}>
            Go to Inbox
          </button>
        </p>
      )}
      {!props.select.on && <OneOffAdder {...props} />}
    </section>
  );
}

/** A project that can't be planned now, such as a paused one: a line, with its open tasks counted. */
export function OtherLine(props: { title: string; pill: ReactNode; sum: string }) {
  return (
    <section className="pother" aria-label={props.title}>
      <span className="pn">{props.title}</span>
      {props.pill}
      <span className="small pmr">{props.sum}</span>
    </section>
  );
}

export function Others(props: ListProps) {
  return (
    <>
      {props.view.others.map((o) => (
        <OtherLine key={o.plan.project.id} title={o.plan.project.title} pill={<Pill tone={o.status.tone}>{o.status.pill}</Pill>} sum={o.sum} />
      ))}
    </>
  );
}

/** No projects yet: the way to Goals, where projects are made. */
export function EmptyCard(props: { children?: ReactNode }) {
  const nav = useNav();
  const toast = useToast();
  return (
    <div className="card emptycard">
      <p>No projects to plan from yet.</p>
      <div className="row">
        {props.children}
        <button
          className="link small"
          type="button"
          onClick={() => {
            nav.go('goals');
            toast.show('Your plan is kept.');
          }}
        >
          Go to Goals
        </button>
      </div>
    </div>
  );
}
