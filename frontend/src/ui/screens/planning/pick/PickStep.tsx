// Pick tasks: add the week's work from projects and One offs. Nothing is picked until added, and suggestions only
// say what to offer. Every add or removal pops up the capacity ring. Two layouts over the same rows: a timeline
// beside the Planned list on desktop, and a board of bars over a half-height sheet on phone.

import { useMemo, useState } from 'react';
import { formatMinutes } from '../../../../core/dates';
import { applyPlanChange } from '../../../../core/plan';
import type { PlanChange, ProjectPlan } from '../../../../core/plan';
import { removeWeekPick, setWeekPick, weekPlanId } from '../../../../core/records';
import type { Writer } from '../../../../core/records';
import { closeTask, tickOneOff, undoProjectChange } from '../../../../core/tasks';
import { ONE_OFFS_BUCKET } from '../../../../core/types';
import type { Fields, LocalDate, Minutes } from '../../../../core/types';
import { useRingPop } from '../../../components/ring/CapacityRing';
import type { Layout } from '../../../app/registry';
import { useApp, useMutation, useQuery } from '../../../app/store';
import { usePlanChange } from '../../../components/editors';
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

/** Everything a layout needs: the rows, the figures, and the actions. */
export interface PickProps {
  week: LocalDate;
  model: WeekModel;
  view: PickView;
  ring: ReturnType<typeof useRingPop>;
  /** What the live region last said. */
  said: string;
  aims: AimSetting[];
  aimsChanged: boolean;
  add(row: PickTask): void;
  remove(row: PickTask): void;
  setMinutes(row: PickTask, minutes: Minutes): void;
  /** The time the task takes: its time left when it has some recorded, else its estimate. */
  setEstimate(row: PickTask, minutes: Minutes): void;
  /** Finished here, so the row shows Undo. */
  isDone(row: PickTask): boolean;
  markDone(row: PickTask): void;
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
  const ring = useRingPop();
  const [said, setSaid] = useState('');

  const pickWrite = useMutation(async (w, picks: readonly { id: string; minutes: Minutes | null }[]) => {
    for (const p of picks) await (p.minutes === null ? removeWeekPick(w, week, p.id) : setWeekPick(w, week, p.id, p.minutes));
  });
  const planWrite = useMutation((w, fields: Fields<'week_plan'>) => w.create('week_plan', { week_start: week, ...fields }, weekPlanId(week)));
  const undo = useMutation((w, plan: ProjectPlan) => undoProjectChange(w, plan, clock));
  const taskWrite = useMutation((w, fn: (w: Writer) => Promise<PlanChange>) => fn(w));
  const apply = usePlanChange();
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

  // Each change pops the ring and is said aloud, from the time used before it.
  const changeBy = (title: string, delta: Minutes) => {
    const after = use.used + delta;
    ring.pulse(use.used, after, after > open);
    setSaid(`${title} ${delta >= 0 ? 'added' : 'removed'}. ${formatMinutes(after)} of ${formatMinutes(open)}.`);
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
    ring,
    said,
    aims: [
      ...model.ranked.map((p) => aimSetting(p.project.id, p.project.title, p.project.weekly_aim)),
      aimSetting(ONE_OFFS_BUCKET, 'One offs', data.settings.one_offs_weekly_aim),
    ],
    aimsChanged: Object.keys(aimsNow).length > 0,
    add: (row) => {
      changeBy(row.title, row.adds);
      void pickWrite.run([{ id: row.c.task.id, minutes: row.adds }]);
    },
    remove: (row) => {
      changeBy(row.title, -row.c.week);
      void pickWrite.run([{ id: row.c.task.id, minutes: null }]);
    },
    setMinutes: (row, minutes) => {
      changeBy(row.title, minutes - row.c.week);
      void pickWrite.run([{ id: row.c.task.id, minutes }]);
    },
    addSuggested: async () => {
      const hints = Object.entries(model.hints);
      ring.pulse(use.used, use.used + view.hintMin, use.used + view.hintMin > open);
      setSaid(`Added ${formatMinutes(view.hintMin)}. ${formatMinutes(use.used + view.hintMin)} of ${formatMinutes(open)}.`);
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
    setEstimate: (row, minutes) => {
      const t = row.c.task;
      const left = t.remaining_min != null;
      const fields = left ? { remaining_min: minutes || null } : { estimate_min: minutes || null };
      const text = minutes ? `${t.title}, ${formatMinutes(minutes)} ${left ? 'left' : 'estimate'}.` : `${t.title}, no estimate.`;
      void apply(() => ({ writes: [{ type: 'task', id: t.id, fields }] }), { message: text });
    },
    isDone: (row) => row.done || !!doneHere[row.c.task.id],
    markDone: async (row) => {
      const t = row.c.task;
      const reverse = await taskWrite.run((w) => (t.kind === 'one_off' ? tickOneOff(w, t.id, clock) : closeTask(w, t.id, 'done', clock)));
      if (!reverse) return;
      setDoneHere((d) => ({ ...d, [t.id]: reverse }));
      setSaid(`${row.title} done.`);
    },
    undoDone: async (row) => {
      const t = row.c.task;
      const reverse = doneHere[t.id] ?? { writes: [{ type: 'task', id: t.id, fields: { done_at: null } }] };
      if (!(await taskWrite.run((w) => applyPlanChange(w, reverse)))) return;
      setDoneHere(({ [t.id]: _, ...rest }) => rest);
      setSaid(`${row.title} not done.`);
    },
    onNext: props.onNext,
  };
  return props.layout === 'phone' ? <PickPhone {...pickProps} /> : <PickDesktop {...pickProps} />;
}
