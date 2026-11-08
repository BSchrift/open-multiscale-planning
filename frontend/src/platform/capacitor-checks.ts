// A test page for XCUITest: buttons that drive the real adapter and real plugins, and print what happened. The test
// script builds it into the app's test copy only, so it never ships.

import { LocalNotifications } from '@capacitor/local-notifications';
import type { AppEnv } from '../core/appConfig';
import { systemClock } from '../core/clock';
import { addDays, nowInstant, thisWeek, toInstant, today } from '../core/dates';
import { META, openDb, refreshStatistics } from '../core/db';
import type { Db } from '../core/db';
import { planProblems, seedLarge } from '../core/queries-testing';
import { setWeekPick, transact, updateSettings, weekPlanId } from '../core/records';
import { capacitorSqlDriver, createCapacitorPlatform } from './capacitor';
import type { Platform } from './types';

const output = document.getElementById('log')!;
const log = (line: string) => {
  const p = document.createElement('p');
  p.textContent = line;
  output.append(p);
};

/** The unit test's check, on the SQLite this plugin ships. */
async function checkQueryPlans(): Promise<string> {
  const db = await openDb(await capacitorSqlDriver('query-plan-check'));
  const version = (await db.get<{ v: string }>('SELECT sqlite_version() AS v'))!.v;
  log(`sqlite:${version}`);
  await seedLarge(db);
  await refreshStatistics(db);
  const problems = await planProblems(db);
  await db.close();
  for (const problem of problems) log(problem);
  return problems.length === 0 ? 'queryplans:ok' : `queryplans:${problems.length} failed`;
}

/** What the plugin could get wrong: transactions, rollback, nulls, non-ASCII text, and rewriting DELETE. */
async function checkDatabase(db: Db): Promise<string> {
  const value = 'Bäke brëad 🍞 \'quoted\'';
  await db.run("DELETE FROM meta WHERE key LIKE 'check.%'");
  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO meta (key, value) VALUES (:key, :value)', { key: 'check.text', value });
  });
  await db
    .transaction(async (tx) => {
      await tx.run('INSERT INTO meta (key, value) VALUES (:key, :value)', { key: 'check.rolled', value });
      throw new Error('roll back');
    })
    .catch(() => undefined);
  const rows = await db.all<{ key: string; value: string; empty: null; number: number }>(
    "SELECT key, value, NULL AS empty, 2 + 1 AS number FROM meta WHERE key LIKE 'check.%'",
  );
  const row = rows[0];
  if (rows.length !== 1 || row?.value !== value || row.empty !== null || row.number !== 3) throw new Error(JSON.stringify(rows));
  await db.run('DELETE FROM meta WHERE key = :key', { key: 'check.text' });
  if ((await db.all("SELECT 1 FROM meta WHERE key LIKE 'check.%'")).length !== 0) throw new Error('DELETE left a row');
  return 'database:ok';
}

/** The app's data as a new install has it. The schema stays, and so does this device's id. */
async function erase(platform: Platform): Promise<string> {
  await platform.db.transaction(async (tx) => {
    await tx.run('DELETE FROM records');
    await tx.run('DELETE FROM outbox');
    await tx.run('DELETE FROM meta WHERE key NOT IN (:schema, :device)', { schema: META.schemaVersion, device: META.deviceId });
  });
  // The sign-in and the one in progress, by the keys auth.ts keeps them under.
  for (const key of ['auth.session', 'auth.pending']) await platform.tokens.remove(key);
  await platform.notifications.replaceAll([]);
  await LocalNotifications.removeAllDeliveredNotifications();
  localStorage.clear();
  const left = (await platform.db.all('SELECT id FROM records')).length;
  const session = await platform.tokens.get('auth.session');
  return left === 0 && session === null ? 'erased' : `erase left ${left} records and ${session === null ? 'no' : 'a'} session`;
}

const MINUTE_MS = 60_000;

/**
 * Where an app flow starts, timed from now: past setup, this week planned, a goal with a project and a milestone, and
 * a two-hour task with a block for each entry, minutes from now. Seeded like the browser tests seed, since the
 * Simulator's clock can't be moved. The UI tests wait near midnight until the earliest block fits in today, so a
 * change to how far back a seed reaches goes in their launchApp call too.
 */
