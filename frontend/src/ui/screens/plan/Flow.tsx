// Planning ahead: Look back (or, before any stretch has started, how often to plan), Practices, Projects, Time and
// Finish, as tabs that can be visited in any order. Decisions apply at once; Save and exit resumes later.

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, Ref } from 'react';
import { addDays, diffDays, formatDate, formatMinutes } from '../../../core/dates';
import { applyPlanChange, doneInPlan, effectiveDue, msInPlan, msReached, pinStretch, planMinutes, plannable, planningOpens, planStretch, plannedIds, stretchError, withChange } from '../../../core/plan';
import type { PlanChange, PlanContext, Stretch } from '../../../core/plan';
import { updateSettings } from '../../../core/records';
import type { Writer } from '../../../core/records';
import type { Fields, Minutes, Practice } from '../../../core/types';
import { ONE_OFFS_BUCKET } from '../../../core/types';
import { useNav } from '../../app/nav';
import type { Layout } from '../../app/registry';
import { useApp, useMutation, useQuery, useToday } from '../../app/store';
import { PracticeAdd, PracticeFields, practiceRule } from '../../components/editors';
import { EstimateSlider } from '../../components/EstimateSlider';
import { PlusIcon } from '../../components/icons';
import { Pill } from '../../components/Pill';
import { useToast } from '../../components/Toast';
import { CadenceFields, draftOf } from './Cadence';
import type { CadenceDraft } from './Cadence';
import { loadLookBack } from './data';
import type { LookBack, PlanData } from './data';
import { logChange, readFlow, resetFlow, usePlanFlow, writeFlow } from './flowState';
import type { Change } from './flowState';
import { firstStretch, hrs, msWhen, needsCall, oneOffsIn, oneOffWhen, planContext, range, whereNow } from './model';
import type { Act } from './model';
import { ProjectsStep } from './ProjectsStep';

interface Entry {
  key: string;
  text: string;
  reverse: PlanChange;
  prev: Change | null;
}

const LAST = 4;
const clampStep = (n: number) => Math.max(0, Math.min(LAST, Math.trunc(Number(n)) || 0));

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

