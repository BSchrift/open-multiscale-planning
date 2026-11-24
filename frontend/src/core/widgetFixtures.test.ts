// The contract between the app and the iPhone widgets: JSON both sides test against, so neither can drift. This builds
// each fixture from the app's own code and checks it matches the files in the Swift package's Tests/Fixtures, which
// the Swift tests decode (frontend/ios/App/MultiscaleWidgets, FixtureTests.swift). After a deliberate change, rewrite
// them with UPDATE_WIDGET_FIXTURES=1 npx vitest run src/core/widgetFixtures.test.ts, then run swift test there.
//
//   snapshots/<name>.json  a snapshot as the app writes it, for each state the spec draws
//   states.json            for each snapshot, what the widget should show at moments through the two days, from the
//                          app's own currentBlock and nextBlock
//   actions/<kind>.json    a queued action as an intent writes it, which the app must read
//   overlays.json          a snapshot and the actions queued on it, and the blocks as the app leaves them once applied:
//                          what the widget shows straight after a tap, before the app has opened
//   times.json             times of day as the app writes them, which the widgets must write the same way

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentBlock, nextBlock } from './blocks';
import { fixedClock } from './clock';
import { formatTime, localDate, today } from './dates';
import type { BlockRow } from './queries';
import { transact } from './records';
import { nodeSqliteDriver } from '../platform/node-sqlite';
import { pst, SCENARIO_AT, widgetScenario, ZONE } from './widget-testing';
import type { WidgetScenario } from './widget-testing';
import { applyWidgetAction, parseWidgetAction, recentStarts, recordOutcome } from './widgetActions';
import type { AppliedWidgetAction, WidgetAction } from './widgetActions';
import { buildWidgetSnapshot, loadWidgetData } from './widgetSnapshot';
import type { WidgetData, WidgetSnapshot } from './widgetSnapshot';

const DIR = join(import.meta.dirname, '../../ios/App/MultiscaleWidgets/Sources/WidgetTestSupport/Fixtures');
const UPDATE = process.env.UPDATE_WIDGET_FIXTURES === '1';

/** Writes the fixture when asked to, and otherwise checks the committed one is what the app makes now. */
function fixture(path: string, value: unknown) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const file = join(DIR, path);
  if (UPDATE) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
    return;
  }
  let committed: string;
  try {
    committed = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`${path} is missing. Write it with UPDATE_WIDGET_FIXTURES=1, then run swift test.`);
  }
  expect(JSON.parse(committed), `${path} differs from what the app writes. Rewrite with UPDATE_WIDGET_FIXTURES=1, then run swift test.`).toEqual(value);
}

const ACTION_ID = (at: string, n: number) => `${Date.parse(at)}-6F9619FF-8B86-4011-B42D-00C04FC964${String(n).padStart(2, '0')}.json`;

async function scenario(name: WidgetScenario, change: (d: WidgetData) => WidgetData = (d) => d) {
  const t = await widgetScenario(name, nodeSqliteDriver());
  const snapshot = buildWidgetSnapshot(change(await loadWidgetData(t.db, t.clock)), { clock: t.clock });
  return { ...t, snapshot, change };
}

/** The blocks of a snapshot as the app's rows, for its own currentBlock and nextBlock. */
const rowsOf = (s: WidgetSnapshot): BlockRow[] =>
  s.blocks.map((b) => ({
    id: b.id,
    start: b.start,
    end: b.end,
    tz: s.zone,
    task_id: null,
    practice_id: null,
    started_at: b.startedAt,
    ended_at: b.endedAt,
    paused_at: b.pausedAt,
    paused_min: b.pausedMin,
    title: b.title,
    task_kind: null,
    result: b.answer,
  }));

/** What a widget shows at a moment, as the spec defines its states. */
function stateAt(s: WidgetSnapshot, at: string) {
  if (!s.signedIn) return { at, mode: 'signedOut', current: null, next: null };
  const clock = fixedClock(at, s.zone);
  const rows = rowsOf(s);
  const day = today(clock);
  const cur = currentBlock(rows, clock);
  const next = nextBlock(rows.filter((b) => b.id !== cur?.id), clock);
  const nextToday = next && localDate(next.start, s.zone) === day ? next : undefined;
  const mode = cur
    ? cur.started_at
      ? cur.paused_at
        ? 'paused'
        : 'now'
      : 'start'
    : nextToday
      ? 'free'
      : rows.some((b) => localDate(b.start, s.zone) === day)
        ? 'finished'
        : 'empty';
  return { at, mode, current: cur?.id ?? null, next: next?.id ?? null };
}

/** Through both days: the scenario's own moment, either side of each block's start and end, and either side of midnight. */
function moments(s: WidgetSnapshot, own: string): string[] {
  const edges = s.blocks.flatMap((b) => [b.start, b.end]).flatMap((t) => [new Date(Date.parse(t) - 1000).toISOString().replace('.000Z', 'Z'), t]);
  return [...new Set([own, ...edges, pst('23:59'), pst('0:00', 19), pst('23:59', 19)])].sort();
}

