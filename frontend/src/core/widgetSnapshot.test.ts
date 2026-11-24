import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock';
import { META, setMeta } from './db';
import { nodeSqliteDriver } from '../platform/node-sqlite';
import { outcomeId, transact, updateSettings, weekPlanId } from './records';
import type { Writer } from './records';
import { pst, widgetScenario, ZONE } from './widget-testing';
import type { WidgetScenario } from './widget-testing';
import {
  blockRev,
  buildWidgetSnapshot,
  loadWidgetData,
  WIDGET_MAX_AIMS,
  WIDGET_MAX_BLOCKS,
  WIDGET_MAX_PRACTICES,
  WIDGET_SNAPSHOT_MAX_BYTES,
  WIDGET_TITLE_MAX,
  widgetSnapshotBytes,
} from './widgetSnapshot';
import type { WidgetData, WidgetSnapshot } from './widgetSnapshot';

async function snapshotOf(name: WidgetScenario, change: (data: WidgetData) => WidgetData = (d) => d): Promise<WidgetSnapshot> {
  const { db, clock } = await widgetScenario(name, nodeSqliteDriver());
  return buildWidgetSnapshot(change(await loadWidgetData(db, clock)), { clock });
}

const block = (s: WidgetSnapshot, id: string) => s.blocks.find((b) => b.id === id)!;

describe('the widget snapshot', () => {
  it('holds today and tomorrow, by start, with each block as the widget draws it', async () => {
    const s = await snapshotOf('now');
    expect(s).toMatchObject({ v: 1, writtenAt: pst('10:04'), syncedAt: pst('10:04'), zone: ZONE, signedIn: true, inbox: { count: 0 }, fromWidget: [] });
    expect(s.days).toEqual([
      { date: '2026-11-18', weekPlanned: true },
      { date: '2026-11-19', weekPlanned: true },
    ]);
    expect(s.blocks.map((b) => [b.id, b.kind, b.title])).toEqual([
      ['run', 'practice', 'Run'],
      ['spec', 'project', 'Write widget spec'],
      ['dentist', 'oneoff', 'Call the dentist'],
      ['prs', 'project', 'Review pull requests'],
      ['piano', 'practice', 'Piano'],
      ['notes', 'project', 'Draft release notes'],
    ]);
    expect(block(s, 'run')).toMatchObject({ answer: 'done', startedAt: null });
    expect(block(s, 'spec')).toEqual({
      id: 'spec',
      rev: expect.stringMatching(/^[0-9a-f]{8}$/),
      start: pst('9:00'),
      end: pst('10:30'),
      kind: 'project',
      title: 'Write widget spec',
      space: null,
      startedAt: '2026-11-18T17:00:41Z',
      pausedAt: null,
      pausedMin: null,
      endedAt: null,
      answer: null,
    });
    expect(s.events).toEqual([{ start: pst('10:30'), end: pst('10:45'), title: 'Standup' }]);
  });

  it('marks the block whose time has come but which hasn’t started', async () => {
    const s = await snapshotOf('start');
    expect(block(s, 'spec')).toMatchObject({ startedAt: null, pausedAt: null, answer: null });
  });

  it('carries a pause under way, so the widget can stop the countdown where it stopped', async () => {
    const s = await snapshotOf('paused');
    expect(block(s, 'spec')).toMatchObject({ startedAt: '2026-11-18T17:00:41Z', pausedAt: pst('9:52'), pausedMin: null });
  });

  it('carries answers, so the next block and the day’s tallies can be worked out at any moment', async () => {
    expect(block(await snapshotOf('next'), 'spec').answer).toBe('done');
    const s = await snapshotOf('finished');
    expect(s.blocks.filter((b) => b.start < pst('0:00', 19)).map((b) => [b.id, b.answer])).toEqual([
      ['run', 'done'],
      ['spec', 'done'],
      ['dentist', 'not'],
      ['prs', 'partly'],
      ['piano', null],
    ]);
  });

  it('says when nothing is planned and the week isn’t either', async () => {
    const s = await snapshotOf('empty');
    expect(s.blocks).toEqual([]);
    expect(s.days.map((d) => d.weekPlanned)).toEqual([false, false]);
  });

  it('keeps nothing of the account once signed out, so the widgets ask to sign in', async () => {
    const s = await snapshotOf('signedout');
    expect(s).toEqual({ v: 1, writtenAt: pst('10:04'), syncedAt: null, zone: ZONE, signedIn: false, days: [], blocks: [], events: [], inbox: null, fromWidget: [] });
  });

  it('shows the plan of a device that never signed in, though its syncs, finding no sign-in, say it’s signed out', async () => {
    const { db, clock } = await widgetScenario('now', nodeSqliteDriver());
    await setMeta(db, META.lastSyncError, 'sign_in_expired');
    const s = buildWidgetSnapshot(await loadWidgetData(db, clock), { clock });
    expect(s.signedIn).toBe(true);
    expect(s.blocks).toHaveLength(6);
  });

  it('asks to sign in once the account this device holds is deleted', async () => {
    const { db, clock } = await widgetScenario('now', nodeSqliteDriver());
    await setMeta(db, META.lastSyncError, 'account_deleted');
    expect(buildWidgetSnapshot(await loadWidgetData(db, clock), { clock }).signedIn).toBe(false);
  });

  it('carries the last sync, so a widget can say it’s behind', async () => {
    expect((await snapshotOf('stale')).syncedAt).toBe(pst('7:58'));
  });

  it('shows a plan made on a device that never signed in', async () => {
    const { db, clock } = await widgetScenario('now', nodeSqliteDriver());
    await db.run("DELETE FROM meta WHERE key = 'last_sync_at'");
    const s = buildWidgetSnapshot(await loadWidgetData(db, clock), { clock });
    expect(s.signedIn).toBe(true);
    expect(s.syncedAt).toBeNull();
    expect(s.blocks).toHaveLength(6);
  });

  it('counts the Inbox', async () => {
    const { db, clock } = await widgetScenario('now', nodeSqliteDriver());
    const data = await loadWidgetData(db, clock);
    expect(buildWidgetSnapshot({ ...data, inbox: 4 }, { clock }).inbox).toEqual({ count: 4 });
  });
});

