// SQLite for tests, on Node's built-in driver. Real SQLite, so tests cover the real schema and query plans.

import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { openDb } from '../core/db';
import type { Db, Row, SqlDriver, SqlValue } from '../core/db';

export function nodeSqliteDriver(path = ':memory:'): SqlDriver {
  const db = new DatabaseSync(path);
  return {
    exec: async (sql) => db.exec(sql),
    all: async (sql, values: SqlValue[]) => db.prepare(sql).all(...(values as SQLInputValue[])) as Row[],
    run: async (sql, values: SqlValue[]) => void db.prepare(sql).run(...(values as SQLInputValue[])),
    close: async () => db.close(),
  };
}

/** A fresh in-memory database with the current schema. */
export function openTestDb(): Promise<Db> {
  return openDb(nodeSqliteDriver());
}
