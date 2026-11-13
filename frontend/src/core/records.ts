// The only write path. Every local write updates the record, its per-field clocks and the outbox in one
// transaction, so nothing can be saved without being queued to sync.
//
//   await transact(db, clock, async (w) => {
//     const id = await w.create('task', { kind: 'inbox', title });
//     await w.set('task', id, { estimate_min: 30 });
//   });
//
// Group everything one user action changes into one transact, so a crash can't leave half of it. Deletes set
// deleted_at and keep the row, so a delete merges like any other field. For Undo, set returns the values it
// replaced: write them back. Each write also stores the record's expiry as expires_at, worked out from the record as it
// then stands (retention.ts), so every writer keeps it right.

import { protocol } from '@multiscale/config';
import { isDay, nowInstant } from './dates';
import { clockWins, formatClock, isClock, nextClock, observeClock, parseClock } from './clock';
import type { Clock } from './clock';
import { getMeta, META, setMeta } from './db';
import type { Db, Sql } from './db';
import { activeRetention, expiryDiffers, expiryFor, trimmedLists } from './retention';
import type { Retention, StoredRecord } from './retention';
import type {
  Fields,
  LocalDate,
  RecordChange,
  RecordMap,
  RecordType,
  Settings,
} from './types';

export const SETTINGS_ID = 'settings';
export const CALENDAR_ID = 'calendar';
const OUTCOME_PREFIX = 'outcome:';

/** Ids are printable ASCII. The server enforces the same rule. */
export const ID_PATTERN = new RegExp(protocol.records.idPattern);

let lastIdMs = 0;
let idSequence = 0;

/**
 * A new id that sorts by creation time (UUID version 7), which is what "added order" means. Within one millisecond
 * a sequence takes the version's first 12 random bits, and a clock stepping back doesn't reorder ids.
 */
