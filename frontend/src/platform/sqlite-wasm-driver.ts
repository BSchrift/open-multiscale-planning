// SqlDriver over SQLite's own WebAssembly build, which the web app runs on OPFS in a worker (opfs.worker.ts).

import type { Database } from '@sqlite.org/sqlite-wasm';
import type { Row, SqlDriver, SqlValue } from '../core/db';

export function sqliteWasmDriver(db: Database): SqlDriver {
  return {
    exec: async (sql) => void db.exec(sql),
    all: async (sql, values: SqlValue[]) => db.selectObjects(sql, values) as Row[],
    run: async (sql, values: SqlValue[]) => void db.exec({ sql, bind: values }),
    close: async () => db.close(),
  };
}
