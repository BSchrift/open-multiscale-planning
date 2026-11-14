// The Projects step: every project on one timeline with the stretch as a band. A solid diamond is in the plan and a
// hollow one isn't. Click a name to add or take it out, drag a diamond or type a date, drag Done to change the end.
// Each project's goal sits under its name, to change in place. Overdue comes first; then active projects in added
// order, so a row never jumps while its dates are dragged, and + Add project after them. Every change goes through
// act, so the pinned Undo line takes them back newest first.

import { useRef, useState } from 'react';
import type { FormEvent, PointerEvent as ReactPointerEvent, ReactNode, Ref, RefObject } from 'react';
import { addDays, dayNumber, diffDays, formatDate, formatMinutes, fromDayNumber, isDay, nowInstant, today } from '../../../core/dates';
import {
  applyPlanChange,
  doneDateError,
  doneInPlan,
  dropMilestone,
  effectiveDue,
  markMilestoneDone,
  moveDone,
  moveMilestone,
  msInPlan,
  msLate,
  msReached,
  parkMilestone,
  pauseProject,
  planMinutes,
  plannedIds,
  resumeProject,
  toggleInPlan,
  withChange,
} from '../../../core/plan';
import type { PlanChange, PlanContext, ProjectPlan, Stretch } from '../../../core/plan';
import { newId } from '../../../core/records';
import { moveOnce, onceWhen, setOnceDates } from '../../../core/schedule';
import { status, withStatusLine } from '../../../core/status';
import { closeProject, scheduledWork } from '../../../core/tasks';
import type { Fields, LocalDate, Milestone, Objective, Task } from '../../../core/types';
import { useApp } from '../../app/store';
import { CloseQuestion, DATE_UNSET, ProjectAdd, useLeave } from '../../components/editors';
import { OneOffDateForm } from '../../components/oneoff';
import { Pill } from '../../components/Pill';
import { Popover } from '../../components/Popover';
import { Sheet } from '../../components/Sheet';
import { TaskName } from '../../components/task/TaskName';
import { axisMonths } from '../../components/TimelineBar';
import { useToast } from '../../components/Toast';
import { useFocusLanding } from '../../components/useFocusLanding';
import type { PlanData } from './data';
import { GoalPicker, useAdd } from './GoalPicker';
import { msWhen, needsCall, oneOffsIn, range } from './model';
import type { Act, Call } from './model';
import { Diamond } from './PlanPage';
import { StepHead } from './StepHead';
import type { Head } from './StepHead';

/** Within this many days of the band's end, a dropped diamond means "by the end" rather than a date. */
const EDGE_DAYS = 3;

interface Axis {
  lo: number;
  hi: number;
}

const pos = (axis: Axis, d: LocalDate) => Math.max(0, Math.min(100, ((dayNumber(d) - axis.lo) / Math.max(1, axis.hi - axis.lo)) * 100));
const pct = (n: number) => `${n.toFixed(1)}%`;
const inBand = (d: LocalDate, st: Stretch) => d >= st.start && d <= st.end;
const msOf = (plan: ProjectPlan, id: string) => plan.milestones.find((m) => m.id === id)!;
const resumed = (plan: ProjectPlan) => (plan.project.state === 'paused' ? ' Project resumed.' : '');

interface Planned {
  key: string;
  text: string;
  change: PlanChange;
}

function toggleMs(plan: ProjectPlan, m: Milestone, st: Stretch, ctx: PlanContext): Planned {
  const was = msInPlan(plan, m, st);
  const change = toggleInPlan(plan, m.id, st, ctx);
  const after = withChange(plan, change);
  const text = was
    ? `Took ${m.title} out of this plan${m.due && inBand(m.due, st) ? ' and cleared its date' : ''}.`
    : `Added ${m.title} to this plan, ${msWhen(after, msOf(after, m.id), ctx)}.${resumed(plan)}`;
  return { key: `ms-${m.id}`, text, change };
}

/** No date, meaning by the stretch's end. One not yet in the plan joins it. */
function clearMs(plan: ProjectPlan, m: Milestone, st: Stretch, ctx: PlanContext): Planned {
  if (!msInPlan(plan, m, st)) return toggleMs(plan, m, st, ctx);
  const change = parkMilestone(plan, m.id, st, ctx);
  const after = withChange(plan, change);
  return { key: `ms-${m.id}`, text: `Cleared the date of ${m.title}, ${msWhen(after, msOf(after, m.id), ctx)}.`, change };
}

function dateMs(plan: ProjectPlan, m: Milestone, day: LocalDate, st: Stretch, ctx: PlanContext): Planned {
  const change = moveMilestone(plan, m.id, day, ctx);
  const after = withChange(plan, change);
  const was = msInPlan(plan, m, st);
  const is = msInPlan(after, msOf(after, m.id), st);
  const lead = was && !is ? `Took ${m.title} out of this plan, now ` : !was && is ? `Added ${m.title} to this plan, ` : `${m.title}, `;
  const pushed = after.project.end !== plan.project.end ? ` Done moved to ${formatDate(after.project.end)}.` : '';
  return { key: `ms-${m.id}`, text: `${lead}${formatDate(day)}.${pushed}`, change };
}

function doneTo(plan: ProjectPlan, day: LocalDate, st: Stretch, ctx: PlanContext): Planned {
  const change = moveDone(plan, day, ctx);
  const was = doneInPlan(plan, st);
  const is = doneInPlan(withChange(plan, change), st);
  const note = was && !is ? " It's out of this plan." : !was && is ? " It's in this plan." : '';
  return { key: `end-${plan.project.id}`, text: `Done moved to ${formatDate(day)}.${note}`, change };
}

