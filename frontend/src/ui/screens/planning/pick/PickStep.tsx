// Pick tasks: add the week's work from projects and One offs. Nothing is picked until added, and suggestions only
// say what to offer. Does it fit, above every step, shows what each change does to the week. Two layouts over the same
// rows: a timeline beside the Planned list on desktop, and a board of bars over a half-height sheet on phone.

import { useMemo, useState } from 'react';
import type { Clock } from '../../../../core/clock';
import { formatMinutes, nowInstant } from '../../../../core/dates';
import { applyPlanChange, minutesLeft } from '../../../../core/plan';
import type { PlanChange, ProjectPlan } from '../../../../core/plan';
import { getRecord, removeWeekPick, setWeekPick, weekPickId, weekPlanId } from '../../../../core/records';
import type { Writer } from '../../../../core/records';
import { closeTask, tickOneOff, undoProjectChange } from '../../../../core/tasks';
import { ONE_OFFS_BUCKET } from '../../../../core/types';
import type { Fields, LocalDate, Minutes } from '../../../../core/types';
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
  value: Minutes;
  canSkip: boolean;
  skipped: boolean;
}

/** A pick put in, changed or taken out, with what puts it back. */
async function pickChange(w: Writer, week: LocalDate, taskId: string, minutes: Minutes | null, clock: Clock): Promise<PlanChange> {
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
  aimsChanged: boolean;
  /** Adds the suggested part, or all that's left, at once. */
  add(row: PickTask): void;
  remove(row: PickTask): void;
  setMinutes(row: PickTask, minutes: Minutes): void;
  /** The time popover's Save: this week's share and the time the task takes, its time left when it has some recorded,
   * else its estimate, as one change with Undo. */
  saveTime(row: PickTask, week: Minutes, estimate: Minutes): void;
  /** Takes it out of the week, with Undo. */
  dropFromWeek(row: PickTask): void;
  /** Finished here, so the row stays, struck through. */
  isDone(row: PickTask): boolean;
  /** Finishes it, with a toast to undo it; focusUndo when what was pressed has gone. */
  markDone(row: PickTask, focusUndo?: boolean): void;
  undoDone(row: PickTask): void;
  /** Adds every suggestion and resolves to the ids added, for Undo. */
  addSuggested(): Promise<string[]>;
  removeAll(ids: readonly string[]): void;
  setAim(bucket: string, minutes: Minutes): void;
  resetAims(): void;
  toggleSkipAim(bucket: string): void;
  skipPastEnd(projectId: string): void;
  undoChange(plan: ProjectPlan): void;
  onNext(): void;
}

