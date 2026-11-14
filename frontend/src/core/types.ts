// The data model. Every record is a JSON object stored in one `records` table and keyed by `id`.
//
// Conventions:
// - Dates are strings. LocalDate is 'YYYY-MM-DD' in the user's zone. Instant is a UTC time in exactly the
//   form 'YYYY-MM-DDTHH:mm:ssZ' (see toInstant in dates.ts), because queries compare instants as text.
// - Minutes are whole numbers. A time of day is minutes after local midnight (0 to 1439).
// - Weekday is 0 for Monday through 6 for Sunday.
// - Fields may be absent on disk: a field never written reads as undefined from JSON and NULL from a view.
//   Unknown fields written by a newer app version are kept, never stripped.
// - Queue, statuses and analytics are computed from these records, not stored.
// - Domain modules in core take plain record arrays and a Clock as arguments and return values, so they stay
//   pure. Read with listRecords or queries.ts, and write only through records.ts.

export type Instant = string;
export type LocalDate = string;
export type Minutes = number;
export type TimeOfDay = number;
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Fields every record can have. deleted_at is the tombstone, so a delete merges like any other field. Beside these the
 * write path keeps expires_at, when the record expires (retention.ts), which nothing reads but expiry.ts.
 */
export interface BaseRecord {
  id: string;
  deleted_at?: Instant | null;
}

export type ObjectiveState = 'active' | 'not_now' | 'archived';

/** Tier 1: a long-term goal. */
export interface Objective extends BaseRecord {
  title: string;
  state: ObjectiveState;
  not_now_until?: LocalDate | null;
  order?: number;
}

export type ProjectState = 'active' | 'paused' | 'finished' | 'dropped';

export interface SlipEntry {
  at: Instant;
  /**
   * end moves the project's end, pause and resume cover the whole project, and close finishes or drops it, so those
   * have no milestone. A close's undo is what Restore puts back for a project closed before tasks carried
   * cancelled_by.
   */
  kind: 'move' | 'drop' | 'met' | 'end' | 'pause' | 'resume' | 'close';
  milestone_id?: string;
  from?: LocalDate | null;
  to?: LocalDate | null;
  /** Real days of slip this change added. */
  days?: number;
  /** More days of slip, from this change pushing the project's end. */
  end_days?: number;
  /** The line shown for this change. */
  text?: string;
  /** The record values Undo restores; its shape belongs to the code that writes the entry. */
  undo?: unknown;
}

/** Tier 2. Added order is id order, because generated ids sort by creation time. */
export interface Project extends BaseRecord {
  objective_id?: string | null;
  title: string;
  state: ProjectState;
  start: LocalDate;
  end: LocalDate;
  weekly_aim?: Minutes | null;
  /**
   * History only: what was replanned, for its lines, slip figures and Undo. Sync keeps one device's whole array, so an
   * entry can be lost, and what a feature needs to read back is kept on the records instead, as paused_on and
   * cancelled_by are.
   */
  slip_log?: SlipEntry[];
  /** The day it was last paused, which Resume moves open dates by and clears. */
  paused_on?: LocalDate | null;
  /** When Raise estimates was last pressed: tasks finished before it no longer argue for raising. */
  estimates_raised_at?: Instant | null;
  /** The day it was made, as a milestone has, so Pick can tell one made since its stretch was planned. Older ones have none. */
  added_on?: LocalDate | null;
}

/** A dated checkpoint in a project, not something you do. */
export interface Milestone extends BaseRecord {
  project_id: string;
  title: string;
  start?: LocalDate | null;
  /** With none, it means by the stretch's end, capped at the project's end. */
  due?: LocalDate | null;
  /** The start date of the plan it was added to. */
  stretch?: LocalDate | null;
  added_on?: LocalDate | null;
  met_at?: Instant | null;
  dropped_at?: Instant | null;
}

/** planning: the app's own task for planning a week, made with no time placed (planning.ts). */
export type TaskKind = 'inbox' | 'one_off' | 'project' | 'planning';
export type RepeatUnit = 'day' | 'week' | 'month' | 'year';

