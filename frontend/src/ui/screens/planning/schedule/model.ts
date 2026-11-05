// What the Schedule step shows: every picked task in scheduling order with what's left to place, the week's blocks,
// and the practices placed for you. The order and the rules come from core; this only joins them up.

import type { Clock } from '../../../../core/clock';
import { blockMinutes, formatMinutes, formatTimeOfDay, instantMs, localDate, localMinutes } from '../../../../core/dates';
import { scheduleOrder, taskDue, taskWork } from '../../../../core/plan';
import type { Work } from '../../../../core/slots';
import type { Minutes, Task, TimeBlock } from '../../../../core/types';
import { dayName, placedBlocks, slotRange } from '../../../components/weekgrid';
import type { PlacedBlock } from '../../../components/weekgrid';
import type { PlanningData, WeekModel } from '../model';

const NO_ESTIMATE_MIN = 30;

export type SchedBlock = PlacedBlock;

export interface SchedRow {
  task: Task;
  work: Work;
  /** 'Write the report, Draft chapters, due Nov 9' */
  context: string;
  oneOff: boolean;
  /** Picked minutes not yet on the week. A pick with no minutes counts as half an hour. */
  toPlace: Minutes;
  /** The estimate not yet on the calendar, or null with no estimate. */
  estimateLeft: Minutes | null;
  /** This week's blocks for it, soonest first. */
  blocks: SchedBlock[];
}

export interface PracticeRow {
  id: string;
  title: string;
  skipped: boolean;
  /** '5 sessions, 2h 30m' */
  meta: string;
  /** Sessions not at a preferred time, because it was taken. */
  notes: string[];
}

export { dayName };

export { slotRange as range };

/** sessions: the week's practice blocks from queries.weekPractices, which say which were moved by hand. */
export function scheduleModel(d: PlanningData, m: WeekModel, sessions: readonly TimeBlock[], clock: Clock) {
  const now = clock.now();
  const zone = clock.zone();
  const blocks = placedBlocks(m.slot.placed, d.blocks, now);

  const list: SchedRow[] = scheduleOrder(m.plans, m.oneOffs, m.input, m.ctx).map((c) => {
    const oneOff = c.task.kind === 'one_off';
    const plan = oneOff ? null : (m.plans.find((p) => p.project.id === c.task.project_id) ?? null);
    const due = taskDue(c.task, plan, d.week, m.ctx);
    const where = plan ? plan.project.title : 'One off';
    const placed = d.blocks.filter((b) => b.task_id === c.task.id).reduce((sum, b) => sum + blockMinutes(b), 0);
    return {
      task: c.task,
      work: taskWork(c.task, due, d.week),
      context: due.label ? `${where}, ${due.label}` : where,
      oneOff,
      toPlace: Math.max(0, (c.week || NO_ESTIMATE_MIN) - placed),
      estimateLeft: c.task.estimate_min != null || c.task.remaining_min != null ? c.left : null,
      blocks: blocks.filter((b) => b.task_id === c.task.id),
    };
  });

  const skipped = m.weekPlan?.skipped_practices ?? [];
  const practices: PracticeRow[] = d.records.practices
    .filter((p) => p.state === 'active' && !p.deleted_at)
    .map((p) => {
      const own = sessions.filter((b) => b.practice_id === p.id && !b.cancelled);
      const total = own.reduce((sum, b) => sum + blockMinutes(b), 0);
      const preferred = p.preferred_times ?? [];
      return {
        id: p.id,
        title: p.title,
        skipped: skipped.includes(p.id),
        meta: skipped.includes(p.id) ? 'Skipped this week' : `${own.length} ${own.length === 1 ? 'session' : 'sessions'}, ${formatMinutes(total)}`,
        notes: own
          .filter((b) => !b.edited && preferred.length > 0 && !preferred.includes(localMinutes(b.start, zone)))
          .sort((a, b) => instantMs(a.start) - instantMs(b.start))
          .map((b) => `${dayName(localDate(b.start, zone))}: preferred time is taken, moved to ${formatTimeOfDay(localMinutes(b.start, zone))}`),
      };
    });

  return { blocks, rows: list, practices };
}

export type ScheduleModel = ReturnType<typeof scheduleModel>;
