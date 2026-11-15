// Planning ahead: Goals (before any stretch has started, how often to plan comes first), Practices, Projects, the
// Inbox and Finish, as tabs that can be visited in any order. Decisions apply at once, each with Undo; Save and exit
// resumes later at the same step, on this device or another. Does it fit stays in view until Finish, which shows all
// of it.

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { formatDate, formatMinutes } from '../../../core/dates';
import { applyPlanChange, doneInPlan, effectiveDue, msInPlan, msReached, pinStretch, planMinutes, planningOpens, planStretch, plannedIds, stretchError, withChange } from '../../../core/plan';
import type { PlanChange, PlanContext, Stretch } from '../../../core/plan';
import { formatTime, formatWeekday, localDate } from '../../../core/dates';
import { addStretchMinutes, finishStretchPlanning, stopPlanning } from '../../../core/planning';
import { getRecord, SETTINGS_ID, updateSettings } from '../../../core/records';
import { usePlanningTime } from '../planning/usePlanningTime';
import type { Writer } from '../../../core/records';
import type { Fields, PlanProgress, Practice } from '../../../core/types';
import { useNav, useOverlay } from '../../app/nav';
import type { Layout } from '../../app/registry';
import { useApp, useMutation, useQuery, useToday } from '../../app/store';
import { PracticeAdd, PracticeFields, practiceRule, ProjectAdd, useLeave } from '../../components/editors';
import { SheetOnPhone } from '../../components/editors/SheetOnPhone';
import { EstimateSlider } from '../../components/EstimateSlider';
import { AddMenu } from '../../components/AddMenu';
import { PlusIcon } from '../../components/icons';
import { Pill } from '../../components/Pill';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { CadenceFields, draftOf } from './Cadence';
import type { CadenceDraft } from './Cadence';
import { loadLookBack } from './data';
import type { PlanData } from './data';
import {
  adoptProgress,
  beginFlow,
  goToStep,
  logChange,
  markDone,
  progressOf,
  readFlow,
  resetFlow,
  settleNote,
  stepOf,
  unlogChange,
  usePlanFlow,
  withProgress,
  writeFlow,
} from './flowState';
import type { StepKey } from './flowState';
import { GoalField, NewGoalForm, useAdd } from './GoalPicker';
import { GoalsStep, shownGoals } from './GoalsStep';
import { InboxStep, itemCount } from './InboxStep';
import { firstStretch, fitOf, msWhen, needsCall, oneOffsIn, oneOffWhen, planContext, range, whereNow } from './model';
import type { Act, Fit } from './model';
import { ProjectsStep } from './ProjectsStep';
import { StepHead } from './StepHead';
import type { Head } from './StepHead';

const STEPS: StepKey[] = ['goals', 'practices', 'projects', 'inbox', 'finish'];
const NAMES: Record<StepKey, string> = { start: 'Start', goals: 'Goals', practices: 'Practices', projects: 'Projects', inbox: 'Inbox', finish: 'Finish' };

