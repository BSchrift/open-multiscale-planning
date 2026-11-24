// A test page for XCUITest: buttons that drive the real adapter and real plugins, and print what happened. The test
// script builds it into the app's test copy only, so it never ships.

import { Capacitor, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { AppEnv } from '../core/appConfig';
import { captureShare } from '../core/captureShare';
import { systemClock } from '../core/clock';
import { addDays, addWeeks, nowInstant, thisWeek, toInstant, today } from '../core/dates';
import { META, openDb, refreshStatistics } from '../core/db';
import type { Db } from '../core/db';
import { dailyAttributes, exceptionAttributes } from '../core/metrickit';
import { planProblems, seedLarge } from '../core/queries-testing';
import { nextStretch } from '../core/plan';
import { historyChanges } from '../core/history-testing';
import { KEEP, KEPT } from '../core/perf';
import { applyRemote, getSettings, setWeekPick, transact, updateSettings, weekPlanId } from '../core/records';
import { newestId, writeSeen } from '../core/whatsNew';
import { WHATS_NEW } from '../whatsNew';
import { capacitorSqlDriver, createCapacitorPlatform } from './capacitor';
import { timeHistoryQueries } from './history-checks';
import type { Platform } from './types';

/** The debug build's hooks for this page (ChecksPlugin in BridgeViewController.swift). */
const Checks = registerPlugin<{ openCapture(): Promise<void>; share(options: { text: string }): Promise<void>; deliverEnergy(): Promise<void> }>('MultiscaleChecks');

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
  // A new install has seen every What's new line, which setup records; the seeds skip setup, so it's recorded here.
  writeSeen(newestId(WHATS_NEW));
  const left = (await platform.db.all('SELECT id FROM records')).length;
  const session = await platform.tokens.get('auth.session');
  return left === 0 && session === null ? 'erased' : `erase left ${left} records and ${session === null ? 'no' : 'a'} session`;
}

const MINUTE_MS = 60_000;

/**
 * Where an app flow starts, timed from now: past setup, this week planned, a goal with a project and a milestone, and
 * a two-hour task with a block for each entry, minutes from now. Seeded like the browser tests seed. The Simulator's
 * clock can't be set, so the UI tests run a seeded app on a page clock shifted to the morning, except where they need
 * the real one (launchApp in MultiscaleUITests.swift).
 */
