// How long records are kept: when each one expires, and which entries of a list inside a record have run out. The
// policy is the build's block of config/retention.yaml. The write path in records.ts stores each record's expiry as its
// expires_at field after every write, expiry.ts removes expired records from the device, and the server leaves them out
// of pulls and lets DynamoDB's TTL remove them. docs/retention.md has the whole picture.

import { isClock, parseClock } from './clock';
import { isDay, toInstant } from './dates';
import type { Instant } from './types';

/**
 * An ISO 8601 duration in parts, as config/retention.ts loads it: core imports nothing from outside, and vite.config.ts
 * checks that what the loader gives fits.
 */
export interface Period {
  iso: string;
  years: number;
  months: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/** One environment's block of config/retention.yaml. */
export interface Retention {
  scheduling: Period;
  closed: Period;
  deleted: Period;
  /** How often staging's cleanup job runs. */
  cleanup?: Period;
}

let active: Retention | null = null;

/**
 * Sets the policy the write path and device expiry follow: the build's block, at startup. Until then, and in tests that
 * don't set one, records get no expiry.
 */
export function configureRetention(policy: Retention | null): void {
  active = policy;
}

export function activeRetention(): Retention | null {
  return active;
}

const DAY_MS = 86_400_000;

/** ms plus the period. Years, months and days are calendar steps in UTC, as the server takes them. */
export function addPeriod(ms: number, p: Period): number {
  const d = new Date(ms);
  const date = Date.UTC(
    d.getUTCFullYear() + p.years,
    d.getUTCMonth() + p.months,
    d.getUTCDate() + p.days,
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
  return date + ((p.hours * 60 + p.minutes) * 60 + p.seconds) * 1000;
}

const instantMs = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/** A date ends at the next midnight in UTC, so every device and zone gets the same expiry. */
const dayEndMs = (value: unknown): number | null => (isDay(value) ? Date.parse(`${value}T00:00:00Z`) + DAY_MS : null);

/** When a field was last written, from its clock. The lowest clock, an automatic write, says nothing. */
const writtenMs = (clock: unknown): number | null => (isClock(clock) ? parseClock(clock).wall || null : null);

const later = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));

/** A record as stored here: its values, and each field's clock. */
export interface StoredRecord {
  data: Record<string, unknown>;
  clocks: Record<string, unknown>;
}

/**
 * When a record expires, or null for never. Deleted beats everything: deleted_at plus the deleted period. A milestone
 * goes with its project, an attachment with its task, and an answer is counted from its block's end, so those take the
 * related record as parent.
 */
export function expiryFor(type: string, record: StoredRecord, policy: Retention, parent?: StoredRecord | null): Instant | null {
  const { data, clocks } = record;
  const after = (from: number | null, period: Period) => (from === null ? null : toInstant(addPeriod(from, period)));
  if (typeof data.deleted_at === 'string') return after(instantMs(data.deleted_at), policy.deleted);
  switch (type) {
    case 'time_block':
      return after(instantMs(data.end), policy.scheduling);
    case 'block_outcome':
      return after(instantMs(parent?.data.end) ?? instantMs(data.answered_at), policy.scheduling);
    case 'week_pick':
    case 'week_plan': {
      const start = dayEndMs(data.week_start);
      return after(start === null ? null : start + 6 * DAY_MS, policy.scheduling);
    }
    case 'task_completion':
      return after(instantMs(data.done_at), policy.scheduling);
    case 'away_period':
      return after(dayEndMs(data.end), policy.scheduling);
    case 'task':
      return after(later(instantMs(data.done_at), instantMs(data.cancelled_at)), policy.closed);
    case 'project':
      return data.state === 'finished' || data.state === 'dropped' ? after(writtenMs(clocks.state), policy.closed) : null;
    case 'milestone':
      return parent ? expiryFor('project', parent, policy) : null;
    // A file follows its record, and the record its task, deleted or closed.
    case 'attachment':
      return parent ? expiryFor('task', parent, policy) : null;
    case 'objective':
      return data.state === 'archived' ? after(writtenMs(clocks.state), policy.closed) : null;
    default:
      return null;
  }
}

/** Whether a record holding expires_at `held` should be written with `wanted`. One that never expired stays without it. */
export function expiryDiffers(held: unknown, wanted: Instant | null): boolean {
  return wanted !== null ? held !== wanted : typeof held === 'string';
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Lists inside a record lose entries older than the scheduling period, rather than the record expiring: a project's slip
 * log, and the stretches pinned in settings. Returns the fields that changed.
 */
export function trimmedLists(type: string, data: Record<string, unknown>, policy: Retention, now: number): Record<string, unknown> {
  const kept = (from: number | null) => from === null || addPeriod(from, policy.scheduling) > now;
  if (type === 'project' && Array.isArray(data.slip_log)) {
    const log = data.slip_log.filter((entry: unknown) => kept(instantMs(isObject(entry) ? entry.at : null)));
    if (log.length < data.slip_log.length) return { slip_log: log };
  }
  if (type === 'settings' && isObject(data.plan_stretch) && Array.isArray(data.plan_stretch.one_offs)) {
    const pinned = data.plan_stretch.one_offs;
    const left = pinned.filter((stretch: unknown) => kept(dayEndMs(isObject(stretch) ? stretch.end : null)));
    if (left.length < pinned.length) return { plan_stretch: { ...data.plan_stretch, one_offs: left } };
  }
  return {};
}