/** What Add makes. Each step's own kind comes first. */
type AddKind = 'task' | 'project' | 'practice' | 'goal';
const ADD_ORDER: AddKind[] = ['task', 'project', 'practice', 'goal'];
const ADD_LABEL: Record<AddKind, string> = { task: 'Task to Inbox', project: 'Project', practice: 'Practice', goal: 'Goal' };
const STEP_KIND: Partial<Record<StepKey, AddKind>> = { goals: 'goal', practices: 'practice', projects: 'project', inbox: 'task' };

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;
/** 'Goals', 'Goals and Practices', 'Goals, Practices and Inbox'. */
const andList = (names: readonly string[]) => (names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

function Continue(props: { phone: boolean; label?: string; onClick(): void }) {
  if (props.phone) return null;
  return (
    <div>
      <button className="btn pri" type="button" onClick={props.onClick}>
        {props.label ?? 'Continue'}
      </button>
    </div>
  );
}

function StartStep(props: { data: PlanData; st: Stretch; phone: boolean; head: Head; onNext(): void }) {
  const on = useToday();
  const [draft, setDraft] = useState(() => draftOf(props.data.settings.plan_cadence, on));
  const save = useMutation((w, fields: Fields<'settings'>) => updateSettings(w, fields));
  const change = (next: CadenceDraft) => {
    setDraft(next);
    void save.run({ plan_cadence: next });
  };
  return (
    <div className={props.phone ? 'stack' : 'wrap stack'}>
      <StepHead head={props.head}>How often do you want to plan?</StepHead>
      <p className={props.phone ? 'small quiet' : 'quiet'}>
        A stretch is the time between planning ahead. Projects keep their own dates, and changing this never moves one.
      </p>
      <div className="card stack8">
        <CadenceFields value={draft} showAnchor onChange={change} />
        <p>Your first stretch: {range(props.st)}</p>
      </div>
      <Continue phone={props.phone} onClick={props.onNext} />
    </div>
  );
}

function NextDates(props: {
  data: PlanData;
  st: Stretch;
  first: boolean;
  held: PlanChange | null;
  onClose(): void;
  /** Set to its way out for the phone's sheet, which keeps changed dates rather than dropping them. */
  leaveRef: { current: (() => boolean) | null };
}) {
  const on = useToday();
  const [start, setStart] = useState(props.st.start);
  const [end, setEnd] = useState(props.st.end);
  const [error, setError] = useState('');
  const { saveRef, leave } = useLeave(start !== props.st.start || end !== props.st.end, props.onClose, setError, "These dates aren't set yet. Set them, or Cancel to drop them.");
  const { leaveRef } = props;
  useEffect(() => {
    leaveRef.current = leave;
    return () => void (leaveRef.current = null);
  });
  const save = useMutation(async (w, to: Stretch) => {
    // A first plan's held milestones are saved first, so they follow its new start too.
    if (props.held) await applyPlanChange(w, props.held);
    const { settings, change } = pinStretch(props.data.settings, props.data.plans.flatMap((p) => p.milestones), props.st, to);
    await updateSettings(w, settings);
    await applyPlanChange(w, change);
    return true;
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const to = { start, end };
    const problem = stretchError(to, on, props.first);
    if (problem) return setError(problem);
    if (await save.run(to)) props.onClose();
  };
  return (
    <form className="row small nextdates" aria-label={props.first ? 'First stretch dates' : 'Next stretch dates'} onSubmit={submit}>
      <label className="popfield">
        Starts
        <input className="field datefield" type="date" value={start} onChange={(event) => (setStart(event.target.value), setError(''))} />
      </label>
      <label className="popfield">
        Ends
        <input className="field datefield" type="date" min={start} value={end} onChange={(event) => (setEnd(event.target.value), setError(''))} />
      </label>
      <div className="row">
        <button ref={saveRef} className="btn sm pri" type="submit">
          Set dates
        </button>
        <button className="btn sm" type="button" onClick={props.onClose}>
          Cancel
        </button>
      </div>
      {error && (
        <div className="fielderr" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}

/** Each practice as a summary, with Edit opening its fields in place, one at a time. */
function PracticesStep(props: { data: PlanData; phone: boolean; head: Head; act: Act; onNext(): void }) {
  const { data, phone, act } = props;
  const add = useAdd(act);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // The open editor's way out other than Save or Cancel, so opening another keeps its unsaved changes.
  const leave = useRef<(() => boolean) | null>(null);
  // The practice whose Edit takes focus once it's on screen: after Save or Cancel, or after adding, when the new one
  // arrives.
  const focusEdit = useRef<string | null>(null);
  const editRef = (id: string) => (el: HTMLButtonElement | null) => {
    if (el && focusEdit.current === id) {
      focusEdit.current = null;
      el.focus();
    }
  };
  const close = (id: string) => {
    focusEdit.current = id;
    setEditing(null);
  };
  const edit = (id: string) => {
    if (leave.current && !leave.current()) return;
    focusEdit.current = null;
    setEditing(id);
  };
  // The editor takes focus as it opens, in place of the Edit that opened it.
  useEffect(() => cardRef.current?.focus(), [editing]);
  const write = (id: string) => (text: string, change: PlanChange) => act(`edit-${id}`, text, (w) => applyPlanChange(w, change));
  const practices = data.practices.filter((p) => p.state !== 'ended');
  const goalLine = (p: Practice) => {
    const goal = data.objectives.find((g) => g.id === p.objective_id);
    return goal ? `Goal: ${goal.title}` : 'No goal';
  };
  const btn = phone ? 'btn' : 'btn sm';
  return (
    <div className={phone ? 'stack' : 'wrap stack'}>
      <StepHead head={props.head}>Your practices</StepHead>
      {practices.map((p) =>
        editing === p.id ? (
          <div
            key={p.id}
            ref={cardRef}
            className="card stack8"
            role="group"
            aria-label={`Edit ${p.title}`}
            tabIndex={-1}
            onKeyDown={(event) => event.key === 'Escape' && leave.current?.()}
          >
            <span className="strong">{p.title}</span>
            <PracticeFields
              practice={p}
              goals={data.objectives}
              goalField={(value, onChange) => (
                <GoalField item={{ type: 'practice', id: p.id, title: p.title, goal: p.objective_id ?? null }} goals={data.objectives} act={act} value={value} onChange={onChange} />
              )}
              write={write(p.id)}
              leaveRef={leave}
              onClose={() => close(p.id)}
              onEnded={() => {
                setEditing(null);
                addRef.current?.focus();
              }}
            />
          </div>
        ) : (
          <div key={p.id} className="card between">
            <div className="grow">
              <div>
                <span className="strong">{p.title}</span> {p.state === 'paused' && <Pill tone="grey">Paused</Pill>}
              </div>
              <div className="small quiet">{practiceRule(p)}</div>
              <div className="small quiet">{goalLine(p)}</div>
            </div>
            <button ref={editRef(p.id)} className={btn} type="button" aria-label={`Edit ${p.title}`} onClick={() => edit(p.id)}>
              Edit
            </button>
          </div>
        ),
      )}
      {practices.length === 0 && <p className={phone ? 'small quiet' : 'quiet'}>No practices yet.</p>}
      {adding && (
        <PracticeAdd goals={data.objectives} objectiveId={null} write={add.practice} onAdded={(id) => (focusEdit.current = id)} onClose={() => setAdding(false)} />
      )}
      {/* Stays while the form is open, so closing it has somewhere to give focus back to. */}
      <div>
        <button ref={addRef} className={btn} type="button" onClick={() => setAdding(true)}>
          Add practice
        </button>
      </div>
      <Continue phone={phone} label="Practices look right" onClick={props.onNext} />
    </div>
  );
}

/** Does it fit, in one line that stays in view on every step until Finish, as the plan changes. */
function FitBar(props: { fit: Fit }) {
  const { fit } = props;
  const scale = Math.max(fit.planned, fit.capacity ?? 0, 1);
  return (
    <section className="fitbar small" aria-label="Does it fit?">
      <span className="strong">Does it fit?</span>{' '}
      {/* With no recent pace there's nothing to compare against, so only the words show. */}
      {fit.capacity != null && (
        <span className="mmeter" aria-hidden="true">
          <span className={`mfill${fit.over ? '' : ' calm'}`} style={{ width: pct(fit.planned / scale) }} />
          <span className="mtick" style={{ left: pct(fit.capacity / scale) }} />
        </span>
      )}{' '}
      <span>{fit.text}</span>
      {fit.over && (
        <>
          {' '}
          <span className="strong overtext">More than your recent pace. Something may slip.</span>
        </>
      )}
    </section>
  );
}

/** Each planned project's hours with its weekly aim, and where recent pace runs out. */
function Aims(props: { fit: Fit; st: Stretch; phone: boolean; act: Act }) {
  const { fit, st, phone, act } = props;
  let run = 0;
  let lined = false;
  return (
    <div className={phone ? 'card' : 'card stack8'}>
      {fit.plans.map((plan) => {
        const hours = planMinutes(plan, st);
        run += hours;
        const lineAbove = fit.capacity != null && !lined && run > fit.capacity;
        if (lineAbove) lined = true;
        const { project } = plan;
        return (
          <div key={project.id}>
            {lineAbove && <div className="paceline">Recent pace runs out here</div>}
            <div className={phone ? 'prow' : 'inboxrow'}>
              <div>
                <div className={phone ? 'small strong' : undefined}>{project.title}</div>
                <div className="small quiet">
                  {hours ? `${formatMinutes(hours)} planned` : 'No hours yet'}
                  {fit.startsLater(plan) ? `, starts ${formatDate(project.start)}` : ''}
                </div>
              </div>
              <div className="aimfield">
                <span className="small quiet">Weekly aim</span>
                <EstimateSlider
                  label={`Weekly aim for ${project.title}`}
                  hideLabel
                  noneLabel="None"
                  value={project.weekly_aim ?? 0}
                  onChange={(weekly_aim) =>
                    void act(
                      `aim-${project.id}`,
                      `Weekly aim changed: ${project.title}`,
                      (w) => applyPlanChange(w, { writes: [{ type: 'project', id: project.id, fields: { weekly_aim } }] }),
                      true,
                    )
                  }
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FinishStep(props: {
  data: PlanData;
  ctx: PlanContext;
  st: Stretch;
  fit: Fit;
  phone: boolean;
  head: Head;
  act: Act;
  /** Steps never opened in this plan, in order. */
  unseen: StepKey[];
  onGo(step: StepKey): void;
  onUndo(key: string): void;
  /** The note is shared with your other devices once you leave it. */
  onNoteDone(): void;
  onFinish(week: boolean): void;
}) {
  const { data, ctx, st, fit, phone } = props;
  const on = useToday();
  const flow = usePlanFlow();
  const noteId = useId();
  const [aims, setAims] = useState(false);
  const planned = data.plans.filter((p) => plannedIds(p, st).length);
  const lines = planned.map((plan) => ({
    key: plan.project.id,
    title: plan.project.title,
    items: [
      ...plan.milestones
        .filter((m) => !msReached(plan, m) && !m.dropped_at && msInPlan(plan, m, st))
        .sort((a, b) => (effectiveDue(plan, a, ctx) < effectiveDue(plan, b, ctx) ? -1 : 1))
        .map((m) => `${m.title}, ${msWhen(plan, m, ctx)}`),
      ...(doneInPlan(plan, st) ? [`project ends ${formatDate(plan.project.end)}`] : []),
    ].join('; '),
  }));
  const oneOffs = oneOffsIn(data.oneOffs, st);
  if (oneOffs.length) lines.push({ key: 'oneoffs', title: 'One offs', items: oneOffs.map((t) => `${t.title}, ${oneOffWhen(t)}`).join('; ') });
  const overdue = needsCall(data, ctx);
  const empty = data.objectives
    .filter((g) => g.state !== 'archived' && !(g.not_now_until && g.not_now_until > on))
    .filter((g) => !data.practices.some((p) => p.objective_id === g.id && p.state !== 'ended'))
    .filter((g) => !planned.some((p) => p.project.objective_id === g.id))
    .map((g) => g.title);
  const warn = phone ? 'warn wrapwarn' : 'warn small';
  const link = phone ? 'btn' : 'link small';
  return (
    <div className={phone ? 'stack' : 'wrap stack'}>
      <StepHead head={props.head}>Ready for {range(st)}</StepHead>
      <div className="card stack8">
        {fit.over || fit.capacity == null ? (
          <p>{fit.text}</p>
        ) : (
          <p>
            <span className="strong fits">Fits:</span> {fit.text.replace(/^About/, 'about')}
          </p>
        )}
        {fit.over && (
          <div className={warn}>
            <span className="grow">Take something out of the plan, or expect to fall short.</span>
            <button className={link} type="button" onClick={() => props.onGo('projects')}>
              Back to Projects
            </button>
          </div>
        )}
        {fit.plans.length > 0 && (
          <div>
            <button className="link small" type="button" aria-expanded={aims} onClick={() => setAims(!aims)}>
              {aims ? 'Hide weekly aims' : 'Set weekly aims'}
            </button>
          </div>
        )}
      </div>
      {aims && <Aims fit={fit} st={st} phone={phone} act={props.act} />}
      {props.unseen.length > 0 && (
        <div className={warn}>
          <span className="grow">Not looked at: {andList(props.unseen.map((s) => NAMES[s]))}.</span>
          <button className={link} type="button" onClick={() => props.onGo(props.unseen[0]!)}>
            Look now
          </button>
        </div>
      )}
      {overdue.length > 0 && (
        <section className="stack8" aria-label={`Projects · ${overdue.length} overdue`}>
          <h3>Projects · {overdue.length} overdue</h3>
          <div className="card stack8">
            {overdue.map((c) => (
              <div key={c.key} className="small">
                {c.title}. {c.sub}
              </div>
            ))}
          </div>
        </section>
      )}
      <section className="stack8" aria-label="The plan">
        <h3>The plan</h3>
        <div className="card stack8">
          {lines.length === 0 && <p className="quiet">No milestones in this plan yet.</p>}
          {lines.map((line) => (
            <div key={line.key} className="small">
              <span className={`strong${line.key === 'oneoffs' ? ' mhead' : ''}`}>{line.title}:</span> {line.items}
            </div>
          ))}
        </div>
      </section>
      <section className="stack8" aria-label="What changed">
        <h3>What changed</h3>
        <div className="card stack8">
          {flow.changes.length === 0 ? (
            <p className="small quiet">You kept everything as it was.</p>
          ) : (
            flow.changes.map((c) => (
              <div key={c.key} className="between small changed">
                <span className="grow">{c.text}</span>
                {c.reverse && (
                  <button className={link} type="button" aria-label={`Undo: ${c.text}`} onClick={() => props.onUndo(c.key)}>
                    Undo
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </section>
      {empty.length > 0 && <p className="small">Nothing planned for {empty.join(', ')}.</p>}
      <div className="stack8">
        <label className="small quiet" htmlFor={noteId}>
          Anything to do differently this stretch? (optional)
        </label>
        <textarea
          id={noteId}
          className="field"
          rows={2}
          value={flow.note}
          onChange={(event) => writeFlow({ note: event.target.value })}
          onBlur={props.onNoteDone}
        />
      </div>
      <p className="small quiet">{data.settings.plan_cadence ? `Next planning: ${formatDate(planningOpens(st))}.` : 'Plan again whenever you like.'}</p>
      {!phone && (
        <div className="row">
          <button className="btn pri" type="button" onClick={() => props.onFinish(true)}>
            Finish and plan the week
          </button>
          <button className="btn" type="button" onClick={() => props.onFinish(false)}>
            Finish
          </button>
        </div>
      )}
    </div>
  );
}

export function PlanFlow(props: { data: PlanData; layout: Layout; close(): void }) {
  const { layout, close } = props;
  const phone = layout === 'phone';
  const { clock } = useApp();
  const nav = useNav();
  const overlay = useOverlay();
  const toast = useToast();
  const on = useToday();
  // Another device's progress is taken up as the flow opens, not while it's open, so the step never moves underfoot.
  // Once taken up, this device's own goes on from it, whatever either device's clock says.
  const [opened, setOpened] = useState<typeof props.data.settings | null>(() => props.data.settings);
  const own = usePlanFlow();
  const flow = opened ? withProgress(own, opened, on) : own;
  const where = whereNow(props.data.settings, on, flow);
  const first = where.firstPlan;
  // A first plan's dates are held here as if saved, with what was already put in this stretch, until Finish or Change
  // saves them. So opening the flow writes nothing that could undo a plan finished on another device.
  const cur = where.cur;
  const held = first && cur ? pinStretch(props.data.settings, props.data.plans.flatMap((p) => p.milestones), cur, firstStretch(props.data.settings, cur, on, flow)) : null;
  const data = held
    ? { ...props.data, settings: { ...props.data.settings, ...held.settings }, plans: props.data.plans.map((p) => withChange(p, held.change)) }
    : props.data;
  const ctx = planContext(data, clock, true);
  const st = planStretch(data.settings, on, true);
  const steps: StepKey[] = where.first ? ['start', ...STEPS] : STEPS;
  const step = stepOf(flow, steps);
  const at = steps.indexOf(step);
  // A first plan's stretch is only starting, so there's nothing to look back on; recent pace still sizes the plan.
  const behind = first ? null : where.cur;
  const look = useQuery((sql, c) => loadLookBack(sql, c, behind), [behind?.start, behind?.end]).data;
  const fit = fitOf(data, ctx, st, look?.pace ?? null);
  const overdue = needsCall(data, ctx);
  const write = useMutation((w, build: (w: Writer) => Promise<PlanChange>) => build(w));
  // The stretch's planning task is the plan being made: the stretch under way for a first plan, else the next.
  const planning = { stretch: first && cur ? cur : st, first };
  const time = usePlanningTime((w, minutes, began) => addStretchMinutes(w, planning.stretch.start, minutes, began));
  const stop = useMutation((w) => stopPlanning(w, planning, clock));
  const exit = () => void time.flush().then(() => stop.run()).then(close);
  // A project's page is outside planning, so going there saves planning as Save and exit does, to continue later.
  const openProject = (id: string) =>
    void time
      .flush()
      .then(() => stop.run())
      .then(() => {
        close();
        nav.go('goals', { project: id });
        toast.show('Planning is saved, so you can continue it later.');
      });
  // Finishing saves the plan and finishes its planning task, freeing what's left of its block; Undo puts both back.
  const save = useMutation(async (w, fields: Fields<'settings'>, andWeek: boolean) => {
    const pinned = held ? await applyPlanChange(w, held.change) : { writes: [] };
    const before = (await getRecord(w.sql, 'settings', SETTINGS_ID)) ? await w.set('settings', SETTINGS_ID, fields) : null;
    if (!before) await updateSettings(w, fields);
    // Finish and plan the week carries a block shared with the week on into weekly planning.
    const closed = await finishStretchPlanning(w, planning.stretch.start, clock, andWeek);
    return { pinned, before, closed };
  });
  const unfinish = useMutation(async (w, done: NonNullable<Awaited<ReturnType<typeof save.run>>>) => {
    await applyPlanChange(w, done.closed.reverse);
    // Settings that never had a stretch reverse to null, which would hide its default of none planned yet.
    if (done.before) await w.set('settings', SETTINGS_ID, { ...done.before, ...(done.before.plan_stretch === null ? { plan_stretch: {} } : {}) });
    await applyPlanChange(w, done.pinned);
  });
  const share = useMutation((w, progress: PlanProgress) => updateSettings(w, { plan_progress: progress }));
  const add = useAdd((...args) => act(...args));
  const head = useRef<HTMLHeadingElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  // Changes made since the flow opened, newest last, for the pinned Undo line. What changed keeps every one.
  const [session, setSession] = useState<string[]>([]);
  const [said, setSaid] = useState('');
  const [menu, setMenu] = useState(false);
  const [adding, setAdding] = useState<Exclude<AddKind, 'task'> | null>(null);
  const [changing, setChanging] = useState(false);
  const leaveDates = useRef<(() => boolean) | null>(null);
  // The Inbox as Process opened on it, so the step can say what it sorted once Process closes.
  const [ran, setRan] = useState<string[] | null>(null);
  const processing = useRef(false);
  // Opened again after an earlier visit: say where planning was.
  const [welcome, setWelcome] = useState(() => {
    const was = withProgress(readFlow(), props.data.settings, on);
    if (!was.seen.length) return null;
    const done = steps.filter((s) => was.done.includes(s)).map((s) => NAMES[s]);
    const verb = done.length > 1 || done[0]?.endsWith('s') ? 'are' : 'is';
    return `Welcome back.${done.length ? ` ${andList(done)} ${verb} done.` : ''} You were on ${NAMES[stepOf(was, steps)]}.`;
  });

  // However the flow was opened, it now counts as begun, so leaving it offers Continue planning, and a first plan
  // keeps the day it began as its start.
  useEffect(() => {
    if (opened) adoptProgress(opened, on);
    setOpened(null);
    if (!readFlow().begun) beginFlow();
    if (!readFlow().begunOn) writeFlow({ begunOn: on });
    if (welcome) setSaid(welcome);
  }, []);

  // Which stretch this planning is for, so it ends everywhere once that stretch is planned. A first plan's can change.
  useEffect(() => {
    if (readFlow().for !== st.start) writeFlow({ for: st.start });
  }, [st.start]);

  // Where planning is goes to your other devices as it changes. The note goes once you leave it.
  const progress = progressOf(flow);
  const shared = progress && JSON.stringify([progress.for, progress.step, progress.done, progress.seen, progress.begun_on]);
  const shareNow = () => {
    const now = progressOf(readFlow());
    if (now) void share.run(now);
  };
  useEffect(() => {
    if (shared) shareNow();
  }, [shared]);

  // Each step starts at its top, with focus on its heading. Opening it writes its key, which also maps a released
  // app's step number once, and notes it as looked at.
  useEffect(() => {
    const now = readFlow();
    if (now.stepKey !== step || !now.seen.includes(step)) goToStep(step);
    root.current?.closest('.flowpane')?.scrollTo?.({ top: 0 });
    root.current?.querySelector('.scroll')?.scrollTo?.({ top: 0 });
    head.current?.focus({ preventScroll: true });
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    root.current?.querySelector('[aria-current="step"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [step]);

  // Once Process closes, focus goes to the line saying what it sorted, since the button that opened it may have gone.
  useEffect(() => {
    if (overlay?.area === 'process') processing.current = true;
    else if (processing.current && !overlay) {
      processing.current = false;
      summaryRef.current?.focus();
    }
  }, [overlay]);

  const go = (key: StepKey) => {
    setWelcome(null);
    goToStep(key);
  };
  const next = () => {
    markDone(step);
    go(steps[Math.min(at + 1, steps.length - 1)]!);
  };

  const act: Act = async (key, text, build, goingOn = false) => {
    const reverse = await write.run(build);
    if (!reverse) return false;
    logChange(key, text, reverse, goingOn);
    setSession((s) => (goingOn && s.at(-1) === key ? s : [...s, key]));
    setSaid(text);
    return true;
  };
  const undo = async (key: string) => {
    const entry = readFlow().changes.find((c) => c.key === key);
    if (!entry?.reverse || !(await write.run((w) => applyPlanChange(w, entry.reverse!)))) return;
    unlogChange(key);
    setSession((s) => {
      const i = s.lastIndexOf(key);
      return i < 0 ? s : [...s.slice(0, i), ...s.slice(i + 1)];
    });
    setSaid(`Undone: ${entry.text}`);
  };
  // The newest change made since opening that can still be undone.
  const pinned = [...session].reverse().map((key) => flow.changes.find((c) => c.key === key && c.reverse)).find(Boolean);

  const finish = async (week: boolean) => {
    // With no cadence the next stretch counts from today, so the one just planned is pinned to keep its dates. A first
    // plan's held dates are already in data.settings, and save writes its milestones.
    const pinnedStretch = data.settings.plan_cadence ? data.settings.plan_stretch : pinStretch(data.settings, [], st, st).settings.plan_stretch;
    const note = flow.note.trim();
    await time.flush();
    const done = await save.run(
      {
        plan_stretch: { ...pinnedStretch, last_planned: st.start, last_note: note || pinnedStretch.last_note || null },
        plan_progress: null,
      },
      week,
    );
    if (done === undefined) return;
    // Nothing has reached the Inbox since its step was continued from, so weekly planning can start on Pick tasks.
    const sorted = flow.inbox !== null && data.inbox.every((i) => flow.inbox!.includes(i.id));
    resetFlow();
    const zone = clock.zone();
    const freed = done.closed.freed && ` ${formatWeekday(localDate(done.closed.freed, zone))} ${formatTime(done.closed.freed, zone)} is free again.`;
    toast.show(`Your plan for ${range(st)} is set.${freed || ''}`, { undo: () => unfinish.run(done) });
    close();
    if (week) nav.openFlow('planning', sorted ? { step: 'pick' } : {});
  };

  const inbox = data.inbox;
  const process = (item?: string) => {
    setRan((r) => r ?? inbox.map((i) => i.id));
    // In the stretch's context: its projects first, new ones ending with it, and no Add to this week.
    const stretch = { stretchStart: st.start, stretchEnd: st.end };
    nav.openOverlay('process', item ? { ...stretch, item } : stretch);
  };
  const sortedCount = ran && ran.filter((id) => !inbox.some((i) => i.id === id)).length;
  const summary = ran && !overlay ? `${sortedCount} sorted. ${inbox.length ? `${inbox.length} still in your Inbox.` : 'Your Inbox is clear.'}` : null;
  const inboxNext = (sorted: boolean) => {
    writeFlow({ inbox: sorted ? inbox.map((i) => i.id) : null });
    next();
  };
  const mainProcesses = step === 'inbox' && inbox.length > 0 && !ran && !flow.done.includes('inbox');

  const pick = (kind: AddKind) => {
    setMenu(false);
    if (kind === 'task') nav.openOverlay('capture');
    else setAdding(kind);
  };
  // Back to what opened the form, named here: the menu item that did has gone.
  const doneAdding = () => {
    setAdding(null);
    setTimeout(() => addRef.current?.focus());
  };

  const count = data.plans.reduce((n, p) => n + plannedIds(p, st).length, 0);
  const continueLabel = `Continue with ${count || 'no'} ${count === 1 ? 'milestone' : 'milestones'}`;
  const title = where.first || first ? 'Plan your first stretch' : 'Plan the next stretch';
  const stepHead: Head = { ref: head, where: `Step ${at + 1} of ${steps.length}, ${NAMES[step]}.` };
  const counts: Partial<Record<StepKey, { short: string; long: string }>> = {
    ...(overdue.length ? { projects: { short: `${overdue.length} overdue`, long: `${overdue.length} overdue` } } : {}),
    ...(inbox.length ? { inbox: { short: String(inbox.length), long: itemCount(inbox.length) } } : {}),
  };
  const goalsLabel = shownGoals(data.objectives, on).length ? 'Goals look right' : 'Continue without goals';
  const unseen = steps.filter((s) => s !== 'start' && s !== 'finish' && !flow.seen.includes(s));

  const body = {
    start: <StartStep key="start" data={data} st={st} phone={phone} head={stepHead} onNext={next} />,
    goals: (
      <GoalsStep
        key="goals"
        data={data}
        ctx={ctx}
        st={st}
        behind={behind}
        look={look}
        phone={phone}
        head={stepHead}
        act={act}
        continueLabel={goalsLabel}
        onNext={next}
        onOpenProject={openProject}
      />
    ),
    practices: <PracticesStep key="practices" data={data} phone={phone} head={stepHead} act={act} onNext={next} />,
    projects: <ProjectsStep key="projects" data={data} ctx={ctx} st={st} phone={phone} act={act} continueLabel={continueLabel} onNext={next} head={stepHead} />,
    inbox: (
      <InboxStep
        key="inbox"
        rows={inbox}
        phone={phone}
        head={stepHead}
        summary={summary}
        summaryRef={summaryRef}
        mainProcesses={phone && mainProcesses}
        onProcess={process}
        onSkip={() => inboxNext(false)}
        onNext={() => inboxNext(true)}
      />
    ),
    finish: (
      <FinishStep
        key="finish"
        data={data}
        ctx={ctx}
        st={st}
        fit={fit}
        phone={phone}
        head={stepHead}
        act={act}
        unseen={unseen}
        onGo={go}
        onUndo={undo}
        onNoteDone={() => (settleNote(), shareNow())}
        onFinish={finish}
      />
    ),
  }[step];

  const mainLabel =
    step === 'finish'
      ? 'Finish and plan the week'
      : step === 'goals'
        ? goalsLabel
        : step === 'practices'
          ? 'Practices look right'
          : step === 'projects'
            ? continueLabel
            : step === 'inbox'
              ? mainProcesses
                ? `Process ${itemCount(inbox.length)}`
                : 'Continue to Finish'
              : 'Continue';
  const main = step === 'finish' ? () => finish(true) : mainProcesses ? () => process() : step === 'inbox' ? () => inboxNext(true) : next;

  const tabs = (
    <nav className={phone ? 'flowsteps' : 'steps'} aria-label="Planning steps">
      {steps.map((key, i) => {
        const done = flow.done.includes(key);
        const n = counts[key];
        return (
          <button
            key={key}
            type="button"
            className={`${phone ? 'flowstep' : 'steptab'}${key === step ? ' on' : ''}`}
            aria-current={key === step ? 'step' : undefined}
            aria-label={`${phone ? '' : `${i + 1}. `}${NAMES[key]}${done ? ', done' : ''}${n ? `, ${n.long}` : ''}`}
            onClick={() => go(key)}
          >
            {phone ? (
              <>
                <span className="stepname">{NAMES[key]}</span>
                <span className="stepmark" aria-hidden="true">
                  {done ? '✓' : (n?.short.split(' ')[0] ?? '')}
                </span>
              </>
            ) : (
              <>
                {i + 1}. {NAMES[key]}
                {done && <span className="stepmark">✓</span>}
                {n && <span className="stepmark">· {n.short}</span>}
              </>
            )}
          </button>
        );
      })}
    </nav>
  );

  const datesLabel = first ? 'Your first stretch' : data.settings.plan_cadence ? 'Next stretch' : 'Planning for';
  const dates = !where.first && (
    <>
      <span className={phone ? 'small quiet grow' : undefined}>
        {datesLabel}: {range(st)}{' '}
      </span>
      {!changing && (
        <button className="link small" type="button" onClick={() => setChanging(true)}>
          Change
        </button>
      )}
    </>
  );
  const nextDates = changing && (
    <NextDates data={data} st={st} first={first} held={held?.change ?? null} onClose={() => setChanging(false)} leaveRef={leaveDates} />
  );
  const fitBar = step !== 'finish' && <FitBar fit={fit} />;
  const welcomeLine = welcome && (
    <div className="planundo welcome">
      <span className="grow">{welcome}</span>
      <button className={phone ? 'btn' : 'link small'} type="button" aria-label="Dismiss: Welcome back" onClick={() => setWelcome(null)}>
        OK
      </button>
    </div>
  );
  const status = (
    <div className="sr" role="status">
      {said}
    </div>
  );
  const showPinned = pinned && step !== 'finish';
  // Each step's own kind comes first.
  const stepKind = STEP_KIND[step];
  const kinds = stepKind ? [stepKind, ...ADD_ORDER.filter((k) => k !== stepKind)] : ADD_ORDER;
  const menuEl = menu && <AddMenu items={kinds.map((kind) => ({ label: ADD_LABEL[kind], onPick: () => pick(kind) }))} phone={phone} onClose={() => setMenu(false)} />;
  const addForm =
    adding === 'goal' ? (
      <SheetOnPhone label="Add goal" onClose={doneAdding}>
        <NewGoalForm
          label="New goal"
          submit="Add goal"
          onCancel={doneAdding}
          onAdd={async (name) => {
            const saved = !!(await add.goal(name));
            if (saved) doneAdding();
            return saved;
          }}
        />
      </SheetOnPhone>
    ) : adding === 'project' ? (
      <ProjectAdd objectiveId={null} end={st.end} write={add.project} onClose={doneAdding} />
    ) : adding === 'practice' ? (
      <PracticeAdd goals={data.objectives} objectiveId={null} write={add.practice} onClose={doneAdding} />
    ) : null;
  // Behind Process or the capture form, the flow is inert: VoiceOver on iPhone doesn't reliably keep to aria-modal.
  const inert = !!overlay || undefined;

  if (phone) {
    return (
      <div ref={root} className="planflow" inert={inert}>
        <h1 className="sr">{title}</h1>
        <div className="flowtop two">
          <button className="btn" type="button" onClick={exit}>
            Save and exit
          </button>
          {dates}
          {tabs}
          {fitBar}
        </div>
        {changing && (
          <Sheet label="Change dates" onClose={() => (leaveDates.current ? leaveDates.current() : setChanging(false))}>
            {nextDates}
          </Sheet>
        )}
        <div className="scroll">
          {welcomeLine}
          {status}
          {body}
        </div>
        {showPinned && (
          <div className="flowdock plundo">
            <span className="small grow">{pinned.text}</span>
            <button className="btn" type="button" aria-label={`Undo: ${pinned.text}`} onClick={() => void undo(pinned.key)}>
              Undo
            </button>
          </div>
        )}
        {step === 'finish' && (
          <div className="flowdock">
            <button className="btn wide100" type="button" onClick={() => finish(false)}>
              Finish
            </button>
          </div>
        )}
        <div className="flowbot">
          <button className="icbtn" type="button" aria-label="Previous step" disabled={at === 0} onClick={() => go(steps[at - 1]!)}>
            ‹
          </button>
          <button className="btn pri grow" type="button" onClick={main}>
            {mainLabel}
          </button>
          <button ref={addRef} className="flowcap" type="button" aria-haspopup="dialog" aria-label="Add a goal, practice, project or Inbox task" onClick={() => setMenu(true)}>
            <PlusIcon />
          </button>
        </div>
        {menuEl}
        {addForm}
      </div>
    );
  }

  return (
    <div ref={root} className="wide stack24 planflow" inert={inert}>
      <div className="between">
        <div className="stack8">
          <h1>{title}</h1>
          {dates && <p className="quiet">{dates}</p>}
        </div>
        <div className="row">
          <div className="editrow addwrap">
            <button ref={addRef} className="btn" type="button" aria-haspopup="dialog" aria-expanded={menu} onClick={() => setMenu(!menu)}>
              + Add <span aria-hidden="true">▾</span>
            </button>
            {menuEl}
          </div>
          <button className="btn" type="button" onClick={exit}>
            Save and exit
          </button>
        </div>
      </div>
      {nextDates}
      <div className="stepsnav">
        <button className="btn sm steparrow" type="button" aria-label="Previous step" disabled={at === 0} onClick={() => go(steps[at - 1]!)}>
          ‹
        </button>
        {tabs}
        <button className="btn sm steparrow" type="button" aria-label="Next step" disabled={at === steps.length - 1} onClick={() => go(steps[at + 1]!)}>
          ›
        </button>
      </div>
      {(fitBar || showPinned) && (
        <div className="planpin">
          {fitBar}
          {showPinned && (
            <div className="planundo">
              <span className="grow">{pinned.text}</span>
              <button className="btn sm" type="button" aria-label={`Undo: ${pinned.text}`} onClick={() => void undo(pinned.key)}>
                Undo
              </button>
            </div>
          )}
        </div>
      )}
      {welcomeLine}
      {status}
      {addForm}
      {body}
    </div>
  );
}
