// What the Schedule step shows: every picked task in scheduling order, then each practice, with what's left to place,
// and the week's blocks. The order and the rules come from core; this only joins them up.

import type { Clock } from '../../../../core/clock';
import { blockMinutes, formatMinutes } from '../../../../core/dates';
import { FIRST_BLOCK_MIN, pickToPlace, scheduleOrder, taskDue, taskWork } from '../../../../core/plan';
import { practicesLeft } from '../../../../core/slots';
import type { Work } from '../../../../core/slots';
import type { Minutes, Practice, Task, TimeBlock } from '../../../../core/types';
import { practiceRule } from '../../../components/editors/PracticeSchedule';
import { placedBlocks } from '../../../components/weekgrid';
import type { PlacedBlock } from '../../../components/weekgrid';
import type { PlanningData, WeekModel } from '../model';

export interface SchedRow {
  /** The task's or practice's. */
  id: string;
  title: string;
  task?: Task;
  practice?: Practice;
  work: Work;
  /** 'Write the report, Draft chapters, due Nov 9' */
  context: string;
  oneOff: boolean;
  /** Picked minutes not yet on the week. A pick with no minutes counts as half an hour. */
  toPlace: Minutes;
  /** The estimate not yet on the calendar, or null with no estimate. */
  estimateLeft: Minutes | null;
  /** How long its next block starts: up to 2h of a task, or one session of a practice. */
  length: Minutes;
  /** This week's blocks for it, soonest first. */
  blocks: PlacedBlock[];
}

export interface PracticeRow {
  id: string;
  title: string;
  skipped: boolean;
  /** '5 sessions, 2h 30m' */
  meta: string;
}

/** sessions: the week's practice blocks from queries.weekPractices, which say which were moved by hand. */
export function scheduleModel(d: PlanningData, m: WeekModel, sessions: readonly TimeBlock[], clock: Clock) {
  const now = clock.now();
  const blocks = placedBlocks(m.slot.placed, d.blocks, now);

  const list: SchedRow[] = scheduleOrder(m.plans, m.oneOffs, m.input, m.ctx).map((c) => {
    const oneOff = c.task.kind === 'one_off';
    const plan = oneOff ? null : (m.plans.find((p) => p.project.id === c.task.project_id) ?? null);
    const due = taskDue(c.task, plan, d.week, m.ctx);
    const where = plan ? plan.project.title : 'One off';
    return {
      id: c.task.id,
      title: c.task.title,
      task: c.task,
      work: taskWork(c.task, due, d.week),
      context: due.label ? `${where}, ${due.label}` : where,
      oneOff,
      toPlace: pickToPlace(c, blocks).left,
      estimateLeft: c.task.estimate_min != null || c.task.remaining_min != null ? c.left : null,
      length: FIRST_BLOCK_MIN,
      blocks: blocks.filter((b) => b.task_id === c.task.id),
    };
  });

  const skipped = m.weekPlan?.skipped_practices ?? [];
  const active = d.records.practices.filter((p) => p.state === 'active');
  const left = new Map(practicesLeft(active, m.slot, skipped, m.weekPlan?.skipped_sessions ?? []).map((x) => [x.practice.id, x]));
  for (const p of active.filter((x) => !skipped.includes(x.id))) {
    const own = blocks.filter((b) => b.practice_id === p.id);
    if (!left.has(p.id) && own.length === 0) continue;
    list.push({
      id: p.id,
      title: p.title,
      practice: p,
      work: { kind: 'project' },
      context: `Practice, ${practiceRule(p)}`,
      oneOff: false,
      toPlace: left.get(p.id)?.minutes ?? 0,
      estimateLeft: null,
      length: left.get(p.id)?.length ?? p.target_min,
      blocks: own,
    });
  }
  const practices: PracticeRow[] = active.map((p) => {
    const own = sessions.filter((b) => b.practice_id === p.id && !b.cancelled);
    const total = own.reduce((sum, b) => sum + blockMinutes(b), 0);
    return {
      id: p.id,
      title: p.title,
      skipped: skipped.includes(p.id),
      meta: skipped.includes(p.id) ? 'Skipped this week' : `${own.length} ${own.length === 1 ? 'session' : 'sessions'}, ${formatMinutes(total)}`,
    };
  });

  return { blocks, rows: list, practices };
}