describe('the week in the widget snapshot', () => {
  /** The scenario's database, changed first, as This week would see it. */
  async function weekOf(name: WidgetScenario, edit?: (w: Writer) => Promise<unknown>, change: (d: WidgetData) => WidgetData = (d) => d) {
    const { db, clock } = await widgetScenario(name, nodeSqliteDriver());
    if (edit) await transact(db, clock, edit);
    return buildWidgetSnapshot(change(await loadWidgetData(db, clock)), { clock }).week!;
  }

  it('holds what This week draws: each day’s planned time, the aims with their pills, and the practices’ sessions', async () => {
    expect(await weekOf('now')).toEqual({
      start: '2026-11-16',
      plannedMinutes: [255, 105, 240, 60, 0, 60, 0],
      aims: [
        { name: 'Garden', space: null, kind: 'project', plannedMinutes: 60, aimMinutes: 120, status: { pill: 'Behind', tone: 'amber' } },
        { name: 'Multiscale', space: null, kind: 'project', plannedMinutes: 450, aimMinutes: 480, status: { pill: 'On track', tone: 'green' } },
        { name: 'One offs', space: null, kind: 'oneoff', plannedMinutes: 60, aimMinutes: 120, status: null },
      ],
      practices: [
        { name: 'Piano', space: null, done: 1, of: 2 },
        { name: 'Run', space: null, done: 2, of: 3 },
      ],
    });
  });

  it('is the same week whatever the moment in it, and says so for a week with nothing in it', async () => {
    expect(await weekOf('finished')).toEqual(await weekOf('now'));
    expect(await weekOf('empty')).toEqual({ start: '2026-11-16', plannedMinutes: [0, 0, 0, 0, 0, 0, 0], aims: [], practices: [] });
  });

  it('counts blocks only, by the day each part falls on, leaving out planning and other calendars', async () => {
    const week = await weekOf('now', async (w) => {
      await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 16', plans: ['week:2026-11-16'] }, 'planning-task');
      await w.create('time_block', { task_id: 'planning-task', start: pst('8:00', 20), end: pst('8:30', 20), tz: ZONE }, 'planning');
      // Friday 11pm to Saturday 1am: an hour on each.
      await w.create('time_block', { task_id: 'spec-task', start: pst('23:00', 20), end: pst('1:00', 21), tz: ZONE }, 'late');
      // Sunday 11pm into next Monday: only Sunday's hour is this week's.
      await w.create('time_block', { task_id: 'spec-task', start: pst('23:00', 22), end: pst('1:00', 23), tz: ZONE }, 'sunday');
      await w.create('time_block', { task_id: 'spec-task', start: pst('9:00', 23), end: pst('10:00', 23), tz: ZONE }, 'next-week');
      await w.set('time_block', 'prs', { cancelled: true });
    });
    expect(week.plannedMinutes).toEqual([255, 105, 180, 60, 60, 120, 60]);
    expect(week.aims.find((a) => a.name === 'Multiscale')!.plannedMinutes).toBe(450 - 60 + 180);
  });

  it('counts a practice’s sessions answered Done or Partly, not those not done or still to answer', async () => {
    const week = await weekOf('finished', async (w) => {
      await w.create('block_outcome', { result: 'not', answered_at: pst('18:01') }, outcomeId('piano'));
      await w.create('time_block', { practice_id: 'run-practice', start: pst('7:00', 20), end: pst('7:45', 20), tz: ZONE }, 'run-fri');
    });
    expect(week.practices).toEqual([
      { name: 'Piano', space: null, done: 1, of: 2 },
      { name: 'Run', space: null, done: 2, of: 3 },
    ]);
  });

  it('gives a daily practice a session for each of its days, and leaves out practices skipped, paused or ended', async () => {
    const week = await weekOf('now', async (w) => {
      await w.create('practice', { title: 'Stretch', target_min: 10, per: 'day', days: [0, 2, 4], state: 'active' }, 'stretch');
      await w.create('practice', { title: 'Guitar', target_min: 60, per: 'week', state: 'paused' }, 'guitar');
      await w.create('practice', { title: 'Swim', target_min: 60, per: 'week', state: 'ended' }, 'swim');
      await w.create('practice', { title: 'Read', target_min: 60, per: 'week', state: 'active' }, 'read');
      await w.set('week_plan', weekPlanId('2026-11-16'), { skipped_practices: ['read'] });
    });
    expect(week.practices.map((p) => [p.name, p.done, p.of])).toEqual([
      ['Piano', 1, 2],
      ['Run', 2, 3],
      ['Stretch', 0, 3],
    ]);
  });

  it('shows an aim only when there is one this week: none set, skipped this week, or on a project not under way', async () => {
    const week = await weekOf('now', async (w) => {
      await w.create('project', { title: 'Taxes', state: 'active', start: '2026-11-01', end: '2026-12-31' }, 'taxes');
      await w.create('project', { title: 'Kitchen', state: 'paused', start: '2026-11-01', end: '2026-12-31', weekly_aim: 120 }, 'kitchen');
      await w.create('project', { title: 'Next year', state: 'active', start: '2027-01-04', end: '2027-03-31', weekly_aim: 120 }, 'later');
      await w.set('week_plan', weekPlanId('2026-11-16'), { skipped_aims: ['garden'], aims: { multiscale: 600 } });
      await updateSettings(w, { one_offs_weekly_aim: null });
    });
    expect(week.aims).toEqual([{ name: 'Multiscale', space: null, kind: 'project', plannedMinutes: 450, aimMinutes: 600, status: { pill: 'On track', tone: 'green' } }]);
  });

  it('has none once signed out, as nothing else of the account stays', async () => {
    const { db, clock } = await widgetScenario('signedout', nodeSqliteDriver());
    expect(buildWidgetSnapshot(await loadWidgetData(db, clock), { clock })).not.toHaveProperty('week');
  });

  it('cuts names to 120 characters, and keeps the first aims and practices', async () => {
    const long = '😀'.repeat(200);
    const week = await weekOf('now', undefined, (d) => ({
      ...d,
      week: d.week && {
        ...d.week,
        aims: Array.from({ length: 30 }, (_, i) => ({ ...d.week!.aims[0]!, name: long, plannedMinutes: i })),
        practices: Array.from({ length: 30 }, (_, i) => ({ ...d.week!.practices[0]!, name: long, done: i })),
      },
    }));
    expect(week.aims.map((a) => a.plannedMinutes)).toEqual(Array.from({ length: WIDGET_MAX_AIMS }, (_, i) => i));
    expect(week.practices.map((p) => p.done)).toEqual(Array.from({ length: WIDGET_MAX_PRACTICES }, (_, i) => i));
    expect(week.aims[0]!.name).toBe('😀'.repeat(WIDGET_TITLE_MAX));
    expect(week.practices[0]!.name).toBe('😀'.repeat(WIDGET_TITLE_MAX));
  });
});

