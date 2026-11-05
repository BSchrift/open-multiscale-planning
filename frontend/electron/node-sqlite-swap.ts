// Stands in for platform/node-sqlite under vitest.electron.config.ts.

import Database from 'better-sqlite3';
import { openDb } from '../src/core/db';
import type { Db, SqlDriver } from '../src/core/db';
import { betterSqliteDriver } from './sqlite-driver';

export const nodeSqliteDriver = (path = ':memory:'): SqlDriver => betterSqliteDriver(new Database(path));
export const openTestDb = (): Promise<Db> => openDb(nodeSqliteDriver());
export const isAppDriver = true;