/** How a one off comes due. A recurring task stays one record whose next_due moves along. */
export type TaskSchedule =
  /** Once, with no date, one date (from only) or a date range. */
  | { type: 'once'; from?: LocalDate | null; to?: LocalDate | null }
  /** Standard recurring, counted from the anchor date. */
  | { type: 'recurring'; every: number; unit: RepeatUnit; anchor: LocalDate; days?: Weekday[] }
  /** Float: a set time after the last completion. */
  | { type: 'float'; every: number; unit: RepeatUnit }
  /** Flexible window: due between min and max after the last completion. */
  | { type: 'window'; min: number; max: number; unit: RepeatUnit }
  /** Seasonal: these months each year, 1 for January. */
  | { type: 'seasonal'; months: number[] }
  /** Complex calendar rule, as an RFC 5545 RRULE string. */
  | { type: 'rule'; rrule: string; anchor: LocalDate };

export interface Task extends BaseRecord {
  kind: TaskKind;
  project_id?: string | null;
  milestone_id?: string | null;
  title: string;
  estimate_min?: Minutes | null;
  remaining_min?: Minutes | null;
  order?: number;
  schedule?: TaskSchedule | null;
  next_due?: LocalDate | null;
  done_at?: Instant | null;
  cancelled_at?: Instant | null;
  /**
   * The project whose finish or drop cancelled it, set and cleared with cancelled_at, so Restore knows what to reopen
   * and the milestone still counts it. Never set when the person cancels it.
   */
  cancelled_by?: string | null;
  /** The milestone a dropped milestone's open task came from. */
  moved_from?: string | null;
  /** Its description: plain text with a little Markdown (notes.ts), up to MAX_NOTES. */
  notes?: string | null;
  /** A planning task's plans, such as ['week:2026-11-16']. */
  plans?: string[] | null;
  /**
   * What an Inbox item became when Process made it a project, practice or goal: set with done_at, so the finished item
   * links to it. Apps from before it see a finished task.
   */
  became?: { type: 'project' | 'practice' | 'objective'; id: string } | null;
  /** When Keep was pressed on a goal backlog's untouched task, so it reads as touched again. */
  kept_at?: Instant | null;
}

/** One per finish of a one off. */
export interface TaskCompletion extends BaseRecord {
  task_id: string;
  done_at: Instant;
  /** The task's next_due before this finish, restored on untick. */
  previous_next?: LocalDate | null;
  /** The writes that give back what this finish freed (blocks, picks, time left), applied on untick while still ahead. */
  undo?: { type: string; id: string; fields: Record<string, unknown> }[] | null;
}

/** Scheduled time for a task or a practice, never both. */
export interface TimeBlock extends BaseRecord {
  task_id?: string | null;
  practice_id?: string | null;
  start: Instant;
  end: Instant;
  /** IANA zone the block was placed in. */
  tz: string;
  started_at?: Instant | null;
  ended_at?: Instant | null;
  /** When the pause under way began; null while working. An end or an answer wins over it. */
  paused_at?: Instant | null;
  /** The pauses already over, added up. Resume adds each one to this and to end. */
  paused_min?: Minutes | null;
  cancelled?: boolean;
}

export type BlockResult = 'done' | 'partly' | 'not';

/** The answer to a block's end prompt. Its id is outcomeId(blockId), so two devices' answers merge. */
export interface BlockOutcome extends BaseRecord {
  result: BlockResult;
  remaining_min?: Minutes | null;
  logged_min?: Minutes | null;
  answered_at: Instant;
  /** Delete on a repeating one off's row in Needs a new time: the row goes, and the answer still counts. */
  dropped_at?: Instant | null;
}

/** Keyed by weekPlanId(week_start). "Planned" means finished_at is set. */
export interface WeekPlan extends BaseRecord {
  week_start: LocalDate;
  finished_at?: Instant | null;
  /** This week's changes to weekly aims, by project id or ONE_OFFS_BUCKET. */
  aims?: Record<string, Minutes>;
  skipped_aims?: string[];
  skipped_practices?: string[];
  /** Single practice sessions skipped this week, as `${practiceId}:${date}` (skippedSessionKey). */
  skipped_sessions?: string[];
  skipped_past_end?: string[];
  /** Skip for now on this week's prompt to plan, on every device. */
  planning_skipped_at?: Instant | null;
  /** Minutes active in planning this week, added each time the flow closes. Written whole. */
  planning_min?: Minutes | null;
  /** When planning first opened for this week: it gives your usual time and Review's same time as today. */
  planning_started_at?: Instant | null;
}