async function seed(db: Db, blocks: readonly { title: string; from: number; to: number; started?: boolean }[], picked: readonly string[] = []): Promise<string> {
  const clock = systemClock;
  const on = today(clock);
  const now = clock.now();
  await transact(db, clock, async (w) => {
    // This week, the next and the stretches are planned, so Today shows no planning row above the work these tests drag
    // and answer: the stretch's row is taller than the alert it replaced, and pushed the day out of the drag's reach.
    const stretch = nextStretch(await getSettings(w.sql), on);
    await updateSettings(w, { setup_done_at: nowInstant(clock), plan_stretch: { last_planned: stretch.start } });
    for (const week of [thisWeek(clock), addWeeks(thisWeek(clock), 1)]) {
      await w.create('week_plan', { week_start: week, finished_at: nowInstant(clock) }, weekPlanId(week));
    }
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
  // Noted at once, so a test can tell a tap the page never heard, which it taps again, from a check still running.
  element.onclick = () => {
    log(`tapped:${label}`);
    void run().then(log, (err: unknown) => log(`${label} failed: ${String(err)}`));
  };
  document.getElementById('buttons')!.append(element);
};

/** The environment the app copy was built for, so Erase clears the database the app itself opens. */
declare const __CHECKS_ENV__: AppEnv;
// So a test that gives up waiting for ready shows a page that never ran apart from one still opening the database, and
// an open that failed says why.
log('opening');
const platform = await createCapacitorPlatform(__CHECKS_ENV__).catch((err: unknown) => {
  log(`open failed: ${String(err)}`);
  throw err;
});
platform.onDeepLink((url) => log(`link:${url}`));
platform.hotkey?.onCapture(() => log('capture'));
platform.lifecycle.onForeground(() => log('foreground'));
platform.notifications.onResponse((r) => log(`response:${r.reminder_id}:${r.action_id}`));

button('Ask', async () => `permission:${await platform.notifications.requestPermission()}`);
const remind = async (inMs: number) => {
  await platform.notifications.replaceAll([
    {
      id: 'check-block:end',
      kind: 'block_end',
      block_id: 'check-block',
      at: new Date(Date.now() + inMs).toISOString(),
      title: 'Paint the fence',
      body: 'How did it go?',
      actions: [
        { id: 'done', title: 'Done' },
        { id: 'partly', title: 'Partly', opens_app: true },
      ],
    },
  ]);
  return `pending:${(await platform.notifications.scheduled()).map((r) => r.id).join(',')}`;
};
// An hour out, so it's still waiting however slow the Simulator. The UI test's launch has the debug build bring it
// forward once the app leaves the screen.
button('Remind', () => remind(60 * MINUTE_MS));
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
// The light tap a hold gives. The adapter never fails, so the app is asked first whether it has the plugin at all. The
// Simulator has no Taptic Engine, so only that the call reached it shows here.
button('Haptic', async () => {
  if (!Capacitor.isPluginAvailable('Haptics')) return 'haptic:missing';
  await platform.haptic!();
  return 'haptic:ok';
});
button('Plans', checkQueryPlans);
button('Browser', async () => {
  await platform.openExternal('https://localhost/');
  return 'browser:opened';
});
// Whether the web view lets a request out, for the UI test of the debug build's offline launch: it types the address
// scripts/test-ios.sh serves on the Mac. Opaque, since that server sends no CORS headers, so only reaching it counts.
const address = document.createElement('input');
// iOS's URL keyboard, which doesn't capitalize or correct what's typed.
address.type = 'url';
address.setAttribute('aria-label', 'Address');
// Noted, so the test can tell a tap the field never heard, which it taps again, from one that gave it focus.
address.addEventListener('focus', () => log('focused:Address'));
document.getElementById('buttons')!.append(address);
button('Fetch', () =>
  fetch(address.value, { mode: 'no-cors' }).then(
    () => 'fetch:reached',
    () => 'fetch:blocked',
  ),
);
button('Shared', async () => {
  const share = platform.shareImport;
  if (!share) return 'shared:off';
  const items = await share.peek();
  await share.remove(items.map((item) => item.id));
  return `shared:${items.map((item) => item.text).join('|')}`;
});
// A 21,000-character share, queued as the share extension queues it: it reaches the app whole, and the app cuts its
// description on a word at 20,000 characters, and says so.
button('Share long', async () => {
  const share = platform.shareImport;
  if (!share) return 'shared-long:off';
  await Checks.share({ text: `Notes from the talk\n${'word '.repeat(4196)}` });
  const items = (await share.peek()).filter((item) => item.text.startsWith('Notes from the talk'));
  await share.remove(items.map((item) => item.id));
  return `shared-long:${items.map((item) => {
    const shared = captureShare(item.text);
    return `${item.text.length}:${shared?.notes?.length}:${shared?.cut ? 'cut' : 'whole'}`;
  }).join('|')}`;
});
// The Control Center button's intent, through the debug build's hook, which logs capture as the button would.
button('Control', async () => {
  await Checks.openCapture();
  return 'control:ran';
});
button('Diagnostics', async () => {
  const snap = await platform.diagnostics!.snapshot();
  log(`previous:${snap.previous?.state ?? 'none'}`);
  return snap.footprint > 0 && snap.peak >= snap.footprint && /^\w+\d/.test(snap.model ?? '') ? 'diagnostics:ok' : `diagnostics:${JSON.stringify(snap)}`;
});
// What MetricKit would deliver, kept by the energy plugin as it keeps a real delivery, through the debug build's hook.
button('Deliver energy', async () => {
  // After taking any an earlier run left, so the check sees only these.
  await platform.energy!.reports!();
  await Checks.deliverEnergy();
  return 'energy:delivered';
});
// The reports kept, as telemetry sends them, each handed over once, and the battery's state.
button('Energy', async () => {
  const energy = platform.energy!;
  const { daily, exceptions } = await energy.reports!();
  const sent = JSON.stringify([...daily.map(dailyAttributes), ...exceptions.map(exceptionAttributes)]);
  const again = await energy.reports!();
  const { power } = await energy.sample();
  const expected = JSON.stringify([
    { 'energy.day': '2026-11-15', 'energy.cpu_seconds': 100.5, 'energy.cellular_bytes': 2000000, 'energy.background_seconds': 40 },
    { 'energy.exception.kind': 'cpu', 'energy.exception.cpu_seconds': 90, 'code.function': 'App+0x28a3c' },
  ]);
  const ok = sent === expected && again.daily.length + again.exceptions.length === 0 && typeof power.lowPower === 'boolean' && /^(nominal|fair|serious|critical)$/.test(power.thermal ?? '');
  return ok ? 'energy:ok' : `energy:${sent} again:${JSON.stringify(again)} power:${JSON.stringify(power)}`;
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
// A started block, so its end notification is the app's soonest. It ends 20 minutes out, so the notification comes only
// when the UI test's launch has the debug build bring it forward, once the app leaves the screen.
button('Seed soon', () => seed(platform.db, [{ title: 'Proof the loaf', from: -20, to: 20, started: true }]));
// A block half an hour out, still to come with free time after it, for Week's day to move.
button('Seed later', () => seed(platform.db, [{ title: 'Shape the loaf', from: 30, to: 90 }]));
// The performance runner's data and numbers (PerfUITests, scripts/test-perf-ios.sh): a year of history ending now, as a
// sync would apply it; the app's measures kept from now on; and then what it kept, by name, with the app's peak memory
// in the run before this page's, the session that was timed.
button('Seed year', async () => {
  await applyRemote(platform.db, historyChanges({ weeks: 52, now: Date.now() }));
  return 'seeded';
});
button('Keep measures', async () => {
  localStorage.setItem(KEEP, '1');
  localStorage.removeItem(KEPT);
  return 'keeping';
});
button('Measures', async () => {
  const kept = JSON.parse(localStorage.getItem(KEPT) ?? '[]') as [string, number][];
  const byName: Record<string, number[]> = {};
  for (const [name, value] of kept) (byName[name] ??= []).push(value);
  const previous = (await platform.diagnostics?.snapshot())?.previous;
  return `measures:${JSON.stringify({ measures: byName, peakMb: previous ? Math.round(previous.peak / 1048576) : null, warnings: previous?.warnings ?? null })}`;
});
// Today and Week on what the app synced, for the history-scale test (scripts/test-history.sh).
button('History', async () => `history:${JSON.stringify(await timeHistoryQueries(platform.db))}`);
log('ready');
// On the app's console too, where scripts/test-ios.sh waits for it as it warms up a new Simulator.
console.info('native-checks ready');