describe('the widget contract fixtures', () => {
  it('hold a snapshot for each state, and what the widget shows at moments through the day', async () => {
    const acme = { name: 'Acme work', encrypted: true };
    const states: Record<string, ReturnType<typeof stateAt>[]> = {};
    const all: [string, WidgetSnapshot, string][] = [];
    for (const name of Object.keys(SCENARIO_AT) as WidgetScenario[]) {
      const { snapshot } = await scenario(name);
      all.push([name, snapshot, SCENARIO_AT[name]]);
    }
    const encrypted = await scenario('now', (d) => ({ ...d, blocks: d.blocks.map((b) => (b.id === 'spec' ? { ...b, space: acme } : b)) }));
    all.push(['encrypted', encrypted.snapshot, SCENARIO_AT.now]);
    const inbox = await scenario('now', (d) => ({ ...d, inbox: 4 }));
    all.push(['inbox', inbox.snapshot, SCENARIO_AT.now]);
    for (const [name, snapshot, at] of all) {
      fixture(`snapshots/${name}.json`, snapshot);
      states[name] = moments(snapshot, at).map((m) => stateAt(snapshot, m));
    }
    // From a release that writes a version this widget doesn't know.
    fixture('snapshots/newer.json', { ...all[0]![1], v: 2 });
    fixture('states.json', states);
    // The spec's own moments land in the states it draws them in.
    expect(Object.fromEntries(all.map(([name, , at]) => [name, states[name]!.find((s) => s.at === at)!.mode]))).toEqual({
      now: 'now',
      start: 'start',
      paused: 'paused',
      next: 'free',
      empty: 'empty',
      finished: 'finished',
      signedout: 'signedOut',
      stale: 'now',
      encrypted: 'now',
      inbox: 'now',
    });
  });

  it('hold each action an intent writes, which the app reads back', () => {
    const block = (s: string) => ({ blockId: s, rev: 'a1b2c3d4' });
    const actions: WidgetAction[] = [
      { v: 1, id: ACTION_ID(pst('9:06'), 1), kind: 'start', ...block('spec'), at: pst('9:06'), target: null },
      { v: 1, id: ACTION_ID('2026-11-18T18:48:30Z', 2), kind: 'startEarly', ...block('dentist'), at: '2026-11-18T18:48:30Z', target: null },
      { v: 1, id: ACTION_ID(pst('9:52'), 3), kind: 'pause', ...block('spec'), at: pst('9:52'), target: null },
      { v: 1, id: ACTION_ID(pst('10:04'), 4), kind: 'resume', ...block('spec'), at: pst('10:04'), target: null },
      { v: 1, id: ACTION_ID(pst('9:08'), 5), kind: 'undo', ...block('spec'), at: pst('9:08'), target: ACTION_ID(pst('9:06'), 1) },
    ];
    for (const action of actions) {
      fixture(`actions/${action.kind}.json`, action);
      expect(parseWidgetAction(action.id, JSON.stringify(action))).toEqual(action);
    }
  });

  it('hold what each tap leaves, as the app applies it', async () => {
    const overlays = [];
    const cases: { name: string; scenario: WidgetScenario; taps: [WidgetAction['kind'], string, string][] }[] = [
      { name: 'start', scenario: 'start', taps: [['start', 'spec', pst('9:06')]] },
      { name: 'startEarly', scenario: 'next', taps: [['startEarly', 'dentist', '2026-11-18T18:48:30Z']] },
      { name: 'pause', scenario: 'now', taps: [['pause', 'spec', pst('9:52')]] },
      { name: 'resume', scenario: 'paused', taps: [['resume', 'spec', '2026-11-18T18:04:29Z']] },
      { name: 'startPauseResume', scenario: 'start', taps: [['start', 'spec', pst('9:06')], ['pause', 'spec', pst('9:30')], ['resume', 'spec', '2026-11-18T17:40:31Z']] },
      { name: 'startEarlyThenPause', scenario: 'next', taps: [['startEarly', 'dentist', '2026-11-18T18:48:30Z'], ['pause', 'dentist', pst('10:55')]] },
      { name: 'pauseAfterEnd', scenario: 'now', taps: [['pause', 'spec', pst('10:31')]] },
    ];
    let n = 10;
    for (const c of cases) {
      const t = await scenario(c.scenario);
      const actions = c.taps.map(([kind, blockId, at]): WidgetAction => ({
        v: 1,
        id: ACTION_ID(at, n++),
        kind,
        blockId,
        rev: t.snapshot.blocks.find((b) => b.id === blockId)!.rev,
        at,
        target: null,
      }));
      let history: AppliedWidgetAction[] = [];
      const last = c.taps[c.taps.length - 1]![2];
      await transact(t.db, t.clock, async (w) => {
        for (const a of actions) history = recordOutcome(history, await applyWidgetAction(w, a, history, ZONE), Date.parse(last));
      });
      const after = buildWidgetSnapshot(await loadWidgetData(t.db, t.clock), { clock: fixedClock(last, ZONE), fromWidget: recentStarts(history, Date.parse(last)) });
      const fields = (s: WidgetSnapshot) => s.blocks.map(({ id, start, end, startedAt, pausedAt, pausedMin }) => ({ id, start, end, startedAt, pausedAt, pausedMin }));
      overlays.push({
        name: c.name,
        snapshot: c.scenario,
        actions,
        blocks: fields(after),
        fromWidget: after.fromWidget.map(({ kind, blockId, at, before }) => ({ kind, blockId, at, before })),
      });
    }
    fixture('overlays.json', overlays);
  });

  it('hold times of day as the app writes them', () => {
    const instants = ['0:00', '0:30', '9:00', '9:06', '10:30', '11:59', '12:00', '12:05', '13:00', '17:30', '23:59'].map((t) => pst(t));
    const zones = [ZONE, 'Europe/London', 'Asia/Kolkata', 'Australia/Lord_Howe'];
    fixture(
      'times.json',
      zones.flatMap((zone) => instants.map((instant) => ({ instant, zone, text: formatTime(instant, zone) }))),
    );
  });
});