/** A task added in Pick tasks. Keyed by weekPickId(week_start, task_id). */
export interface WeekPick extends BaseRecord {
  week_start: LocalDate;
  task_id: string;
  minutes: Minutes;
}

/** Mutes reminders and pauses pace. */
export interface AwayPeriod extends BaseRecord {
  start: LocalDate;
  end: LocalDate;
}

/** A stretch of the week closed to work. A block with to < from runs past midnight, and one with to === from closes nothing. */
export interface AvailabilityBlock {
  days: 'all' | 'weekdays' | 'weekends';
  from: TimeOfDay;
  to: TimeOfDay;
  /** Whether this time is closed for projects. */
  projects: boolean;
  /** Whether this time is closed for one offs. */
  one_offs: boolean;
}

export type CadenceUnit = 'weeks' | 'months' | 'quarters';

export interface PlanCadence {
  /** Ignored for quarters, where each stretch ends on its calendar quarter's last day. */
  every: number;
  unit: CadenceUnit;
  anchor?: LocalDate | null;
}

export interface PlanStretch {
  /** Stretches pinned by hand, overriding what the cadence would give. */
  one_offs?: { start: LocalDate; end: LocalDate }[];
  /** Start date of the stretch last planned for. */
  last_planned?: LocalDate | null;
  last_note?: string | null;
}

/**
 * How far planning ahead has got, shared so it resumes on any device (ui/screens/plan/flowState.ts). Released apps keep
 * it unread. It's over once its stretch is planned, and Finish clears it.
 */
export interface PlanProgress {
  /** The start of the stretch being planned. */
  for: LocalDate;
  /** The step it's on, and those continued from and opened, by key. Strings, so a later app's step reads safely. */
  step: string;
  done: string[];
  seen: string[];
  /** The day a first plan began, which its stretch starts on. */
  begun_on?: LocalDate | null;
  note?: string | null;
  /** When it last changed on the device that wrote it, so the newer of it and a device's own wins. */
  at: Instant;
}

export interface ReminderSettings {
  block_start: boolean;
  check_in: boolean;
  check_in_delay_min: Minutes;
  block_end: boolean;
  /** The weekly reminder while next week's planning has no time. Missing means on. */
  planning?: boolean;
}

/** A time pattern no longer suggested. */
export interface AvoidedSlot {
  day: Weekday;
  from: TimeOfDay;
  to: TimeOfDay;
}

/** One record, id SETTINGS_ID. Read with getSettings, which fills in DEFAULT_SETTINGS. */
export interface Settings extends BaseRecord {
  availability: AvailabilityBlock[];
  one_offs_weekly_aim?: Minutes | null;
  /** null means no fixed schedule. */
  plan_cadence: PlanCadence | null;
  plan_stretch: PlanStretch;
  /** Planning ahead under way, on any device, or null. */
  plan_progress?: PlanProgress | null;
  reminders: ReminderSettings;
  avoided_slots: AvoidedSlot[];
  /** Set when first-run setup ends, here so a second device skips it. */
  setup_done_at?: Instant | null;
  /**
   * Minutes active in planning the stretch starting on start, and when it began, added each time the flow closes; and
   * the last 3 finished stretches' minutes, which its estimate learns from. Its own field, so it can't clobber
   * plan_stretch.
   */
  stretch_planning?: { start: LocalDate; started_at?: Instant | null; min?: Minutes | null; history?: Minutes[] } | null;
}

export interface CalendarEvent {
  id: string;
  /** google_id of its calendar; each device filters by that calendar's mode. */
  calendar: string;
  title: string;
  start: Instant;
  end: Instant;
  all_day?: boolean;
}

/** One record, id CALENDAR_ID, written only by the backend. */
export interface CalendarState extends BaseRecord {
  connected: boolean;
  calendar_id?: string | null;
  events?: CalendarEvent[];
  synced_at?: Instant | null;
  last_error?: string | null;
}

export type CalendarMode = 'block' | 'info' | 'ignore';