export function PickStep(props: { week: LocalDate; layout: Layout; onNext(): void }) {
  const { week } = props;
  const { clock } = useApp();
  const data = useQuery((sql) => loadPlanning(sql, clock, week), [week]).data;
  const toast = useToast();
  const [said, setSaid] = useState('');

  const pickWrite = useMutation(async (w, picks: readonly { id: string; minutes: Minutes | null }[]) => {
    for (const p of picks) await (p.minutes === null ? removeWeekPick(w, week, p.id) : setWeekPick(w, week, p.id, p.minutes));
  });
  const planWrite = useMutation((w, fields: Fields<'week_plan'>) => w.create('week_plan', { week_start: week, ...fields }, weekPlanId(week)));
  const undo = useMutation((w, plan: ProjectPlan) => undoProjectChange(w, plan, clock));
  const taskWrite = useMutation((w, fn: (w: Writer) => Promise<PlanChange>) => fn(w));
  // What each Mark done here wrote, so Undo puts back the picks and blocks it freed, and a repeating one off's date.
  const [doneHere, setDoneHere] = useState<Record<string, PlanChange>>({});

  // Both read the whole history, so they're worked out only when the data changes, not on every render: a live region
  // line, a ring pulse or a save's pending state. On a five-year account each took about 200 ms.
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
  const changeBy = (title: string, delta: Minutes, verb?: 'added' | 'removed') => {
    if (verb) setSaid(`${title} ${verb}. ${fitWords(use.used + delta)}.`);
  };
  const freeWords = (free: Minutes) => (free < 0 ? `${formatMinutes(-free)} over` : `${formatMinutes(free)} free`);
  const undoable = (reverse: PlanChange | undefined, message: string, options: { spoken?: string; focusUndo?: boolean } = {}) => {
    if (reverse) toast.show(message, { ...options, undo: () => taskWrite.run((w) => applyPlanChange(w, reverse)) });
  };
  const aimsNow = weekPlan?.aims ?? {};
  const skipped = weekPlan?.skipped_aims ?? [];
  const aimRows = model.aimRows(model.planned);
  const aimSetting = (bucket: string, name: string, usual: Minutes | null | undefined): AimSetting => {
    const row = aimRows.find((r) => r.bucket === bucket);
    return { bucket, name, value: aimsNow[bucket] ?? usual ?? 0, canSkip: !!row && aimWords(row).canSkip, skipped: skipped.includes(bucket) };
  };

  const pickProps: PickProps = {
    week,
    model,
    view,
    said,
    aims: [
      ...model.ranked.map((p) => aimSetting(p.project.id, p.project.title, p.project.weekly_aim)),
      aimSetting(ONE_OFFS_BUCKET, 'One offs', data.settings.one_offs_weekly_aim),
    ],
    aimsChanged: Object.keys(aimsNow).length > 0,
    add: (row) => {
      changeBy(row.title, row.adds, 'added');
      void pickWrite.run([{ id: row.c.task.id, minutes: row.adds }]);
    },
    remove: (row) => {
      changeBy(row.title, -row.c.week, 'removed');
      void pickWrite.run([{ id: row.c.task.id, minutes: null }]);
    },
    setMinutes: (row, minutes) => {
      changeBy(row.title, minutes - row.c.week);
      void pickWrite.run([{ id: row.c.task.id, minutes }]);
    },
    addSuggested: async () => {
      const hints = Object.entries(model.hints);
      setSaid(`Added ${formatMinutes(view.hintMin)}. ${fitWords(use.used + view.hintMin)}.`);
      await pickWrite.run(hints.map(([id, h]) => ({ id, minutes: h.minutes })));
      return hints.map(([id]) => id);
    },
    removeAll: (ids) => {
      setSaid('Undone.');
      void pickWrite.run(ids.map((id) => ({ id, minutes: null })));
    },
    setAim: (bucket, minutes) => void planWrite.run({ aims: { ...aimsNow, [bucket]: minutes } }),
    resetAims: () => void planWrite.run({ aims: {} }),
    toggleSkipAim: (bucket) =>
      void planWrite.run({ skipped_aims: skipped.includes(bucket) ? skipped.filter((b) => b !== bucket) : [...skipped, bucket] }),
    skipPastEnd: (id) => void planWrite.run({ skipped_past_end: [...(weekPlan?.skipped_past_end ?? []), id] }),
    undoChange: (plan) => void undo.run(plan),
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
    dropFromWeek: async (row) => {
      const reverse = await taskWrite.run((w) => pickChange(w, week, row.c.task.id, null, clock));
      undoable(reverse, `Removed ${row.title} from this week.`, { spoken: `${freeWords(use.free + row.c.week)}.` });
    },
    isDone: (row) => row.done || !!doneHere[row.c.task.id],
    markDone: async (row, focusUndo = false) => {
      const t = row.c.task;
      const reverse = await taskWrite.run((w) => (t.kind === 'one_off' ? tickOneOff(w, t.id, clock) : closeTask(w, t.id, 'done', clock)));
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
  };
  return props.layout === 'phone' ? <PickPhone {...pickProps} /> : <PickDesktop {...pickProps} />;
}
