// SqlDriver over better-sqlite3. Its prepare takes a single statement and its all and run each refuse the wrong kind
// of statement, so these check which kind they were given: PRAGMA optimize, for one, reaches all but returns no rows.

import type { Database } from 'better-sqlite3';
import type { Row, SqlDriver } from '../src/core/db';

export function betterSqliteDriver(db: Database): SqlDriver {
  return {
    exec: async (sql) => void db.exec(sql),
    all: async (sql, values) => {
      const statement = db.prepare(sql);
      if (statement.reader) return statement.all(...values) as Row[];
      statement.run(...values);
      return [];
    },
    run: async (sql, values) => {
      const statement = db.prepare(sql);
      if (statement.reader) statement.all(...values);
      else statement.run(...values);
    },
    close: async () => void db.close(),
  };
}
