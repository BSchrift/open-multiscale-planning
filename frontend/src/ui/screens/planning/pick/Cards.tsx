// Pick's cards, the same at both sizes: one per project with its pill, aim and a thin timeline, then its overdue
// question, then its tasks under their milestones; One offs in purple; the projects that can't be planned now, quietly;
// and a dashed card when there's nothing to plan from.

import type { ReactNode } from 'react';
import type { AimRow } from '../../../../core/capacity';
import { formatMinutes } from '../../../../core/dates';
import type { Minutes } from '../../../../core/types';
import { MilestoneDiamond } from '../../../components/MilestoneDiamond';
import { Pill } from '../../../components/Pill';
import { TimelineBar } from '../../../components/TimelineBar';
import { useNav } from '../../../app/nav';
import { useToast } from '../../../components/Toast';
import { useStickyState } from '../../../app/store';
import { ONE_OFFS_BUCKET } from '../../../../core/types';
import { aimWords } from './model';
import type { PickGroup, PickProject, PickTask, PickView } from './model';
import { CardAdder, OneOffAdder } from './Adders';
import type { AddingState } from './Adders';
import { CarriedAsk, MilestoneAsk } from './Overdue';
import { PickRow } from './PickRow';
import type { PickProps } from './PickStep';
import type { Selection } from './Select';

/**
 * Which cards are open: each as it was last left on this device, else every one when there are four projects or fewer,
 * else the first with overdue work or suggestions.
 */
export function useOpenCards(view: PickView) {
  const [stored, setStored] = useStickyState<Record<string, boolean>>('pick.open', {});
  const busy = (rows: readonly PickTask[]) => rows.some((r) => r.hint || asking(r, false));
  const first =
    view.projects.find((p) => p.status.late || busy(p.groups.flatMap((g) => g.rows)))?.plan.project.id ?? (busy(view.oneOffs.rows) ? ONE_OFFS_BUCKET : undefined);
  const isOpen = (id: string) => stored[id] ?? (view.projects.length <= 4 || id === first);
  return { isOpen, toggle: (id: string) => setStored({ ...stored, [id]: !isOpen(id) }), open: (id: string) => !isOpen(id) && setStored({ ...stored, [id]: true }) };
}

export function AimMeter(props: { aim: AimRow }) {
  const w = aimWords(props.aim);
  return (
    <>
      <span className="mmeter" role="img" aria-label={w.alt}>
        {/* Short of its aim, or past it, is calm blue, never amber, which means over the week's open time. Green is met. */}
        <span className={`mfill ${props.aim.got > props.aim.aim && !props.aim.skipped ? 'calm' : w.cls || 'calm'}`} style={{ width: `${props.aim.pct}%` }} />
        <span className="mtick" style={{ left: `${props.aim.tickPct}%` }} />
      </span>
      <span>{w.value}</span>
    </>
  );
}

export interface CardProps extends PickProps {
  phone: boolean;
  select: Selection;
  adder: AddingState;
}

/** Needs a new time and not yet in the week: asked about above the card's tasks, not listed among them. */
export const asking = (r: PickTask, done: boolean) => r.c.carried && !r.c.picked && !done;

function Rows(props: CardProps & { rows: PickTask[] }) {
  return (
    <ul className="picklist">
      {props.rows.map((r) => (
        <PickRow key={r.c.task.id} {...props} row={r} />
      ))}
    </ul>
  );
}

function Group(props: CardProps & { group: PickGroup }) {
  const { group: g } = props;
  const rows = g.rows.filter((r) => !asking(r, props.isDone(r)));
  if (!rows.length) return null;
  return (
    <>
      <h3 className={`gh${g.late ? ' late' : ''}`} aria-label={`${g.isMs ? 'Milestone: ' : ''}${g.head}${g.isMs && g.planned > 0 ? `, ${formatMinutes(g.planned)} planned` : ''}`}>
        <span className="ghl">
          {g.isMs && <MilestoneDiamond {...(g.state ? { state: g.state } : {})} />}
          {g.head}
        </span>
        {g.isMs && g.planned > 0 && <span className="ghr">{formatMinutes(g.planned)} planned</span>}
      </h3>
      <Rows {...props} rows={rows} />
    </>
  );
}

