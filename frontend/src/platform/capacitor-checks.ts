// A test page for XCUITest: buttons that drive the real adapter and real plugins, and print what happened. The test
// script builds it into the app's test copy only, so it never ships.

import { registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { AppEnv } from '../core/appConfig';
import { systemClock } from '../core/clock';
import { addDays, addWeeks, localToInstant, nowInstant, thisWeek, toInstant, today } from '../core/dates';
import type { Fields, LocalDate } from '../core/types';
import { META, openDb, refreshStatistics } from '../core/db';
import type { Db } from '../core/db';
import { planProblems, seedLarge } from '../core/queries-testing';
import { nextStretch } from '../core/plan';
import { weekPlanningId, weekPlanningTitle } from '../core/planning';
import { getSettings, outcomeId, setWeekPick, transact, updateSettings, weekPlanId } from '../core/records';
import type { Writer } from '../core/records';
import { capacitorSqlDriver, createCapacitorPlatform } from './capacitor';
import { timeHistoryQueries } from './history-checks';
import type { Platform } from './types';

/** The debug build's hooks for this page (ChecksPlugin in BridgeViewController.swift). */
const Checks = registerPlugin<{ openCapture(): Promise<void> }>('MultiscaleChecks');

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
 * a two-hour task with a block for each entry, minutes from now. Seeded like the browser tests seed. The Simulator's
 * clock can't be set, so the UI tests run a seeded app on a page clock shifted to the morning, except where they need
 * the real one (launchApp in MultiscaleUITests.swift).
 */
interface Seeded {
  goal: string;
  project: string;
  milestone: string;
  /** Today, on the page's clock. */
  on: LocalDate;
  /** Now in ms, on the page's clock. */
  now: number;
}

interface SeedOptions {
  /** Leaves this week, the next and the stretch unplanned, for the planning flows. */
  unplanned?: boolean;
  /** More records, in the same transaction, for a feature test's own start. */
  more?: (w: Writer, seeded: Seeded) => Promise<void>;
}

async function seed(
  db: Db,
  blocks: readonly { title: string; from: number; to: number; started?: boolean }[],
  picked: readonly string[] = [],
  options: SeedOptions = {},
): Promise<string> {
  const clock = systemClock;
  const on = today(clock);
  const now = clock.now();
  await transact(db, clock, async (w) => {
    if (options.unplanned) {
      await updateSettings(w, { setup_done_at: nowInstant(clock) });
    } else {
      // This week, the next and the stretches are planned, so Today shows no planning row above the work these tests
      // drag and answer: the stretch's row is taller than the alert it replaced, and pushed the day out of the drag's
      // reach.
      const stretch = nextStretch(await getSettings(w.sql), on);
      await updateSettings(w, { setup_done_at: nowInstant(clock), plan_stretch: { last_planned: stretch.start } });
      for (const week of [thisWeek(clock), addWeeks(thisWeek(clock), 1)]) {
        await w.create('week_plan', { week_start: week, finished_at: nowInstant(clock) }, weekPlanId(week));
      }
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
    await options.more?.(w, { goal, project, milestone, on, now });
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
// The feature tests' own starts, one or more per area (the UITests file named in each comment).
// Four items waiting in the Inbox, in added order, for Process, the Inbox's rows and select mode (InboxUITests.swift).
button('Seed inbox items', () =>
  seed(platform.db, [], [], {
    more: async (w) => {
      for (const title of ['Call the bank', 'Fix the gate', 'Water the plants', 'Buy stamps']) await w.create('task', { kind: 'inbox', title });
    },
  }),
);
// A milestone, Make a starter, a week past its date with one of its two tasks done, so its project asks what to do
// about it. The project started a month ago, before the milestone was due (GoalsUITests.swift).
button('Seed goals overdue', () =>
  seed(platform.db, [], [], {
    more: async (w, s) => {
      await w.set('project', s.project, { start: addDays(s.on, -30) });
      const late = await w.create('milestone', { project_id: s.project, title: 'Make a starter', due: addDays(s.on, -7), added_on: addDays(s.on, -30) });
      await w.create('task', {
        kind: 'project',
        project_id: s.project,
        milestone_id: late,
        title: 'Mix flour and water',
        estimate_min: 60,
        done_at: toInstant(s.now - 10 * 24 * 60 * MINUTE_MS),
      });
      await w.create('task', { kind: 'project', project_id: s.project, milestone_id: late, title: 'Feed the starter', estimate_min: 120 });
    },
  }),
);
// A practice with no goal, Stretch, 15 minutes every day around 7am, and a goal with nothing under it to link it to
// (GoalsUITests.swift).
button('Seed goals practice', () =>
  seed(platform.db, [], [], {
    more: async (w) => {
      await w.create('objective', { title: 'Run a 10k', state: 'active' });
      await w.create('practice', { title: 'Stretch', target_min: 15, per: 'day', state: 'active', preferred_times: [7 * 60] });
    },
  }),
);
// A block that began a minute ago, not yet started, so the Now card offers Start before "Have you started?" is due, and
// one later in the day for Mark done now to free the time until, and for the timeline to open and drag
// (TodayUITests.swift).
button('Seed today now', () =>
  seed(platform.db, [
    { title: 'Mix the dough', from: -1, to: 59 },
    { title: 'Shape the dough', from: 120, to: 210 },
  ]),
);
// A block paused 22 minutes in that ran to its end ten minutes ago, as Today's browser test has it, and the next block
// starting before the 28 minutes a Resume gives back would end, so Resume brings the shift (TodayUITests.swift).
button('Seed today paused', () =>
  seed(platform.db, [{ title: 'Bake the loaf', from: 15, to: 45 }], [], {
    more: async (w, s) => {
      const at = (minutes: number) => toInstant(s.now + minutes * MINUTE_MS);
      const task = await w.create('task', { kind: 'project', project_id: s.project, milestone_id: s.milestone, title: 'Proof the loaf', estimate_min: 120 });
      await w.create('time_block', { task_id: task, start: at(-60), end: at(-10), tz: systemClock.zone(), started_at: at(-60), paused_at: at(-38) });
    },
  }),
);
// Five blocks that ended this morning unanswered, so the missed blocks sheet opens by itself and keeps two rows for a
// swipe down and Review after a row's answer and a selection's (TodayUITests.swift).
button('Seed today missed', () =>
  seed(platform.db, [
    { title: 'Feed the starter', from: -200, to: -180 },
    { title: 'Mix the dough', from: -170, to: -150 },
    { title: 'Fold the dough', from: -140, to: -120 },
    { title: 'Shape the dough', from: -110, to: -90 },
    { title: 'Proof the loaf', from: -80, to: -60 },
  ]),
);
// This week unplanned with one off to start from Next up. Next week is planned, so its row never takes the place of the
// banner a skip leaves, as it would in the last days of the week (TodayUITests.swift).
button('Seed today unplanned', () =>
  seed(platform.db, [], [], {
    unplanned: true,
    more: async (w) => {
      await w.create('task', { kind: 'one_off', title: 'Buy flour', estimate_min: 30 });
      const next = addWeeks(thisWeek(systemClock), 1);
      await w.create('week_plan', { week_start: next, finished_at: nowInstant(systemClock) }, weekPlanId(next));
    },
  }),
);
// Mix the dough picked and unplaced, Clean the banneton a one off to add from the drawer, and Shape the dough on next
// week's Tuesday at 9am, to move to another day and remove. Proof the loaf, started and running until 11:30, keeps
// Week's suggestions clear of now, so a block placed by one never asks "Have you started?" mid-test (WeekUITests.swift).
button('Seed week', () =>
  seed(platform.db, [{ title: 'Proof the loaf', from: -30, to: 90, started: true }], ['Mix the dough'], {
    more: async (w, s) => {
      const zone = systemClock.zone();
      await w.create('task', { kind: 'one_off', title: 'Clean the banneton', estimate_min: 60 });
      const task = await w.create('task', { kind: 'project', project_id: s.project, title: 'Shape the dough', estimate_min: 60 });
      const tuesday = addDays(thisWeek(systemClock), 8);
      await w.create('time_block', { task_id: task, start: localToInstant(tuesday, 9 * 60, zone), end: localToInstant(tuesday, 10 * 60, zone), tz: zone });
    },
  }),
);
// Feed the starter finished in a block this morning, and Shape the dough's block ended half an hour ago with no answer,
// so Today asks about it and Done lists it under Not marked yet. Neither is under the milestone, so finishing both
// reaches nothing more (ReviewUITests.swift).
button('Seed done', () =>
  seed(platform.db, [], [], {
    more: async (w, s) => {
      const zone = systemClock.zone();
      const at = (minutes: number) => toInstant(s.now + minutes * MINUTE_MS);
      const fed = await w.create('task', { kind: 'project', project_id: s.project, title: 'Feed the starter', estimate_min: 60, done_at: at(-120) });
      const fedBlock = await w.create('time_block', { task_id: fed, start: at(-180), end: at(-120), tz: zone });
      await w.create('block_outcome', { result: 'done', answered_at: at(-120) }, outcomeId(fedBlock));
      const shape = await w.create('task', { kind: 'project', project_id: s.project, title: 'Shape the dough', estimate_min: 60 });
      await w.create('time_block', { task_id: shape, start: at(-90), end: at(-30), tz: zone });
    },
  }),
);
// This morning one block done and one not, and the same weekday's evening not done in each of the last five weeks, so
// the stretch shows that evening as a pattern to stop suggesting (ReviewUITests.swift).
button('Seed analytics', () =>
  seed(platform.db, [], [], {
    more: async (w, s) => {
      const zone = systemClock.zone();
      const task = await w.create('task', { kind: 'project', project_id: s.project, title: 'Feed the starter', estimate_min: 60 });
      const answered = async (date: LocalDate, from: number, result: 'done' | 'not') => {
        const block = await w.create('time_block', { task_id: task, start: localToInstant(date, from, zone), end: localToInstant(date, from + 60, zone), tz: zone });
        await w.create('block_outcome', { result, answered_at: nowInstant(systemClock) }, outcomeId(block));
      };
      await answered(s.on, 7 * 60, 'done');
      await answered(s.on, 8 * 60, 'not');
      for (let weeks = 1; weeks <= 5; weeks++) await answered(addDays(s.on, -7 * weeks), 19 * 60, 'not');
    },
  }),
);
// A block that ended half an hour ago with no answer, so Today asks about it at once and, put off, keeps a Review row,
// which away dates for today take away (SettingsUITests.swift).
button('Seed settings missed', () => seed(platform.db, [{ title: 'Feed the starter', from: -90, to: -30 }]));

/**
 * A two-hour task with a block at a clock time on the seeded day, in minutes after midnight, so the reminder tests can
 * match the labels Today gives blocks whole. The seeded app's day starts at 10am, and the seed runs a minute or two in.
 */
async function blockAt(w: Writer, s: Seeded, title: string, from: number, to: number, fields: Fields<'time_block'> = {}): Promise<string> {
  const zone = systemClock.zone();
  const task = await w.create('task', { kind: 'project', project_id: s.project, milestone_id: s.milestone, title, estimate_min: 120 });
  return w.create('time_block', { task_id: task, start: localToInstant(s.on, from, zone), end: localToInstant(s.on, to, zone), tz: zone, ...fields });
}

/** A practice of the session's length, every day, with a session at a clock time on the seeded day. */
async function practiceAt(w: Writer, s: Seeded, title: string, from: number, to: number): Promise<void> {
  const zone = systemClock.zone();
  const practice = await w.create('practice', { title, target_min: to - from, per: 'day', state: 'active' });
  await w.create('time_block', { practice_id: practice, start: localToInstant(s.on, from, zone), end: localToInstant(s.on, to, zone), tz: zone });
}

// Shape the dough at 10:10, so its start is the app's soonest reminder; next week's planning block at 10:50, its week
// left unplanned so the block reminds; and Bake the loaf at 11:30 (RemindersUITests.swift).
button('Seed reminders start', () =>
  seed(platform.db, [], [], {
    more: async (w, s) => {
      const zone = systemClock.zone();
      const week = addWeeks(thisWeek(systemClock), 1);
      await blockAt(w, s, 'Shape the dough', 610, 640);
      await w.set('week_plan', weekPlanId(week), { finished_at: null });
      await w.create('task', { kind: 'planning', title: weekPlanningTitle(week), plans: [`week:${week}`], estimate_min: 30 }, weekPlanningId(week));
      await w.create('time_block', { task_id: weekPlanningId(week), start: localToInstant(s.on, 650, zone), end: localToInstant(s.on, 680, zone), tz: zone });
      await blockAt(w, s, 'Bake the loaf', 690, 720);
    },
  }),
);
// Shape the dough began at 9:54 unstarted, so with the usual 5-minute check-in Today asks at once, while with 15 minutes
// its check-in is still to come, at 10:09. Bake the loaf follows at 10:40 (RemindersUITests.swift).
button('Seed reminders check-in', () =>
  seed(platform.db, [], [], {
    more: async (w, s) => {
      await blockAt(w, s, 'Shape the dough', 594, 624);
      await blockAt(w, s, 'Bake the loaf', 640, 670);
    },
  }),
);
// Proof the loaf, started at 9:40 and paused at 9:50, so its one still-paused reminder at 10:20 is the soonest; then two
// practice sessions under way later in the morning, Stretch at 10:30 and Walk at 10:50 (RemindersUITests.swift).
button('Seed reminders paused', () =>
  seed(platform.db, [], [], {
    more: async (w, s) => {
      const zone = systemClock.zone();
      await blockAt(w, s, 'Proof the loaf', 580, 660, { started_at: localToInstant(s.on, 580, zone), paused_at: localToInstant(s.on, 590, zone) });
      await practiceAt(w, s, 'Stretch', 630, 645);
      await practiceAt(w, s, 'Walk', 650, 660);
    },
  }),
);
// Planning next week, with this week and the stretch planned: two picks waiting for it, a practice whose Monday session
// is already placed, and one item in the Inbox. Next week's days are all ahead whatever weekday the clock lands on. The
// block in two hours brings the notification question at launch, before any test step it could cover
// (PlanningUITests.swift).
button('Seed planning next week', () =>
  seed(platform.db, [{ title: 'Feed the starter', from: 120, to: 150 }], [], {
    unplanned: true,
    more: async (w, s) => {
      const week = thisWeek(systemClock);
      const next = addWeeks(week, 1);
      const zone = systemClock.zone();
      await updateSettings(w, { plan_stretch: { last_planned: nextStretch(await getSettings(w.sql), s.on).start } });
      await w.create('week_plan', { week_start: week, finished_at: nowInstant(systemClock) }, weekPlanId(week));
      for (const [title, minutes] of [
        ['Mix the dough', 120],
        ['Shape the loaf', 60],
      ] as const) {
        const task = await w.create('task', { kind: 'project', project_id: s.project, milestone_id: s.milestone, title, estimate_min: minutes });
        await setWeekPick(w, next, task, minutes);
      }
      const practice = await w.create('practice', { title: 'Morning stretch', target_min: 30, per: 'day', days: [0], preferred_times: [420], state: 'active' });
      await w.create('time_block', { practice_id: practice, start: localToInstant(next, 420, zone), end: localToInstant(next, 450, zone), tz: zone });
      await w.create('task', { kind: 'inbox', title: 'Buy rye flour' });
    },
  }),
);
// Every six weeks from a week ago, with this stretch planned: the next runs from 35 to 76 days out and isn't due to plan
// yet, on any date. Shape the first loaf falls inside it, and Share a loaf after it, before its project ends
// (PlanningUITests.swift).
button('Seed planning stretch', () =>
  seed(platform.db, [], [], {
    more: async (w, s) => {
      const anchor = addDays(s.on, -7);
      await updateSettings(w, { plan_cadence: { every: 6, unit: 'weeks', anchor }, plan_stretch: { last_planned: anchor } });
      await w.create('milestone', { project_id: s.project, title: 'Shape the first loaf', due: addDays(s.on, 50), added_on: s.on });
      await w.create('milestone', { project_id: s.project, title: 'Share a loaf', due: addDays(s.on, 83), added_on: s.on });
    },
  }),
);
// Nothing planned, neither this week nor any stretch. The block in two hours brings the notification question at launch
// (PlanningUITests.swift).
button('Seed planning nothing planned', () => seed(platform.db, [{ title: 'Feed the starter', from: 120, to: 150 }], [], { unplanned: true }));
// Today and Week on what the app synced, for the history-scale test (scripts/test-history.sh).
button('History', async () => `history:${JSON.stringify(await timeHistoryQueries(platform.db))}`);
log('ready');
// On the app's console too, where scripts/test-ios.sh waits for it as it warms up a new Simulator.
console.info('native-checks ready');