export function newId(clock: Clock): string {
  const now = clock.now();
  if (now > lastIdMs) {
    lastIdMs = now;
    idSequence = 0;
  } else if (++idSequence > 0xfff) {
    lastIdMs++;
    idSequence = 0;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let ms = lastIdMs;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | (idSequence >> 8);
  bytes[7] = idSequence & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** An outcome's id comes from its block, so answers from two devices merge. */
export function outcomeId(blockId: string): string {
  return OUTCOME_PREFIX + blockId;
}

/** Deterministic: each pick merges on its own across devices. */
export function weekPickId(weekStart: LocalDate, taskId: string): string {
  return `pick:${weekStart}:${taskId}`;
}

export function weekPlanId(weekStart: LocalDate): string {
  return `week:${weekStart}`;
}

/** A practice has at most one placed session a day, so two devices placing the same week merge into one record. */
export function practiceSessionId(practiceId: string, date: LocalDate): string {
  return `session:${practiceId}:${date}`;
}

/** The day a practice session is for, from an id practiceSessionId made for it, else null. */
export function sessionDay(id: string, practiceId: string): LocalDate | null {
  const prefix = `session:${practiceId}:`;
  const date = id.startsWith(prefix) ? id.slice(prefix.length) : '';
  return isDay(date) ? date : null;
}

/** The id of one finish of a recurring task, so that two offline devices finishing the same occurrence merge. */
export function occurrenceId(taskId: string, date: LocalDate): string {
  return `occ-done:${taskId}:${date}`;
}

const parse = (json: string) => JSON.parse(json) as Record<string, unknown>;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

interface StoredRow {
  type: string;
  data: string;
  clocks: string;
}

const readRow = (sql: Sql, id: string) =>
  sql.get<StoredRow>('SELECT type, data, clocks FROM records WHERE id = :id', { id });

async function writeRow(sql: Sql, id: string, type: string, data: object, clocks: object): Promise<void> {
  await sql.run(
    `INSERT INTO records (id, type, data, clocks) VALUES (:id, :type, :data, :clocks)
     ON CONFLICT (id) DO UPDATE SET data = excluded.data, clocks = excluded.clocks`,
    { id, type, data: JSON.stringify(data), clocks: JSON.stringify(clocks) },
  );
}

export interface Writer {
  /** Adds a record and returns its id. With a deterministic id that already exists, merges into it. */
  create<T extends RecordType>(type: T, fields: Fields<T>, id?: string): Promise<string>;
  /** Changes fields on an existing record and returns the values it replaced, for Undo. */
  set<T extends RecordType>(type: T, id: string, fields: Fields<T>): Promise<Fields<T>>;
  /** Marks a record deleted. Setting deleted_at back to null undoes it. */
  delete(type: RecordType, id: string): Promise<void>;
  /** Writes what follows from a record as it stands, such as its expiry, if that has changed. */
  refresh(id: string): Promise<void>;
  /** The transaction, for reads that must see this transaction's writes. */
  readonly sql: Sql;
  /**
   * The same transaction for what the app fills in on its own, which can run before this device has pulled: a field it
   * writes that has no clock here yet, as on a record that isn't here yet, gets the lowest clock, so any write to it from
   * any device wins.
   */
  readonly automatic: Writer;
}

class TxWriter implements Writer {
  private lastClock: string | null | undefined;
  private device: string | null = null;
  wrote = false;

  constructor(
    readonly sql: Sql,
    private readonly clock: Clock,
  ) {}

  /** The device id and the last clock, in one read: on the desktop and the phone each statement is a round trip. */
  private async readMeta(): Promise<void> {
    const rows = await this.sql.all<{ key: string; value: string }>('SELECT key, value FROM meta WHERE key IN (:device, :clock)', {
      device: META.deviceId,
      clock: META.clock,
    });
    const value = (key: string) => rows.find((row) => row.key === key)?.value ?? null;
    this.device = value(META.deviceId);
    this.lastClock ??= value(META.clock);
  }

  private async deviceId(): Promise<string> {
    if (!this.device) await this.readMeta();
    if (!this.device) throw new Error('This database has no device id. Open it with openDb.');
    return this.device;
  }

  private async tick(): Promise<string> {
    if (this.lastClock === undefined) await this.readMeta();
    this.lastClock = nextClock(this.lastClock ?? null, this.clock.now(), await this.deviceId());
    return this.lastClock;
  }

  get automatic(): Writer {
    return {
      sql: this.sql,
      create: (type, fields, id) => this.create(type, fields, id, true),
      set: (type, id, fields) => this.set(type, id, fields, true),
      delete: (type, id) => this.delete(type, id),
      refresh: (id) => this.refresh(id, true),
      get automatic() {
        return this;
      },
    };
  }

  async finish(): Promise<void> {
    if (this.lastClock) await setMeta(this.sql, META.clock, this.lastClock);
  }

  private async write(type: string, id: string, row: StoredRow | undefined, fields: Record<string, unknown>, automatic = false) {
    const data = row ? parse(row.data) : {};
    const previous: Record<string, unknown> = {};
    const changed = Object.keys(fields).filter((f) => {
      if (f === 'id') throw new Error('A record id cannot be changed');
      // An explicit null is a value, and can override a default or another device's write.
      return fields[f] !== undefined && (!row || !(f in data) || !same(data[f], fields[f]));
    });
    if (changed.length === 0 && row) return previous;
    for (const field of changed) previous[field] = data[field] ?? null;
    await this.commit(type, id, row, Object.fromEntries(changed.map((f) => [f, fields[f]])), automatic);
    return previous;
  }

  /**
   * Writes changes onto a record with their clocks, then what follows from it as it now stands: its expiry, and lists
   * trimmed. An automatic write gives a field it writes for the first time the lowest clock, so any other write to it
   * wins, and leaves lists alone, since trimming one is a real change.
   */
  private async commit(type: string, id: string, row: StoredRow | undefined, changes: Record<string, unknown>, automatic: boolean) {
    const data = row ? parse(row.data) : {};
    const clocks = row ? parse(row.clocks) : {};
    let ticked: string | undefined;
    const clockFor = async (field: string) =>
      automatic && !(field in clocks) ? formatClock({ wall: 0, counter: 0, device: await this.deviceId() }) : (ticked ??= await this.tick());
    const written: Record<string, string> = {};
    const apply = async (fields: Record<string, unknown>) => {
      for (const [field, value] of Object.entries(fields)) {
        data[field] = value;
        clocks[field] = written[field] = await clockFor(field);
      }
    };
    await apply(changes);
    const policy = activeRetention();
    const follows = policy ? await this.retentionChanges(type, id, data, clocks, policy, automatic) : {};
    await apply(follows);

    const names = Object.keys(written);
    if (names.length === 0 && row) return;
    // Every changed field in one statement, rather than one each.
    if (names.length > 0) {
      await this.sql.run(
        `INSERT INTO outbox (record_id, type, field, clock) VALUES ${names.map((_, i) => `(:id, :type, :field${i}, :clock${i})`).join(', ')}
         ON CONFLICT (record_id, field) DO UPDATE SET clock = excluded.clock`,
        { id, type, ...Object.fromEntries(names.flatMap((field, i) => [[`field${i}`, field], [`clock${i}`, written[field]!]])) },
      );
    }
    await writeRow(this.sql, id, type, data, clocks);
    this.wrote = true;
    // A milestone goes with its project, an attachment with its task, and an answer is counted from its block's end.
    if ('expires_at' in follows && type === 'task') {
      const attachments = await this.sql.all<{ id: string }>(
        "SELECT id FROM records WHERE type = 'attachment' AND json_extract(data, '$.task_id') = :id",
        { id },
      );
      for (const a of attachments) await this.refresh(a.id, automatic);
    }
    if ('expires_at' in follows && type === 'project') {
      const milestones = await this.sql.all<{ id: string }>(
        "SELECT id FROM records WHERE type = 'milestone' AND json_extract(data, '$.project_id') = :id",
        { id },
      );
      for (const m of milestones) await this.refresh(m.id, automatic);
    }
    if ('expires_at' in follows && type === 'time_block') await this.refresh(outcomeId(id), automatic);
  }

  private async stored(id: string, type: string): Promise<StoredRecord | null> {
    const row = await readRow(this.sql, id);
    return row?.type === type ? { data: parse(row.data), clocks: parse(row.clocks) } : null;
  }

  /** The expiry and trimmed lists that follow from a record, where they differ from what it holds. */
  private async retentionChanges(type: string, id: string, data: Record<string, unknown>, clocks: Record<string, unknown>, policy: Retention, automatic: boolean) {
    const changes = automatic ? {} : trimmedLists(type, data, policy, this.clock.now());
    const parent =
      type === 'milestone' && typeof data.project_id === 'string'
        ? await this.stored(data.project_id, 'project')
        : type === 'attachment' && typeof data.task_id === 'string'
          ? await this.stored(data.task_id, 'task')
          : type === 'block_outcome' && id.startsWith(OUTCOME_PREFIX)
            ? await this.stored(id.slice(OUTCOME_PREFIX.length), 'time_block')
            : null;
    const expires = expiryFor(type, { data: { ...data, ...changes }, clocks }, policy, parent);
    // Cleared when what it counts from clears, as when a task opens again.
    return expiryDiffers(data.expires_at, expires) ? { ...changes, expires_at: expires } : changes;
  }

  async refresh(id: string, automatic = false): Promise<void> {
    const row = await readRow(this.sql, id);
    if (row) await this.commit(row.type, id, row, {}, automatic);
  }

  async create<T extends RecordType>(type: T, fields: Fields<T>, id?: string, automatic = false): Promise<string> {
    const recordId = id ?? newId(this.clock);
    if (!ID_PATTERN.test(recordId)) throw new Error(`Invalid record id: ${recordId}`);
    // A new id can't be here yet, so only a given one is looked up.
    const row = id === undefined ? undefined : await readRow(this.sql, recordId);
    if (row && row.type !== type) throw new Error(`Record ${recordId} is a ${row.type}, not a ${type}`);
    await this.write(type, recordId, row, fields, automatic);
    return recordId;
  }

  async set<T extends RecordType>(type: T, id: string, fields: Fields<T>, automatic = false): Promise<Fields<T>> {
    const row = await readRow(this.sql, id);
    if (!row) throw new Error(`No ${type} record ${id}`);
    if (row.type !== type) throw new Error(`Record ${id} is a ${row.type}, not a ${type}`);
    return (await this.write(type, id, row, fields, automatic)) as Fields<T>;
  }

  async delete(type: RecordType, id: string): Promise<void> {
    await this.set(type, id, { deleted_at: nowInstant(this.clock) } as Fields<typeof type>);
  }
}

/** Runs fn in one transaction and announces the change once it has committed. */
export async function transact<R>(db: Db, clock: Clock, fn: (w: Writer) => Promise<R>): Promise<R> {
  let wrote = false;
  const result = await db.transaction(async (tx) => {
    const writer = new TxWriter(tx, clock);
    const value = await fn(writer);
    await writer.finish();
    wrote = writer.wrote;
    return value;
  });
  if (wrote) db.notifyChanged({ source: 'local' });
  return result;
}

const isWellFormed = (change: RecordChange) =>
  typeof change.id === 'string' && ID_PATTERN.test(change.id) && typeof change.type === 'string' && !!change.fields;

/**
 * Merges records from the server: per field, the higher clock wins, so applying the same change twice or in any
 * order converges. Unknown types and fields are kept for a newer app version. A pending outbox row for a field
 * that lost is removed, since the server already holds something newer. A malformed change is skipped: failing the
 * batch would stop the cursor advancing, and this device would never sync again. Returns how many fields changed.
 */
export async function applyRemote(db: Db, changes: readonly RecordChange[]): Promise<number> {
  let applied = 0;
  await db.transaction(async (tx) => {
    let highest = await getMeta(tx, META.clock);
    const start = highest;
    for (const change of changes) {
      if (!isWellFormed(change)) continue;
      const row = await readRow(tx, change.id);
      const data = row ? parse(row.data) : {};
      const clocks = row ? parse(row.clocks) : {};
      let changed = false;
      for (const [field, entry] of Object.entries(change.fields)) {
        const { v, c } = entry ?? {};
        // A malformed clock must not poison this device's clock, which every later write builds on.
        if (!isClock(c)) continue;
        highest = observeClock(highest, c);
        if (!clockWins(c, clocks[field] as string | undefined)) continue;
        data[field] = v;
        clocks[field] = c;
        changed = true;
        applied++;
        await tx.run('DELETE FROM outbox WHERE record_id = :id AND field = :field', { id: change.id, field });
      }
      if (changed) await writeRow(tx, change.id, row?.type ?? change.type, data, clocks);
    }
    if (highest && highest !== start) await setMeta(tx, META.clock, highest);
  });
  if (applied > 0) db.notifyChanged({ source: 'remote' });
  return applied;
}

/** The server refuses a clock more than this far ahead of its own time. */
const CLOCK_AHEAD_LIMIT_MS = protocol.sync.maxClockAheadHours * 60 * 60_000;

/**
 * Once the device's time is set right after running far ahead, gives the edits made meanwhile new clocks from now,
 * and lets later writes build on now again, so the server takes them. The server refused every request carrying those
 * clocks, so no other copy holds them. Call before each sync.
 */
export async function rebaseClocks(db: Db, clock: Clock): Promise<void> {
  await db.transaction(async (tx) => {
    const last = await getMeta(tx, META.clock);
    if (!last || parseClock(last).wall <= clock.now() + CLOCK_AHEAD_LIMIT_MS) return;
    // A device running behind builds on clocks the server sent it, which are fine however far ahead of its own time.
    const confirmed = (
      await tx.get<{ c: string | null }>(
        `SELECT MAX(j.value) AS c FROM records r, json_each(r.clocks) j
         WHERE NOT EXISTS (SELECT 1 FROM outbox o WHERE o.record_id = r.id AND o.field = j.key)`,
      )
    )?.c;
    const floor = Math.max(clock.now(), confirmed ? parseClock(confirmed).wall : 0);
    // Clocks compare as text, so this wall time alone sorts below every clock past the floor's limit and above the rest.
    const limit = String(floor + CLOCK_AHEAD_LIMIT_MS + 1).padStart(13, '0');
    if (last < limit) return;
    const ahead = await tx.all<{ record_id: string; field: string }>('SELECT record_id, field FROM outbox WHERE clock >= :limit', { limit });
    // The highest clock seen here that the server could have taken, so new clocks still sort after it.
    let issued =
      (await tx.get<{ c: string | null }>('SELECT MAX(j.value) AS c FROM records r, json_each(r.clocks) j WHERE j.value < :limit', { limit }))?.c ??
      null;
    const device = (await getMeta(tx, META.deviceId))!;
    for (const { record_id, field } of ahead) {
      issued = nextClock(issued, clock.now(), device);
      const row = await readRow(tx, record_id);
      if (row) await writeRow(tx, record_id, row.type, parse(row.data), { ...parse(row.clocks), [field]: issued });
      await tx.run('UPDATE outbox SET clock = :clock WHERE record_id = :id AND field = :field', { clock: issued, id: record_id, field });
    }
    if (issued) await setMeta(tx, META.clock, issued);
    else await tx.run('DELETE FROM meta WHERE key = :key', { key: META.clock });
  });
}

interface DataRow {
  id: string;
  data: string;
}

const toRecord = <T>({ id, data }: DataRow) => ({ ...parse(data), id }) as T;

/** One record, or undefined if it doesn't exist or isn't that type. Includes deleted records. */
export async function getRecord<T extends RecordType>(sql: Sql, type: T, id: string): Promise<RecordMap[T] | undefined> {
  const row = await sql.get<DataRow>('SELECT id, data FROM records WHERE id = :id AND type = :type', { id, type });
  return row && toRecord<RecordMap[T]>(row);
}

/** Every record of a type, oldest first, without deleted ones unless asked. This is what domain modules take. */
export async function listRecords<T extends RecordType>(
  sql: Sql,
  type: T,
  options: { includeDeleted?: boolean } = {},
): Promise<RecordMap[T][]> {
  const filter = options.includeDeleted ? '' : "AND json_extract(data, '$.deleted_at') IS NULL";
  const rows = await sql.all<DataRow>(`SELECT id, data FROM records WHERE type = :type ${filter} ORDER BY id`, { type });
  return rows.map((row) => toRecord<RecordMap[T]>(row));
}

export const DEFAULT_SETTINGS: Omit<Settings, 'id'> = {
  availability: [{ days: 'all', from: 22 * 60, to: 7 * 60, projects: true, one_offs: true }],
  one_offs_weekly_aim: null,
  plan_cadence: { every: 1, unit: 'quarters' },
  plan_stretch: {},
  reminders: { block_start: true, check_in: true, check_in_delay_min: 5, block_end: true },
  avoided_slots: [],
};

/** The settings record with defaults for anything never written. */
export async function getSettings(sql: Sql): Promise<Settings> {
  const stored = await getRecord(sql, 'settings', SETTINGS_ID);
  return { ...DEFAULT_SETTINGS, ...stored, id: SETTINGS_ID };
}

/** Writes settings fields, creating the record the first time. */
export function updateSettings(w: Writer, fields: Fields<'settings'>): Promise<string> {
  return w.create('settings', fields, SETTINGS_ID);
}

/** Adds a task to a week, or changes its minutes if it's already there. */
export function setWeekPick(w: Writer, weekStart: LocalDate, taskId: string, minutes: number): Promise<string> {
  return w.create(
    'week_pick',
    { week_start: weekStart, task_id: taskId, minutes, deleted_at: null },
    weekPickId(weekStart, taskId),
  );
}

/** Takes a task out of a week. */
export async function removeWeekPick(w: Writer, weekStart: LocalDate, taskId: string): Promise<void> {
  await w.delete('week_pick', weekPickId(weekStart, taskId));
}
