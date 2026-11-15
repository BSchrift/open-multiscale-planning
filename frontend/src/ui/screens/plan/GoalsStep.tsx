// The Goals step, which planning starts with: how the stretch is going, then one card per goal with what it got and
// what's under it, so each can be kept, renamed, put off or archived, and given a project or practice in place. Below
// them, what has no goal yet, and the goals put off for now. Every change goes through act, so each has Undo.
// Each project under a goal is a block that opens a preview over the step, since opening the project itself leaves
// planning; the preview offers that too, saving planning first. A goal's backlog is a block after its projects, and its
// preview is where untouched tasks get Keep or Delete, so tidying happens inside planning.

import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { addDays, formatDate, formatMinutes, localDate, nowInstant, today } from '../../../core/dates';
import { backlogId, untouchedSince } from '../../../core/backlog';
import { applyPlanChange, cadenceBefore, lateMilestone, minutesLeft } from '../../../core/plan';
import type { PlanContext, ProjectPlan, Stretch } from '../../../core/plan';
import { shortWord, status } from '../../../core/status';
import { closeTask } from '../../../core/tasks';
import type { Fields, Objective, Task } from '../../../core/types';
import { PracticeAdd, ProjectAdd } from '../../components/editors';
import { Pill } from '../../components/Pill';
import { Popover } from '../../components/Popover';
import { Sheet } from '../../components/Sheet';
import { useFocusLanding } from '../../components/useFocusLanding';
import { ProjectProgress } from '../goals/ProjectTimeline';
// The project timeline's finer points live with the Goals screen, which may not have loaded yet.
import '../goals/goals.css';
import type { LookBack, PlanData } from './data';
import { GoalPicker, NewGoalForm, useAdd } from './GoalPicker';
import type { Linked } from './GoalPicker';
import type { Act } from './model';
import { StepHead } from './StepHead';
import type { Head } from './StepHead';
import { Button } from '../../components/ds/Button';
import { Icon } from '../../components/ds/Icon';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const resting = (g: Objective, on: string) => g.state === 'not_now' && !!g.not_now_until && g.not_now_until > on;
const kept = (objectives: readonly Objective[]) =>
  objectives
    .filter((g) => g.state !== 'archived' && !g.deleted_at)
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || (a.id < b.id ? -1 : 1));

/** The goals the step asks about: any not archived, and not put off until later. */
export const shownGoals = (objectives: readonly Objective[], on: string) => kept(objectives).filter((g) => !resting(g, on));
const live = (plan: ProjectPlan) => plan.project.state === 'active' || plan.project.state === 'paused';

/** Milestones due so far and how many were met, plus any met before their date came. */
export function metLine({ met, total, early }: LookBack['met']): string {
  const was = early === 1 ? 'was' : 'were';
  if (!total) return early ? `No milestones were due in this time, but ${early} ${was} met early.` : 'No milestones were due in this time.';
  return `${met} of ${total} milestones due in this time were met${early ? `, and ${early} more ${was} met early` : ''}.`;
}