function StartStep(props: { data: PlanData; st: Stretch; phone: boolean; headRef: Ref<HTMLHeadingElement>; onNext(): void }) {
  const on = useToday();
  const [draft, setDraft] = useState(() => draftOf(props.data.settings.plan_cadence, on));
  const save = useMutation((w, fields: Fields<'settings'>) => updateSettings(w, fields));
  const change = (next: CadenceDraft) => {
    setDraft(next);
    void save.run({ plan_cadence: next });
  };
  return (
    <div className={props.phone ? 'stack' : 'wrap stack'}>
      <h2 ref={props.headRef} tabIndex={-1}>
        How often do you want to plan?
      </h2>
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

function NextDates(props: { data: PlanData; st: Stretch; first: boolean; held: PlanChange | null; onClose(): void }) {
  const on = useToday();
  const [start, setStart] = useState(props.st.start);
  const [end, setEnd] = useState(props.st.end);
  const [error, setError] = useState('');
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
        <button className="btn sm pri" type="submit">
          Set dates
        </button>
        <button className="btn sm" type="button" onClick={props.onClose}>
          Close
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

/** Milestones due so far and how many were met, plus any met before their date came. */
function metLine({ met, total, early }: LookBack['met']): string {
  const was = early === 1 ? 'was' : 'were';
  if (!total) return early ? `No milestones were due in this time, but ${early} ${was} met early.` : 'No milestones were due in this time.';
  return `${met} of ${total} milestones due in this time were met${early ? `, and ${early} more ${was} met early` : ''}.`;
}

function LookBackStep(props: {
  data: PlanData;
  cur: Stretch | null;
  st: Stretch;
  first: boolean;
  held: PlanChange | null;
  look: LookBack | undefined;
  phone: boolean;
  headRef: Ref<HTMLHeadingElement>;
  onNext(): void;
}) {
  const { data, cur, st, first, look, phone } = props;
  const on = useToday();
  const flow = usePlanFlow();
  const noteId = useId();
  const [changing, setChanging] = useState(false);
  const title = !cur ? 'How have the last few weeks gone?' : on >= addDays(cur.end, -7) ? `How did ${range(cur)} go?` : `How is ${range(cur)} going?`;
  const lastNote = data.settings.plan_stretch.last_note;
  return (
    <div className={phone ? 'stack' : 'wrap stack'}>
      <h2 ref={props.headRef} tabIndex={-1}>
        {title}
      </h2>
      {lastNote && <p className="small quiet">Last time you wrote: {lastNote}</p>}
      {look && (
        <>
          <div className="card stack8">
            <div>{metLine(look.met)}</div>
            {look.pace != null && <div className="small quiet">About {formatMinutes(look.pace)} a week went to your goals.</div>}
          </div>
          <section className="stack8" aria-label="Time by goal, and One offs">
            <h3>Time by goal, and One offs</h3>
            <div className="card stack8">
              {look.time.map((row) => (
                <div key={row.id} className={`between small${row.id === ONE_OFFS_BUCKET ? (phone ? ' mhead' : ' mnt') : ''}`}>
                  <span>{row.name}</span>
                  <span>{formatMinutes(row.delivered_min)}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
      <div className="card stack">
        <div className="stack8">
          <label className="small quiet" htmlFor={noteId}>
            Anything to do differently? (optional)
          </label>
          <textarea id={noteId} className="field" rows={2} value={flow.note} onChange={(event) => writeFlow({ note: event.target.value })} />
        </div>
        <div className="between">
          <span className="small">
            {first ? 'Your first stretch' : data.settings.plan_cadence ? 'Next stretch' : 'Planning for'}: {range(st)}
          </span>
          {!changing && (
            <button className={phone ? 'btn' : 'link small'} type="button" onClick={() => setChanging(true)}>
              Change
            </button>
          )}
        </div>
        {changing && <NextDates data={data} st={st} first={first} held={props.held} onClose={() => setChanging(false)} />}
      </div>
      <Continue phone={phone} onClick={props.onNext} />
    </div>
  );
}

/** Each practice as a summary, with Edit opening its fields in place, one at a time. */
function PracticesStep(props: { data: PlanData; phone: boolean; headRef: Ref<HTMLHeadingElement>; onNext(): void }) {
  const { data, phone } = props;
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  // The practice whose Edit takes focus once it's on screen: after Done, or after adding, when the new one arrives.
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
  const practices = data.practices.filter((p) => p.state !== 'ended');
  const goalLine = (p: Practice) => {
    const goal = data.objectives.find((g) => g.id === p.objective_id);
    return goal ? `Goal: ${goal.title}` : 'No goal';
  };
  const btn = phone ? 'btn' : 'btn sm';
  return (
    <div className={phone ? 'stack' : 'wrap stack'}>
      <h2 ref={props.headRef} tabIndex={-1}>
        Your practices
      </h2>
      {practices.map((p) =>
        editing === p.id ? (
          <div key={p.id} className="card stack8" role="group" aria-label={`Edit ${p.title}`} onKeyDown={(event) => event.key === 'Escape' && close(p.id)}>
            <div className="between">
              <span className="strong">{p.title}</span>
              <button className={btn} type="button" autoFocus onClick={() => close(p.id)}>
                Done
              </button>
            </div>
            <PracticeFields
              practice={p}
              goals={data.objectives}
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
            <button ref={editRef(p.id)} className={btn} type="button" aria-label={`Edit ${p.title}`} onClick={() => setEditing(p.id)}>
              Edit
            </button>
          </div>
        ),
      )}
      {practices.length === 0 && <p className={phone ? 'small quiet' : 'quiet'}>No practices yet.</p>}
      {adding && <PracticeAdd goals={data.objectives} objectiveId={null} onAdded={(id) => (focusEdit.current = id)} onClose={() => setAdding(false)} />}
      {/* Stays while the form is open, so closing it has somewhere to give focus back to. */}
      <div>
        <button ref={addRef} className={btn} type="button" onClick={() => setAdding(true)}>
          Add practice
        </button>
      </div>
      <Continue phone={phone} onClick={props.onNext} />
    </div>
  );
}

function TimeStep(props: { data: PlanData; ctx: PlanContext; st: Stretch; pace: Minutes | null; phone: boolean; headRef: Ref<HTMLHeadingElement>; onProjects(): void; onNext(): void }) {
  const { data, ctx, st, pace, phone } = props;
  const on = useToday();
  const save = useMutation((w, id: string, weekly_aim: Minutes) => w.set('project', id, { weekly_aim }));
  const ranked = plannable(data.plans, ctx);
  const starting = data.plans.filter((p) => p.project.state === 'active' && p.project.start > on && p.project.start <= st.end);
  const list = [...ranked, ...starting].filter((p) => plannedIds(p, st).length);
  const capacity = pace == null ? null : (pace * (diffDays(st.start, st.end) + 1)) / 7;
  const total = list.reduce((sum, p) => sum + planMinutes(p, st), 0);
  const over = capacity != null && total > capacity;
  let run = 0;
  let lined = false;
  return (
    <div className={phone ? 'stack' : 'wrap stack'}>
      <h2 ref={props.headRef} tabIndex={-1}>
        Does it fit?
      </h2>
      <p className={phone ? 'small' : undefined}>
        About {hrs(total)} of open tasks sit under your planned milestones.
        {capacity != null && ` At your recent pace of ${formatMinutes(pace!)} a week, you'd do about ${hrs(capacity)}.`}
      </p>
      {over && (
        <div className={phone ? 'warn wrapwarn' : 'warn small'}>
          <span className="grow">Take something out of the plan, or expect to fall short.</span>
          <button className={phone ? 'btn' : 'link small'} type="button" onClick={props.onProjects}>
            Back to Projects
          </button>
        </div>
      )}
      <div className={phone ? 'card' : 'card stack8'}>
        {list.map((plan) => {
          const hours = planMinutes(plan, st);
          run += hours;
          const lineAbove = capacity != null && !lined && run > capacity;
          if (lineAbove) lined = true;
          const { project } = plan;
          const startsLater = !ranked.includes(plan);
          return (
            <div key={project.id}>
              {lineAbove && <div className="paceline">Recent pace runs out here</div>}
              <div className={phone ? 'prow' : 'inboxrow'}>
                <div>
                  <div className={phone ? 'small strong' : undefined}>{project.title}</div>
                  <div className="small quiet">
                    {hours ? `${formatMinutes(hours)} planned` : 'No hours yet'}
                    {startsLater ? `, starts ${formatDate(project.start)}` : ''}
                  </div>
                </div>
                <div className="aimfield">
                  <span className="small quiet">Weekly aim</span>
                  <EstimateSlider
                    label={`Weekly aim for ${project.title}`}
                    hideLabel
                    noneLabel="None"
                    value={project.weekly_aim ?? 0}
                    onChange={(minutes) => {
                      void save.run(project.id, minutes);
                      logChange(`aim-${project.id}`, `Weekly aim changed: ${project.title}`);
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <Continue phone={phone} onClick={props.onNext} />
    </div>
  );
}

function FinishStep(props: { data: PlanData; ctx: PlanContext; st: Stretch; phone: boolean; headRef: Ref<HTMLHeadingElement>; onFinish(week: boolean): void }) {
  const { data, ctx, st, phone } = props;
  const on = useToday();
  const flow = usePlanFlow();
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
  const calls = needsCall(data, ctx);
  const empty = data.objectives
    .filter((g) => g.state !== 'archived' && !(g.not_now_until && g.not_now_until > on))
    .filter((g) => !data.practices.some((p) => p.objective_id === g.id && p.state !== 'ended'))
    .filter((g) => !planned.some((p) => p.project.objective_id === g.id))
    .map((g) => g.title);
  return (
    <div className={phone ? 'stack' : 'wrap stack'}>
      <h2 ref={props.headRef} tabIndex={-1}>
        Ready for {range(st)}
      </h2>
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
              <div key={c.key} className="small">
                {c.text}
              </div>
            ))
          )}
        </div>
      </section>
      {calls.length > 0 && (
        <section className="stack8" aria-label="Still needs a call">
          <h3>Still needs a call</h3>
          <div className="card stack8">
            {calls.map((c) => (
              <div key={c.key} className="small">
                {c.title}. {c.sub}
              </div>
            ))}
          </div>
        </section>
      )}
      {empty.length > 0 && <p className="small">Nothing planned for {empty.join(', ')}.</p>}
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
  const toast = useToast();
  const on = useToday();
  const flow = usePlanFlow();
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
  const step = clampStep(flow.step);
  // A first plan's stretch is only starting, so it looks back over the last few weeks instead.
  const behind = first ? null : where.cur;
  const look = useQuery((sql, c) => loadLookBack(sql, c, behind), [behind?.start, behind?.end]).data;
  const [log, setLog] = useState<Entry[]>([]);
  const write = useMutation((w, build: (w: Writer) => Promise<PlanChange>) => build(w));
  const save = useMutation(async (w, fields: Fields<'settings'>) => {
    if (held) await applyPlanChange(w, held.change);
    return updateSettings(w, fields);
  });
  const head = useRef<HTMLHeadingElement>(null);
  const root = useRef<HTMLDivElement>(null);

  // However the flow was opened, it now counts as begun, so leaving it offers Continue planning, and a first plan
  // keeps the day it began as its start.
  useEffect(() => {
    if (!readFlow().begun) writeFlow({ begun: true, step: 0 });
    if (!readFlow().begunOn) writeFlow({ begunOn: on });
  }, []);

  // Each step starts at its top, with focus on its heading.
  useEffect(() => {
    root.current?.closest('.flowpane')?.scrollTo?.({ top: 0 });
    root.current?.querySelector('.scroll')?.scrollTo?.({ top: 0 });
    head.current?.focus({ preventScroll: true });
  }, [step]);

  const go = (n: number) => writeFlow({ step: clampStep(n) });

  const act: Act = async (key, text, build) => {
    const reverse = await write.run(build);
    if (!reverse) return false;
    const prev = readFlow().changes.find((c) => c.key === key) ?? null;
    logChange(key, text);
    setLog((l) => [...l, { key, text, reverse, prev }]);
    return true;
  };
  const undo = async () => {
    const last = log.at(-1);
    if (!last || !(await write.run((w) => applyPlanChange(w, last.reverse)))) return;
    setLog((l) => l.slice(0, -1));
    writeFlow({ changes: [...readFlow().changes.filter((c) => c.key !== last.key), ...(last.prev ? [last.prev] : [])] });
  };

  const finish = async (week: boolean) => {
    // With no cadence the next stretch counts from today, so the one just planned is pinned to keep its dates. A first
    // plan's held dates are already in data.settings, and save writes its milestones.
    const pinned = data.settings.plan_cadence ? data.settings.plan_stretch : pinStretch(data.settings, [], st, st).settings.plan_stretch;
    const note = flow.note.trim();
    const done = await save.run({ plan_stretch: { ...pinned, last_planned: st.start, last_note: note || pinned.last_note || null } });
    if (done === undefined) return;
    resetFlow();
    toast.show(`Your plan for ${range(st)} is set.`);
    close();
    if (week) nav.openFlow('planning');
  };
  const editGoals = () => {
    close();
    nav.go('goals');
    toast.show(phone ? 'Your planning is saved. Continue from Plan in More.' : 'Your planning is saved. Continue from the Plan tab.');
  };

  const count = data.plans.reduce((n, p) => n + plannedIds(p, st).length, 0);
  const continueLabel = `Continue with ${count || 'no'} ${count === 1 ? 'milestone' : 'milestones'}`;
  const names = [where.first ? 'Start' : 'Look back', 'Practices', 'Projects', 'Time', 'Finish'];
  const title = where.first || first ? 'Plan your first stretch' : 'Plan the next stretch';
  const showEditGoals = !(where.first && step === 0);
  const undoText = log.at(-1)?.text ?? null;
  const next = () => go(step + 1);

  const body = [
    where.first ? (
      <StartStep key="start" data={data} st={st} phone={phone} headRef={head} onNext={next} />
    ) : (
      <LookBackStep key="look" data={data} cur={behind} st={st} first={first} held={held?.change ?? null} look={look} phone={phone} headRef={head} onNext={next} />
    ),
    <PracticesStep key="practices" data={data} phone={phone} headRef={head} onNext={next} />,
    <ProjectsStep
      key="projects"
      data={data}
      ctx={ctx}
      st={st}
      pace={look?.pace ?? null}
      phone={phone}
      act={act}
      undoText={undoText}
      onUndo={undo}
      continueLabel={continueLabel}
      onNext={next}
      headRef={head}
    />,
    <TimeStep key="time" data={data} ctx={ctx} st={st} pace={look?.pace ?? null} phone={phone} headRef={head} onProjects={() => go(2)} onNext={next} />,
    <FinishStep key="finish" data={data} ctx={ctx} st={st} phone={phone} headRef={head} onFinish={finish} />,
  ][step];

  const tabs = (
    <nav className={phone ? 'flowsteps' : 'steps'} aria-label="Planning steps">
      {names.map((label, i) => (
        <button
          key={label}
          type="button"
          className={`${phone ? 'flowstep' : 'steptab'}${i === step ? ' on' : ''}`}
          aria-current={i === step ? 'step' : undefined}
          onClick={() => go(i)}
        >
          {phone ? label : `${i + 1}. ${label}`}
        </button>
      ))}
    </nav>
  );

  if (phone) {
    return (
      <div ref={root} className="planflow">
        <h1 className="sr">{title}</h1>
        <div className="flowtop two">
          <button className="btn" type="button" onClick={close}>
            Save and exit
          </button>
          {showEditGoals && (
            <button className="btn flowedit" type="button" onClick={editGoals}>
              Edit goals
            </button>
          )}
          {tabs}
        </div>
        <div className="scroll">{body}</div>
        {step === 2 && undoText && (
          <div className="flowdock plundo">
            <span className="small grow">{undoText}</span>
            <button className="btn" type="button" aria-label={`Undo: ${undoText}`} onClick={undo}>
              Undo
            </button>
          </div>
        )}
        {step === LAST && (
          <div className="flowdock">
            <button className="btn wide100" type="button" onClick={() => finish(false)}>
              Finish
            </button>
          </div>
        )}
        <div className="flowbot">
          <button className="icbtn" type="button" aria-label="Previous step" disabled={step === 0} onClick={() => go(step - 1)}>
            ‹
          </button>
          <button className="btn pri grow" type="button" onClick={step === LAST ? () => finish(true) : next}>
            {step === LAST ? 'Finish and plan the week' : step === 2 ? continueLabel : 'Continue'}
          </button>
          <button className="flowcap" type="button" aria-label="Capture a task" onClick={() => nav.openOverlay('capture')}>
            <PlusIcon />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={root} className="wide stack24 planflow">
      <div className="between">
        <h1>{title}</h1>
        <div className="row">
          {showEditGoals && (
            <button className="btn" type="button" onClick={editGoals}>
              Edit goals
            </button>
          )}
          <button className="btn" type="button" onClick={close}>
            Save and exit
          </button>
        </div>
      </div>
      <div className="stepsnav">
        <button className="btn sm steparrow" type="button" aria-label="Previous step" disabled={step === 0} onClick={() => go(step - 1)}>
          ‹
        </button>
        {tabs}
        <button className="btn sm steparrow" type="button" aria-label="Next step" disabled={step === LAST} onClick={next}>
          ›
        </button>
      </div>
      {body}
    </div>
  );
}
