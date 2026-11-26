// What the Schedule step shows: each practice with something to place, then every picked task in scheduling order, with
// what's left to place, and the week's blocks. Practices come first since their days and times are set, and one whose set
// time is taken leads them. Sessions at their set times are placed already (core/setTimes.ts), so they're a ticked group
// of their own. The order and the rules come from core; this only joins them up.

import { isBacklog } from '../../../../core/backlog';
import type { Clock } from '../../../../core/clock';
import { blockMinutes, formatMinutes, formatTimeOfDay, formatWeekday } from '../../../../core/dates';
import { FIRST_BLOCK_MIN, pickToPlace, scheduleOrder, taskDue, taskWork } from '../../../../core/plan';
import { atSetTime, setTimeFit } from '../../../../core/setTimes';
import type { SetTimeWhy } from '../../../../core/setTimes';
import { practicesLeft } from '../../../../core/slots';
import type { Work } from '../../../../core/slots';
import type { LocalDate, Minutes, Practice, Task, TimeBlock } from '../../../../core/types';
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
  /** A practice's first day waiting because its set time can't be used, and why. */
  why?: { date: LocalDate; why: SetTimeWhy };
}

/** A practice's sessions this week at their set times: 'Tue and Wed at 7am'. */
export interface SetTimesRow {
  id: string;
  title: string;
  line: string;
  sessions: PlacedBlock[];
}

/** 'Mon, Tue and Fri at 7am', or by time, 'Mon and Tue at 7am, Fri at 9:30am'. */
function atLine(sessions: readonly PlacedBlock[]): string {
  const days = new Intl.ListFormat('en-GB');
  const times = [...new Set(sessions.map((b) => b.start))];
  return times.map((t) => `${days.format(sessions.filter((b) => b.start === t).map((b) => formatWeekday(b.date)))} at ${formatTimeOfDay(t)}`).join(', ');
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

  const plans = [...m.plans, ...m.backlogs];
  const tasks: SchedRow[] = scheduleOrder(plans, m.oneOffs, m.input, m.ctx).map((c) => {
    const oneOff = c.task.kind === 'one_off';
    const plan = oneOff ? null : (plans.find((p) => p.project.id === c.task.project_id) ?? null);
    // A backlog's dates are placeholders, so its tasks are never due.
    const due = taskDue(c.task, plan && !isBacklog(plan.project) ? plan : null, d.week, m.ctx);
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
  const zone = clock.zone();
  const list: SchedRow[] = [];
  const setTimes: SetTimesRow[] = [];
  for (const p of active.filter((x) => !skipped.includes(x.id))) {
    const own = blocks.filter((b) => b.practice_id === p.id);
    const row = d.blocks.filter((b) => b.practice_id === p.id);
    // Those at their set times are ticked in their own group; any others, moved or placed by hand, stay with the practice.
    const set = own.filter((b) => row.some((r) => r.id === b.id && atSetTime(p, r, zone)));
    if (set.length) setTimes.push({ id: p.id, title: p.title, line: atLine(set), sessions: set });
    const rest = own.filter((b) => !set.includes(b));
    if (!left.has(p.id) && rest.length === 0) continue;
    const date = left.get(p.id)?.dates?.find((x) => {
      const fit = setTimeFit(p, x, m.slot);
      return fit && 'why' in fit;
    });
    const fit = date ? setTimeFit(p, date, m.slot) : null;
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
      blocks: rest,
      ...(date && fit && 'why' in fit ? { why: { date, why: fit } } : {}),
    });
  }
  // A session whose set time is taken asks first.
  list.sort((a, b) => Number(!a.why) - Number(!b.why));
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

  return { blocks, rows: [...list, ...tasks], practices, setTimes, atSetTimes: setTimes.reduce((n, g) => n + g.sessions.length, 0) };
}
