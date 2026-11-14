// A project: its status, pace or timeline, the overdue question, the latest change with Undo, milestones as
// collapsible groups of tasks, and Project settings in a dialog. The same body opens inline on desktop and as a page
// on phone.

import { useRef, useState } from 'react';
import type { FormEvent, PointerEvent as ReactPointerEvent } from 'react';
import { formatDate, formatMinutes, isDay, localDate } from '../../../core/dates';
import {
  applyPlanChange,
  doneDateError,
  dueAfter,
  effectiveDue,
  moveDone,
  msReached,
  originalDue,
  pauseProject,
  replannedBadge,
  resumeProject,
  sortedMilestones,
} from '../../../core/plan';
import type { PlanChange, PlanContext, ProjectPlan } from '../../../core/plan';
import { onceWhen } from '../../../core/schedule';
import { status } from '../../../core/status';
import { closeTask, undoProjectChange } from '../../../core/tasks';
import type { Milestone, Objective, Task } from '../../../core/types';
import { useShowCompleted } from '../../app/showCompleted';
import { useApp, useMutation } from '../../app/store';
import { CloseProject, diamondFor, doneDiamond, GoalSelect, MilestoneEditor, OverdueFix, TaskEditor, useLeave, usePlanChange } from '../../components/editors';
import { EstimateSlider } from '../../components/EstimateSlider';
import { ChevronIcon } from '../../components/icons';
import { LateWarning, lateSaid, lateText } from '../../components/LateWarning';
import { MilestoneDiamond } from '../../components/MilestoneDiamond';
import { Pill } from '../../components/Pill';
import { Sheet } from '../../components/Sheet';
import { NoteMark } from '../../components/notes/NoteMark';
import { ShowCompleted, useTickAway } from '../../components/ShowCompleted';
import { useOpenTask } from '../../components/task/TaskName';
import { HOLD_MS, SLOP_PX, swallowClick } from '../../components/weekgrid';
import { ProjectProgress } from './ProjectTimeline';

type Editing =
  | { kind: 'addTask'; at: string; milestone: string | null }
  | { kind: 'milestone'; id: string }
  | { kind: 'addMilestone' };

const LOOSE = 'loose';

type Point = { clientX: number; clientY: number };

/**
 * Phone: holding a task lifts it, and letting go over a group ([data-drop]) moves it there. Moving before the hold
 * scrolls instead. The Milestone selector in the task's sheet does the same without dragging.
 */
function useHoldToMove(onDrop: (taskId: string, key: string) => void) {
  const [drag, setDrag] = useState<{ id: string; title: string; y: number; over: string } | null>(null);
  const press = (id: string, title: string) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const row = e.currentTarget;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let lifted = false;
    const over = (m: Point) => document.elementFromPoint?.(m.clientX, m.clientY)?.closest('[data-drop]')?.getAttribute('data-drop') ?? '';
    const track = (m: Point) => setDrag({ id, title, y: m.clientY, over: over(m) });
    const block = (ev: Event) => {
      if (lifted) ev.preventDefault();
    };
    const on: Record<string, (ev: Event) => void> = {
      pointermove: (ev) => {
        const m = ev as PointerEvent;
        if (lifted) track(m);
        else if (Math.abs(m.clientX - x0) > SLOP_PX || Math.abs(m.clientY - y0) > SLOP_PX) stop();
      },
      pointerup: (ev) => {
        stop();
        if (!lifted) return;
        // The release after a drop also clicks the row; that click shouldn't open it.
        swallowClick(row);
        setDrag(null);
        const key = over(ev as PointerEvent);
        if (key) onDrop(id, key);
      },
      pointercancel: () => {
        stop();
        setDrag(null);
      },
      // While lifted, the page holds still and the long-press menu stays away.
      touchmove: block,
      contextmenu: block,
    };
    const stop = () => {
      clearTimeout(timer);
      for (const [k, f] of Object.entries(on)) window.removeEventListener(k, f);
    };
    for (const [k, f] of Object.entries(on)) window.addEventListener(k, f, k === 'touchmove' ? { passive: false } : undefined);
    const timer = setTimeout(() => {
      lifted = true;
      track({ clientX: x0, clientY: y0 });
    }, HOLD_MS);
  };
  return { drag, press };
}

