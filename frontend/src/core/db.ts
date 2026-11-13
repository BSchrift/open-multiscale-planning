// The database contract and schema.
//
// Everything is async because the iPhone plugin is. A platform adapter implements only SqlDriver: positional
// parameters and no concurrency concerns. createDb wraps it into the Db used everywhere else, which takes named
// parameters (`:name`), runs one operation at a time so a transaction can't interleave with other work, and
// announces changes.
//
// Schema rules, each of which keeps SQLite on the indexes:
// - `records.id` has no declared type. Comparing a JSON field with a TEXT column applies text affinity, and an
//   index on a JSON expression then can't be used. Stored ids are still text.
// - Statistics must exist, so `PRAGMA optimize=0x10002` runs at each open.
// - Filter a JSON field in a subquery, not a LEFT JOIN onto a view.
// Views are read-only conveniences with one column per field, rebuilt at open when they differ from this code's. Writes
// go through records.ts only.

import { RECORD_TYPES } from './types';
import type { RecordMap, RecordType } from './types';

export type SqlValue = string | number | null;
export type Params = Readonly<Record<string, SqlValue | boolean | undefined>>;
export type Row = Record<string, unknown>;

/** What a platform adapter provides. Statements run one at a time and are never concurrent. */
export interface SqlDriver {
  /** Runs one or more statements with no parameters, ignoring any rows. */
  exec(sql: string): Promise<void>;
  all(sql: string, values: SqlValue[]): Promise<Row[]>;
  run(sql: string, values: SqlValue[]): Promise<void>;
  close(): Promise<void>;
}

/** The read and write surface shared by a Db and an open transaction. */
export interface Sql {
  all<T = Row>(sql: string, params?: Params): Promise<T[]>;
  get<T = Row>(sql: string, params?: Params): Promise<T | undefined>;
  run(sql: string, params?: Params): Promise<void>;
}

export interface DbChange {
  /** Local edits start a sync soon after; remote ones came from a sync. */
  source: 'local' | 'remote';
}

export interface Db extends Sql {
  /**
   * Runs fn in one transaction, rolling back if it throws. Use only the handle it gives you: awaiting the outer
   * Db inside fn waits for the transaction to end, which deadlocks.
   */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  subscribe(listener: (change: DbChange) => void): () => void;
  /** Tells subscribers that records changed. records.ts calls it after each commit. */
  notifyChanged(change: DbChange): void;
  close(): Promise<void>;
}

/** Turns `:name` parameters into positional ones, leaving string literals and comments alone. */
export function toPositional(sql: string, params: Params = {}): { sql: string; values: SqlValue[] } {
  const values: SqlValue[] = [];
  const out = sql.replace(/'(?:[^']|'')*'|--[^\n]*|:([A-Za-z_][A-Za-z0-9_]*)/g, (match, name?: string) => {
    if (!name) return match;
    if (!(name in params)) throw new Error(`Missing SQL parameter :${name}`);
    const value = params[name];
    values.push(value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value);
    return '?';
  });
  return { sql: out, values };
}

function bind(driver: SqlDriver): Sql {
  const all = <T>(sql: string, params?: Params) => {
    const p = toPositional(sql, params);
    return driver.all(p.sql, p.values) as Promise<T[]>;
  };
  return {
    all,
    get: async <T>(sql: string, params?: Params) => (await all<T>(sql, params))[0],
    run: (sql, params) => {
      const p = toPositional(sql, params);
      return driver.run(p.sql, p.values);
    },
  };
}

/** SQLite can roll back by itself on errors such as a full disk. Then this throws too, and must not hide the cause. */
async function rollback(driver: SqlDriver): Promise<void> {
  await driver.exec('ROLLBACK').catch(() => undefined);
}

/** Serializes all work on one connection, and adds parameters, transactions and change events. */
export function createDb(driver: SqlDriver): Db {
  const sql = bind(driver);
  const listeners = new Set<(change: DbChange) => void>();
  let tail: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work, work);
    tail = result.catch(() => undefined);
    return result;
  };

  return {
    all: (s, p) => enqueue(() => sql.all(s, p)),
    get: (s, p) => enqueue(() => sql.get(s, p)),
    run: (s, p) => enqueue(() => sql.run(s, p)),
    transaction: (fn) =>
      enqueue(async () => {
        await driver.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(sql);
          await driver.exec('COMMIT');
          return result;
        } catch (err) {
          await rollback(driver);
          throw err;
        }
      }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notifyChanged(change) {
      // The write has already committed, so a listener's bug must not make it look failed.
      for (const listener of [...listeners]) {
        try {
          listener(change);
        } catch (err) {
          console.error('Change listener failed', err);
        }
      }
    },
    close: () => enqueue(() => driver.close()),
  };
}