describe('privacy in the widget snapshot', () => {
  const acme = { name: 'Acme work', encrypted: true };
  const inAcme = (d: WidgetData): WidgetData => ({
    ...d,
    blocks: d.blocks.map((b) => (b.id === 'spec' ? { ...b, space: acme } : b)),
    events: d.events.map((e) => ({ ...e, space: acme })),
  });

  it('never holds the name of a task in an encrypted space, only the space’s', async () => {
    const s = await snapshotOf('now', inAcme);
    expect(block(s, 'spec')).toMatchObject({ title: null, space: acme });
    expect(s.events[0]!.title).toBeNull();
    const json = JSON.stringify(s);
    expect(json).not.toContain('Write widget spec');
    expect(json).not.toContain('Standup');
  });

  it('never holds the name of a project or practice in an encrypted space, in This week’s aims and practices', async () => {
    const s = await snapshotOf('now', (d) => ({
      ...d,
      week: d.week && {
        ...d.week,
        aims: d.week.aims.map((a) => (a.name === 'Multiscale' ? { ...a, space: acme } : a)),
        practices: d.week.practices.map((p) => (p.name === 'Run' ? { ...p, space: acme } : p)),
      },
    }));
    expect(s.week!.aims.find((a) => a.plannedMinutes === 450)).toMatchObject({ name: null, space: acme, aimMinutes: 480, status: { pill: 'On track' } });
    expect(s.week!.practices.find((p) => p.of === 3)).toMatchObject({ name: null, space: acme, done: 2 });
    expect(s.week!.aims.find((a) => a.plannedMinutes === 60 && a.kind === 'project')).toMatchObject({ name: 'Garden', space: null });
    const json = JSON.stringify(s.week);
    expect(json).not.toContain('Multiscale');
    expect(json).not.toContain('Run');
  });

  it('keeps the names in a space that isn’t encrypted', async () => {
    const s = await snapshotOf('now', (d) => ({ ...d, blocks: d.blocks.map((b) => (b.id === 'spec' ? { ...b, space: { name: 'Home', encrypted: false } } : b)) }));
    expect(block(s, 'spec')).toMatchObject({ title: 'Write widget spec', space: { name: 'Home', encrypted: false } });
  });

  it('holds only times, states, counts and names: no notes, descriptions or other free text', async () => {
    const s = await snapshotOf('now');
    const keys = new Set<string>();
    const walk = (v: unknown, path: string) => {
      if (Array.isArray(v)) v.forEach((x) => walk(x, `${path}[]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
      else if (typeof v === 'string') keys.add(path);
    };
    walk(s, '');
    // The Lock Screen shows these behind privacySensitive(), so iOS can hide them (WidgetText in the Swift package).
    // A status pill and its tone are the app's fixed words ("On track", "amber"), not anyone's text.
    const names = [...keys].filter((k) => !/(At|^start|\.start|\.end|^zone|\.rev|\.id|\.kind|\.date|\.answer|\.pill|\.tone)$/.test(k));
    expect(names.sort()).toEqual(['blocks[].title', 'events[].title', 'week.aims[].name', 'week.practices[].name']);
  });
});

describe('the widget snapshot’s size', () => {
  it('cuts titles to 120 characters without splitting one', async () => {
    const long = '😀'.repeat(200);
    const s = await snapshotOf('now', (d) => ({ ...d, blocks: d.blocks.map((b) => ({ ...b, title: long })) }));
    expect(Array.from(block(s, 'spec').title!)).toHaveLength(WIDGET_TITLE_MAX);
    expect(block(s, 'spec').title).toBe('😀'.repeat(WIDGET_TITLE_MAX));
  });

  it('keeps at most 60 blocks, the earliest, and stays under 64 KB at the longest titles', async () => {
    const { db, clock } = await widgetScenario('now', nodeSqliteDriver());
    const data = await loadWidgetData(db, clock);
    const many = Array.from({ length: 80 }, (_, i) => ({
      ...data.blocks[1]!,
      id: `b${String(i).padStart(2, '0')}`,
      start: new Date(Date.parse(pst('0:00')) + i * 60_000).toISOString().replace('.000Z', 'Z'),
      title: '𝔸'.repeat(500),
    }));
    const events = Array.from({ length: 80 }, (_, i) => ({ ...data.events[0]!, id: `e${i}`, title: '𝔹'.repeat(500) }));
    const s = buildWidgetSnapshot({ ...data, blocks: many, events }, { clock });
    expect(s.blocks.length).toBeLessThanOrEqual(WIDGET_MAX_BLOCKS);
    expect(s.blocks[0]!.id).toBe('b00');
    expect(widgetSnapshotBytes(s)).toBeLessThanOrEqual(WIDGET_SNAPSHOT_MAX_BYTES);
  });
});

describe('a block’s rev', () => {
  const row = {
    id: 'b',
    start: pst('9:00'),
    end: pst('10:00'),
    tz: ZONE,
    task_id: 't',
    practice_id: null,
    started_at: null,
    ended_at: null,
    title: 'x',
    task_kind: 'project' as const,
    result: null,
  };

  it('changes with anything a widget button depends on, and not with the title', () => {
    const base = blockRev(row);
    expect(blockRev({ ...row, title: 'y' })).toBe(base);
    for (const change of [{ start: pst('9:05') }, { end: pst('10:05') }, { started_at: pst('9:00') }, { paused_at: pst('9:30') }, { paused_min: 3 }, { ended_at: pst('9:40') }, { result: 'done' as const }, { task_id: 'u' }]) {
      expect(blockRev({ ...row, ...change })).not.toBe(base);
    }
  });
});

describe('starts from the widget', () => {
  it('stay in the snapshot while Undo is offered and the block is still started as the widget started it', async () => {
    const { db, clock } = await widgetScenario('now', nodeSqliteDriver());
    const data = await loadWidgetData(db, clock);
    const recent = { id: '1795111241000-6F9619FF-8B86-D011-B42D-00C04FC964FF.json', kind: 'start' as const, blockId: 'spec', at: '2026-11-18T17:00:41Z', before: null };
    const at = (time: string) => buildWidgetSnapshot(data, { clock: fixedClock(time, ZONE), fromWidget: [recent] }).fromWidget;
    expect(at('2026-11-18T17:04:00Z')).toEqual([recent]);
    expect(at('2026-11-18T17:05:41Z')).toEqual([]);
    expect(buildWidgetSnapshot(data, { clock: fixedClock('2026-11-18T17:04:00Z', ZONE), fromWidget: [{ ...recent, at: '2026-11-18T17:00:00Z' }] }).fromWidget).toEqual([]);
  });
});
