// How a block reads anywhere it's shown: its kind (and so its colour), what it belongs to, and its time.

import { isBacklog } from '../../../core/backlog';
import { addDays, formatDate, formatTime, formatWeekday } from '../../../core/dates';
import type { BlockRow } from '../../../core/queries';
import { isRepeating, onceWhen, scheduleLabel } from '../../../core/schedule';
import type { BlockResult, Instant, LocalDate, Objective, Practice, Project, Task } from '../../../core/types';
import { practiceRule } from '../editors/PracticeSchedule';

/** Blue for projects, purple for one offs, teal for practices, grey for planning, and no kind yet for the Inbox. */
export type BlockKind = 'project' | 'one_off' | 'practice' | 'planning' | 'inbox';

/** The kind in words, for labels, so it never rests on colour alone. */
export const KIND_WORD: Record<BlockKind, string> = { project: 'Project', practice: 'Practice', one_off: 'One off', planning: 'Planning', inbox: 'Inbox' };

/** A task's block, which opens the task's popup, rather than a practice's session or planning. */
export const isTaskBlock = (kind: BlockKind) => kind === 'project' || kind === 'one_off' || kind === 'inbox';

function blockKind(block: Pick<BlockRow, 'practice_id' | 'task_kind'>): BlockKind {
  if (block.practice_id) return 'practice';
  return block.task_kind === 'one_off' || block.task_kind === 'planning' || block.task_kind === 'inbox' ? block.task_kind : 'project';
}

export const OUTCOME_WORD: Record<BlockResult, string> = { done: 'Done', partly: 'Partly', not: 'Not done' };

/** 'Today', 'Tomorrow' or 'Thu Nov 12': a day, said from today. */
export function dayWord(date: LocalDate, today: LocalDate): string {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  return `${formatWeekday(date)} ${formatDate(date)}`;
}

/** '6pm to 7:30pm' */
export function formatRange(start: Instant, end: Instant, zone: string): string {
  return `${formatTime(start, zone)} to ${formatTime(end, zone)}`;
}

export interface BlockRecords {
  task?: Task | undefined;
  project?: Project | undefined;
  objective?: Objective | undefined;
  practice?: Practice | undefined;
}

interface BlockDescription {
  kind: BlockKind;
  /** What the path is: Goal, Backlog, Project, One off or Practice. */
  word: string;
  /** 'Goal > Project', a one off's schedule, or a practice's goal and target. */
  path: string;
}

export function describeBlock(block: Pick<BlockRow, 'practice_id' | 'task_kind'>, records: BlockRecords): BlockDescription {
  const { task, project, objective, practice } = records;
  const kind = blockKind(block);
  if (kind === 'practice') {
    const target = practice ? practiceRule(practice) : '';
    return { kind, word: 'Practice', path: [objective?.title, target].filter(Boolean).join(', ') };
  }
  if (kind === 'planning') return { kind, word: 'Planning', path: '' };
  if (kind === 'inbox') return { kind, word: 'Inbox', path: '' };
  if (kind === 'one_off') {
    const s = task?.schedule;
    const when = s && (isRepeating(task!) ? scheduleLabel(s) : s.type === 'once' ? onceWhen(s) : '');
    return { kind, word: 'One off', path: when || 'No date' };
  }
  // A goal backlog says so, and is named by its goal, so a title an older app stored never shows.
  if (project && isBacklog(project)) return { kind, word: 'Backlog', path: `${objective?.title ?? 'Removed goal'} > Backlog` };
  if (objective && project) return { kind, word: 'Goal', path: `${objective.title} > ${project.title}` };
  return { kind, word: 'Project', path: project?.title ?? '' };
}
