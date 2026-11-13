// Pick tasks on desktop: every project on one rolling timeline, each opening to its tasks, One offs below, and the
// Planned list beside them, where the capacity ring pops up. A task's title opens its editor, its estimate a slider,
// and Mark done finishes it in place, struck through with Undo.

import { useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type { AimRow } from '../../../../core/capacity';
import { pickWarning } from '../../../../core/capacity';
import { formatDate, formatMinutes, formatWeekRange } from '../../../../core/dates';
import { MilestoneDiamond } from '../../../components/MilestoneDiamond';
import { NoteMark } from '../../../components/notes/NoteMark';
import { Pill } from '../../../components/Pill';
import { CapacityRing } from '../../../components/ring/CapacityRing';
import { useOpenTask } from '../../../components/task/TaskName';
import { TimelineAxisHead, TimelineBar } from '../../../components/TimelineBar';
import { useFocusLanding } from '../../../components/useFocusLanding';
import { Aims } from './Aims';
import { EstimatePopover } from './EstimatePopover';
import { aimWords } from './model';
import type { PickGroup, PickProject, PickTask } from './model';
import { OverdueFix } from './OverdueFix';
import { PastEnd } from './PastEnd';
import type { PickProps } from './PickStep';

/** Its estimate as Pick counts it, or, with all of it on the calendar this week, that. */
export function estWords(r: PickTask): string {
  const t = r.c.task;
  if (t.estimate_min == null && t.remaining_min == null) return 'No estimate';
  return r.c.left || !r.c.placed ? `${formatMinutes(r.c.left)} estimate` : 'On the calendar';
}

function AimMeter(props: { aim: AimRow }) {
  const w = aimWords(props.aim);
  return (
    <span className="mrow">
      <span className="mmeter" role="img" aria-label={w.alt}>
        <span className={`mfill ${w.cls}`} style={{ width: `${props.aim.pct}%` }} />
        <span className="mtick" style={{ left: `${props.aim.tickPct}%` }} />
      </span>
      <span>{w.value}</span>
    </span>
  );
}

function SkipAim(props: PickProps & { aim?: AimRow; rows: PickTask[] }) {
  const { aim, rows } = props;
  if (!aim || !aimWords(aim).canSkip) return null;
  const allIn = rows.length > 0 && rows.every((r) => r.c.picked && r.c.week === r.c.left);
  return (
    <div className="row small">
      {allIn && !aim.skipped && <span className="quiet">That's everything open.</span>}
      <button className="link small" type="button" onClick={() => props.toggleSkipAim(aim.bucket)}>
        {aim.skipped ? "Count this week's aim" : "Skip this week's aim"}
      </button>
    </div>
  );
}

function TaskLine(props: PickProps & { row: PickTask }) {
  const { row: r } = props;
  const [estOpen, setEstOpen] = useState(false);
  const openTask = useOpenTask();
  const estRef = useRef<HTMLButtonElement>(null);
  const closeEst = () => {
    setEstOpen(false);
    estRef.current?.focus();
  };
  const done = props.isDone(r);
  const full = !r.c.picked && !r.c.left && r.c.placed && estWords(r) === 'On the calendar';
  return (
    <div className="editrow">
      <div className={`pickrow${done ? ' isdone' : ''}`}>
        <div className="pickinfo">
          <button className="picktitle subline" type="button" aria-haspopup="dialog" aria-label={`Edit task ${r.title}`} onClick={() => openTask(r.c.task.id)}>
            {r.title}
            {r.c.task.notes && <NoteMark />}
          </button>
          {r.meta && <span className="subline small quiet">{r.meta}</span>}
        </div>
        {done ? (
          <span className="small quiet pickest">Done</span>
        ) : (
          <button ref={estRef} className="small quiet pickest pickestbtn" type="button" aria-expanded={estOpen} aria-label={`Estimate for ${r.title}: ${estWords(r)}`} onClick={() => setEstOpen(!estOpen)}>
            {estWords(r)}
          </button>
        )}
        <span className="pickact">
          {done ? (
            <button className="btn sm pickbtn" type="button" aria-label={`Undo finishing ${r.title}`} onClick={() => props.undoDone(r)}>
              Undo
            </button>
          ) : (
            <button className="btn sm pickbtn" type="button" aria-label={`Mark ${r.title} done`} onClick={() => props.markDone(r)}>
              Mark done
            </button>
          )}
          {done || full ? null : r.c.picked ? (
            <button className="btn sm pickbtn" type="button" aria-label={`Remove ${r.title} from the plan`} onClick={() => props.remove(r)}>
              Remove
            </button>
          ) : (
            <button className="btn sm pickbtn" type="button" aria-label={`Add ${r.title} to the plan`} onClick={() => props.add(r)}>
              Add
            </button>
          )}
        </span>
      </div>
      {estOpen && !done && (
        <EstimatePopover row={r} phone={false} onSave={(m) => props.setEstimate(r, m)} onClose={closeEst} />
      )}
    </div>
  );
}

function Group(props: PickProps & { group: PickGroup }) {
  const { group: g } = props;
  return (
    <>
      <div className={`pmshead small strong${g.late ? ' latetext' : ''}`}>
        {g.isMs && (
          <>
            <MilestoneDiamond {...(g.state ? { state: g.state } : {})} />
            Milestone:{' '}
          </>
        )}
        {g.head}
        {g.isMs && g.planned > 0 && `: ${formatMinutes(g.planned)} planned`}
      </div>
      {g.rows.map((r) => (
        <TaskLine key={r.c.task.id} {...props} row={r} />
      ))}
    </>
  );
}

// A click anywhere on the row opens it, except on its own controls.
const onRow = (toggle: () => void) => (event: MouseEvent) => {
  if (!(event.target as HTMLElement).closest('button,a,input,select,label,[role=dialog]')) toggle();
};

function ProjectLine(props: PickProps & { s: PickProject; open: boolean; toggle(): void; fixOpen: boolean; setFix(open: boolean): void }) {
  const { s, open, toggle, view, model } = props;
  const { project } = s.plan;
  const late = s.status.late;
  return (
    <>
      <div className="qline">
        <div className="qname canopen" onClick={onRow(toggle)}>
          <button className="qbtn" type="button" aria-expanded={open} aria-label={`${project.title}, ${formatMinutes(s.planned)} planned`} onClick={toggle}>
            <span className="qcaret" aria-hidden="true">
              {open ? '▾' : '▸'}
            </span>
            <span className="small strong">{project.title}</span>
          </button>
          {late ? (
            <Pill tone="red" aria-label={`${s.status.pill}: move the date or drop the milestone`} aria-expanded={props.fixOpen} onClick={() => props.setFix(!props.fixOpen)}>
              {s.status.pill} ▾
            </Pill>
          ) : (
            <Pill tone={s.status.tone}>{s.status.pill}</Pill>
          )}
          {s.aim ? <AimMeter aim={s.aim} /> : <span className="subline small quiet qpad">{formatMinutes(s.planned)} planned</span>}
          {props.fixOpen && late && (
            <OverdueFix
              plan={s.plan}
              milestone={late}
              ctx={model.ctx}
              onClose={() => props.setFix(false)}
              onSaved={() => {
                props.setFix(false);
                if (!open) toggle();
              }}
            />
          )}
        </div>
        <div className="canopen" onClick={toggle}>
          <TimelineBar
            axis={view.axis}
            bar={{ start: project.start, end: project.end }}
            {...(view.stretch ? { stretch: view.stretch } : {})}
            week={view.weekSpan}
            diamonds={s.marks}
            alt={s.alt}
          />
        </div>
      </div>
      {open && (
        <div className="pcard">
          <div className="small">
            {s.goal && <span className="quiet">{s.goal}. </span>}
            {formatDate(project.start)} to {formatDate(project.end)}. {s.lateText && <span className="latetext">{s.lateText}</span>} {s.next}
          </div>
          <div className="small quiet">{s.status.word}</div>
          {s.change && (
            <div className="row small">
              <span className="grow">{s.change.text}</span>
              <button className="link small" type="button" onClick={() => props.undoChange(s.plan)}>
                Undo
              </button>
            </div>
          )}
          <SkipAim {...props} {...(s.aim ? { aim: s.aim } : {})} rows={s.groups.flatMap((g) => g.rows)} />
          {s.groups.map((g) => (
            <Group key={g.key} {...props} group={g} />
          ))}
          {s.groups.length === 0 && <p className="small quiet">No open tasks.</p>}
        </div>
      )}
    </>
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

export function PickDesktop(props: PickProps) {
  const { view, model, week, ring } = props;
  const [open, setOpen] = useState<Record<string, boolean>>(() => ({ oneOffs: view.oneOffs.count > 0 }));
  const [fixFor, setFixFor] = useState<string | null>(null);
  const [aimsOpen, setAimsOpen] = useState(false);
  const land = useFocusLanding();
  const headRef = useRef<HTMLHeadingElement>(null);
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  const weekLabel = formatWeekRange(week);
  const free = model.use.free;
  const warn = pickWarning(free, model.pushback);

  return (
    <div className="picklay">
      <div className="pickmain stack8">
        <div>
          <h2>Pick tasks for the week</h2>
          <p className="small quiet">Open a project and add what you want to do this week. Nothing is in the plan until you add it.</p>
        </div>
        {view.pastEnd.map(({ plan, status }) => (
          <div key={plan.project.id} className="card stack8">
            <PastEnd plan={plan} status={status} ctx={model.ctx} onSkip={() => props.skipPastEnd(plan.project.id)} />
          </div>
        ))}
        <section className="card" aria-label="Your projects">
          <div className="qline qhead">
            <h3>Your projects</h3>
            <TimelineAxisHead axis={view.axis} week={view.weekSpan} weekLabel={weekLabel} />
          </div>
          {view.projects.map((s) => (
            <ProjectLine
              key={s.plan.project.id}
              {...props}
              s={s}
              open={!!open[s.plan.project.id]}
              toggle={() => toggle(s.plan.project.id)}
              fixOpen={fixFor === s.plan.project.id}
              setFix={(on) => setFixFor(on ? s.plan.project.id : null)}
            />
          ))}
          {view.others.map((o) => (
            <div key={o.plan.project.id} className="qline muted">
              <div className="qname">
                <span className="small qpad">{o.plan.project.title}</span>
                <Pill tone={o.status.tone}>{o.status.pill}</Pill>
                <span className="subline small quiet qpad">{o.sum}</span>
              </div>
              <TimelineBar
                axis={view.axis}
                bar={{ start: o.plan.project.start, end: o.plan.project.end }}
                {...(view.stretch ? { stretch: view.stretch } : {})}
                week={view.weekSpan}
                diamonds={o.marks}
                alt={`${o.plan.project.title} runs ${formatDate(o.plan.project.start)} to ${formatDate(o.plan.project.end)}.`}
              />
            </div>
          ))}
          <Legend stretch={!!view.stretch} />
        </section>
        <section className="mband stack8" aria-label="One offs">
          <div className="mbandhead">
            <button className="qbtn" type="button" aria-expanded={!!open.oneOffs} aria-label={`One offs, ${formatMinutes(view.oneOffs.planned)} planned`} onClick={() => toggle('oneOffs')}>
              <span className="qcaret" aria-hidden="true">
                {open.oneOffs ? '▾' : '▸'}
              </span>
              <span className="strong">One offs</span>
            </button>
            <span className="small quiet">Not part of a project.</span>
            {view.oneOffs.aim ? <AimMeter aim={view.oneOffs.aim} /> : <span className="small quiet">{formatMinutes(view.oneOffs.planned)} planned</span>}
          </div>
          {open.oneOffs && (
            <div className="pcard">
              <SkipAim {...props} {...(view.oneOffs.aim ? { aim: view.oneOffs.aim } : {})} rows={view.oneOffs.rows} />
              {view.oneOffs.rows.map((r) => (
                <TaskLine key={r.c.task.id} {...props} row={r} />
              ))}
              {view.oneOffs.rows.length === 0 && <p className="small quiet">Nothing due.</p>}
            </div>
          )}
        </section>
      </div>
      <aside className="pickside card stack8" aria-label="Time this week">
        <h3 ref={headRef} tabIndex={-1}>
          Planned for {weekLabel}
        </h3>
        {view.planned.length === 0 && <p className="small quiet">Nothing yet. Add tasks from your projects or One offs.</p>}
        {view.hintMin > 0 && (
          <div>
            <button
              className="btn sm"
              type="button"
              onClick={() => {
                land(() => headRef.current);
                void props.addSuggested();
              }}
            >
              Add suggested ({formatMinutes(view.hintMin)})
            </button>
          </div>
        )}
        {view.planned.map((r) => {
          const { week: minutes, left } = r.c;
          const text = `${formatMinutes(minutes)} of ${formatMinutes(left)}`;
          return (
            <div key={r.c.task.id} className={`planitem${r.oneOff ? ' is-maint' : ''}`}>
              <div className="small">{r.title}</div>
              <div className="row small">
                <span>{left > 15 ? text : formatMinutes(minutes)}</span>
                <button
                  className="link small"
                  type="button"
                  aria-label={`Remove ${r.title} from the plan`}
                  onClick={(event) => {
                    // The row goes, so focus moves to the next row's Remove, else the one before, else the heading.
                    const item = event.currentTarget.closest('.planitem');
                    const near = [item?.nextElementSibling, item?.previousElementSibling].find((el) => el?.classList.contains('planitem'));
                    land(() => near?.querySelector('button') ?? headRef.current);
                    props.remove(r);
                  }}
                >
                  Remove
                </button>
              </div>
              {left > 15 && (
                <input
                  type="range"
                  className="wide-range"
                  min={15}
                  max={left}
                  step={15}
                  value={minutes}
                  aria-label={`Time this week for ${r.title}`}
                  aria-valuetext={text}
                  onChange={(event) => props.setMinutes(r, Number(event.target.value))}
                />
              )}
            </div>
          );
        })}
        <div className="between small captop">
          <span>Open time</span>
          <span>{formatMinutes(model.open)}</span>
        </div>
        <div className="between small">
          <span>Practices and repeating work</span>
          <span>{formatMinutes(model.repeating)}</span>
        </div>
        <div className="between small">
          <span>Tasks you added</span>
          <span className="strong">{formatMinutes(view.picked)}</span>
        </div>
        <div className="between small">
          <span>Left free</span>
          <span className="strong">{formatMinutes(Math.max(0, free))}</span>
        </div>
        {warn && <div className="warn small">{warn}</div>}
        <div>
          <button className="btn sm" type="button" aria-expanded={aimsOpen} onClick={() => setAimsOpen(!aimsOpen)}>
            Change aims for this week
          </button>
        </div>
        {aimsOpen && <Aims {...props} />}
        <button className="btn pri" type="button" onClick={props.onNext}>
          Continue to scheduling
        </button>
        {ring.pop && <CapacityRing pop={ring.pop} open={model.open} />}
        <div className="sr" role="status">
          {props.said}
        </div>
      </aside>
    </div>
  );
}