/** The fields on each record type, which become its view's columns. The checks below keep this list complete. */
export const RECORD_FIELDS = {
  objective: ['title', 'state', 'not_now_until', 'order', 'deleted_at'],
  project: ['objective_id', 'title', 'state', 'start', 'end', 'weekly_aim', 'slip_log', 'paused_on', 'estimates_raised_at', 'deleted_at'],
  milestone: ['project_id', 'title', 'start', 'due', 'stretch', 'added_on', 'met_at', 'dropped_at', 'deleted_at'],
  task: [
    'kind',
    'project_id',
    'milestone_id',
    'title',
    'estimate_min',
    'remaining_min',
    'order',
    'schedule',
    'next_due',
    'done_at',
    'cancelled_at',
    'cancelled_by',
    'moved_from',
    'notes',
    'plans',
    'became',
    'deleted_at',
  ],
  task_completion: ['task_id', 'done_at', 'previous_next', 'undo', 'deleted_at'],
  time_block: ['task_id', 'practice_id', 'start', 'end', 'tz', 'started_at', 'ended_at', 'paused_at', 'paused_min', 'cancelled', 'deleted_at'],
  block_outcome: ['result', 'remaining_min', 'logged_min', 'answered_at', 'dropped_at', 'deleted_at'],
  week_plan: ['week_start', 'finished_at', 'aims', 'skipped_aims', 'skipped_practices', 'skipped_sessions', 'skipped_past_end', 'planning_skipped_at', 'planning_min', 'planning_started_at', 'deleted_at'],
  week_pick: ['week_start', 'task_id', 'minutes', 'deleted_at'],
  away_period: ['start', 'end', 'deleted_at'],
  settings: [
    'availability',
    'one_offs_weekly_aim',
    'plan_cadence',
    'plan_stretch',
    'plan_progress',
    'reminders',
    'avoided_slots',
    'setup_done_at',
    'stretch_planning',
    'deleted_at',
  ],
  calendar: ['connected', 'calendar_id', 'events', 'synced_at', 'last_error', 'deleted_at'],
  calendar_source: ['google_id', 'name', 'mode', 'deleted_at'],
  practice: ['objective_id', 'title', 'target_min', 'per', 'days', 'preferred_times', 'sessions', 'day_times', 'state', 'deleted_at'],
  attachment: ['task_id', 'kind', 'name', 'url', 'size', 'type', 'sha256', 'uploaded_at', 'deleted_at'],
} as const satisfies { [K in RecordType]: readonly Exclude<keyof RecordMap[K], 'id'>[] };

// Fails to compile if a record type gains a field that is missing from its view.
type MissingViewField = {
  [K in RecordType]: Exclude<keyof RecordMap[K], 'id' | (typeof RECORD_FIELDS)[K][number]>;
}[RecordType];
const _everyFieldHasAColumn: [MissingViewField] extends [never] ? true : MissingViewField = true;
void _everyFieldHasAColumn;

/**
 * Fields no longer in the data model whose columns stay in the views, because a bundle a device can roll back to still
 * selects them. They read as NULL, or as an older device wrote them.
 * shortcut: these only serve rollbacks; drop them once no installed app can go back to a bundle from before they were
 * retired, counting the bundle built into each app.
 */
const RETIRED_COLUMNS: Partial<Record<RecordType, readonly string[]>> = {
  project: ['baseline'],
  task: ['first_step', 'link', 'waiting_until'],
  time_block: ['edited'],
  week_pick: ['skipped'],
};

function viewSql(type: RecordType): string {
  const columns = ['id'];
  if (type === 'block_outcome') columns.push("substr(id, 9) AS block_id");
  for (const field of [...RECORD_FIELDS[type], ...(RETIRED_COLUMNS[type] ?? [])]) {
    // ORDER is a keyword, so that field is exposed as sort_order.
    columns.push(`json_extract(data, '$.${field}') AS ${field === 'order' ? 'sort_order' : field}`);
  }
  return `CREATE VIEW ${type} AS SELECT ${columns.join(', ')} FROM records WHERE type = '${type}'`;
}

export interface Migration {
  version: number;
  statements: string[];
  /** Older apps can't read what this migration leaves, so they refuse the database rather than damage it. */
  breaking?: true;
}