/** Past the band's end takes a milestone out; onto its edge keeps it in by the end; anywhere else dates it. */
function droppedAt(plan: ProjectPlan, m: Milestone, day: LocalDate, st: Stretch, ctx: PlanContext): Planned | null {
  if (Math.abs(diffDays(day, st.end)) <= EDGE_DAYS) return !m.due && m.stretch === st.start ? null : clearMs(plan, m, st, ctx);
  if (day > st.end && msInPlan(plan, m, st)) return toggleMs(plan, m, st, ctx);
  return m.due === day ? null : dateMs(plan, m, day, st, ctx);
}

/** Pointer dragging along a track. The axis holds still until the drop, which writes once. */
function useDrag(axis: Axis) {
  const [drag, setDrag] = useState<{ id: string; day: LocalDate } | null>(null);
  const dragged = useRef(false);
  const grab = (id: string, clamp: (d: LocalDate) => LocalDate, commit: (d: LocalDate) => void) => (ev: ReactPointerEvent<HTMLElement>) => {
    const track = ev.currentTarget.parentElement;
    if (!track) return;
    ev.preventDefault();
    const from = ev.clientX;
    let day: LocalDate | null = null;
    dragged.current = false;
    const move = (e: PointerEvent) => {
      if (day === null && Math.abs(e.clientX - from) < 3) return;
      const r = track.getBoundingClientRect();
      day = clamp(fromDayNumber(axis.lo + Math.round(((e.clientX - r.left) / Math.max(1, r.width)) * (axis.hi - axis.lo))));
      setDrag({ id, day });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDrag(null);
      if (day === null) return;
      // The click that follows a drag isn't a request to type a date.
      dragged.current = true;
      setTimeout(() => (dragged.current = false), 50);
      commit(day);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  return { drag, dragged, grab };
}

function Track(props: { axis: Axis; st: Stretch; on: LocalDate; phone: boolean; label: string; children: ReactNode }) {
  const { axis, st } = props;
  const months = axisMonths({ start: fromDayNumber(axis.lo), end: fromDayNumber(axis.hi) });
  return (
    <div className={props.phone ? 'pltrack' : 'ptrack plantrack'} role="group" aria-label={props.label}>
      <span className="ctband" style={{ left: pct(pos(axis, st.start)), width: pct(pos(axis, st.end) - pos(axis, st.start)) }} />
      {months.map((m) => (
        <span key={m} className="ptick" style={{ left: pct(pos(axis, m)) }} />
      ))}
      <span className="cttoday" style={{ left: pct(pos(axis, props.on)) }} aria-hidden="true" />
      {props.children}
    </div>
  );
}

function AxisHead(props: { axis: Axis; st: Stretch }) {
  const { axis, st } = props;
  return (
    <div className="paxis" aria-hidden="true">
      {axisMonths({ start: fromDayNumber(axis.lo), end: fromDayNumber(axis.hi) }).map((m) => (
        <span key={m} style={{ left: pct(pos(axis, m)) }}>
          {formatDate(m).split(' ')[0]}
        </span>
      ))}
      <span className="wk" style={{ left: pct(pos(axis, st.start)) }}>
        {formatDate(st.start)} to {formatDate(st.end)}
      </span>
    </div>
  );
}

/** The non-drag path for every diamond: in place on desktop, a sheet on phone. Returns an error to show, or null. */
function DateForm(props: {
  label: string;
  initial: LocalDate;
  min: LocalDate;
  phone: boolean;
  clear?: { label: string; run(): void } | null;
  hint?: string | null;
  onSet(date: string): string | null;
  onClose(): void;
}) {
  const [date, setDate] = useState(props.initial);
  const [error, setError] = useState('');
  const { saveRef, leave } = useLeave(date !== props.initial, props.onClose, setError, DATE_UNSET);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(props.onSet(date) ?? '');
  };
  const form = (
    <form
      className={props.phone ? 'stack8' : 'stack8 planform'}
      aria-label={props.label}
      noValidate
      onSubmit={submit}
      onKeyDown={(event) => event.key === 'Escape' && leave()}
    >
      <div className={props.phone ? 'stack8' : 'row small'}>
        <label className={props.phone ? 'popfield' : 'row datelabel'}>
          {props.label}
          <input
            className="field datefield"
            type="date"
            autoFocus
            min={props.min}
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
              setError('');
            }}
          />
        </label>
        <div className="row">
          <button ref={saveRef} className="btn sm pri" type="submit">
            Set date
          </button>
          {props.clear && (
            <button className="btn sm" type="button" onClick={props.clear.run}>
              {props.clear.label}
            </button>
          )}
          <button className="btn sm" type="button" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </div>
      {props.hint && <div className="small quiet">{props.hint}</div>}
      {error && (
        <div className="fielderr" role="alert">
          {error}
        </div>
      )}
    </form>
  );
  return props.phone ? (
    <Sheet label={props.label} onClose={leave}>
      {form}
    </Sheet>
  ) : (
    form
  );
}

interface RowProps {
  plan: ProjectPlan;
  goals: readonly Objective[];
  axis: Axis;
  st: Stretch;
  ctx: PlanContext;
  phone: boolean;
  act: Act;
}

