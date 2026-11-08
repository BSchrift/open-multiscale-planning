import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '../core/clock';
import { openDb } from '../core/db';
import { transact } from '../core/records';
import { sqliteWasmDriver } from './sqlite-wasm-driver';

// The web app runs this driver on OPFS in a worker. Node has only the in-memory database, which takes the same calls.
const open = async () => sqliteWasmDriver(new (await sqlite3InitModule()).oo1.DB(':memory:'));

describe('SQLite Wasm driver', () => {
  it('runs migrations, which send DDL through run and transaction control through exec', async () => {
    const db = await openDb(await open());
    const views = await db.all("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'task'");
    expect(views).toHaveLength(1);
  });

  it('all tolerates a statement that returns no rows, such as PRAGMA optimize', async () => {
    const driver = await open();
    expect(await driver.all('CREATE TABLE t (a)', [])).toEqual([]);
    expect(await driver.all('PRAGMA optimize=0x10002', [])).toEqual([]);
  });

  it('run tolerates a statement that returns rows, such as a pragma that echoes', async () => {
    await expect((await open()).run('PRAGMA journal_mode', [])).resolves.toBeUndefined();
  });

  it('exec takes several statements, and all binds positional values, null included', async () => {
    const driver = await open();
    await driver.exec('CREATE TABLE t (a, b); INSERT INTO t VALUES (1, NULL)');
    await driver.run('INSERT INTO t VALUES (?, ?)', ['x', null]);
    expect(await driver.all('SELECT a, b FROM t WHERE a = ?', [1])).toEqual([{ a: 1, b: null }]);
    expect(await driver.all('SELECT a FROM t WHERE b IS ?', [null])).toEqual([{ a: 1 }, { a: 'x' }]);
  });

  it("rejects with SQLite's message on a bad statement", async () => {
    await expect((await open()).all('SELECT * FROM missing', [])).rejects.toThrow('no such table: missing');
  });

  it('commits and rolls back through the Db', async () => {
    const db = await openDb(await open());
    const clock = fixedClock('2026-11-02T09:00:00Z');
    await transact(db, clock, (w) => w.create('task', { kind: 'inbox', title: 'Paint the fence' }));
    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO meta (key, value) VALUES ('k', 'v')");
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect(await db.all("SELECT 1 FROM meta WHERE key = 'k'")).toEqual([]);
    expect(await db.all("SELECT title FROM task WHERE kind = 'inbox'")).toEqual([{ title: 'Paint the fence' }]);
  });
});