/**
 * Append only. New record fields need no migration: unknown JSON fields just work, and opening rebuilds the views.
 * A device can roll back to the bundle before, so a migration should leave a database that bundle can still use, and
 * otherwise be marked breaking. Bundles up to c88b04d refuse any version above 4, so version 5 must wait until no
 * device can roll back to one of them.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE records (
         id     NOT NULL PRIMARY KEY,
         type   TEXT NOT NULL,
         data   TEXT NOT NULL,
         clocks TEXT NOT NULL
       )`,
      'CREATE INDEX records_by_type ON records (type)',
      `CREATE TABLE outbox (
         record_id TEXT NOT NULL,
         type      TEXT NOT NULL,
         field     TEXT NOT NULL,
         clock     TEXT NOT NULL,
         PRIMARY KEY (record_id, field)
       )`,
      `CREATE TABLE meta (
         key   TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,
      "CREATE INDEX block_start ON records (json_extract(data, '$.start')) WHERE type = 'time_block'",
      "CREATE INDEX block_task ON records (json_extract(data, '$.task_id'), json_extract(data, '$.start')) WHERE type = 'time_block'",
      "CREATE INDEX task_project ON records (json_extract(data, '$.project_id')) WHERE type = 'task'",
      "CREATE INDEX task_kind ON records (json_extract(data, '$.kind')) WHERE type = 'task'",
      "CREATE INDEX milestone_project ON records (json_extract(data, '$.project_id')) WHERE type = 'milestone'",
      "CREATE INDEX pick_week ON records (json_extract(data, '$.week_start'), json_extract(data, '$.task_id')) WHERE type = 'week_pick'",
      "CREATE INDEX outcome_result ON records (json_extract(data, '$.result')) WHERE type = 'block_outcome'",
    ],
  },
  // Versions 2 and 4 rebuilt the views, which every open now does.
  { version: 2, statements: [] },
  // No query looks up milestones by project any more.
  { version: 3, statements: ['DROP INDEX IF EXISTS milestone_project'] },
  { version: 4, statements: [] },
];

/** Keys in the meta table. */
export const META = {
  cursor: 'cursor',
  /** The server table's generation at the last sync. A new one means the table was restored from a backup. */
  generation: 'generation',
  /** The account this device's records belong to, from the first sign-in that synced. */
  account: 'account',
  deviceId: 'device_id',
  clock: 'clock',
  schemaVersion: 'schema_version',
  /** The lowest app schema version that can use this database, set by a breaking migration. */
  minAppSchema: 'min_app_schema',
  lastSyncAt: 'last_sync_at',
  lastSyncError: 'last_sync_error',
  /** Set while a sign-in back from the browser waits for its first sync, so screens show it's under way. */
  signingIn: 'signing_in',
} as const;

export async function getMeta(sql: Sql, key: string): Promise<string | null> {
  const row = await sql.get<{ value: string }>('SELECT value FROM meta WHERE key = :key', { key });
  return row?.value ?? null;
}

export async function setMeta(sql: Sql, key: string, value: string): Promise<void> {
  await sql.run('INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT (key) DO UPDATE SET value = :value', { key, value });
}

/** The schema version and the lowest app version that can use it, both 0 for a new database. */
async function schemaState(driver: SqlDriver): Promise<{ version: number; minApp: number }> {
  const tables = await driver.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'", []);
  if (tables.length === 0) return { version: 0, minApp: 0 };
  const rows = await driver.all('SELECT key, value FROM meta WHERE key IN (?, ?)', [META.schemaVersion, META.minAppSchema]);
  const value = (key: string) => Number(rows.find((row) => row.key === key)?.value ?? 0);
  return { version: value(META.schemaVersion), minApp: value(META.minAppSchema) };
}

/** BEGIN stays outside the try: when it fails, no transaction is this code's to roll back, as in createDb. */
async function inTransaction(driver: SqlDriver, work: () => Promise<void>): Promise<void> {
  await driver.exec('BEGIN IMMEDIATE');
  try {
    await work();
    await driver.exec('COMMIT');
  } catch (err) {
    await rollback(driver);
    throw err;
  }
}

const UPSERT_META = 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value';

function randomDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Prepares a raw connection and returns the Db: applies pending migrations, each in its own transaction, rebuilds any
 * view that differs from this code's, makes sure this device has an id, and refreshes planner statistics. A database a
 * newer bundle migrated still opens, since an update that fails its trial goes back to the bundle before it. Throws
 * only when a breaking migration says this app can't use the database, rather than risk damaging it.
 */
export async function openDb(driver: SqlDriver, migrations: readonly Migration[] = MIGRATIONS): Promise<Db> {
  const { version: current, minApp } = await schemaState(driver);
  const latest = Math.max(0, ...migrations.map((m) => m.version));
  if (minApp > latest) throw new Error(`Database version ${minApp} is newer than this app (${latest})`);

  for (const migration of migrations) {
    if (migration.version <= current) continue;
    await inTransaction(driver, async () => {
      for (const statement of migration.statements) await driver.run(statement, []);
      await driver.run(UPSERT_META, [META.schemaVersion, String(migration.version)]);
      if (migration.breaking) await driver.run(UPSERT_META, [META.minAppSchema, String(migration.version)]);
    });
  }
  // From this code's fields, so after a newer bundle rolls back, the one running reads the columns it expects. Only those
  // that differ, so an ordinary open writes nothing.
  const views = await driver.all("SELECT name, sql FROM sqlite_master WHERE type = 'view'", []);
  const stale = RECORD_TYPES.filter((type) => views.find((v) => v.name === type)?.sql !== viewSql(type));
  if (stale.length) await inTransaction(driver, () => driver.exec(stale.map((type) => `DROP VIEW IF EXISTS ${type}; ${viewSql(type)}`).join(';\n')));

  const db = createDb(driver);
  if (!(await getMeta(db, META.deviceId))) await setMeta(db, META.deviceId, randomDeviceId());
  await refreshStatistics(db);
  return db;
}

/** Without statistics SQLite can pick the type index over a date index. Run after a large import too. */
export async function refreshStatistics(sql: Sql): Promise<void> {
  await sql.all('PRAGMA optimize=0x10002');
}
