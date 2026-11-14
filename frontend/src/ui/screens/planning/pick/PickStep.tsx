// Pick tasks: add the week's work from projects and One offs. Nothing is picked until added, and suggestions only
// say what to offer. Does it fit, above every step, shows what each change does to the week. A card per project, with
// its overdue question inside it, and the week's shape beside them on desktop and as a tab on phone.

import { useMemo, useState } from 'react';
import type { Clock } from '../../../../core/clock';
import { formatDate, formatMinutes, nowInstant, today } from '../../../../core/dates';
import { applyPlanChange, dropMilestone, markMilestoneDone, minutesLeft, moveMilestone } from '../../../../core/plan';
import type { PlanChange, ProjectPlan, RecordWrite } from '../../../../core/plan';
import { getRecord, newId, setWeekPick, weekPickId, weekPlanId } from '../../../../core/records';
import type { Writer } from '../../../../core/records';
import { withStatusLine } from '../../../../core/status';
import { closeTask, scheduledWork, tickOneOff } from '../../../../core/tasks';
import { ONE_OFFS_BUCKET } from '../../../../core/types';
import type { Fields, LocalDate, Milestone, Minutes, Objective } from '../../../../core/types';
import type { Layout } from '../../../app/registry';
import { useApp, useMutation, useQuery } from '../../../app/store';
import { useToast } from '../../../components/Toast';
import { loadPlanning, weekModel } from '../model';
import type { WeekModel } from '../model';
import { aimWords, pickModel } from './model';
import type { PickTask, PickView } from './model';
import { PickDesktop } from './PickDesktop';
import { PickPhone } from './PickPhone';
import './pick.css';

interface AimSetting {
  bucket: string;
  name: string;
  /** This week's aim, and the one it has every week. */
  value: Minutes;
  usual: Minutes;
  canSkip: boolean;
  skipped: boolean;
}

/** A pick put in, changed or taken out, with what puts it back. Schedule's Remove from this week takes one out too. */
export async function pickChange(w: Writer, week: LocalDate, taskId: string, minutes: Minutes | null, clock: Clock): Promise<PlanChange> {
  const id = weekPickId(week, taskId);
  const had = await getRecord(w.sql, 'week_pick', id);
  if (!had || had.deleted_at) {
    if (minutes === null) return { writes: [] };
    await setWeekPick(w, week, taskId, minutes);
    return { writes: [{ type: 'week_pick', id, fields: { deleted_at: nowInstant(clock) } }] };
  }
  return applyPlanChange(w, { writes: [{ type: 'week_pick', id, fields: minutes === null ? { deleted_at: nowInstant(clock) } : { minutes } }] });
}

/** Everything a layout needs: the rows, the figures, and the actions. */
export interface PickProps {
  week: LocalDate;
  model: WeekModel;
  view: PickView;
  /** What the live region last said. */
  said: string;
  aims: AimSetting[];
  /** Adds the suggested part, or all that's left, at once. */
  add(row: PickTask): void;
  /** The time popover's Save: this week's share and the time the task takes, its time left when it has some recorded,
   * else its estimate, as one change with Undo. */
  saveTime(row: PickTask, week: Minutes, estimate: Minutes): void;
  /** Takes it out of the week, with Undo; focusUndo when what was pressed has gone. */
  dropFromWeek(row: PickTask, focusUndo?: boolean): void;
  /** Finished here, so the row stays, struck through. */
  isDone(row: PickTask): boolean;
  /** Finishes it, with a toast to undo it; focusUndo when what was pressed has gone. */
  markDone(row: PickTask, focusUndo?: boolean): void;
  undoDone(row: PickTask): void;
  /** Several at once, each as one change with one toast and Undo, which takes focus since what was pressed has gone. */
  pickMany(rows: PickTask[]): void;
  doneMany(rows: PickTask[]): void;
  dropMany(rows: PickTask[]): void;
  /** Keep in plan on an overdue milestone: its new date, and the open tasks to add with it. */
  keepMilestone(plan: ProjectPlan, milestone: Milestone, date: LocalDate, add: PickTask[]): void;
  milestoneDone(plan: ProjectPlan, milestone: Milestone): void;
  dropMilestone(plan: ProjectPlan, milestone: Milestone): void;
  /** Keep in plan on a task that needs a new time: into this week at its estimate. */
  keepCarried(row: PickTask): void;
  /** Drop on a task that needs a new time: it's cancelled. */
  dropTask(row: PickTask): void;
  saveAims(aims: Record<string, Minutes>, skipped: string[]): void;
  /** Goals a new project can go under. */
  goals: Objective[];
  /** Adding while you pick: each saves at once, with a toast whose Undo deletes it, and resolves to its id. A task or one
   * off can start in this week. A task added out of sight, to a folded milestone, keeps its toast until the next action. */
  addTask(plan: ProjectPlan, fields: Fields<'task'>, inWeek: boolean, folded?: boolean): Promise<string | undefined>;
  addMilestone(plan: ProjectPlan, title: string, due: LocalDate | null): Promise<string | undefined>;
  addProject(fields: Fields<'project'>): Promise<string | undefined>;
  addOneOff(fields: Fields<'task'>, inWeek: boolean): Promise<string | undefined>;
  skipPastEnd(projectId: string): void;
  onNext(): void;
  /** Back to step 1, where what's still in the Inbox is sorted. */
  onInbox(): void;
}