async function seed(db: Db, blocks: readonly { title: string; from: number; to: number; started?: boolean }[], picked: readonly string[] = []): Promise<string> {
  const clock = systemClock;
  const on = today(clock);
  const now = clock.now();
  await transact(db, clock, async (w) => {
    await updateSettings(w, { setup_done_at: nowInstant(clock) });
    await w.create('week_plan', { week_start: thisWeek(clock), finished_at: nowInstant(clock) }, weekPlanId(thisWeek(clock)));
    const goal = await w.create('objective', { title: 'Learn to bake bread', state: 'active' });
    const project = await w.create('project', { objective_id: goal, title: 'Bake a sourdough loaf', state: 'active', start: on, end: addDays(on, 90) });
    const milestone = await w.create('milestone', { project_id: project, title: 'A starter that rises', due: addDays(on, 14), added_on: on });
    for (const title of picked) {
      const task = await w.create('task', { kind: 'project', project_id: project, milestone_id: milestone, title, estimate_min: 30 });
      await setWeekPick(w, thisWeek(clock), task, 30);
    }
    for (const b of blocks) {
      const task = await w.create('task', { kind: 'project', project_id: project, milestone_id: milestone, title: b.title, estimate_min: 120 });
      await w.create('time_block', {
        task_id: task,
        start: toInstant(now + b.from * MINUTE_MS),
        end: toInstant(now + b.to * MINUTE_MS),
        tz: clock.zone(),
        ...(b.started ? { started_at: nowInstant(clock) } : {}),
      });
    }
  });
  return 'seeded';
}

const button = (label: string, run: () => Promise<string>) => {
  const element = document.createElement('button');
  element.textContent = label;
  element.onclick = () => void run().then(log, (err: unknown) => log(`${label} failed: ${String(err)}`));
  document.getElementById('buttons')!.append(element);
};

/** The environment the app copy was built for, so Erase clears the database the app itself opens. */
declare const __CHECKS_ENV__: AppEnv;
const platform = await createCapacitorPlatform(__CHECKS_ENV__);
platform.onDeepLink((url) => log(`link:${url}`));
platform.hotkey?.onCapture(() => log('capture'));
platform.lifecycle.onForeground(() => log('foreground'));
platform.notifications.onResponse((r) => log(`response:${r.reminder_id}:${r.action_id}`));

button('Ask', async () => `permission:${await platform.notifications.requestPermission()}`);
button('Remind', async () => {
  await platform.notifications.replaceAll([
    {
      id: 'check-block:end',
      kind: 'block_end',
      block_id: 'check-block',
      at: new Date(Date.now() + 4000).toISOString(),
      title: 'Paint the fence',
      body: 'How did it go?',
      actions: [
        { id: 'done', title: 'Done' },
        { id: 'partly', title: 'Partly', opens_app: true },
      ],
    },
  ]);
  return `pending:${(await platform.notifications.scheduled()).map((r) => r.id).join(',')}`;
});
button('Cancel', async () => {
  await platform.notifications.cancel(['check-block:end']);
  return `pending:${(await platform.notifications.scheduled()).length}`;
});
button('Keychain', async () => {
  const key = 'check.token';
  await platform.tokens.set(key, 'secret');
  const stored = await platform.tokens.get(key);
  await platform.tokens.remove(key);
  return stored === 'secret' && (await platform.tokens.get(key)) === null ? 'keychain:ok' : `keychain:wrong ${stored}`;
});
button('Database', () => checkDatabase(platform.db));
button('Plans', checkQueryPlans);
button('Browser', async () => {
  await platform.openExternal('https://localhost/');
  return 'browser:opened';
});
button('Shared', async () => {
  const share = platform.shareImport;
  if (!share) return 'shared:off';
  const items = await share.peek();
  await share.remove(items.map((item) => item.id));
  return `shared:${items.map((item) => item.text).join('|')}`;
});
button('Diagnostics', async () => {
  const snap = await platform.diagnostics!.snapshot();
  log(`previous:${snap.previous?.state ?? 'none'}`);
  return snap.footprint > 0 && snap.peak >= snap.footprint && /^\w+\d/.test(snap.model ?? '') ? 'diagnostics:ok' : `diagnostics:${JSON.stringify(snap)}`;
});
button('Erase', () => erase(platform));
button('Seed plan', () => seed(platform.db, []));
// Picked for this week with nothing placed, so it waits in To schedule on Today.
button('Seed to schedule', () => seed(platform.db, [], ['Mix the dough']));
// One block ended half an hour ago and one started six minutes ago, unstarted, so both of Today's questions are due.
button('Seed today', () =>
  seed(platform.db, [
    { title: 'Feed the starter', from: -90, to: -30 },
    { title: 'Shape the dough', from: -6, to: 24 },
  ]),
);
// A started block that ends in two minutes, so its end notification is the only one, and comes after even a slow
// Simulator has opened the app and scheduled it.
button('Seed soon', () => seed(platform.db, [{ title: 'Proof the loaf', from: -20, to: 2, started: true }]));
log('ready');
