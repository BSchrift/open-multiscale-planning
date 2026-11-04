// SqlDriver over sql.js, SQLite compiled to WebAssembly.

import type { Database } from 'sql.js';
import type { Row, SqlDriver, SqlValue } from '../core/db';

export function sqlJsDriver(db: Database): SqlDriver {
  return {
    exec: async (sql) => {
      db.exec(sql);
    },
    all: async (sql, values: SqlValue[]) => {
      const statement = db.prepare(sql);
      try {
        statement.bind(values);
        const rows: Row[] = [];
        while (statement.step()) rows.push(statement.getAsObject() as Row);
        return rows;
      } finally {
        statement.free();
      }
    },
    run: async (sql, values: SqlValue[]) => {
      db.run(sql, values);
    },
    close: async () => db.close(),
  };
}