function ProjectRow(props: RowProps) {
  const { plan, axis, st, ctx, phone, act } = props;
  const { clock } = useApp();
  const { project } = plan;
  const on = today(ctx.clock);
  const by = formatDate(st.end);
  const { drag, dragged, grab } = useDrag(axis);
  const [menu, setMenu] = useState(false);
  const [asking, setAsking] = useState<'finished' | 'dropped' | null>(null);
  const finishRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const run = (p: Planned | null) => {
    if (!p) return;
    setEditing(null);
    setMenu(false);
    void act(p.key, p.text, (w) => applyPlanChange(w, p.change));
  };
  const close = (state: 'finished' | 'dropped') => {
    setMenu(false);
    setAsking(null);
    void act(`proj-${project.id}`, `${state === 'finished' ? 'Finished' : 'Dropped'} ${project.title}.`, (w) => closeProject(w, project.id, state, clock));
  };
  const startTo = (day: LocalDate) => {
    if (day === project.start || day >= project.end) return;
    run({ key: `start-${project.id}`, text: `${project.title} starts ${formatDate(day)}.`, change: { writes: [{ type: 'project', id: project.id, fields: { start: day } }] } });
  };
  // The menu's start date waits for Save, as a dragged one doesn't.
  const [startDraft, setStartDraft] = useState<LocalDate | null>(null);
  const [menuError, setMenuError] = useState('');
  const closeMenu = () => {
    setMenu(false);
    setAsking(null);
  };
  const { saveRef, leave } = useLeave(startDraft !== null && startDraft !== project.start, closeMenu, setMenuError);
  const saveStart = (event: FormEvent) => {
    event.preventDefault();
    if (startDraft === null || startDraft === project.start) return closeMenu();
    if (!isDay(startDraft) || startDraft >= project.end) return setMenuError(`Pick a start before ${formatDate(project.end)}.`);
    startTo(startDraft);
  };
  const pause = () =>
    run(
      project.state === 'paused'
        ? { key: `proj-${project.id}`, text: `Resumed ${project.title}.`, change: resumeProject(plan, ctx) }
        : { key: `proj-${project.id}`, text: `Paused ${project.title}.`, change: pauseProject(plan, ctx) },
    );

  const stat = status(plan, ctx);
  const ms = plan.milestones.filter((m) => !m.dropped_at);
  const open = ms.filter((m) => !msReached(plan, m)).sort((a, b) => (effectiveDue(plan, a, ctx) < effectiveDue(plan, b, ctx) ? -1 : 1));
  const doneOn = doneInPlan(plan, st);
  const hours = planMinutes(plan, st);
  const nothing = plannedIds(plan, st).length === 0;
  const late = (m: Milestone) => !msReached(plan, m) && msLate(m, ctx);
  const dotCls = (m: Milestone) => (msReached(plan, m) ? 'met' : [late(m) && 'late', msInPlan(plan, m, st) && 'on'].filter(Boolean).join(' '));
  const lastDated = ms.filter((m) => m.due).reduce((max, m) => (m.due! > max ? m.due! : max), '');
  const lowest = [addDays(project.start, 1), on, lastDated].sort().pop()!;
  const dayOf = (id: string, d: LocalDate) => (drag?.id === id ? drag.day : d);
  const edit = (id: string) => () => {
    if (dragged.current) return;
    setEditing(id);
    setAdding(null);
  };
  const hoursText = nothing ? 'Nothing planned' : hours ? `${formatMinutes(hours)} planned` : 'No hours yet';

  const whereTip = (m: Milestone, d: LocalDate) =>
    Math.abs(diffDays(d, st.end)) <= EDGE_DAYS
      ? `by ${formatDate(d < project.end ? d : st.end)}`
      : d > st.end && msInPlan(plan, m, st)
        ? 'Out of this plan'
        : formatDate(d);
  const dots = [
    ...ms.map((m) => {
      const reached = msReached(plan, m);
      const inPlan = msInPlan(plan, m, st);
      const due = effectiveDue(plan, m, ctx);
      const day = dayOf(m.id, due);
      const what = reached ? 'met' : `${late(m) ? `overdue, was due ${formatDate(due)}` : msWhen(plan, m, ctx)}${inPlan ? ', in this plan' : ', not in this plan'}`;
      return {
        key: m.id,
        day,
        cls: dotCls(m),
        fixed: reached,
        tip: `Milestone: ${m.title}, ${drag?.id === m.id ? whereTip(m, day) : what}`,
        grab: grab(m.id, (d) => (d < on ? on : d), (d) => run(droppedAt(plan, m, d, st, ctx))),
        edit: edit(m.id),
      };
    }),
    {
      key: 'done',
      day: dayOf('done', project.end),
      cls: `done${doneOn ? ' on' : ''}${project.end < on ? ' late' : ''}`,
      fixed: false,
      tip: `Done, ${formatDate(dayOf('done', project.end))}${doneOn ? ', in this plan' : ', not in this plan'}`,
      grab: grab('done', (d) => (d < lowest ? lowest : d), (d) => d !== project.end && run(doneTo(plan, d, st, ctx))),
      edit: edit('done'),
    },
  ].sort((a, b) => dayNumber(a.day) - dayNumber(b.day));
  // Diamonds on nearly the same day step left, so each can still be reached.
  const nudges = dots.map(() => 0);
  for (let i = dots.length - 2; i >= 0; i -= 1) {
    if (pos(axis, dots[i + 1]!.day) - pos(axis, dots[i]!.day) < 1.6) nudges[i] = nudges[i + 1]! - 8;
  }

  const items = [
    ...open.map((m) => {
      const inPlan = msInPlan(plan, m, st);
      const when = late(m) ? `was due ${formatDate(effectiveDue(plan, m, ctx))}` : msWhen(plan, m, ctx);
      return {
        key: m.id,
        name: m.title,
        on: inPlan,
        cls: dotCls(m),
        late: late(m),
        when,
        nameLabel: inPlan ? `Take milestone ${m.title} out of this plan` : `Add milestone ${m.title} to this plan`,
        dateLabel: `Change the date of ${m.title}, ${when}`,
        toggle: () => run(toggleMs(plan, m, st, ctx)),
        openDate: edit(m.id),
      };
    }),
    {
      key: 'done',
      name: 'Done',
      on: doneOn,
      cls: `done${doneOn ? ' on' : ''}`,
      late: project.end < on,
      when: formatDate(project.end),
      nameLabel: project.state === 'paused' ? `Resume ${project.title}` : `Done, ${doneOn ? 'in' : 'not in'} this plan. Change the end date`,
      dateLabel: `Change the end date of ${project.title}, ${formatDate(project.end)}`,
      toggle: project.state === 'paused' ? pause : edit('done'),
      openDate: edit('done'),
    },
  ];

  const inNames = [...open.filter((m) => msInPlan(plan, m, st)).map((m) => m.title), ...(doneOn ? ['Done'] : [])];
  const outNames = [...open.filter((m) => !msInPlan(plan, m, st)).map((m) => m.title), ...(doneOn ? [] : ['Done'])];
  const alt = `${project.title}, ${formatDate(project.start)} to ${formatDate(project.end)}. In this plan: ${inNames.join(', ') || 'nothing'}. Not in this plan: ${outNames.join(', ') || 'nothing'}.`;
  const start = dayOf('start', project.start);
  const end = dayOf('done', project.end);

  const track = (
    <Track axis={axis} st={st} on={on} phone={phone} label={alt}>
      <span className="pspan" style={{ left: pct(pos(axis, start)), width: pct(Math.max(0.5, pos(axis, end) - pos(axis, start))) }} />
      {!phone && (
        <span
          className="cthandle"
          style={{ left: pct(pos(axis, start)) }}
          title="Drag to change the start date"
          aria-hidden="true"
          onPointerDown={grab('start', (d) => (d >= project.end ? addDays(project.end, -1) : d), startTo)}
        />
      )}
      {dots.map((d, i) => {
        const mark = phone ? <i className={`gdia ${d.cls}`.trim()} /> : <span className={`pdot ${d.cls}`.trim()} />;
        const style = { left: pct(pos(axis, d.day)), transform: nudges[i] ? `translateX(${nudges[i]}px)` : undefined };
        if (d.fixed) {
          return (
            <span key={d.key} className={phone ? 'pldot' : 'cttip'} style={style} role="img" tabIndex={phone ? undefined : 0} aria-label={d.tip} data-tip={d.tip}>
              {mark}
            </span>
          );
        }
        return (
          <button
            key={d.key}
            type="button"
            className={phone ? 'pldot' : `cttip${drag?.id === d.key ? ' drag' : ''}`}
            style={style}
            aria-label={`${d.tip}. Change its date`}
            data-tip={d.tip}
            onPointerDown={d.grab}
            onClick={d.edit}
          >
            {mark}
          </button>
        );
      })}
    </Track>
  );

  const menuSheet = menu && (
    <Popover label={project.title} onClose={leave}>
      {phone && <h2>{project.title}</h2>}
      {asking ? (
        <CloseQuestion state={asking} onYes={() => close(asking)} onNo={() => setAsking(null)} back={() => (asking === 'finished' ? finishRef : dropRef).current} />
      ) : (
        <>
          <div className={phone ? 'stack8' : 'row'}>
            <button className="btn sm" type="button" onClick={pause}>
              {project.state === 'paused' ? 'Resume' : 'Pause'}
            </button>
            <button ref={finishRef} className="btn sm danger" type="button" onClick={() => setAsking('finished')}>
              Finish
            </button>
            <button ref={dropRef} className="btn sm danger" type="button" onClick={() => setAsking('dropped')}>
              Drop
            </button>
          </div>
          {stat.leftMin > 0 && <div className="small quiet">Finishing cancels the {formatMinutes(stat.leftMin)} left.</div>}
          <form className="stack8" aria-label={`Start date of ${project.title}`} onSubmit={saveStart}>
            <label className="popfield">
              Start date
              <input
                className="field datefield"
                type="date"
                value={startDraft ?? project.start}
                onChange={(event) => {
                  setStartDraft(event.target.value);
                  setMenuError('');
                }}
              />
            </label>
            {menuError && (
              <div className="fielderr" role="alert">
                {menuError}
              </div>
            )}
            <div className="row">
              <button ref={saveRef} className={phone ? 'btn pri grow' : 'btn sm pri'} type="submit">
                Save
              </button>
              <button className={phone ? 'btn grow' : 'btn sm'} type="button" onClick={closeMenu}>
                Cancel
              </button>
            </div>
          </form>
        </>
      )}
    </Popover>
  );

  const editingMs = editing && editing !== 'done' ? plan.milestones.find((m) => m.id === editing) : undefined;
  const dateForm = editing === 'done' ? (
    <DateForm
      key="done"
      label="Done date"
      initial={project.end}
      min={lowest}
      phone={phone}
      hint={doneOn ? `Done is in this plan while its date is on or before ${by}. Set a later date to take it out.` : `Done joins this plan when its date is on or before ${by}.`}
      onSet={(date) => {
        if (!isDay(date) || date < on) return 'Pick today or a later date.';
        const error = doneDateError(plan, date);
        if (error) return error;
        if (date === project.end) setEditing(null);
        else run(doneTo(plan, date, st, ctx));
        return null;
      }}
      onClose={() => setEditing(null)}
    />
  ) : editingMs ? (
    <DateForm
      key={editingMs.id}
      label={`Date for ${editingMs.title}`}
      initial={editingMs.due ?? ''}
      min={on}
      phone={phone}
      clear={
        editingMs.due
          ? { label: `Clear date, by ${formatDate(project.end < st.end && project.end >= st.start ? project.end : st.end)}`, run: () => run(clearMs(plan, editingMs, st, ctx)) }
          : null
      }
      onSet={(date) => {
        if (!isDay(date) || date < on) return 'Pick today or a later date.';
        if (date === editingMs.due) setEditing(null);
        else run(dateMs(plan, editingMs, date, st, ctx));
        return null;
      }}
      onClose={() => setEditing(null)}
    />
  ) : null;

  const addForm = adding !== null && (
    <form
      className={phone ? 'stack8' : 'row small planform'}
      aria-label={`New milestone for ${project.title}`}
      onKeyDown={(event) => event.key === 'Escape' && setAdding(null)}
      onSubmit={(event) => {
        event.preventDefault();
        const title = adding.trim();
        if (!title) return;
        const id = newId(clock);
        const fresh = { ...plan, milestones: [...plan.milestones, { id, project_id: project.id, title, added_on: on }] };
        const change = toggleInPlan(fresh, id, st, ctx);
        const after = withChange(fresh, change);
        setAdding(null);
        void act(`ms-${id}`, `Added ${title} to this plan, ${msWhen(after, msOf(after, id), ctx)}.${resumed(plan)}`, async (w) => {
          await w.create('milestone', { project_id: project.id, title, added_on: on }, id);
          const reverse = await applyPlanChange(w, change);
          return { writes: [...reverse.writes, { type: 'milestone', id, fields: { deleted_at: nowInstant(clock) } }] };
        });
      }}
    >
      <input className="field grow" autoFocus aria-label="Milestone name" placeholder="Milestone name" value={adding} onChange={(event) => setAdding(event.target.value)} />
      <div className="row">
        <button className={phone ? 'btn pri grow' : 'btn sm'} type="submit">
          Add
        </button>
        <button className={phone ? 'btn' : 'btn sm'} type="button" onClick={() => setAdding(null)}>
          Close
        </button>
      </div>
    </form>
  );
  const addButton = (
    <button
      className={phone ? 'btn' : 'btn sm'}
      type="button"
      aria-label={`Add a milestone to ${project.title}`}
      onClick={() => {
        setAdding('');
        setEditing(null);
      }}
    >
      + Milestone
    </button>
  );
  const menuButton = (
    <button className="qbtn" type="button" aria-haspopup="dialog" aria-expanded={menu} aria-label={`${project.title}: Pause, Finish, Drop`} onClick={() => {
        setStartDraft(null);
        setMenuError('');
        setMenu(true);
      }}
    >
      <span className="small strong grow">{project.title} ▾</span>
    </button>
  );
  const pill = <Pill tone={stat.tone}>{stat.pill}</Pill>;
  const goal = props.goals.find((g) => g.id === project.objective_id && !g.deleted_at && g.state !== 'archived');
  const goalName = goal?.title ?? 'No goal';
  const goalButton = (
    <button
      className={`plgoal small${goal ? '' : ' none'}`}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={picking}
      aria-label={`Goal for ${project.title}: ${goalName}. Change`}
      onClick={() => setPicking(true)}
    >
      {goalName} <span aria-hidden="true">▾</span>
    </button>
  );
  const goalPicker = picking && (
    <GoalPicker item={{ type: 'project', id: project.id, title: project.title, goal: goal?.id ?? null }} goals={props.goals} act={act} onClose={() => setPicking(false)} />
  );

  if (phone) {
    return (
      <div className={`prow${nothing ? ' muted' : ''}`}>
        {menuButton}
        <div className="pline">
          {goalButton}
          {pill}
          <span className="small quiet">{hoursText}</span>
        </div>
        {goalPicker}
        {track}
        <div>
          {items.map((it) => (
            <div key={it.key} className={`plitem${it.on ? '' : ' off'}`}>
              <button className="plname" type="button" aria-pressed={it.on} aria-label={it.nameLabel} onClick={it.toggle}>
                <Diamond cls={it.cls} phone />
                <span>{it.name}</span>
              </button>
              <button className={`pldate${it.late ? ' late' : ''}`} type="button" aria-label={it.dateLabel} onClick={it.openDate}>
                {it.when}
              </button>
            </div>
          ))}
        </div>
        {addForm || addButton}
        {menuSheet}
        {dateForm}
      </div>
    );
  }
  return (
    <>
      <div className={`qline${nothing ? ' muted' : ''}`}>
        <div className="qname">
          {menuButton}
          {pill}
          <span className="small quiet">{hoursText}</span>
          {menuSheet}
          <div className="editrow">
            {goalButton}
            {goalPicker}
          </div>
        </div>
        {track}
      </div>
      <div className={`planline${nothing ? ' quiet' : ''}`}>
        {items.map((it) => (
          <span key={it.key} className={`planms${it.on ? '' : ' off'}`}>
            <button className="planname" type="button" aria-pressed={it.on} aria-label={it.nameLabel} onClick={it.toggle}>
              <Diamond cls={it.cls} phone={false} />
              {it.name}
            </button>
            <button className={`plandate${it.late ? ' late' : ''}`} type="button" aria-label={it.dateLabel} onClick={it.openDate}>
              {it.when}
            </button>
          </span>
        ))}
        {addButton}
      </div>
      {addForm}
      {dateForm}
    </>
  );
}