function Card(props: {
  name: string;
  /** A project's id, for what + Add finds in view. */
  project?: string;
  open: boolean;
  toggle(): void;
  planned: Minutes;
  className?: string;
  head?: ReactNode;
  meter: ReactNode;
  strip?: ReactNode;
  asks?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`card pcd${props.className ? ` ${props.className}` : ''}`} aria-label={props.name} data-project={props.project}>
      <div className="pcdh">
        <button className="pchev" type="button" aria-expanded={props.open} aria-label={`${props.name}, ${formatMinutes(props.planned)} planned`} onClick={props.toggle}>
          <span className={`chev2${props.open ? ' open' : ''}`} aria-hidden="true">
            ›
          </span>
          <span className="pn">{props.name}</span>
        </button>
        {props.head}
        <span className="pmr">{props.meter}</span>
      </div>
      {props.strip}
      {props.asks}
      {props.open && (
        <div className="pcbody" role="group" aria-label={`${props.name} tasks`}>
          {props.children}
        </div>
      )}
    </section>
  );
}

export function ProjectCard(props: CardProps & { s: PickProject; open: boolean; toggle(): void }) {
  const { s, view, phone } = props;
  const { project } = s.plan;
  const late = s.status.late;
  const carried = s.groups.flatMap((g) => g.rows).filter((r) => asking(r, props.isDone(r)));
  // On phone a pill shows only when something needs you.
  const pill = phone && !late && s.status.pill === 'On track' ? null : <Pill tone={s.status.tone}>{s.status.pill}</Pill>;
  return (
    <Card
      name={project.title}
      project={project.id}
      open={props.open}
      toggle={props.toggle}
      planned={s.planned}
      head={
        <>
          {pill}
          {!props.open && s.hintN > 0 && <span className="pstar small">★ {s.hintN} suggested</span>}
        </>
      }
      meter={s.aim ? <AimMeter aim={s.aim} /> : <span>{formatMinutes(s.planned)} planned</span>}
      strip={
        <div className="pcstrip">
          <TimelineBar
            axis={view.axis}
            bar={{ start: project.start, end: project.end }}
            {...(view.stretch ? { stretch: view.stretch } : {})}
            week={view.weekSpan}
            diamonds={s.marks}
            alt={s.alt}
          />
        </div>
      }
      asks={
        <>
          {late && <MilestoneAsk {...props} plan={s.plan} milestone={late} />}
          {carried.map((r) => (
            <CarriedAsk key={r.c.task.id} {...props} row={r} />
          ))}
        </>
      }
    >
      {s.groups.map((g) => (
        <Group key={g.key} {...props} group={g} />
      ))}
      {s.groups.length === 0 && <p className="small quiet emptyline">No open tasks.</p>}
      {!props.select.on && <CardAdder {...props} plan={s.plan} />}
    </Card>
  );
}

export function OneOffsCard(props: CardProps & { open: boolean; toggle(): void }) {
  const { view } = props;
  const carried = view.oneOffs.rows.filter((r) => asking(r, props.isDone(r)));
  const rows = view.oneOffs.rows.filter((r) => !asking(r, props.isDone(r)));
  return (
    <Card
      name="One offs"
      className="oo"
      open={props.open}
      toggle={props.toggle}
      planned={view.oneOffs.planned}
      meter={view.oneOffs.aim ? <AimMeter aim={view.oneOffs.aim} /> : <span>{formatMinutes(view.oneOffs.planned)} planned</span>}
      asks={carried.map((r) => (
        <CarriedAsk key={r.c.task.id} {...props} row={r} />
      ))}
    >
      {rows.length ? <Rows {...props} rows={rows} /> : <p className="small quiet emptyline">Nothing due this week.</p>}
      {!props.select.on && <OneOffAdder {...props} />}
    </Card>
  );
}

/** A project that can't be planned now, such as a paused one. */
export function OtherCard(props: { title: string; pill: ReactNode; sum: string }) {
  return (
    <section className="card pcd muted" aria-label={props.title}>
      <div className="pcdh">
        <span className="pn">{props.title}</span>
        {props.pill}
        <span className="small pmr">{props.sum}</span>
      </div>
    </section>
  );
}

/** No projects yet: the way to Goals, where projects are made. */
export function EmptyCard(props: { children?: ReactNode }) {
  const nav = useNav();
  const toast = useToast();
  return (
    <div className="card pcd emptycard">
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

export function Legend(props: { stretch: boolean; className?: string }) {
  return (
    <div className={`legend pklegend ${props.className ?? ''}`.trim()}>
      <span>
        <i className="lg-dates" />
        Project dates
      </span>
      <span>
        <i className="lg-week" />
        This week
      </span>
      {props.stretch && (
        <span>
          <i className="lg-stretch" />
          This stretch. Projects keep their own dates.
        </span>
      )}
      <span>
        <MilestoneDiamond state={{ on: true }} />
        In the plan
      </span>
      <span>
        <MilestoneDiamond />
        Not in the plan
      </span>
      <span>
        <MilestoneDiamond state={{ met: true }} />
        Met
      </span>
      <span>
        <MilestoneDiamond state={{ late: true }} />
        Overdue
      </span>
    </div>
  );
}
