// A task's dates in its popup, for wherever Belongs to has it going, with the rules One offs and Process use: a one off
// repeats or has a date or a range, as the add form sets them; a project's task has a date or a range and never
// repeats; an Inbox item has none until it has a home; and a goal's backlog has none, as Belongs to's note says. They
// save with the rest of the popup, on Save.

import { sameSchedule, scheduledDue, setOnceDates } from '../../../core/schedule';
import type { Fields, LocalDate, Task } from '../../../core/types';
import { draftSchedule, scheduleError } from '../../components/oneoff/draft';
import type { OneOffDraft } from '../../components/oneoff/draft';
import { RepeatFields } from '../../components/oneoff/OneOffForm';

/** What a task's dates can be where it's going. */
export type DatesFor = 'one_off' | 'project' | 'inbox' | 'backlog';

/** A project's task takes only the draft's date or range. */
const onceOf = (d: OneOffDraft): OneOffDraft => ({ ...d, type: 'once' });

/** Why the dates can't be saved yet, or null. */
export function datesError(kind: DatesFor, d: OneOffDraft): string | null {
  return kind === 'one_off' ? scheduleError(d) : kind === 'project' ? scheduleError(onceOf(d)) : null;
}

/**
 * The fields the dates write: none while they're as the popup opened them, so a schedule the form can't show, such as
 * every 2 weeks, is never rewritten by saving something else, and none when they say what the task has. Moved, it
 * always takes them, since the move's own fields leave dates to these. An Inbox item's and a backlog's are cleared by
 * the move itself.
 */
export function datesFields(
  kind: DatesFor,
  d: OneOffDraft,
  opened: OneOffDraft,
  task: Task,
  lastDone: LocalDate | null,
  today: LocalDate,
  moved: boolean,
): Fields<'task'> {
  if (!moved && JSON.stringify(d) === JSON.stringify(opened)) return {};
  if (kind === 'one_off') {
    const schedule = draftSchedule(d);
    return moved || !sameSchedule(schedule, task.schedule) ? { schedule, next_due: scheduledDue(schedule, task, lastDone, today) } : {};
  }
  if (kind !== 'project') return {};
  const fields = d.from ? setOnceDates(d.from, d.ranged ? d.to || null : null) : { schedule: null, next_due: null };
  return moved || !sameSchedule(fields.schedule, task.schedule) ? fields : {};
}

/** Where none apply, why. A backlog's is left to Belongs to's note while that says it, as a task moves in with dates. */
const NONE: Partial<Record<DatesFor, string>> = {
  inbox: 'Inbox items have no date. To give it one, choose One offs or a project under Belongs to.',
  backlog: 'Backlog tasks have no date.',
};

export function TaskDates(props: { kind: DatesFor; draft: OneOffDraft; put(patch: Partial<OneOffDraft>): void; said?: boolean }) {
  const { kind, draft, put } = props;
  const none = NONE[kind];
  if (none && props.said) return null;
  return (
    <div className="stack8 taskpopdates">
      {none ? <p className="small quiet">{none}</p> : <RepeatFields draft={kind === 'project' ? onceOf(draft) : draft} put={put} onceOnly={kind === 'project'} />}
    </div>
  );
}
