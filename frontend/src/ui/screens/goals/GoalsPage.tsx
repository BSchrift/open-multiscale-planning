// Goals as a quiet hierarchy: each goal opens to its practices and projects, with a pen in its title to rename or
// delete it. A closed goal shows its worst project when one needs you, and asks "Still a goal?" when nothing is
// active and nothing under it has changed for a cadence. Finished and dropped projects and archived goals wait under Archived, each with Restore.

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { formatDate, formatMinutes, localDate, nowInstant, today } from '../../../core/dates';
import { cadenceBefore, nextStretch, restoreProject } from '../../../core/plan';
import type { PlanContext, ProjectPlan } from '../../../core/plan';
import { shortWord, status } from '../../../core/status';
import { deleteGoal, goalContents } from '../../../core/tasks';
import type { Fields, Objective, Practice } from '../../../core/types';
import { useNav } from '../../app/nav';
import { useApp, useMutation, useQuery } from '../../app/store';
import { PracticeAdd, PracticeFields, practiceRule, PracticeSheet, ProjectAdd, usePlanChange } from '../../components/editors';
import { ChevronIcon, PenIcon } from '../../components/icons';
import { Pill } from '../../components/Pill';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { useFocusLanding } from '../../components/useFocusLanding';
import type { GoalsData } from './data';
import { ProjectBody } from './ProjectView';
import { useStretchPlanning } from '../../components/planning/useStretchPlanning';

const NO_GOAL = 'nogoal';
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const live = (plan: ProjectPlan) => plan.project.state === 'active' || plan.project.state === 'paused';

type Adding = { kind: 'project' | 'practice'; goal: string | null };

/** A goal's title as a name field, with Save, Cancel (or Esc) and Delete goal. A blank name is never saved. */
function RenameGoal(props: { goal: Objective; save(title: string): Promise<unknown>; onDone(): void; onDelete(): void }) {
  const { layout } = useApp();
  const [name, setName] = useState(props.goal.title);
  const [error, setError] = useState('');
  const btn = layout === 'phone' ? 'btn' : 'btn sm';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const title = name.trim();
    if (!title) return setError('Give it a name.');
    if (await props.save(title)) props.onDone();
  };
  return (
    <form className="stack8 grow goalname" onSubmit={submit} onKeyDown={(event) => event.key === 'Escape' && props.onDone()}>
      <div className="row">
        <input
          className="field grow"
          aria-label="Goal name"
          autoFocus
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError('');
          }}
        />
        <button className={`${btn} pri`} type="submit">
          Save
        </button>
        <button className={btn} type="button" onClick={props.onDone}>
          Cancel
        </button>
        <button className={btn} type="button" onClick={props.onDelete}>
          Delete goal
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