/** onMoved runs as the project is moved to another goal (null for none), before the move is saved. */
export function ProjectBody(props: { plan: ProjectPlan; ctx: PlanContext; goals: readonly Objective[]; page?: boolean; onClosed?(): void; onMoved?(goal: string | null): void }) {
  const { plan, ctx } = props;
  const { layout, clock } = useApp();
  const phone = layout === 'phone';
  const apply = usePlanChange();
  const [editing, setEditing] = useState<Editing | null>(null);
  const openTask = useOpenTask();
  const [fold, setFold] = useState<Record<string, boolean>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const showCompleted = useShowCompleted();
  const tickAway = useTickAway();
  const ticked = useRef(new Map<string, PlanChange>());
  const { drag, press } = useHoldToMove((taskId, key) => {
    const t = plan.tasks.find((x) => x.id === taskId);
    if (!t) return;
    const to = key === LOOSE ? null : key;
    if ((t.milestone_id ?? null) === to) return;
    const name = to ? plan.milestones.find((m) => m.id === to)?.title : 'Done';
    void apply(() => ({ writes: [{ type: 'task', id: t.id, fields: { milestone_id: to, moved_from: null } }] }), { message: `Moved ${t.title} to ${name}.` });
  });
  // A new task can land in a folded group, Done included, so that group opens to show it.
  const onAdded = (_id: string, milestoneId: string | null) => setFold((f) => ({ ...f, [milestoneId ?? LOOSE]: true }));
  const st = status(plan, ctx);
  const badge = replannedBadge(plan);
  const log = plan.project.slip_log ?? [];
  const latest = log.at(-1);
  const milestones = sortedMilestones(plan, ctx);
  const live = milestones.filter((m) => !m.dropped_at);
  const known = new Set(plan.milestones.map((m) => m.id));
  const loose = plan.tasks.filter((t) => !t.milestone_id || !known.has(t.milestone_id));
  const dropOn = (key: string) => (drag && drag.over === key ? ' dropon' : '');
  // Decided once, so a group never folds under you as its last task is ticked.
  // A project that opened with nothing to show decides when its first milestone or task arrives.
  const firstOpen = live.find((m) => !msReached(plan, m))?.id ?? (loose.length ? LOOSE : undefined);
  const [nextOpen, setNextOpen] = useState(firstOpen);
  if (nextOpen === undefined && firstOpen !== undefined) setNextOpen(firstOpen);
  const isOpen = (key: string) => fold[key] ?? key === nextOpen;
  const close = () => setEditing(null);
  const plus = (what: string) => (layout === 'phone' ? `+ ${what}` : `Add ${what.toLowerCase()}`);

  const undo = useMutation((w, p: ProjectPlan) => undoProjectChange(w, p, clock));
  const tick = useMutation(async (w, task: Task, done: boolean) => {
    if (done) {
      ticked.current.set(task.id, await closeTask(w, task.id, 'done', clock));
      return true;
    }
    // Unticking reverses the tick, giving back the time it freed, while that's still known.
    const reverse = ticked.current.get(task.id);
    ticked.current.delete(task.id);
    if (reverse) await applyPlanChange(w, reverse);
    else await w.set('task', task.id, { done_at: null });
  });

  const taskRow = (t: Task, locked: boolean) => {
    const from = t.moved_from ? plan.milestones.find((m) => m.id === t.moved_from)?.title : undefined;
    const meta = t.cancelled_at ? 'Cancelled' : `${t.estimate_min ? formatMinutes(t.estimate_min) : 'No estimate'}${from ? `, from ${from}` : ''}`;
    // Its own date, a day or a range, beside its estimate, with a warning when it falls after its deadline.
    const when = t.schedule?.type === 'once' ? onceWhen(t.schedule) : '';
    const lateBy = when && !t.done_at && !t.cancelled_at ? dueAfter(plan, t, ctx) : null;
    const late = lateBy && lateText(lateBy);
    const editable = !locked && !t.cancelled_at && !t.done_at;
    const cls = t.done_at || t.cancelled_at ? 'done' : undefined;
    return (
      <div key={t.id} className={`taskline editrow${drag?.id === t.id ? ' lifted' : ''}`}>
        <label className="taskcheck">
          <input
            type="checkbox"
            aria-label={`${t.title} done`}
            checked={!!t.done_at}
            disabled={locked || !!t.cancelled_at}
            onChange={(event) => {
              if (!event.target.checked || showCompleted) return void tick.run(t, event.target.checked);
              void tickAway(event.target, t.title, () => tick.run(t, true), () => tick.run(t, false));
            }}
          />
        </label>
        {editable ? (
          <button
            className="rowbtn"
            type="button"
            aria-label={`Edit task ${t.title}, ${when ? `${when}, ` : ''}${meta}${lateSaid(late)}${t.notes ? ', has details' : ''}`}
            onPointerDown={phone ? press(t.id, t.title) : undefined}
            onClick={() => openTask(t.id)}
          >
            <span className="grow">
              {t.title}
              {t.notes && <NoteMark />}
            </span>
            <span className="small quiet">{when ? `${when} · ${meta}` : meta}</span>
            <span className="editcue" aria-hidden="true">
              Edit
            </span>
            {late && <LateWarning text={late} />}
          </button>
        ) : (
          <div className="rowstatic taskstatic grow">
            <span className={`grow ${cls ?? ''}`.trim()}>{t.title}</span>
            <span className="small quiet">{when ? `${when} · ${meta}` : meta}</span>
          </div>
        )}
      </div>
    );
  };

  // Completed tasks wait behind each group's Show completed, counted as in the progress (cancelled ones aren't).
  const taskRows = (tasks: Task[], locked: boolean, label: string) => (
    <>
      {tasks.filter((t) => showCompleted || !t.done_at).map((t) => taskRow(t, locked))}
      <ShowCompleted count={tasks.filter((t) => t.done_at).length} list={label} />
    </>
  );

  const addTaskButton = (at: string, milestone: Milestone | null) => (
    <div className="editrow addrow">
      <button
        className={layout === 'phone' ? 'btn plain' : 'btn sm'}
        type="button"
        aria-label={milestone ? `Add task to ${milestone.title}` : undefined}
        onClick={() => setEditing({ kind: 'addTask', at, milestone: milestone?.id ?? null })}
      >
        {plus('Task')}
      </button>
      {editing?.kind === 'addTask' && editing.at === at && <TaskEditor plan={plan} ctx={ctx} milestoneId={editing.milestone} onAdded={onAdded} onClose={close} />}
    </div>
  );

  const milestoneMeta = (m: Milestone) => {
    if (m.dropped_at) return `Dropped ${formatDate(localDate(m.dropped_at, clock.zone()))}`;
    if (m.met_at) return `Met ${formatDate(localDate(m.met_at, clock.zone()))}`;
    if (msReached(plan, m)) return 'Met';
    const own = plan.tasks.filter((t) => t.milestone_id === m.id && !t.cancelled_at);
    const progress = own.length ? `${own.filter((t) => t.done_at).length} of ${own.length} done, ` : '';
    const was = m.due && originalDue(plan, m, ctx) !== m.due ? `, was ${formatDate(originalDue(plan, m, ctx))}` : '';
    return `${progress}${m.due ? 'due' : 'by'} ${formatDate(effectiveDue(plan, m, ctx))}${was}`;
  };

  const foldButton = (key: string, label: string) => (
    <button
      className="msfold"
      type="button"
      aria-expanded={isOpen(key)}
      aria-label={`${label} tasks`}
      onClick={() => setFold({ ...fold, [key]: !isOpen(key) })}
    >
      <span aria-hidden="true">{isOpen(key) ? '▾' : '▸'}</span>
    </button>
  );

  return (
    <div className="stack projectbody">
      <div>
        <div className="pillrow">
          {props.page && <Pill tone={st.tone}>{st.pill}</Pill>}
          <span className={props.page ? 'small' : 'small quiet'}>{st.word}</span>
        </div>
        {badge && (
          <div className="badgeline">
            <span className="badge">{badge}</span>
          </div>
        )}
      </div>

      <ProjectProgress plan={plan} ctx={ctx} st={st} />

      <OverdueFix plan={plan} ctx={ctx} />

      <div className="row small changeline" role="status">
        {latest?.text && (
          <>
            <span className="grow">{latest.text}</span>
            <button className="link small" type="button" onClick={() => void undo.run(plan)}>
              Undo
            </button>
          </>
        )}
      </div>

      {st.ended && (
        <div className="panel stack8">
          <CloseProject plan={plan} ctx={ctx} {...(props.onClosed ? { onClosed: props.onClosed } : {})} />
        </div>
      )}

      <div className="stack8 groups">
        {milestones.map((m) => {
          const late = st.late?.id === m.id;
          const meta = milestoneMeta(m);
          const own = plan.tasks.filter((t) => t.milestone_id === m.id);
          return (
            <div key={m.id} className={`msgroup${dropOn(m.id)}`} role="group" aria-label={`Milestone: ${m.title}`} data-drop={m.dropped_at ? undefined : m.id}>
              <div className="mshead editrow">
                {foldButton(m.id, m.title)}
                {m.dropped_at ? (
                  <div className="rowstatic taskstatic grow">
                    <span className="grow strong small done">
                      <MilestoneDiamond />
                      Milestone: {m.title}
                    </span>
                    <span className="small quiet">{meta}</span>
                  </div>
                ) : (
                  <button className="rowbtn" type="button" aria-label={`Edit milestone ${m.title}, ${meta}`} onClick={() => setEditing({ kind: 'milestone', id: m.id })}>
                    <span className="grow strong small">
                      <MilestoneDiamond state={diamondFor(plan, m, ctx)} />
                      <span className={late ? 'latetext' : undefined}>Milestone: {m.title}</span>
                    </span>
                    <span className="small quiet">{meta}</span>
                    <span className="editcue" aria-hidden="true">
                      Edit
                    </span>
                  </button>
                )}
                {editing?.kind === 'milestone' && editing.id === m.id && <MilestoneEditor plan={plan} ctx={ctx} milestoneId={m.id} onClose={close} />}
              </div>
              {isOpen(m.id) && (
                <div className="mstasks">
                  {taskRows(own, !!m.dropped_at, m.title)}
                  {!m.dropped_at && addTaskButton(m.id, m)}
                </div>
              )}
            </div>
          );
        })}
        {/* The implicit Done: the project's end, always last, holding the tasks with no milestone. */}
        <div className={`msgroup${dropOn(LOOSE)}`} role="group" aria-label={`Done, due ${formatDate(plan.project.end)}`} data-drop={LOOSE}>
          <div className="mshead">
            {foldButton(LOOSE, 'Done')}
            <div className="rowstatic taskstatic grow">
              <span className="grow strong small">
                <MilestoneDiamond state={doneDiamond(plan, ctx)} />
                Done
              </span>
              <span className="small quiet">due {formatDate(plan.project.end)}</span>
            </div>
          </div>
          {isOpen(LOOSE) && <div className="mstasks">{taskRows(loose, false, 'Done')}</div>}
        </div>
        {drag && (
          <div className="taskghost" style={{ top: drag.y }} aria-hidden="true">
            {drag.title}
          </div>
        )}
      </div>

      <div className="row">
        {addTaskButton('project', null)}
        <div className="editrow addrow">
          <button className={layout === 'phone' ? 'btn plain' : 'btn sm'} type="button" onClick={() => setEditing({ kind: 'addMilestone' })}>
            {plus('Milestone')}
          </button>
          {editing?.kind === 'addMilestone' && <MilestoneEditor plan={plan} ctx={ctx} onClose={close} />}
        </div>
      </div>

      <button className={layout === 'phone' ? 'card projbtn morerow' : 'link small settingsbtn'} type="button" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)}>
        <span>Project settings</span>
        {layout === 'phone' && (
          <span className="chev" aria-hidden="true"><ChevronIcon /></span>
        )}
      </button>
      {settingsOpen && (
        <ProjectSettings
          plan={plan}
          ctx={ctx}
          goals={props.goals}
          onClose={() => setSettingsOpen(false)}
          {...(props.onClosed ? { onClosed: props.onClosed } : {})}
          {...(props.onMoved ? { onMoved: props.onMoved } : {})}
        />
      )}
    </div>
  );
}