function CallRow(props: { call: Call; st: Stretch; ctx: PlanContext; phone: boolean; act: Act }) {
  const { call, st, ctx, phone, act } = props;
  const { clock } = useApp();
  const toast = useToast();
  const [asking, setAsking] = useState<'finished' | 'dropped' | null>(null);
  const [keeping, setKeeping] = useState(false);
  const finishRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const { plan, milestone: m } = call;
  const on = today(ctx.clock);
  const btn = phone ? 'btn grow' : 'btn sm';
  const run = (p: Planned) => void act(p.key, p.text, (w) => applyPlanChange(w, p.change));
  const close = (state: 'finished' | 'dropped') => {
    setAsking(null);
    void act(`proj-${plan.project.id}`, `${state === 'finished' ? 'Finished' : 'Dropped'} ${plan.project.title}.`, (w) => closeProject(w, plan.project.id, state, clock));
  };
  // A project past its end is brought in as it always was; an overdue milestone is kept in with a date in this stretch.
  const bringIn = () => {
    const error = doneDateError(plan, st.end);
    if (error) return toast.show(error);
    run({ key: `proj-${plan.project.id}`, text: `Brought in ${plan.project.title}, ending ${formatDate(st.end)}.`, change: moveDone(plan, st.end, ctx) });
  };
  const earliest = st.start > on ? st.start : on;
  const keep = (ms: Milestone, date: string) => {
    if (!isDay(date) || date < earliest || date > st.end) return `Pick a date from ${range({ start: earliest, end: st.end })}.`;
    setKeeping(false);
    run({ key: `ms-${ms.id}`, text: `Kept ${ms.title} in this plan, ${formatDate(date)}.`, change: moveMilestone(plan, ms.id, date, ctx) });
    return null;
  };
  // Ticks its open tasks too, and frees any time still ahead for them, as Mark done does on Goals.
  const markDone = (ms: Milestone) =>
    void act(`ms-${ms.id}`, `Marked ${ms.title} done.`, async (w) => {
      const open = plan.tasks.filter((t) => t.milestone_id === ms.id && !t.done_at && !t.cancelled_at).map((t) => t.id);
      const work = open.length ? await scheduledWork(w.sql, open, clock) : {};
      return applyPlanChange(w, withStatusLine(plan, markMilestoneDone(plan, ms.id, work, ctx), ctx));
    });
  // Same as dropping on Goals: done tasks stay on record and open ones move to the next open milestone.
  const drop = () =>
    m
      ? run({ key: `ms-${m.id}`, text: `Dropped ${m.title}.`, change: withStatusLine(plan, dropMilestone(plan, m.id, { cancelOpen: false }, ctx), ctx) })
      : setAsking('dropped');
  return (
    <div className={phone ? 'plcall' : 'plancall'}>
      <div>
        <div>
          {m && (
            <>
              <Diamond cls="late" phone={phone} />
              Milestone:{' '}
            </>
          )}
          <span className="strong">{call.title}</span>
        </div>
        <div className="small quiet">{call.sub}</div>
        {!m && call.leftMin > 0 && <div className="small quiet">Finishing cancels the {formatMinutes(call.leftMin)} left.</div>}
      </div>
      {asking ? (
        <CloseQuestion state={asking} onYes={() => close(asking)} onNo={() => setAsking(null)} back={() => (asking === 'finished' ? finishRef : dropRef).current} />
      ) : m ? (
        <div className="row">
          <button className={btn} type="button" aria-label={`Already done: ${call.title}`} onClick={() => markDone(m)}>
            Already done
          </button>
          <button ref={keepRef} className={btn} type="button" aria-label={`Keep in plan: ${call.title}`} onClick={() => setKeeping(true)}>
            Keep in plan
          </button>
          <button ref={dropRef} className={btn} type="button" aria-label={`Drop ${call.title}`} onClick={drop}>
            Drop
          </button>
        </div>
      ) : (
        <div className="row">
          <button className={btn} type="button" aria-label={`Bring in ${call.title}`} onClick={bringIn}>
            Bring in
          </button>
          <button ref={dropRef} className={`${btn} danger`} type="button" aria-label={`Drop ${call.title}`} onClick={drop}>
            Drop
          </button>
          <button ref={finishRef} className={`${btn} danger`} type="button" aria-label={`Finish ${call.title}`} onClick={() => setAsking('finished')}>
            Finish
          </button>
        </div>
      )}
      {m && keeping && (
        <DateForm
          label={`Date for ${m.title}`}
          initial={st.end}
          min={earliest}
          phone={phone}
          hint={`It stays in this plan on any day from ${range({ start: earliest, end: st.end })}.`}
          onSet={(date) => keep(m, date)}
          onClose={() => {
            setKeeping(false);
            if (!phone) keepRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

const onceOf = (t: Task) => (t.schedule?.type === 'once' ? t.schedule : { type: 'once' as const });

/** A one off's new dates, as a change on the Undo line. */
const setDates = (act: Act, task: Task, fields: Fields<'task'>) =>
  act(`oo-${task.id}`, `${task.title}, ${onceWhen(onceOf({ ...task, ...fields } as Task)) || 'no date'}.`, (w) =>
    applyPlanChange(w, { writes: [{ type: 'task', id: task.id, fields }] }),
  );

/** The one off date form under its row, or in a sheet on phone. Closing puts focus back on the row's date. */
function OneOffDateEditor(props: { task: Task; phone: boolean; act: Act; opener: RefObject<HTMLButtonElement | null>; onSave?(): void; onClose(): void }) {
  const { task, phone } = props;
  // The sheet puts focus back itself.
  const close = () => {
    props.onClose();
    if (!phone) props.opener.current?.focus();
  };
  const form = (
    <OneOffDateForm
      task={task}
      commit={(from, to) => setDates(props.act, task, setOnceDates(from, to))}
      {...(props.onSave ? { onSave: props.onSave } : {})}
      onClose={close}
    />
  );
  return phone ? (
    <Sheet label={`${onceOf(task).from ? 'Change date' : 'Add date'} for ${task.title}`} onClose={props.onClose}>
      {form}
    </Sheet>
  ) : (
    form
  );
}

/** A one off follows its dates. Dragging its mark moves them, and a range keeps its length. It's never a project. */
function OneOffRow(props: { task: Task; axis: Axis; st: Stretch; on: LocalDate; phone: boolean; act: Act }) {
  const { task, axis, st, on, phone, act } = props;
  const s = onceOf(task);
  const { drag, dragged, grab } = useDrag(axis);
  const [editing, setEditing] = useState(false);
  const dateRef = useRef<HTMLButtonElement>(null);
  const length = s.from && s.to ? diffDays(s.from, s.to) : 0;
  const from = drag?.day ?? s.from!;
  const to = s.to ? addDays(from, length) : null;
  const when = onceWhen({ type: 'once', from, to });
  const tip = `One off: ${task.title}, ${when}`;
  const commit = (d: LocalDate) => {
    if (d !== s.from) void setDates(act, task, moveOnce(s, d));
  };
  const half = Math.floor(length / 2);
  const dateButton = (
    <button ref={dateRef} className={phone ? 'link small' : 'plandate'} type="button" aria-label={`Change date for ${task.title}, ${when}`} onClick={() => setEditing(true)}>
      {when}
    </button>
  );
  const track = (
    <Track axis={axis} st={st} on={on} phone={phone} label={tip}>
      <button
        className={`oomark${drag ? ' drag' : ''}`}
        type="button"
        style={{ left: pct(pos(axis, from)), width: pct(Math.max(0, pos(axis, to ?? from) - pos(axis, from))) }}
        aria-label={`${tip}. Change its date`}
        data-tip={tip}
        onPointerDown={grab('date', (d) => [addDays(d, -half), on].sort().pop()!, commit)}
        onClick={() => !dragged.current && setEditing(true)}
      />
    </Track>
  );
  return (
    <>
      {phone ? (
        <div className="prow">
          <div className="between">
            <span className="grow small strong">
              <TaskName className="rowname" id={task.id} title={task.title} />
            </span>
            {dateButton}
          </div>
          {track}
        </div>
      ) : (
        <div className="qline">
          <div className="qname">
            <span className="small strong">
              <TaskName id={task.id} title={task.title} />
            </span>
            {dateButton}
          </div>
          {track}
        </div>
      )}
      {editing && <OneOffDateEditor task={task} phone={phone} act={act} opener={dateRef} onClose={() => setEditing(false)} />}
    </>
  );
}

function Undated(props: { task: Task; phone: boolean; act: Act; onSave(): void }) {
  const [editing, setEditing] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <div className="planshowrow small undated">
        <span className="grow">
          <TaskName className="rowname" id={props.task.id} title={props.task.title} />
        </span>
        <button ref={addRef} className={props.phone ? 'btn' : 'btn sm'} type="button" aria-label={`Add date for ${props.task.title}`} onClick={() => setEditing(true)}>
          Add date
        </button>
      </div>
      {editing && <OneOffDateEditor task={props.task} phone={props.phone} act={props.act} opener={addRef} onSave={props.onSave} onClose={() => setEditing(false)} />}
    </>
  );
}

function Caret(props: { open: boolean; label: string; onToggle(): void; phone: boolean; btnRef?: Ref<HTMLButtonElement> }) {
  const button = (
    <button ref={props.btnRef} className="qbtn" type="button" aria-expanded={props.open} onClick={props.onToggle}>
      {!props.phone && (
        <span className="qcaret" aria-hidden="true">
          {props.open ? '▾' : '▸'}
        </span>
      )}
      <span className="small strong grow">{props.label}</span>
      {props.phone && (
        <span className="chev" aria-hidden="true">
          {props.open ? '▾' : '▸'}
        </span>
      )}
    </button>
  );
  return props.phone ? button : <div className="planlater">{button}</div>;
}

export function ProjectsStep(props: {
  data: PlanData;
  ctx: PlanContext;
  st: Stretch;
  phone: boolean;
  act: Act;
  continueLabel: string;
  onNext(): void;
  head: Head;
}) {
  const { data, ctx, st, phone, act } = props;
  const on = today(ctx.clock);
  const add = useAdd(act);
  const [laterOpen, setLaterOpen] = useState(false);
  const [looseOpen, setLooseOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  // A date takes a one off out of No date yet, so focus lands on the next one there, the list's toggle or the heading.
  const land = useFocusLanding();
  const oneOffsRef = useRef<HTMLElement>(null);
  const looseRef = useRef<HTMLButtonElement>(null);
  const oneOffsHeadRef = useRef<HTMLHeadingElement>(null);
  const landFrom = (i: number) =>
    land(() => {
      // Each row's Add date, not its name, which opens the task's popup.
      const adds = oneOffsRef.current?.querySelectorAll<HTMLElement>('.undated > button');
      return adds?.[i] ?? adds?.[i - 1] ?? looseRef.current ?? oneOffsHeadRef.current;
    });
  const oneOffsHead = (
    <h3 ref={oneOffsHeadRef} className="mhead" tabIndex={-1}>
      One offs
    </h3>
  );

  const pastEnd = (p: ProjectPlan) => p.project.state === 'active' && p.project.end < on;
  const active = data.plans.filter((p) => p.project.state === 'active' && !pastEnd(p) && p.project.start <= st.end);
  const later = data.plans.filter((p) => p.project.state === 'paused' || (p.project.state === 'active' && !pastEnd(p) && p.project.start > st.end));
  const shown = [...active, ...later];
  const axis: Axis = {
    lo: Math.min(dayNumber(on), dayNumber(st.start)) - 14,
    hi: Math.max(dayNumber(st.end) + 45, ...shown.map((p) => dayNumber(p.project.end) + 7)),
  };
  const calls = needsCall(data, ctx);
  const oneOffs = oneOffsIn(data.oneOffs, st);
  const loose = data.oneOffs.filter((t) => t.schedule?.type === 'once' && !t.schedule.from);

  const noTasks = data.plans.reduce((n, plan) => {
    const ids = plannedIds(plan, st);
    const openUnder = (id: string | null) => plan.tasks.some((t) => (t.milestone_id ?? null) === id && !t.done_at && !t.cancelled_at);
    const anyOpen = plan.tasks.some((t) => !t.done_at && !t.cancelled_at);
    return n + ids.filter((id) => (id.startsWith('done:') ? !anyOpen : !openUnder(id))).length;
  }, 0);
  const row = (plan: ProjectPlan) => <ProjectRow key={plan.project.id} plan={plan} goals={data.objectives} axis={axis} st={st} ctx={ctx} phone={phone} act={act} />;

  return (
    <div className="stack planstep">
      <div className="stack8">
        <StepHead head={props.head}>What will you reach by {formatDate(st.end)}?</StepHead>
        <p className={phone ? 'small quiet' : 'quiet'}>Add milestones to this plan. Date one only if the date matters.</p>
        {noTasks > 0 && (
          <p className="small quiet">
            {noTasks} planned {noTasks === 1 ? 'milestone has' : 'milestones have'} no tasks yet, so Does it fit may be low.
          </p>
        )}
      </div>
      {calls.length > 0 && (
        <section className="stack8" aria-label={`Overdue (${calls.length})`}>
          <h3>Overdue ({calls.length})</h3>
          <div className="card">
            {calls.map((call) => (
              <CallRow key={call.key} call={call} st={st} ctx={ctx} phone={phone} act={act} />
            ))}
          </div>
        </section>
      )}
      <section className="card" aria-label="Projects in this plan">
        {phone ? (
          <div className="pkaxis">
            <AxisHead axis={axis} st={st} />
          </div>
        ) : (
          <div className="qline qhead">
            <h3>Active projects</h3>
            <AxisHead axis={axis} st={st} />
          </div>
        )}
        {active.map(row)}
        <div className={phone ? 'planadd' : 'planadd planlater'}>
          <button className={phone ? 'btn' : 'btn sm'} type="button" onClick={() => setAdding(true)}>
            + Add project
          </button>
        </div>
        {adding && <ProjectAdd objectiveId={null} end={st.end} write={add.project} onClose={() => setAdding(false)} />}
        {later.length > 0 && <Caret open={laterOpen} label={`Paused or starting later (${later.length})`} onToggle={() => setLaterOpen(!laterOpen)} phone={phone} />}
        {laterOpen && later.map(row)}
        <Legend phone={phone} />
      </section>
      {(oneOffs.length > 0 || loose.length > 0) && (
        <section ref={oneOffsRef} className="card" aria-label="One offs in this plan">
          {phone ? (
            oneOffsHead
          ) : (
            <div className="qline qhead">{oneOffsHead}</div>
          )}
          {oneOffs.map((t) => (
            <OneOffRow key={t.id} task={t} axis={axis} st={st} on={on} phone={phone} act={act} />
          ))}
          {loose.length > 0 && (
            <Caret open={looseOpen} label={`No date yet (${loose.length})`} onToggle={() => setLooseOpen(!looseOpen)} phone={phone} btnRef={looseRef} />
          )}
          {looseOpen && loose.map((t, i) => <Undated key={t.id} task={t} phone={phone} act={act} onSave={() => landFrom(i)} />)}
        </section>
      )}
      {!phone && (
        <div>
          <button className="btn pri" type="button" onClick={props.onNext}>
            {props.continueLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function Legend(props: { phone: boolean }) {
  const key = (cls: string, label: string) => (
    <span>
      <Diamond cls={cls} phone={props.phone} />
      {label}
    </span>
  );
  return (
    <div className={props.phone ? 'legend plankey' : 'ctkey small quiet plankey'}>
      {key('on', 'In this plan')}
      {key('', 'Not in this plan')}
      {key('on done', 'Done')}
      {key('met', 'Met')}
      {key('late', 'Overdue')}
      <span>
        <i aria-hidden="true" />
        Today
      </span>
    </div>
  );
}