/** One per Google calendar. The backend writes the name and the device sets the mode. */
export interface CalendarSource extends BaseRecord {
  google_id: string;
  name: string;
  mode: CalendarMode;
}

export type PracticeState = 'active' | 'paused' | 'ended';

/** Ongoing time on something, linked to a goal or nothing. Never part of a project, never completed. */
export interface Practice extends BaseRecord {
  objective_id?: string | null;
  title: string;
  /** Minutes a day for per 'day'; minutes a week for per 'week'. */
  target_min: Minutes;
  per: 'day' | 'week';
  /** per 'day': the days it's on. per 'week': the days its sessions go on first. Absent means every day. */
  days?: Weekday[];
  /** The usual time first, then times to try if it's taken. */
  preferred_times?: TimeOfDay[];
  /**
   * per 'week' only: sessions a week, 1 to 7, each target_min / sessions long. Absent, a weekly target works out to
   * sessions of up to an hour. Apps from before it read the target alone.
   */
  sessions?: number | null;
  /**
   * Seven entries, Monday first: that day's own time, or null for the usual time. Only the practice's days use theirs.
   * Apps from before it use the usual time every day.
   */
  day_times?: (TimeOfDay | null)[] | null;
  state: PracticeState;
}

export type AttachmentKind = 'link' | 'photo' | 'file';

/**
 * A link, photo or file on a task, as a record of its own. A photo's or file's bytes go to private storage through the
 * API, which checks them against size, type and sha256 here; this device keeps a copy once it has them (files.ts).
 */
export interface Attachment extends BaseRecord {
  task_id: string;
  kind: AttachmentKind;
  /** What it's called: a page's address or a file's name. */
  name: string;
  /** A link's address. */
  url?: string | null;
  /** A photo's or file's size in bytes. */
  size?: number | null;
  /** A photo's or file's content type. */
  type?: string | null;
  /** The SHA-256 of a photo's or file's bytes, in base64, as the upload signs it. */
  sha256?: string | null;
  /** When its upload finished, so other devices know they can fetch it. */
  uploaded_at?: Instant | null;
}

export interface RecordMap {
  objective: Objective;
  project: Project;
  milestone: Milestone;
  task: Task;
  task_completion: TaskCompletion;
  time_block: TimeBlock;
  block_outcome: BlockOutcome;
  week_plan: WeekPlan;
  week_pick: WeekPick;
  away_period: AwayPeriod;
  settings: Settings;
  calendar: CalendarState;
  calendar_source: CalendarSource;
  practice: Practice;
  attachment: Attachment;
}

export type RecordType = keyof RecordMap;

/** Everything on a record of type T that can be written. */
export type Fields<T extends RecordType> = Partial<Omit<RecordMap[T], 'id'>>;

export const RECORD_TYPES = [
  'objective',
  'project',
  'milestone',
  'task',
  'task_completion',
  'time_block',
  'block_outcome',
  'week_plan',
  'week_pick',
  'away_period',
  'settings',
  'calendar',
  'calendar_source',
  'practice',
  'attachment',
] as const satisfies readonly RecordType[];

/** The bucket aims and meters use for all one offs together, beside project ids. */
export const ONE_OFFS_BUCKET = 'one_offs';

/** One field in sync form: its value and its clock. */
export interface FieldChange {
  v: unknown;
  c: string;
}

/** A record's changed fields, as sent to and received from the server. */
export interface RecordChange {
  type: string;
  id: string;
  fields: Record<string, FieldChange>;
}

export type ReminderKind = 'block_start' | 'check_in' | 'block_end' | 'still_paused' | 'planning_unscheduled';

export interface ReminderAction {
  id: string;
  title: string;
  /** The action needs the app in front, such as Partly asking for time remaining. */
  opens_app?: boolean;
}

/** A notification to schedule. Which ones to schedule is decided in core; firing them is the platform's job. */
export interface Reminder {
  /** Stable, so that rescheduling replaces rather than duplicates. */
  id: string;
  kind: ReminderKind;
  /** The block it's about, or for planning_unscheduled the week's planning task. */
  block_id: string;
  at: Instant;
  title: string;
  body?: string;
  actions: ReminderAction[];
}