/**
 * A dialog whose fields change nothing until Save, which writes them in one go, with Undo; Cancel drops them, and Esc
 * or the backdrop does when nothing has changed. Pause, Finish and Drop act at once, as they do elsewhere, each with
 * its Undo.
 */
function ProjectSettings(props: {
  plan: ProjectPlan;
  ctx: PlanContext;
  goals: readonly Objective[];
  onClose(): void;
  onClosed?(): void;
  onMoved?(goal: string | null): void;
}) {
  const { plan, ctx } = props;
  const { project } = plan;
  const { layout } = useApp();
  const apply = usePlanChange();
  const live = {
    title: project.title,
    objective_id: project.objective_id ?? null,
    start: project.start,
    end: project.end,
    weekly_aim: project.weekly_aim ?? null,
  };
  // Only the fields edited here are kept, so the rest show and are checked as the project is now, after a sync or
  // Resume, and Save writes only those.
  const [edits, setEdits] = useState<Partial<typeof live>>({});
  const form = { ...live, ...edits };
  const [error, setError] = useState('');
  const st = status(plan, ctx);
  const older = (project.slip_log ?? []).slice(0, -1).reverse();
  const btn = layout === 'phone' ? 'btn grow' : 'btn sm';
  const edit = (fields: Partial<typeof live>) => {
    setEdits({ ...edits, ...fields });
    setError('');
  };
  const { saveRef, leave } = useLeave(
    Object.entries(edits).some(([k, v]) => v !== live[k as keyof typeof live]),
    props.onClose,
    setError,
  );

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const title = form.title.trim();
    const { start, end } = form;
    if (!title) return setError('Give it a name.');
    if (!isDay(start) || !isDay(end) || end < start) return setError('Pick an end date on or after the start.');
    const { end: moved, ...fields } = Object.fromEntries(Object.entries({ ...form, title }).filter(([k, v]) => v !== live[k as keyof typeof live]));
    // The end moves as it does anywhere else: logged, with Undo, which takes back a start changed with it too.
    const endError = moved ? doneDateError({ ...plan, project: { ...project, start } }, end) : null;
    if (endError) return setError(endError);
    if (!moved && !Object.keys(fields).length) return props.onClose();
    if ('objective_id' in fields) props.onMoved?.(form.objective_id);
    const writes = [{ type: 'project' as const, id: project.id, fields }, ...(moved ? moveDone(plan, end, ctx, 'start' in fields ? start : undefined).writes : [])];
    if (await apply(() => ({ writes }), { message: `Saved ${title}.` })) props.onClose();
  };

  return (
    <Sheet label="Project settings" tall onClose={leave}>
      <form className="stack8 editor" onSubmit={save}>
        <h2>Project settings</h2>
        <label className="popfield">
          Name
          <input className="field" value={form.title} onChange={(event) => edit({ title: event.target.value })} />
        </label>
        <GoalSelect goals={props.goals} value={form.objective_id ?? ''} onChange={(id) => edit({ objective_id: id || null })} />
        <div className="row nowrap">
          <label className="popfield grow">
            Starts
            <input className="field datefield" type="date" value={form.start} onChange={(event) => edit({ start: event.target.value })} />
          </label>
          <label className="popfield grow">
            Ends
            <input className="field datefield" type="date" value={form.end} onChange={(event) => edit({ end: event.target.value })} />
          </label>
        </div>
        {project.state === 'active' && (
          <EstimateSlider label="Weekly aim" noneLabel="None" value={form.weekly_aim} onChange={(aim) => edit({ weekly_aim: aim || null })} />
        )}
        {error && (
          <div className="fielderr" role="alert">
            {error}
          </div>
        )}
        <div className="row">
          <button ref={saveRef} className={`${btn} pri`} type="submit">
            Save
          </button>
          <button className={btn} type="button" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </form>
      {(project.state === 'active' || project.state === 'paused') && (
        <div className="stack8">
          <div>
            <button
              className="btn sm"
              type="button"
              onClick={() => apply(() => (project.state === 'paused' ? resumeProject(plan, ctx) : pauseProject(plan, ctx)))}
            >
              {project.state === 'paused' ? 'Resume' : 'Pause'}
            </button>
          </div>
          <p className="small quiet">Pausing takes the project out of planning. Resuming moves its end date and open milestones later by the time it was paused.</p>
        </div>
      )}
      {!st.ended && <CloseProject plan={plan} ctx={ctx} changeEnd={false} {...(props.onClosed ? { onClosed: props.onClosed } : {})} />}
      {older.length > 0 && (
        <div className="stack8">
          <h3>Earlier changes</h3>
          {older.map((entry) => (
            <div key={entry.at + entry.text} className="small">
              {entry.text}
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}

/** A project on its own page, as phone opens it and as other areas link to it. */
export function ProjectPage(props: { plan: ProjectPlan | undefined; goal: string | undefined; goals: readonly Objective[]; ctx: PlanContext; onClosed(): void }) {
  const { plan } = props;
  if (!plan || plan.project.state === 'finished' || plan.project.state === 'dropped') {
    return <p className="quiet">This project is no longer active.</p>;
  }
  return (
    <div className="stack">
      <div>
        <h1>{plan.project.title}</h1>
        <div className="small quiet">{props.goal ?? 'No goal'}</div>
      </div>
      <ProjectBody plan={plan} ctx={props.ctx} goals={props.goals} page onClosed={props.onClosed} />
    </div>
  );
}