export function PickStep(props: { week: LocalDate; layout: Layout; onNext(): void; onInbox(): void }) {
  const { week } = props;
  const { clock } = useApp();
  const data = useQuery((sql) => loadPlanning(sql, clock, week), [week]).data;
  const toast = useToast();
  const [said, setSaid] = useState('');

  const pickWrite = useMutation((w, id: string, minutes: Minutes) => setWeekPick(w, week, id, minutes));
  const planWrite = useMutation((w, fields: Fields<'week_plan'>) => w.create('week_plan', { week_start: week, ...fields }, weekPlanId(week)));
  const taskWrite = useMutation((w, fn: (w: Writer) => Promise<PlanChange>) => fn(w));
  // What each Mark done here wrote, so Undo puts back the picks and blocks it freed, and a repeating one off's date.
  const [doneHere, setDoneHere] = useState<Record<string, PlanChange>>({});

  // Both read the whole history, so they're worked out only when the data changes, not on every render: a live region
  // line, a card opening or a save's pending state. On a five-year account each took about 200 ms.
  const models = useMemo(() => {
    if (!data) return null;
    const model = weekModel(data, clock);
    return { model, view: pickModel(data, model, clock) };
  }, [data, clock]);
  if (!data || !models) return null;
  const { model, view } = models;
  const { open, use, weekPlan } = model;

  // The week's time once a change is made, ending with how far over it goes: '7h 5m of 30h', '25h 20m of 24h, 1h 20m over'.
  const fitWords = (after: Minutes) => `${formatMinutes(after)} of ${formatMinutes(open)}${after > open ? `, ${formatMinutes(after - open)} over` : ''}`;
  // Adding and removing are said aloud, from the time used before. A slider's steps aren't, since the slider says its
  // own value, and a change with a toast isn't, since the toast says it.
  const changeBy = (title: string, delta: Minutes, verb: 'added' | 'removed') => setSaid(`${title} ${verb}. ${fitWords(use.used + delta)}.`);
  const freeWords = (free: Minutes) => (free < 0 ? `${formatMinutes(-free)} over` : `${formatMinutes(free)} free`);
  const undoable = (reverse: PlanChange | undefined, message: string, options: { spoken?: string; focusUndo?: boolean; stay?: boolean } = {}) => {
    if (reverse) toast.show(message, { ...options, undo: () => taskWrite.run((w) => applyPlanChange(w, reverse)) });
  };
  const aimsNow = weekPlan?.aims ?? {};
  const skipped = weekPlan?.skipped_aims ?? [];
  const aimRows = model.aimRows(model.planned);
  const aimSetting = (bucket: string, name: string, usual: Minutes | null | undefined): AimSetting => {
    const row = aimRows.find((r) => r.bucket === bucket);
    return { bucket, name, value: aimsNow[bucket] ?? usual ?? 0, usual: usual ?? 0, canSkip: !!row && aimWords(row).canSkip, skipped: skipped.includes(bucket) };
  };
  const tasks = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`;
  const many = async (rows: readonly PickTask[], fn: (w: Writer, row: PickTask) => Promise<PlanChange>) =>
    taskWrite.run(async (w) => {
      const writes = [];
      for (const r of rows) writes.unshift(...(await fn(w, r)).writes);
      return { writes };
    });
  const finish = (w: Writer, t: PickTask['c']['task']) => (t.kind === 'one_off' ? tickOneOff(w, t.id, clock) : closeTask(w, t.id, 'done', clock));
  // A new record, and with it, for a task in this week, its pick; Undo deletes both.
  const create = async <T extends 'task' | 'milestone' | 'project'>(type: T, fields: Fields<T>, pick: Minutes | null, message: string, stay = false) => {
    const id = newId(clock);
    const reverse = await taskWrite.run(async (w) => {
      await w.create(type, fields, id);
      const picked = pick === null ? { writes: [] } : await pickChange(w, week, id, pick, clock);
      return { writes: [...picked.writes, { type, id, fields: { deleted_at: nowInstant(clock) } }] };
    });
    if (!reverse) return undefined;
    undoable(reverse, message, { ...(pick === null ? {} : { spoken: `${fitWords(use.used + pick)}.` }), ...(stay ? { stay } : {}) });
    return id;
  };
  const inThisWeek = (minutes: Minutes, inWeek: boolean) => (inWeek ? `, ${formatMinutes(minutes)} in this week` : '');

  const pickProps: PickProps = {
    week,
    model,
    view,
    said,
    aims: [
      ...model.ranked.map((p) => aimSetting(p.project.id, p.project.title, p.project.weekly_aim)),
      aimSetting(ONE_OFFS_BUCKET, 'One offs', data.settings.one_offs_weekly_aim),
    ],
    add: (row) => {
      changeBy(row.title, row.adds, 'added');
      void pickWrite.run(row.c.task.id, row.adds);
    },
    pickMany: async (rows) => {
      const sum = rows.reduce((s, r) => s + r.adds, 0);
      const reverse = await many(rows, (w, r) => pickChange(w, week, r.c.task.id, r.adds, clock));
      undoable(reverse, `Added ${rows.length === 1 ? rows[0]!.title : tasks(rows.length)}, ${formatMinutes(sum)}.`, { spoken: `${fitWords(use.used + sum)}.`, focusUndo: true });
    },
    dropMany: async (rows) => {
      const sum = rows.reduce((s, r) => s + r.c.week, 0);
      const reverse = await many(rows, (w, r) => pickChange(w, week, r.c.task.id, null, clock));
      undoable(reverse, `Removed ${rows.length === 1 ? rows[0]!.title : tasks(rows.length)} from this week.`, { spoken: `${freeWords(use.free + sum)}.`, focusUndo: true });
    },
    doneMany: async (rows) => {
      const freed = rows.reduce((s, r) => s + (r.c.picked ? r.c.week : 0), 0);
      const each: Record<string, PlanChange> = {};
      const reverse = await many(rows, async (w, r) => (each[r.c.task.id] = await finish(w, r.c.task)));
      if (!reverse) return;
      setDoneHere((d) => ({ ...d, ...each }));
      const ids = Object.keys(each);
      toast.show(`${rows.length === 1 ? `${rows[0]!.title} done.` : `${tasks(rows.length)} done.`}${freed ? ` ${formatMinutes(freed)} freed.` : ''}`, {
        spoken: `${freeWords(use.free + freed)}.`,
        focusUndo: true,
        undo: async () => {
          if (await taskWrite.run((w) => applyPlanChange(w, reverse))) setDoneHere((d) => Object.fromEntries(Object.entries(d).filter(([id]) => !ids.includes(id))));
        },
      });
    },
    keepMilestone: async (plan, ms, date, add) => {
      const sum = add.reduce((s, r) => s + r.c.left, 0);
      const reverse = await taskWrite.run(async (w) => {
        const moved = await applyPlanChange(w, withStatusLine(plan, moveMilestone(plan, ms.id, date, model.ctx), model.ctx));
        const picks: RecordWrite[] = [];
        for (const r of add) picks.unshift(...(await pickChange(w, week, r.c.task.id, r.c.left, clock)).writes);
        return { writes: [...picks, ...moved.writes] };
      });
      undoable(reverse, `Kept ${ms.title}, due ${formatDate(date)}.${sum ? ` Added ${formatMinutes(sum)}.` : ''}`, { spoken: `${fitWords(use.used + sum)}.`, focusUndo: true });
    },
    milestoneDone: async (plan, ms) => {
      const open = plan.tasks.filter((t) => t.milestone_id === ms.id && !t.done_at && !t.cancelled_at).map((t) => t.id);
      const reverse = await taskWrite.run(async (w) => {
        const work = open.length ? await scheduledWork(w.sql, open, clock) : {};
        return applyPlanChange(w, withStatusLine(plan, markMilestoneDone(plan, ms.id, work, model.ctx), model.ctx));
      });
      undoable(reverse, `Marked ${ms.title} done${open.length ? `, and ticked ${tasks(open.length)}` : ''}.`, { focusUndo: true });
    },
    dropMilestone: async (plan, ms) => {
      const reverse = await taskWrite.run((w) => applyPlanChange(w, withStatusLine(plan, dropMilestone(plan, ms.id, { cancelOpen: false }, model.ctx), model.ctx)));
      undoable(reverse, `Dropped ${ms.title}.`, { focusUndo: true });
    },
    keepCarried: async (row) => {
      const reverse = await taskWrite.run((w) => pickChange(w, week, row.c.task.id, row.c.left, clock));
      undoable(reverse, `Added ${row.title} to this week, ${formatMinutes(row.c.left)}.`, { spoken: `${fitWords(use.used + row.c.left)}.`, focusUndo: true });
    },
    dropTask: async (row) => {
      const reverse = await taskWrite.run((w) => closeTask(w, row.c.task.id, 'cancelled', clock));
      undoable(reverse, `Dropped ${row.title}.`, { focusUndo: true });
    },
    saveAims: async (aims, skippedNow) => {
      const before = { aims: { ...aimsNow }, skipped_aims: [...skipped] };
      if (!(await planWrite.run({ aims, skipped_aims: skippedNow }))) return;
      toast.show('Changed the aims for this week.', { undo: () => planWrite.run(before) });
    },
    skipPastEnd: (id) => void planWrite.run({ skipped_past_end: [...(weekPlan?.skipped_past_end ?? []), id] }),
    goals: data.records.objectives,
    addTask: (plan, fields, inWeek, folded = false) => {
      const minutes = fields.estimate_min ?? 0;
      const where = plan.milestones.find((m) => m.id === fields.milestone_id)?.title ?? plan.project.title;
      return create('task', fields, inWeek ? minutes : null, `Added ${fields.title} to ${where}${inThisWeek(minutes, inWeek)}.`, folded);
    },
    // Tagged to this stretch, so one with no date reads "by" its end and is never outside it as soon as it's made.
    addMilestone: (plan, title, due) =>
      create('milestone', { project_id: plan.project.id, title, due, stretch: view.stretch?.start ?? null, added_on: today(clock) }, null, `Added milestone ${title} to ${plan.project.title}.`),
    addProject: (fields) =>
      create('project', { ...fields, added_on: today(clock) }, null, `Added project ${fields.title}, ${formatDate(fields.start!)} to ${formatDate(fields.end!)}.`),
    addOneOff: (fields, inWeek) => {
      const minutes = fields.estimate_min ?? 0;
      return create('task', fields, inWeek ? minutes : null, `Added ${fields.title} to One offs${inThisWeek(minutes, inWeek)}.`);
    },
    saveTime: async (row, minutes, estimate) => {
      const t = row.c.task;
      const left = t.remaining_min != null;
      const estChanged = estimate !== minutesLeft(t);
      // An estimate that's all on the calendar already leaves nothing to add.
      const weekChanged = row.c.picked ? minutes !== row.c.week : !(minutes === 0 && estimate > 0);
      const reverse = await taskWrite.run(async (w) => {
        const back = estChanged
          ? await applyPlanChange(w, { writes: [{ type: 'task', id: t.id, fields: left ? { remaining_min: estimate || null } : { estimate_min: estimate || null } }] })
          : { writes: [] };
        const picked = weekChanged ? await pickChange(w, week, t.id, minutes, clock) : { writes: [] };
        return { writes: [...picked.writes, ...back.writes] };
      });
      const parts = [
        weekChanged && `${formatMinutes(minutes)} this week`,
        estChanged && (estimate ? `${formatMinutes(estimate)} ${left ? 'left' : 'estimate'}` : 'no estimate'),
      ].filter(Boolean);
      undoable(reverse, `${t.title}, ${parts.join(', ')}.`);
    },
    dropFromWeek: async (row, focusUndo = false) => {
      const reverse = await taskWrite.run((w) => pickChange(w, week, row.c.task.id, null, clock));
      undoable(reverse, `Removed ${row.title} from this week.`, { spoken: `${freeWords(use.free + row.c.week)}.`, focusUndo });
    },
    isDone: (row) => row.done || !!doneHere[row.c.task.id],
    markDone: async (row, focusUndo = false) => {
      const t = row.c.task;
      const reverse = await taskWrite.run((w) => finish(w, t));
      if (!reverse) return;
      setDoneHere((d) => ({ ...d, [t.id]: reverse }));
      // Its pick goes with it, so say what that freed. The toast is the announcement; its spoken words end with the fit.
      const freed = row.c.picked ? row.c.week : 0;
      toast.show(freed ? `${row.title} done. ${formatMinutes(freed)} freed.` : `${row.title} done.`, {
        spoken: `${freeWords(use.free + freed)}.`,
        focusUndo,
        undo: async () => {
          if (await taskWrite.run((w) => applyPlanChange(w, reverse))) setDoneHere(({ [t.id]: _, ...rest }) => rest);
        },
      });
    },
    undoDone: async (row) => {
      const t = row.c.task;
      const reverse = doneHere[t.id] ?? { writes: [{ type: 'task', id: t.id, fields: { done_at: null } }] };
      if (!(await taskWrite.run((w) => applyPlanChange(w, reverse)))) return;
      setDoneHere(({ [t.id]: _, ...rest }) => rest);
    },
    onNext: props.onNext,
    onInbox: props.onInbox,
  };
  return props.layout === 'phone' ? <PickPhone {...pickProps} /> : <PickDesktop {...pickProps} />;
}