/** Asks before deleting a goal, naming everything that goes with it. Undo brings it all back. */
function DeleteGoal(props: { goal: Objective; onClose(): void; onDeleted(): void }) {
  const { goal } = props;
  const { clock, layout } = useApp();
  const toast = useToast();
  const apply = usePlanChange();
  const id = useId();
  const { data } = useQuery((sql) => goalContents(sql, goal.id), [goal.id]);
  const remove = useMutation((w) => deleteGoal(w, goal.id, clock));
  const projects = data?.projects ?? [];
  const practices = data?.practices ?? [];
  const total = (key: 'milestones' | 'tasks') => projects.reduce((sum, p) => sum + p[key].length, 0);
  const btn = layout === 'phone' ? 'btn grow' : 'btn';

  const confirm = async () => {
    const reverse = await remove.run();
    if (!reverse) return;
    props.onDeleted();
    props.onClose();
    toast.show(`Deleted ${goal.title}.`, { undo: () => apply(() => reverse), focusUndo: true });
  };

  return (
    <Sheet label={`Delete ${goal.title}?`} describedBy={id} onClose={props.onClose}>
      <h2>Delete {goal.title}?</h2>
      <div id={id}>
        {data &&
          (projects.length + practices.length ? (
            <>
              <p>Everything under it goes too:</p>
              <ul>
                {projects.length > 0 && (
                  <li>
                    {plural(projects.length, 'project')}: {projects.map((p) => p.title).join(', ')}, with {plural(total('milestones'), 'milestone')} and{' '}
                    {plural(total('tasks'), 'task')}
                  </li>
                )}
                {practices.length > 0 && (
                  <li>
                    {plural(practices.length, 'practice')}: {practices.map((p) => p.title).join(', ')}
                  </li>
                )}
              </ul>
            </>
          ) : (
            <p>Nothing else is under it.</p>
          ))}
      </div>
      <div className="row">
        <button className={`${btn} pri`} type="button" disabled={!data || remove.pending} onClick={confirm}>
          Yes, delete
        </button>
        <button className={btn} type="button" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}

export function GoalsPage(props: { data: GoalsData; ctx: PlanContext; show?: string }) {
  const { data, ctx } = props;
  const { layout, clock } = useApp();
  const nav = useNav();
  const toast = useToast();
  const apply = usePlanChange();
  const phone = layout === 'phone';
  const on = today(clock);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState<Adding | null>(null);
  const [practiceOpen, setPracticeOpen] = useState<string | null>(null);
  const [newGoalOpen, setNewGoalOpen] = useState(false);
  const [newGoal, setNewGoal] = useState('');
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Objective | null>(null);
  // Where focus goes when the control that had it goes away: row buttons by goal id or `project:<id>`.
  const land = useFocusLanding();
  const heads = useRef(new Map<string, HTMLElement>());
  const headRef = (key: string) => (el: HTMLElement | null) => void (el ? heads.current.set(key, el) : heads.current.delete(key));
  const archivedRef = useRef<HTMLButtonElement>(null);

  const setGoal = useMutation((w, id: string, fields: Fields<'objective'>) => w.set('objective', id, fields));
  const addGoal = useMutation((w, title: string) => w.create('objective', { title, state: 'active' }));

  const goals = data.objectives.filter((g) => g.state !== 'archived');
  goals.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || (a.id < b.id ? -1 : 1));
  const goalIds = new Set(goals.map((g) => g.id));
  const plans = data.plans.filter(live);
  const practices = data.practices.filter((p) => p.state !== 'ended');
  const homeOf = (id: string | null | undefined) => (id && goalIds.has(id) ? id : NO_GOAL);
  const archivedGoals = data.objectives.filter((g) => g.state === 'archived');
  const archivedProjects = data.plans.filter((p) => !live(p));
  const looseProjects = plans.filter((p) => homeOf(p.project.objective_id) === NO_GOAL);
  const loosePractices = practices.filter((p) => homeOf(p.objective_id) === NO_GOAL);

  const toggle = (id: string) => setOpen({ ...open, [id]: !open[id] });
  // Each open practice's way out other than Save or Cancel, so its row's toggle keeps unsaved changes rather than
  // dropping them.
  // shortcut: folding the goal around an open practice, or leaving Goals, still drops them; guard those too if anyone
  // loses typing that way.
  const leaves = useRef(new Map<string, { current: (() => boolean) | null }>());
  const leaveOf = (id: string) => {
    let leave = leaves.current.get(id);
    if (!leave) leaves.current.set(id, (leave = { current: null }));
    return leave;
  };
  const closePractice = (id: string, saved?: Fields<'practice'>) => {
    const key = `practice:${id}`;
    const home = saved && 'objective_id' in saved ? homeOf(saved.objective_id) : null;
    const moved = !!home && home !== homeOf(practices.find((p) => p.id === id)?.objective_id);
    const was = heads.current.get(key);
    setPracticeOpen(null);
    // A new goal moves the row under it, so that opens and focus follows the row there, once it has arrived.
    setOpen((o) => ({ ...o, [key]: false, ...(home ? { [home]: true } : {}) }));
    land(() => {
      const head = heads.current.get(key);
      return moved && head === was ? null : head;
    });
  };

  // A link to a practice or goal, such as from what an Inbox item became, opens it.
  useEffect(() => {
    const practice = practices.find((p) => p.id === props.show);
    const section = practice ? homeOf(practice.objective_id) : goals.find((g) => g.id === props.show)?.id;
    if (!section) return;
    setOpen((o) => ({ ...o, [section]: true, ...(practice && !phone ? { [`practice:${practice.id}`]: true } : {}) }));
    if (practice && phone) setPracticeOpen(practice.id);
  }, [props.show]);
  const change = (goal: Objective, fields: Fields<'objective'>, message: string, then: () => HTMLElement | null | undefined) => async () => {
    land(then);
    const previous = await setGoal.run(goal.id, fields);
    if (previous) toast.show(message, { undo: () => setGoal.run(goal.id, previous) });
  };

  const submitGoal = async (event: FormEvent) => {
    event.preventDefault();
    const title = newGoal.trim();
    if (!title) return;
    const id = await addGoal.run(title);
    if (id) {
      setNewGoal('');
      setNewGoalOpen(false);
      toast.show(`Added ${title}.`, { undo: () => setGoal.run(id, { deleted_at: nowInstant(clock) }) });
    }
  };

  const practiceRow = (p: Practice) => {
    const week = data.practiceWeek[p.id];
    const time = week ? `${formatMinutes(week.spent_min)} of ${formatMinutes(week.target_min)} this week` : '';
    const paused = p.state === 'paused' && <Pill tone="grey">Paused</Pill>;
    if (phone) {
      return (
        <div key={p.id}>
          <button ref={headRef(`practice:${p.id}`)} className="projbtn" type="button" onClick={() => setPracticeOpen(p.id)}>
            <span className="grow">
              <span className="lineblock">
                {p.title} {paused}
              </span>
              <span className="small quiet lineblock">{time}</span>
            </span>
            <span className="chev" aria-hidden="true"><ChevronIcon /></span>
          </button>
        </div>
      );
    }
    const key = `practice:${p.id}`;
    const leave = leaveOf(p.id);
    return (
      <div key={p.id} className="prow">
        <div className="prowhead">
          <button
            ref={headRef(key)}
            className="pmain"
            type="button"
            aria-expanded={!!open[key]}
            onClick={() => (open[key] && leave.current ? leave.current() : toggle(key))}
          >
            <span className="qcaret" aria-hidden="true">
              {open[key] ? '▾' : '▸'}
            </span>
            <span className="grow">
              <span className="strong">{p.title}</span> {paused}
              <span className="small quiet lineblock">Practice{p.state === 'active' && time ? `, ${time}` : ''}</span>
            </span>
          </button>
        </div>
        {open[key] && (
          <div className="detail stack8">
            <div className="small quiet">{practiceRule(p)}</div>
            <PracticeFields practice={p} goals={data.objectives} label={`Edit ${p.title}`} leaveRef={leave} onClose={(saved) => closePractice(p.id, saved)} />
          </div>
        )}
      </div>
    );
  };

  const projectRow = (plan: ProjectPlan) => {
    const st = status(plan, ctx);
    const { project } = plan;
    if (phone) {
      return (
        <button key={project.id} className="projbtn" type="button" onClick={() => nav.go('goals', { project: project.id })}>
          <span className="grow">
            <span className="lineblock">{project.title}</span>
            <span className="pillrow">
              <Pill tone={st.tone}>{st.pill}</Pill>
              <span className="small quiet">{shortWord(st)}</span>
            </span>
          </span>
          <span className="chev" aria-hidden="true"><ChevronIcon /></span>
        </button>
      );
    }
    const key = `project:${project.id}`;
    const count = plan.milestones.filter((m) => !m.dropped_at).length;
    return (
      <div key={project.id} className="prow">
        <div className="prowhead">
          <button ref={headRef(key)} className="pmain" type="button" aria-expanded={!!open[key]} onClick={() => toggle(key)}>
            <span className="qcaret" aria-hidden="true">
              {open[key] ? '▾' : '▸'}
            </span>
            <span className="row grow">
              <span className="strong">{project.title}</span>
              <Pill tone={st.tone}>{st.pill}</Pill>
              <span className="small quiet">{count ? plural(count, 'milestone') : 'No milestones'}</span>
            </span>
          </button>
        </div>
        {open[key] && (
          <div className="detail">
            <ProjectBody
              plan={plan}
              ctx={ctx}
              goals={data.objectives}
              onMoved={(goal) => {
                // The row moves under its new goal, so that opens and focus follows the row there.
                setOpen((o) => ({ ...o, [goal ?? NO_GOAL]: true }));
                land(() => heads.current.get(key));
              }}
            />
          </div>
        )}
      </div>
    );
  };

  const addButtons = (goal: string | null, withProject: boolean) => (
    <div className="row">
      {withProject && (
        <button className={phone ? 'btn plain' : 'btn sm'} type="button" onClick={() => setAdding({ kind: 'project', goal })}>
          {phone ? '+ Project' : 'Add project'}
        </button>
      )}
      <button className={phone ? 'btn plain' : 'btn sm'} type="button" onClick={() => setAdding({ kind: 'practice', goal })}>
        {phone ? '+ Practice' : 'Add practice'}
      </button>
    </div>
  );

  const addForms = (goal: string | null, title?: string) =>
    adding?.goal === goal &&
    (adding.kind === 'project' ? (
      <ProjectAdd objectiveId={goal} {...(title ? { goalTitle: title } : {})} onClose={() => setAdding(null)} />
    ) : (
      <PracticeAdd goals={data.objectives} objectiveId={goal} onClose={() => setAdding(null)} />
    ));

  const goalRow = (goal: Objective) => {
    const projects = plans.filter((p) => p.project.objective_id === goal.id);
    const own = practices.filter((p) => p.objective_id === goal.id);
    const has = projects.length + own.length > 0;
    const notNow = !has && goal.state === 'not_now' && !!goal.not_now_until && goal.not_now_until > on;
    // Asked once a Not now runs out, or when nothing under the goal has changed for a cadence.
    const changed = data.changed[goal.id];
    const quiet = changed !== undefined && localDate(changed, clock.zone()) <= cadenceBefore(ctx.settings, on);
    const asks = !has && !notNow && (goal.state === 'not_now' || quiet);
    const flagged = projects
      .map((plan) => ({ plan, st: status(plan, ctx) }))
      .filter((x) => x.st.rank >= 2)
      .sort((a, b) => b.st.rank - a.st.rank);
    const worst = flagged[0];
    const isOpen = !!open[goal.id];
    const counts = [own.length ? plural(own.length, 'practice') : '', projects.length ? plural(projects.length, 'project') : ''].filter(Boolean).join(', ');
    const line = notNow ? `Not now. Asking again ${formatDate(goal.not_now_until!)}.` : has ? counts : asks ? 'Nothing active. Still a goal?' : 'Nothing active.';
    // Open, a goal with nothing active asks inside instead.
    const showLine = isOpen ? notNow || (!phone && has) : !worst && (!phone || !has || notNow);
    const pen = `rename:${goal.id}`;
    return (
      <div key={goal.id} className="card goal">
        <div className="goalhead">
          {isOpen && renaming === goal.id ? (
            <RenameGoal
              goal={goal}
              save={async (title) => {
                const previous = await setGoal.run(goal.id, { title });
                if (previous && title !== goal.title) toast.show(`Renamed to ${title}.`, { undo: () => setGoal.run(goal.id, previous) });
                return previous;
              }}
              onDone={() => {
                land(() => heads.current.get(pen));
                setRenaming(null);
              }}
              onDelete={() => setDeleting(goal)}
            />
          ) : (
            <>
              <button ref={headRef(goal.id)} className={phone ? 'goalbtn' : 'pmain'} type="button" aria-expanded={isOpen} onClick={() => toggle(goal.id)}>
                <span className={phone ? 'quiet' : 'qcaret'} aria-hidden="true">
                  {isOpen ? '▾' : '▸'}
                </span>
                <span className="grow">
                  <span className="strong">{goal.title}</span>
                  {worst && !isOpen && (
                    <span className="pillrow">
                      <Pill tone={worst.st.tone}>{worst.st.pill}</Pill>
                      <span className="small">
                        {worst.plan.project.title}
                        {flagged.length > 1 ? `, +${flagged.length - 1} more` : ''}
                      </span>
                    </span>
                  )}
                  {showLine && <span className="small quiet lineblock">{line}</span>}
                </span>
              </button>
              {isOpen && (
                <button ref={headRef(pen)} className={phone ? 'icbtn penbtn' : 'icon penbtn'} type="button" aria-label={`Rename ${goal.title}`} onClick={() => setRenaming(goal.id)}>
                  <PenIcon />
                </button>
              )}
            </>
          )}
        </div>
        {isOpen && (
          <div className="nested stack8">
            {own.map(practiceRow)}
            {projects.map(projectRow)}
            {asks && (
              <div className="row">
                <span className="small quiet">Still a goal?</span>
                <button
                  className={phone ? 'btn plain' : 'btn sm'}
                  type="button"
                  onClick={change(goal, { state: 'not_now', not_now_until: nextStretch(ctx.settings, on).start }, `${goal.title}: not now.`, () => heads.current.get(goal.id))}
                >
                  Yes, not now
                </button>
                <button className={phone ? 'btn plain' : 'btn sm'} type="button" onClick={change(goal, { state: 'archived' }, `Archived ${goal.title}.`, () => archivedRef.current)}>
                  No, archive it
                </button>
              </div>
            )}
            {addForms(goal.id, goal.title)}
            {addButtons(goal.id, true)}
          </div>
        )}
      </div>
    );
  };

  // A practice can stand alone, so it needs a home here without being a goal itself. Phone hides it while empty.
  const noGoalSection = () => {
    const empty = !looseProjects.length && !loosePractices.length;
    if (phone && empty) return null;
    const isOpen = !!open[NO_GOAL];
    const title = looseProjects.length ? 'No goal' : 'Practices with no goal';
    const counts = [loosePractices.length ? plural(loosePractices.length, 'practice') : '', looseProjects.length ? plural(looseProjects.length, 'project') : '']
      .filter(Boolean)
      .join(', ');
    return (
      <div className="stack8 nogoal">
        <div>
          <button className="seclabel" type="button" aria-expanded={isOpen} onClick={() => toggle(NO_GOAL)}>
            <span aria-hidden="true">
              {isOpen ? '▾' : '▸'}
            </span>
            <span className="grow">
              <span className="strong">{title}</span>
              {!phone && <span className="small quiet lineblock">{counts || 'None yet'}</span>}
            </span>
          </button>
        </div>
        {isOpen && (
          <div className="nested stack8 card">
            {loosePractices.map(practiceRow)}
            {looseProjects.map(projectRow)}
            {addForms(null)}
            {addButtons(null, false)}
          </div>
        )}
      </div>
    );
  };

  const archivedCount = archivedGoals.length + archivedProjects.length;
  // On the page rather than in the row, so it stays open when its practice moves to another goal.
  const sheetPractice = practices.find((p) => p.id === practiceOpen);
  const stretchPlanning = useStretchPlanning();
  return (
    <div className={phone ? 'stack goalspage' : 'wrap stack goalspage'}>
      <h1>Goals</h1>
      {/* Today's row asks to plan the stretch; here, once its planning has a time, only when. */}
      {phone && stretchPlanning.at && (
        <button className="attn due" type="button" onClick={() => nav.openFlow('plan')}>
          <span>{stretchPlanning.at}</span>
          <span aria-hidden="true">›</span>
        </button>
      )}
      {!phone && (
        <form className="row newgoal" onSubmit={submitGoal}>
          <label className="small quiet" htmlFor="newgoal">
            New goal
          </label>
          <input id="newgoal" className="field grow" value={newGoal} onChange={(event) => setNewGoal(event.target.value)} />
          <button className="btn" type="submit">
            Add
          </button>
        </form>
      )}
      <div className="stack">
        {goals.map(goalRow)}
        {noGoalSection()}
      </div>
      {phone && (
        <>
          <div className="row">
            <button className="btn plain" type="button" aria-expanded={newGoalOpen} onClick={() => setNewGoalOpen(!newGoalOpen)}>
              + New goal
            </button>
            {!loosePractices.length && !looseProjects.length && (
              <button className="btn plain" type="button" onClick={() => setAdding({ kind: 'practice', goal: null })}>
                + Practice
              </button>
            )}
          </div>
          {newGoalOpen && (
            <form className="row nowrap" onSubmit={submitGoal}>
              <input className="field grow" aria-label="New goal" autoFocus value={newGoal} onChange={(event) => setNewGoal(event.target.value)} />
              <button className="btn" type="submit">
                Add
              </button>
            </form>
          )}
          {!loosePractices.length && !looseProjects.length && addForms(null)}
        </>
      )}
      {sheetPractice && <PracticeSheet practice={sheetPractice} goals={data.objectives} onClose={(saved) => closePractice(sheetPractice.id, saved)} />}
      {deleting && <DeleteGoal goal={deleting} onClose={() => setDeleting(null)} onDeleted={() => setRenaming(null)} />}
      {archivedCount > 0 && (
        <div className="stack8 archived">
          <div>
            <button ref={archivedRef} className="seclabel" type="button" aria-expanded={archivedOpen} onClick={() => setArchivedOpen(!archivedOpen)}>
              Archived ({archivedCount})
            </button>
          </div>
          {archivedOpen && (
            <div className="card">
              {archivedGoals.map((g) => (
                <div key={g.id} className="between archrow">
                  <span>{g.title}</span>
                  <span className="row">
                    <button
                      className="btn sm"
                      type="button"
                      aria-label={`Restore ${g.title}`}
                      onClick={async () => {
                        const previous = await setGoal.run(g.id, { state: 'active', not_now_until: null });
                        if (previous) toast.show(`${g.title} restored.`, { undo: () => setGoal.run(g.id, previous), focusUndo: true });
                      }}
                    >
                      Restore
                    </button>
                    <button className="btn sm" type="button" aria-label={`Delete ${g.title}`} onClick={() => setDeleting(g)}>
                      Delete
                    </button>
                  </span>
                </div>
              ))}
              {archivedProjects.map((plan) => (
                <div key={plan.project.id} className="between archrow">
                  <span className="row">
                    <span>{plan.project.title}</span>
                    <Pill tone="grey">{plan.project.state === 'finished' ? 'Finished' : 'Dropped'}</Pill>
                  </span>
                  <button
                    className="btn sm"
                    type="button"
                    aria-label={`Restore ${plan.project.title}`}
                    onClick={() => apply(() => restoreProject(plan), { message: `${plan.project.title} restored.` })}
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