function Rename(props: { goal: Objective; phone: boolean; onSave(title: string): Promise<boolean>; onDone(): void }) {
  const [name, setName] = useState(props.goal.title);
  const [error, setError] = useState('');
  const btn = { size: 'compact' as const };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const title = name.trim();
    if (!title) return setError('Give it a name.');
    if (title === props.goal.title || (await props.onSave(title))) props.onDone();
  };
  return (
    <form className="stack8 grow" aria-label={`Rename ${props.goal.title}`} onSubmit={submit} onKeyDown={(event) => event.key === 'Escape' && props.onDone()}>
      <div className="row">
        <input className="field grow" aria-label="Goal name" autoFocus value={name} onChange={(event) => (setName(event.target.value), setError(''))} />
        <Button {...btn} variant="primary" type="submit">
          Save
        </Button>
        <Button {...btn} type="button" onClick={props.onDone}>
          Cancel
        </Button>
      </div>
      {error && (
        <div className="fielderr" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}

/** A project as its page begins: its goal, dates, status and how it's going, with a way to the page itself. */
function ProjectPreview(props: { plan: ProjectPlan; goal: string; ctx: PlanContext; phone: boolean; onOpen(): void; onClose(): void }) {
  const { plan, ctx } = props;
  const { project } = plan;
  const st = status(plan, ctx);
  const noteId = useId();
  const btn = { className: props.phone ? 'grow' : undefined };
  return (
    <Sheet label={project.title} onClose={props.onClose}>
      <div>
        <h2>{project.title}</h2>
        <div className="small quiet">
          Goal: {props.goal}. Runs {formatDate(project.start)} to {formatDate(project.end)}.
        </div>
      </div>
      <div className="pillrow">
        <Pill tone={st.tone}>{st.pill}</Pill> <span className="small">{st.word}</span>
      </div>
      <ProjectProgress plan={plan} ctx={ctx} st={st} />
      <div className="row">
        <Button {...btn} type="button" aria-describedby={noteId} onClick={props.onOpen}>
          Open project in Goals
        </Button>
        <Button {...btn} type="button" onClick={props.onClose}>
          Close
        </Button>
      </div>
      <p id={noteId} className="small quiet">
        Opening the project saves planning first, as Save and exit does.
      </p>
    </Sheet>
  );
}

/** A goal's backlog over the step: untouched tasks first, each with Keep and Delete, then the rest. */
function BacklogPreview(props: {
  goal: Objective;
  plan: ProjectPlan;
  touches: Record<string, number>;
  on: string;
  phone: boolean;
  act: Act;
  clock: PlanContext['clock'];
  onOpen(): void;
  onClose(): void;
}) {
  const { goal, plan, act } = props;
  const land = useFocusLanding();
  const root = useRef<HTMLDivElement>(null);
  const noteId = useId();
  const btn = { size: 'compact' as const };
  const open = plan.tasks.filter((t) => !t.done_at && !t.cancelled_at);
  const since = (t: Task) => untouchedSince(props.touches[t.id], props.on);
  const untouched = open.filter(since);
  const rest = open.filter((t) => !since(t));
  const oldest = untouched.map((t) => since(t)!).sort()[0];
  // Each Keep or Delete takes its row away, so focus moves to the next untouched row's Keep, else to Open backlog.
  const answer = (t: Task, keep: boolean) => {
    const at = untouched.indexOf(t);
    land(() => root.current?.querySelectorAll<HTMLElement>('[data-keep]')[at] ?? root.current?.querySelector<HTMLElement>('[data-open]'));
    void act(
      `backlog-${t.id}`,
      keep ? `Kept ${t.title}.` : `Deleted ${t.title}.`,
      keep ? (w) => applyPlanChange(w, { writes: [{ type: 'task', id: t.id, fields: { kept_at: nowInstant(props.clock) } }] }) : (w) => closeTask(w, t.id, 'deleted', props.clock),
    );
  };
  return (
    <Sheet label={`The backlog for ${goal.title}`} onClose={props.onClose}>
      <div ref={root} className="stack8">
        <div>
          <div className="small quiet">{goal.title}</div>
          <h2>Backlog</h2>
        </div>
        {untouched.length > 0 && (
          <div className="stack8" role="group" aria-label={`Untouched since ${formatDate(oldest!)}`}>
            <h3 className="small strong">Untouched since {formatDate(oldest!)}</h3>
            {untouched.map((t) => (
              <div key={t.id} className="between strow">
                <span className="grow">
                  {t.title}
                  <span className="small quiet lineblock">Untouched since {formatDate(since(t)!)}</span>
                </span>
                <span className="row">
                  <Button {...btn} type="button" data-keep={t.id} aria-label={`Keep ${t.title}`} onClick={() => answer(t, true)}>
                    Keep
                  </Button>
                  <Button {...btn} type="button" aria-label={`Delete ${t.title}`} onClick={() => answer(t, false)}>
                    Delete
                  </Button>
                </span>
              </div>
            ))}
          </div>
        )}
        {rest.length > 0 && (
          <ul className="stack8 bltasks" aria-label={untouched.length ? 'The rest' : 'Tasks'}>
            {rest.map((t) => (
              <li key={t.id} className="between">
                <span>{t.title}</span>
                <span className="small quiet">{t.estimate_min ? formatMinutes(t.estimate_min) : 'No estimate'}</span>
              </li>
            ))}
          </ul>
        )}
        {!open.length && <p className="small quiet">No tasks left in it.</p>}
        <div className="row">
          <Button {...btn} type="button" data-open aria-describedby={noteId} onClick={props.onOpen}>
            Open backlog in Goals
          </Button>
          <Button {...btn} type="button" onClick={props.onClose}>
            Close
          </Button>
        </div>
        <p id={noteId} className="small quiet">
          Opening the backlog saves planning first, as Save and exit does.
        </p>
      </div>
    </Sheet>
  );
}

export function GoalsStep(props: {
  data: PlanData;
  ctx: PlanContext;
  st: Stretch;
  /** The stretch looked back on, or null for a first plan, which has none. */
  behind: Stretch | null;
  look: LookBack | undefined;
  phone: boolean;
  head: Head;
  act: Act;
  continueLabel: string;
  onNext(): void;
  /** Leaves planning, saved, for the project's own page. */
  onOpenProject(id: string): void;
  /** Leaves planning, saved, for a goal on Goals, where its backlog is. */
  onOpenGoal(id: string): void;
}) {
  const { data, ctx, st, behind, look, phone, act } = props;
  const on = today(ctx.clock);
  const add = useAdd(act);
  const land = useFocusLanding();
  const root = useRef<HTMLDivElement>(null);
  const newRef = useRef<HTMLButtonElement>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [adding, setAdding] = useState<{ kind: 'project' | 'practice'; goal: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [picking, setPicking] = useState<{ item: Linked; at: number } | null>(null);
  const [notNowOpen, setNotNowOpen] = useState(false);
  const [preview, setPreview] = useState<{ id: string; goal: string } | null>(null);
  const [backlogOpen, setBacklogOpen] = useState<string | null>(null);
  const btn = { size: 'compact' as const };

  const goals = shownGoals(data.objectives, on);
  const notNow = kept(data.objectives).filter((g) => resting(g, on));
  const goalIds = new Set(kept(data.objectives).map((g) => g.id));
  const plans = data.plans.filter(live);
  const practices = data.practices.filter((p) => p.state !== 'ended');
  const loose: (Linked & { kind: string })[] = [
    ...practices.filter((p) => !p.objective_id || !goalIds.has(p.objective_id)).map((p) => ({ type: 'practice' as const, kind: 'Practice', id: p.id, title: p.title, goal: null })),
    ...plans
      .filter((p) => !p.project.objective_id || !goalIds.has(p.project.objective_id))
      .map((p) => ({ type: 'project' as const, kind: 'Project', id: p.project.id, title: p.project.title, goal: null })),
  ];
  const askAgain = addDays(st.end, 1);
  const hours = (id: string) => look?.time.find((row) => row.id === id)?.delivered_min ?? 0;

  const setGoal = (g: Objective, fields: Fields<'objective'>, text: string) =>
    act(`goal-${g.id}`, text, (w) => applyPlanChange(w, { writes: [{ type: 'objective', id: g.id, fields }] }));
  // The card goes, so focus moves on to the next card's first control, or to + New goal.
  const goAway = (g: Objective, fields: Fields<'objective'>, text: string) => {
    setMenu(null);
    const at = goals.indexOf(g);
    land(() => root.current?.querySelectorAll<HTMLElement>('.goalcard')[at]?.querySelector<HTMLElement>('button') ?? newRef.current);
    void setGoal(g, fields, text);
  };
  const notNowFields = { state: 'not_now' as const, not_now_until: askAgain };
  const notNowText = (g: Objective) => `${g.title}: not now, asking again ${formatDate(askAgain)}.`;

  // In the project colour its blocks have on the week, with the status the Goals page gives it.
  const block = (plan: ProjectPlan, g: Objective) => {
    const { project } = plan;
    const stat = status(plan, ctx);
    const statId = `projst-${project.id}`;
    return (
      <button
        className="projblock blk k-project s-planned"
        type="button"
        aria-haspopup="dialog"
        aria-label={`Open project ${project.title}`}
        aria-describedby={statId}
        onClick={() => setPreview({ id: project.id, goal: g.title })}
      >
        <span>{project.title}</span>
        <span id={statId} className="pillrow">
          <Pill tone={stat.tone}>{stat.pill}</Pill> <span className="small">{phone ? shortWord(stat) : stat.word}</span>
        </span>
      </button>
    );
  };
  const previewed = preview && plans.find((p) => p.project.id === preview.id);
  const backlogOf = (g: Objective) => data.backlogs.find((b) => b.project.id === backlogId(g.id) && b.project.state === 'active');
  // A goal's backlog, after its projects, in blue with a thin edge and no stripe. With nothing open it isn't shown.
  const backlogBlock = (g: Objective, asks: boolean) => {
    const plan = backlogOf(g);
    const open = plan?.tasks.filter((t) => !t.done_at && !t.cancelled_at) ?? [];
    if (!plan || !open.length) return null;
    const minutes = open.reduce((sum, t) => sum + minutesLeft(t), 0);
    const untouched = open.map((t) => untouchedSince(data.touches[t.id], on)).filter((d): d is string => !!d).sort();
    // A card already asking "Still a goal?" says enough.
    const parts = [plural(open.length, 'task'), minutes ? formatMinutes(minutes) : '', untouched.length && !asks ? `${untouched.length} untouched since ${formatDate(untouched[0]!)}` : ''];
    const descId = `blst-${g.id}`;
    return (
      <button
        className={`projblock ${phone ? 'c-backlog' : 'ev-backlog'}`}
        type="button"
        aria-haspopup="dialog"
        aria-label={`Open the backlog for ${g.title}`}
        aria-describedby={descId}
        onClick={() => setBacklogOpen(g.id)}
      >
        <span>Backlog</span>
        <span id={descId} className="small">
          {parts.filter(Boolean).join(', ')}
        </span>
      </button>
    );
  };
  const backlogGoal = backlogOpen ? goals.find((g) => g.id === backlogOpen) : undefined;
  const backlogPlan = backlogGoal && backlogOf(backlogGoal);

  const card = (g: Objective) => {
    const projects = plans.filter((p) => p.project.objective_id === g.id);
    const own = practices.filter((p) => p.objective_id === g.id);
    const has = projects.length + own.length > 0;
    // Asked once a Not now runs out, or when nothing under it has changed for a cadence, as the Goals page asks.
    const changed = data.changed[g.id];
    const quiet = changed !== undefined && localDate(changed, ctx.clock.zone()) <= cadenceBefore(ctx.settings, on);
    const asks = !has && (g.state === 'not_now' || quiet);
    const late = projects.filter((p) => p.project.state === 'active' && (p.project.end < on || lateMilestone(p, ctx))).length;
    const time = behind ? hours(g.id) : 0;
    const titleId = `goal-${g.id}`;
    return (
      <section key={g.id} className="card stack8 goalcard" aria-labelledby={titleId}>
        <div className="between">
          {renaming === g.id ? (
            <Rename
              goal={g}
              phone={phone}
              onSave={(title) => setGoal(g, { title }, `Renamed ${g.title} to ${title}.`)}
              onDone={() => {
                setRenaming(null);
                land(() => root.current?.querySelector<HTMLElement>(`[data-rename="${g.id}"]`));
              }}
            />
          ) : (
            <>
              <div className="row grow">
                <h3 id={titleId}>{g.title}</h3>
                <button className={phone ? 'icbtn penbtn' : 'icon penbtn'} type="button" data-rename={g.id} aria-label={`Rename ${g.title}`} onClick={() => setRenaming(g.id)}>
                  <Icon name="pen" />
                </button>
              </div>
              {time > 0 && <span className="small quiet">{formatMinutes(time)} this stretch</span>}
              {!has && !asks && (
                <div className="editrow">
                  <Button
                    {...btn}
                    type="button"
                    aria-haspopup="dialog"
                    aria-expanded={menu === g.id}
                    aria-label={`More for ${g.title}: Not now, Archive`}
                    onClick={() => setMenu(menu === g.id ? null : g.id)}
                  >
                    ⋯
                  </Button>
                  {menu === g.id && (
                    <Popover label={g.title} onClose={() => setMenu(null)}>
                      {phone && <h2>{g.title}</h2>}
                      <div className={phone ? 'stack8' : 'row'}>
                        <Button {...btn} type="button" onClick={() => goAway(g, notNowFields, notNowText(g))}>
                          Not now, ask again {formatDate(askAgain)}
                        </Button>
                        <Button {...btn} type="button" onClick={() => goAway(g, { state: 'archived' }, `Archived ${g.title}.`)}>
                          Archive
                        </Button>
                      </div>
                    </Popover>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        {own.length > 0 && <div className="small">Practices: {own.map((p) => p.title).join(', ')}</div>}
        {projects.length > 0 && (
          <ul className="projblocks" aria-label={`Projects for ${g.title}`}>
            {projects.map((p) => (
              <li key={p.project.id}>{block(p, g)}</li>
            ))}
          </ul>
        )}
        {backlogBlock(g, asks)}
        {!has && <div className="small quiet">No practices or projects</div>}
        {late > 0 && <div className="small overtext">{plural(late, 'project')} late</div>}
        {asks && (
          <div className="row" role="group" aria-label={`Still a goal: ${g.title}?`}>
            <span className="small quiet grow">Nothing active. Still a goal?</span>
            <Button {...btn} type="button" onClick={() => goAway(g, notNowFields, notNowText(g))}>
              Yes, not now
            </Button>
            <Button {...btn} type="button" onClick={() => goAway(g, { state: 'archived' }, `Archived ${g.title}.`)}>
              No, archive it
            </Button>
          </div>
        )}
        <div className="row">
          <Button {...btn} type="button" aria-label={`Add project to ${g.title}`} onClick={() => setAdding({ kind: 'project', goal: g.id })}>
            + Project
          </Button>
          <Button {...btn} type="button" aria-label={`Add practice to ${g.title}`} onClick={() => setAdding({ kind: 'practice', goal: g.id })}>
            + Practice
          </Button>
        </div>
        {adding?.goal === g.id &&
          (adding.kind === 'project' ? (
            <ProjectAdd objectiveId={g.id} goalTitle={g.title} end={st.end} write={add.project} onClose={() => setAdding(null)} />
          ) : (
            <PracticeAdd goals={data.objectives} objectiveId={g.id} write={add.practice} onClose={() => setAdding(null)} />
          ))}
      </section>
    );
  };

  const lastNote = data.settings.plan_stretch.last_note;
  return (
    <div ref={root} className={phone ? 'stack' : 'wrap stack'}>
      <div className="stack8">
        <StepHead head={props.head}>{goals.length ? 'Are these still your goals?' : 'What are your goals?'}</StepHead>
        {goals.length === 0 && (
          <p className={phone ? 'small' : undefined}>
            A goal is something you want for years, like Health or Write a book. Projects and practices sit under goals, so planning can show where your time goes.
          </p>
        )}
        {behind && lastNote && <p className="small quiet">Last time you wrote: {lastNote}</p>}
        {behind && look && (
          <div className="stack8">
            <div className={phone ? 'small' : undefined}>{metLine(look.met)}</div>
            {look.pace != null && <div className="small quiet">About {formatMinutes(look.pace)} a week went to your goals.</div>}
          </div>
        )}
      </div>
      {goals.map(card)}
      {newOpen || goals.length === 0 ? (
        <NewGoalForm
          label="New goal"
          submit="Add goal"
          autoFocus={goals.length > 0}
          onAdd={async (title) => !!(await add.goal(title))}
          {...(goals.length ? { onCancel: () => (setNewOpen(false), setTimeout(() => newRef.current?.focus())) } : {})}
        />
      ) : (
        <div>
          <Button ref={newRef} {...btn} type="button" onClick={() => setNewOpen(true)}>
            + New goal
          </Button>
        </div>
      )}
      {loose.length > 0 && (
        <section className="card stack8" aria-label="No goal">
          <h3>No goal</h3>
          {loose.map((x, at) => (
            <div key={x.id} className="between">
              <span>
                {x.title} <span className="small quiet">{x.kind}</span>
              </span>
              <Button {...btn} type="button" data-give={x.id} aria-label={`Give ${x.title} a goal`} onClick={() => setPicking({ item: x, at })}>
                Give it a goal
              </Button>
            </div>
          ))}
        </section>
      )}
      {picking && (
        <GoalPicker
          item={picking.item}
          goals={data.objectives}
          act={act}
          onClose={() => {
            // Given a goal, the row goes, so focus moves to the next one's button, or to + New goal.
            const others = () => [...(root.current?.querySelectorAll<HTMLElement>('[data-give]') ?? [])].filter((b) => b.dataset.give !== picking.item.id);
            land(() => others()[picking.at] ?? others()[picking.at - 1] ?? newRef.current);
            setPicking(null);
          }}
        />
      )}
      {previewed && (
        <ProjectPreview
          plan={previewed}
          goal={preview.goal}
          ctx={ctx}
          phone={phone}
          onOpen={() => props.onOpenProject(previewed.project.id)}
          onClose={() => setPreview(null)}
        />
      )}
      {backlogGoal && backlogPlan && (
        <BacklogPreview
          goal={backlogGoal}
          plan={backlogPlan}
          touches={data.touches}
          on={on}
          phone={phone}
          act={act}
          clock={ctx.clock}
          onOpen={() => props.onOpenGoal(backlogGoal.id)}
          onClose={() => {
            const id = backlogGoal.id;
            setBacklogOpen(null);
            land(() => root.current?.querySelector<HTMLElement>(`[aria-describedby="blst-${id}"]`));
          }}
        />
      )}
      {notNow.length > 0 && (
        <div className="stack8">
          <div>
            <button className="link small" type="button" aria-expanded={notNowOpen} onClick={() => setNotNowOpen(!notNowOpen)}>
              <Icon name={notNowOpen ? 'chevron-down' : 'chevron-right'} size={16} />{' '}
              Not now ({notNow.length})
            </button>
          </div>
          {notNowOpen &&
            notNow.map((g) => (
              <div key={g.id} className="card between">
                <span>
                  {g.title} <span className="small quiet">Asking again {formatDate(g.not_now_until!)}</span>
                </span>
                <Button {...btn} type="button" aria-label={`Restore ${g.title}`} onClick={() => void setGoal(g, { state: 'active', not_now_until: null }, `Restored ${g.title}.`)}>
                  Restore
                </Button>
              </div>
            ))}
        </div>
      )}
      {!phone && (
        <div>
          <Button variant="primary" type="button" onClick={props.onNext}>
            {props.continueLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
