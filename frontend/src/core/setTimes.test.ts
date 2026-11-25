import { describe, expect, it } from 'vitest';
import { placeWeekPractices, removeBlock } from './blocks';
import { fixedClock, parseClock } from './clock';
import { blockMinutes } from './dates';
import type { Db } from './db';
import { applyPlanChange } from './plan';
import { CALENDAR_ID, getRecord, listRecords, SETTINGS_ID, transact, weekPlanId } from './records';
import type { Writer } from './records';
import {
  addAwayDates,
  atSetTime,
  awayMessage,
  followMessage,
  followOneOff,
  followSetTimes,
  oneOffWhy,
  pausedMessage,
  pausePractice,
  placedMessage,
  placeSetTimes,
  resumedMessage,
  resumePractice,
  setTimeFit,
  setTimesDays,
  whySaid,
} from './setTimes';
import type { SetTimeWhy } from './setTimes';
import { practicesLeft, slotContext } from './slots';
import { runSync } from './sync';
import { fakeSyncServer } from './sync-testing';
import { resetWeek } from './weekReset';
import type { Fields, Practice } from './types';
import { openTestDb } from '../platform/node-sqlite';

// Next week is Nov 30 to Dec 6. Its planning appears on Friday Nov 27, PLANNING_LEAD_DAYS before it starts.
const NEXT = '2026-11-30';
const THU = '2026-11-26T05:00:00Z';
const FRI = '2026-11-27T05:00:00Z';
const at = (date: string, time: string) => `${date}T${time}:00Z`;

const run: Fields<'practice'> = { title: 'Morning run', target_min: 30, per: 'day', days: [0, 1, 2, 3, 4], preferred_times: [7 * 60], state: 'active' };
const piano: Fields<'practice'> = { title: 'Piano practice', target_min: 45, per: 'day', days: [0, 2, 4], preferred_times: [18 * 60], state: 'active' };

async function setup(now = FRI, seed: (w: Writer) => Promise<unknown> = async () => undefined, zone = 'UTC') {
  const clock = fixedClock(now, zone);
  const db = await openTestDb();
  await transact(db, clock, async (w) => {
    await w.create('practice', run, 'run');
    await seed(w);
  });
  return {
    db,
    clock,
    run: <R>(fn: (w: Writer) => Promise<R>) => transact(db, clock, fn),
    place: () => transact(db, clock, (w) => placeSetTimes(w.automatic, clock)),
    /** Live sessions, as [id, start, end]. */
    sessions: async (practice = 'run') =>
      (await listRecords(db, 'time_block'))
        .filter((b) => b.practice_id === practice && !b.cancelled)
        .map((b) => [b.id, b.start, b.end])
        .sort((a, b) => a[1]!.localeCompare(b[1]!)),
  };
}

const dentist = (start = at('2026-12-03', '06:45'), end = at('2026-12-03', '08:00')) => (w: Writer) =>
  w.create('calendar', { connected: true, events: [{ id: 'e1', calendar: 'primary', title: 'Dentist', start, end }] }, CALENDAR_ID);

const fieldClocks = async (db: Db, id: string) =>
  JSON.parse((await db.get<{ clocks: string }>('SELECT clocks FROM records WHERE id = :id', { id }))!.clocks) as Record<string, string>;

describe('which days are placed', () => {
  it('is today to the end of this week, and next week from when its planning appears', () => {
    expect(setTimesDays(fixedClock(THU))).toEqual(['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']);
    expect(setTimesDays(fixedClock(FRI))).toHaveLength(10);
    expect(setTimesDays(fixedClock(FRI)).at(-1)).toBe('2026-12-06');
  });
});

describe('placing practices at their set times', () => {
  it('places each set day at its time, under the day id, with the lowest clocks', async () => {
    const t = await setup();
    const done = await t.place();
    // Friday Nov 27 itself, then next week's weekdays.
    expect((await t.sessions()).map((s) => s[0])).toEqual([
      'session:run:2026-11-27',
      'session:run:2026-11-30',
      'session:run:2026-12-01',
      'session:run:2026-12-02',
      'session:run:2026-12-03',
      'session:run:2026-12-04',
    ]);
    expect((await t.sessions())[1]).toEqual(['session:run:2026-11-30', at('2026-11-30', '07:00'), at('2026-11-30', '07:30')]);
    for (const clock of Object.values(await fieldClocks(t.db, 'session:run:2026-11-30'))) expect(parseClock(clock)).toMatchObject({ wall: 0, counter: 0 });
    expect(placedMessage(done.placed, t.clock)).toBe('Placed 6 practice sessions at their set times this week and next.');
  });

  it('leaves next week alone until its planning appears', async () => {
    const t = await setup(THU);
    await t.place();
    expect((await t.sessions()).map((s) => s[0])).toEqual(['session:run:2026-11-26', 'session:run:2026-11-27']);
  });

  it('never fills in a time that has passed, and says so', async () => {
    const t = await setup(at('2026-11-27', '07:10'));
    await t.place();
    expect((await t.sessions())[0]![0]).toBe('session:run:2026-11-30');
    const ctx = await context(t, '2026-11-23');
    expect(setTimeFit(await practice(t), '2026-11-27', ctx)).toEqual({ time: 420, why: 'has passed' });
  });

  it('places nothing for a counted practice, one at any time, a paused or ended one, or one skipped this week', async () => {
    const t = await setup(FRI, async (w) => {
      await w.create('practice', { title: 'Stretching', target_min: 60, per: 'week', sessions: 3, days: [0, 2, 4], preferred_times: [8 * 60], state: 'active' }, 'stretch');
      await w.create('practice', { title: 'Sketch', target_min: 30, per: 'day', preferred_times: [], state: 'active' }, 'sketch');
      await w.create('practice', { ...piano, state: 'paused' }, 'paused');
      await w.create('practice', { ...piano, state: 'ended' }, 'ended');
      await w.create('practice', piano, 'piano');
      await w.create('week_plan', { week_start: NEXT, skipped_practices: ['piano'], skipped_sessions: ['run:2026-12-01'] }, weekPlanId(NEXT));
    });
    await t.place();
    const placed = (await listRecords(t.db, 'time_block')).map((b) => b.practice_id);
    expect(new Set(placed)).toEqual(new Set(['run', 'piano']));
    // Piano's Friday this week only, as next week skips it; Morning run's Tuesday is skipped.
    expect((await t.sessions('piano')).map((s) => s[0])).toEqual(['session:piano:2026-11-27']);
    expect((await t.sessions()).map((s) => s[0])).not.toContain('session:run:2026-12-01');
  });

  it('uses a day its own time', async () => {
    const t = await setup(FRI, (w) => w.set('practice', 'run', { day_times: [null, null, null, 9 * 60, null, null, null] }));
    await t.place();
    expect((await t.sessions()).find((s) => s[0] === 'session:run:2026-12-03')).toEqual(['session:run:2026-12-03', at('2026-12-03', '09:00'), at('2026-12-03', '09:30')]);
  });

  it('places nothing on a day away, and nothing asks for it', async () => {
    const t = await setup(FRI, (w) => w.create('away_period', { start: '2026-12-01', end: '2026-12-02' }));
    await t.place();
    expect((await t.sessions()).map((s) => s[0])).toEqual(['session:run:2026-11-27', 'session:run:2026-11-30', 'session:run:2026-12-03', 'session:run:2026-12-04']);
    const left = practicesLeft([await practice(t)], await context(t, NEXT));
    expect(left).toEqual([]);
  });
});

describe('when the set time is taken', () => {
  it('waits, for an event on a blocking calendar, saying what takes it', async () => {
    const t = await setup(FRI, dentist());
    await t.place();
    expect((await t.sessions()).map((s) => s[0])).not.toContain('session:run:2026-12-03');
    const fit = setTimeFit(await practice(t), '2026-12-03', await context(t, NEXT));
    expect(fit).toEqual({ time: 420, why: 'is taken', by: 'Dentist' });
    expect(whySaid(fit as SetTimeWhy)).toBe('7am is taken by Dentist');
    expect(whySaid(fit as SetTimeWhy, false)).toBe('7am is taken');
    const left = practicesLeft([await practice(t)], await context(t, NEXT));
    expect(left[0]?.dates).toEqual(['2026-12-03']);
  });

  it('is placed over an event on an information calendar', async () => {
    const t = await setup(FRI, async (w) => {
      await dentist()(w);
      await w.create('calendar_source', { google_id: 'primary', name: 'Family', mode: 'info' });
    });
    await t.place();
    expect((await t.sessions()).map((s) => s[0])).toContain('session:run:2026-12-03');
  });

  it('waits for another block or a planning block', async () => {
    const t = await setup(FRI, async (w) => {
      await w.create('task', { kind: 'one_off', title: 'Renew passport' }, 'pass');
      await w.create('time_block', { task_id: 'pass', start: at('2026-11-30', '07:15'), end: at('2026-11-30', '07:45'), tz: 'UTC' });
      await w.create('task', { kind: 'planning', title: 'Plan the week' }, 'plan');
      await w.create('time_block', { task_id: 'plan', start: at('2026-12-01', '06:45'), end: at('2026-12-01', '07:15'), tz: 'UTC' });
    });
    await t.place();
    const ids = (await t.sessions()).map((s) => s[0]);
    expect(ids).not.toContain('session:run:2026-11-30');
    expect(ids).not.toContain('session:run:2026-12-01');
    const ctx = await context(t, NEXT);
    expect(setTimeFit(await practice(t), '2026-11-30', ctx)).toEqual({ time: 420, why: 'is taken', by: 'Renew passport' });
    expect(setTimeFit(await practice(t), '2026-12-01', ctx)).toEqual({ time: 420, why: 'is taken', by: 'Plan the week' });
  });

  it('waits for time outside available hours', async () => {
    const t = await setup(FRI, (w) => w.create('settings', { availability: [{ days: 'all', from: 22 * 60, to: 8 * 60, projects: true, one_offs: true }] }, SETTINGS_ID));
    await t.place();
    expect(await t.sessions()).toEqual([]);
    expect(setTimeFit(await practice(t), NEXT, await context(t, NEXT))).toEqual({ time: 420, why: 'is outside your available hours' });
  });

  it("tries the practice's own other listed times, and never the nearest free time", async () => {
    const t = await setup(FRI, async (w) => {
      await dentist()(w);
      await w.set('practice', 'run', { preferred_times: [7 * 60, 8 * 60] });
    });
    await t.place();
    expect((await t.sessions()).find((s) => s[0] === 'session:run:2026-12-03')).toEqual(['session:run:2026-12-03', at('2026-12-03', '08:00'), at('2026-12-03', '08:30')]);

    const lone = await setup(FRI, dentist('2026-12-03T06:45:00Z', '2026-12-03T07:15:00Z'));
    await lone.place();
    expect((await lone.sessions()).map((s) => s[0])).not.toContain('session:run:2026-12-03');
  });

  it('gives the slot to the practice made first, and the other waits saying which', async () => {
    const t = await setup(FRI, (w) => w.create('practice', { ...run, title: 'Yoga' }, 'yoga'));
    await t.place();
    expect(await t.sessions()).toHaveLength(6);
    expect(await t.sessions('yoga')).toEqual([]);
    const yoga = (await getRecord(t.db, 'practice', 'yoga'))!;
    expect(setTimeFit(yoga, NEXT, await context(t, NEXT))).toEqual({ time: 420, why: 'is taken', by: 'Morning run' });
  });

  it('moves a time the clocks skip to the first that exists', async () => {
    // Clocks in New York skip 2am to 3am on Sunday Mar 14, 2027.
    const t = await setup(
      '2027-03-12T15:00:00Z',
      async (w) => {
        await w.set('practice', 'run', { days: [6], preferred_times: [2 * 60 + 30] });
        await w.create('settings', { availability: [] }, SETTINGS_ID);
      },
      'America/New_York',
    );
    await t.place();
    // 3am in New York that day, and 2:30am the next Sunday.
    expect(await t.sessions()).toEqual([
      ['session:run:2027-03-14', '2027-03-14T07:00:00Z', '2027-03-14T07:30:00Z'],
      ['session:run:2027-03-21', '2027-03-21T06:30:00Z', '2027-03-21T07:00:00Z'],
    ]);
  });
});

describe('placing once', () => {
  it('places nothing a second time, nor where a session was taken off, deleted, or moved from or to', async () => {
    const t = await setup();
    await t.place();
    expect((await t.place()).placed).toEqual([]);
    await t.run(async (w) => {
      await removeBlock(w, 'session:run:2026-11-30');
      await w.delete('time_block', 'session:run:2026-12-01');
      await w.set('time_block', 'session:run:2026-12-02', { start: at('2026-12-03', '12:00'), end: at('2026-12-03', '12:30') });
      await w.delete('time_block', 'session:run:2026-12-03');
    });
    // Wednesday's session moved to Thursday: Wednesday keeps its id, and Thursday has a session on it.
    expect((await t.place()).placed).toEqual([]);
  });

  it('Undo takes each one off, so it waits in To schedule and is never placed again', async () => {
    const t = await setup();
    const done = await t.place();
    await t.run((w) => applyPlanChange(w, done));
    expect(await t.sessions()).toEqual([]);
    expect((await t.place()).placed).toEqual([]);
    expect(practicesLeft([await practice(t)], await context(t, NEXT))[0]?.dates).toHaveLength(5);
  });

  it('on two devices before they sync makes one session a day, and a take-off on either wins', async () => {
    const clock = fixedClock(FRI);
    const server = fakeSyncServer({ now: () => clock.now() });
    const [phone, desk] = [await openTestDb(), await openTestDb()];
    await transact(phone, clock, (w) => w.create('practice', run, 'run'));
    for (const db of [phone, desk]) await runSync(db, server.send);
    await transact(phone, clock, (w) => placeSetTimes(w.automatic, clock));
    await transact(desk, clock, (w) => placeSetTimes(w.automatic, clock));
    clock.set(clock.now() + 60_000);
    await transact(desk, clock, (w) => removeBlock(w, 'session:run:2026-12-01'));
    for (const db of [phone, desk, phone]) await runSync(db, server.send);
    for (const db of [phone, desk]) {
      const blocks = await listRecords(db, 'time_block');
      expect(blocks).toHaveLength(6);
      expect(blocks.filter((b) => b.cancelled).map((b) => b.id)).toEqual(['session:run:2026-12-01']);
    }
    // Once synced, neither places again.
    expect((await transact(phone, clock, (w) => placeSetTimes(w.automatic, clock))).placed).toEqual([]);
  });

  it('two devices that saw different calendars still make one session, with one device’s values', async () => {
    const clock = fixedClock(FRI);
    const server = fakeSyncServer({ now: () => clock.now() });
    const [phone, desk] = [await openTestDb(), await openTestDb()];
    await transact(phone, clock, (w) => w.create('practice', { ...run, preferred_times: [7 * 60, 8 * 60] }, 'run'));
    for (const db of [phone, desk]) await runSync(db, server.send);
    await transact(desk, clock, dentist());
    await transact(phone, clock, (w) => placeSetTimes(w.automatic, clock));
    await transact(desk, clock, (w) => placeSetTimes(w.automatic, clock));
    for (const db of [phone, desk, phone]) await runSync(db, server.send);
    const thu = async (db: Db) => getRecord(db, 'time_block', 'session:run:2026-12-03');
    expect(await thu(phone)).toEqual(await thu(desk));
    expect([at('2026-12-03', '07:00'), at('2026-12-03', '08:00')]).toContain((await thu(phone))!.start);
    expect(blockMinutes((await thu(phone))!)).toBe(30);
  });
});

describe('a week reset', () => {
  it('is not filled again, and Place the rest puts its sessions back at their set times', async () => {
    const t = await setup();
    await t.place();
    // Reset next week's plan: its sessions still to come are deleted, as anything planned is.
    await t.run((w) => resetWeek(w, NEXT, t.clock));
    expect((await t.sessions()).map((s) => s[0])).toEqual(['session:run:2026-11-27']);
    expect((await t.place()).placed).toEqual([]);
    expect(practicesLeft([await practice(t)], await context(t, NEXT))[0]?.dates).toHaveLength(5);
    // Planned again, Place the rest puts them back at their set times.
    await t.run((w) => placeWeekPractices(w, NEXT, t.clock));
    expect((await t.sessions()).filter((s) => s[1]!.startsWith('2026-12-01'))).toEqual([['session:run:2026-12-01', at('2026-12-01', '07:00'), at('2026-12-01', '07:30')]]);
  });
});

describe('a practice made or edited', () => {
  it('places a new practice at once, for the days still ahead', async () => {
    const t = await setup(FRI);
    const id = 'piano';
    const done = await t.run(async (w) => {
      await w.create('practice', piano, id);
      return placeSetTimes(w, t.clock, (await getRecord(w.sql, 'practice', id))!);
    });
    expect(done.placed.map((s) => s.date)).toEqual(['2026-11-27', '2026-11-30', '2026-12-02', '2026-12-04']);
    // Not the automatic clocks: the person did this.
    expect(parseClock((await fieldClocks(t.db, 'session:piano:2026-11-30')).start!).wall).toBeGreaterThan(0);
  });

  it('moves sessions at the old time to the new one, leaving those moved by hand, and Undo puts all back', async () => {
    const t = await setup(FRI, dentist(at('2026-12-02', '07:30'), at('2026-12-02', '08:00')));
    await t.place();
    await t.run((w) => w.set('time_block', 'session:run:2026-12-01', { start: at('2026-12-01', '06:00'), end: at('2026-12-01', '06:30') }));
    const before = await practice(t);
    const done = await t.run(async (w) => {
      const back = await applyPlanChange(w, { writes: [{ type: 'practice', id: 'run', fields: { preferred_times: [7 * 60 + 30] } }] });
      const follow = await followSetTimes(w, before, { ...before, preferred_times: [7 * 60 + 30] }, t.clock);
      return { ...follow, writes: [...follow.writes, ...back.writes] };
    });
    expect(followMessage(done)).toBe('Moved 4 sessions to 7:30am. 1 waits in To schedule.');
    const starts = Object.fromEntries((await t.sessions()).map((s) => [s[0], s[1]]));
    expect(starts['session:run:2026-11-30']).toBe(at('2026-11-30', '07:30'));
    expect(starts['session:run:2026-12-01']).toBe(at('2026-12-01', '06:00'));
    expect(starts['session:run:2026-12-02']).toBeUndefined();
    await t.run((w) => applyPlanChange(w, done));
    expect(Object.fromEntries((await t.sessions()).map((s) => [s[0], s[1]]))['session:run:2026-12-02']).toBe(at('2026-12-02', '07:00'));
    expect((await practice(t)).preferred_times).toEqual([7 * 60]);
  });

  it('takes off sessions on days dropped, places new days, and keeps sessions when set to any time', async () => {
    const t = await setup();
    await t.place();
    const before = await practice(t);
    const after = { ...before, days: [0, 1, 2, 3, 5] as Practice['days'] };
    const done = await t.run(async (w) => {
      await w.set('practice', 'run', { days: after.days });
      return followSetTimes(w, before, after, t.clock);
    });
    expect(followMessage(done)).toBe('Placed 2 sessions at their set times. Took 2 sessions off the calendar.');
    expect((await t.sessions()).map((s) => s[0])).toEqual([
      'session:run:2026-11-28',
      'session:run:2026-11-30',
      'session:run:2026-12-01',
      'session:run:2026-12-02',
      'session:run:2026-12-03',
      'session:run:2026-12-05',
    ]);

    const anyTime = { ...after, preferred_times: [] };
    const kept = await t.run(async (w) => {
      await w.set('practice', 'run', { preferred_times: [] });
      return followSetTimes(w, after, anyTime, t.clock);
    });
    expect(followMessage(kept)).toBe('');
    expect(await t.sessions()).toHaveLength(6);
  });

  it('keeps sessions at their time with a new length, and says so', async () => {
    const t = await setup();
    await t.place();
    const before = await practice(t);
    const done = await t.run(async (w) => {
      await w.set('practice', 'run', { target_min: 45 });
      return followSetTimes(w, before, { ...before, target_min: 45 }, t.clock);
    });
    expect(followMessage(done)).toBe('Made 6 sessions 45m.');
    expect((await t.sessions())[0]).toEqual(['session:run:2026-11-27', at('2026-11-27', '07:00'), at('2026-11-27', '07:45')]);
  });

  it('a session is at its set time only on its own day, at its time and length', async () => {
    const p = { id: 'run', ...run } as Practice;
    expect(atSetTime(p, { id: 'session:run:2026-11-30', start: at('2026-11-30', '07:00'), end: at('2026-11-30', '07:30') }, 'UTC')).toBe(true);
    expect(atSetTime(p, { id: 'session:run:2026-11-30', start: at('2026-11-30', '07:15'), end: at('2026-11-30', '07:45') }, 'UTC')).toBe(false);
    expect(atSetTime(p, { id: 'session:run:2026-11-30', start: at('2026-12-01', '07:00'), end: at('2026-12-01', '07:30') }, 'UTC')).toBe(false);
    expect(atSetTime(p, { id: 'session:run:2026-11-30', start: at('2026-11-30', '07:00'), end: at('2026-11-30', '08:00') }, 'UTC')).toBe(false);
  });
});

describe('pausing and resuming', () => {
  it('takes off what is still to come, and Resume puts back what it took off where the time is free', async () => {
    const t = await setup();
    await t.place();
    // Taken off before the pause, it stays off.
    await t.run((w) => removeBlock(w, 'session:run:2026-11-30'));
    const paused = await t.run((w) => pausePractice(w, 'run', t.clock));
    expect(pausedMessage('Morning run', paused.off)).toBe('Paused Morning run. Took 5 sessions off the calendar.');
    expect(await t.sessions()).toEqual([]);
    expect((await t.place()).placed).toEqual([]);

    await t.run(dentist(at('2026-12-02', '07:00'), at('2026-12-02', '07:30')));
    const resumed = await t.run((w) => resumePractice(w, 'run', t.clock));
    expect(resumedMessage('Morning run', resumed.back)).toBe('Resumed Morning run. 4 sessions are back on the calendar.');
    expect((await t.sessions()).map((s) => s[0])).toEqual(['session:run:2026-11-27', 'session:run:2026-12-01', 'session:run:2026-12-03', 'session:run:2026-12-04']);
    expect((await practice(t)).state).toBe('active');

    // Undo pauses it again, and resuming again puts them back.
    await t.run((w) => applyPlanChange(w, resumed));
    expect(await t.sessions()).toEqual([]);
    expect((await practice(t)).state).toBe('paused');
    await t.run((w) => resumePractice(w, 'run', t.clock));
    expect(await t.sessions()).toHaveLength(4);
  });

  it('Undo of a pause puts everything back', async () => {
    const t = await setup();
    await t.place();
    const paused = await t.run((w) => pausePractice(w, 'run', t.clock));
    await t.run((w) => applyPlanChange(w, paused));
    expect(await t.sessions()).toHaveLength(6);
    expect((await practice(t)).state).toBe('active');
  });

  it('places the days a paused practice never had', async () => {
    const t = await setup(FRI, (w) => w.set('practice', 'run', { state: 'paused' }));
    const resumed = await t.run((w) => resumePractice(w, 'run', t.clock));
    expect(resumed.back).toBe(6);
  });
});

describe('away dates', () => {
  it('take off the practice sessions on them, and Undo puts them back', async () => {
    const t = await setup();
    await t.place();
    const added = await t.run((w) => addAwayDates(w, '2026-12-01', '2026-12-02', t.clock));
    expect(awayMessage('2026-12-01', '2026-12-02', added.off)).toBe('Added away dates Dec 1 to Dec 2. Took 2 practice sessions off the calendar.');
    expect((await t.sessions()).map((s) => s[0])).not.toContain('session:run:2026-12-01');
    await t.run((w) => applyPlanChange(w, added));
    expect(await t.sessions()).toHaveLength(6);
    expect((await listRecords(t.db, 'away_period')).filter((a) => !a.deleted_at)).toEqual([]);
  });
});

async function practice(t: { db: Db }, id = 'run') {
  return (await getRecord(t.db, 'practice', id))!;
}

async function context(t: Awaited<ReturnType<typeof setup>>, week: string) {
  const { blocksInRange } = await import('./queries');
  const { weekRange } = await import('./dates');
  const { getSettings } = await import('./records');
  return slotContext({
    week,
    availability: (await getSettings(t.db)).availability,
    avoided: [],
    sources: await listRecords(t.db, 'calendar_source'),
    calendar: (await getRecord(t.db, 'calendar', CALENDAR_ID)) ?? null,
    blocks: await blocksInRange(t.db, weekRange(week, t.clock.zone())),
    clock: t.clock,
    away: await listRecords(t.db, 'away_period'),
  });
}

describe('one offs at a time of day', () => {
  const passport = (fields: Fields<'task'> = {}) => (w: Writer) =>
    w.create('task', { kind: 'one_off', title: 'Renew passport', estimate_min: 30, schedule: { type: 'once', from: '2026-12-02' }, time: 9 * 60, ...fields }, 'pass');
  const blocks = async (t: Awaited<ReturnType<typeof setup>>, task = 'pass') =>
    (await listRecords(t.db, 'time_block')).filter((b) => b.task_id === task && !b.cancelled).map((b) => [b.id, b.start, b.end]);

  it('lands at its time on its one date, under the day id, with the lowest clocks', async () => {
    const t = await setup(FRI, passport());
    const done = await t.place();
    expect(await blocks(t)).toEqual([['due:pass:2026-12-02', at('2026-12-02', '09:00'), at('2026-12-02', '09:30')]]);
    for (const clock of Object.values(await fieldClocks(t.db, 'due:pass:2026-12-02'))) expect(parseClock(clock)).toMatchObject({ wall: 0 });
    expect(placedMessage(done.placed, t.clock)).toBe('Placed 7 blocks at their set times this week and next.');
    expect((await t.place()).placed).toEqual([]);
  });

  it("a repeating one lands on its next date; one with a range, a window, no time, or that's done doesn't", async () => {
    const t = await setup(FRI, async (w) => {
      await w.create('task', { kind: 'one_off', title: 'Water the plants', schedule: { type: 'recurring', every: 1, unit: 'week', anchor: '2026-11-03' }, next_due: '2026-12-01', time: 8 * 60 }, 'water');
      await w.create('task', { kind: 'one_off', title: 'Paint the fence', schedule: { type: 'once', from: '2026-12-01', to: '2026-12-03' }, time: 8 * 60 }, 'fence');
      await w.create('task', { kind: 'one_off', title: 'Service the boiler', schedule: { type: 'window', min: 2, max: 3, unit: 'month' }, next_due: '2026-12-01', time: 8 * 60 }, 'boiler');
      await w.create('task', { kind: 'one_off', title: 'Call the bank', schedule: { type: 'once', from: '2026-12-01' } }, 'bank');
      await w.create('task', { kind: 'one_off', title: 'Post the card', schedule: { type: 'once', from: '2026-12-01' }, time: 8 * 60, done_at: FRI }, 'card');
    });
    await t.place();
    expect(await blocks(t, 'water')).toEqual([['due:water:2026-12-01', at('2026-12-01', '08:00'), at('2026-12-01', '08:30')]]);
    for (const id of ['fence', 'boiler', 'bank', 'card']) expect(await blocks(t, id)).toEqual([]);
  });

  it('waits when its time is taken, and never lands on a day that has had a block of it', async () => {
    const t = await setup(FRI, async (w) => {
      await passport({ schedule: { type: 'once', from: '2026-12-03' }, time: 7 * 60 + 15 })(w);
      await w.create('task', { kind: 'one_off', title: 'Return the drill', schedule: { type: 'once', from: '2026-12-04' }, time: 12 * 60 }, 'drill');
      await w.create('time_block', { task_id: 'drill', start: at('2026-12-04', '15:00'), end: at('2026-12-04', '15:30'), tz: 'UTC', cancelled: true });
      await dentist()(w);
    });
    await t.place();
    expect(await blocks(t)).toEqual([]);
    expect(await blocks(t, 'drill')).toEqual([]);
  });

  it('comes after the practices for the same time, and waits saying what takes it', async () => {
    const t = await setup(FRI, passport({ schedule: { type: 'once', from: '2026-12-01' }, time: 7 * 60 }));
    await t.place();
    expect(await blocks(t)).toEqual([]);
    expect((await t.sessions()).map((s) => s[0])).toContain('session:run:2026-12-01');
    const task = (await getRecord(t.db, 'task', 'pass'))!;
    expect(oneOffWhy(task, '2026-12-01', await context(t, NEXT))).toEqual({ time: 420, why: 'is taken', by: 'Morning run' });
    expect(oneOffWhy(task, '2026-12-02', await context(t, NEXT))).toBeNull();
  });

  it('a released app editing its dates keeps its time', async () => {
    const t = await setup(FRI, passport());
    await t.run((w) => w.set('task', 'pass', { schedule: { type: 'once', from: '2026-12-03' }, next_due: '2026-12-03' }));
    expect((await getRecord(t.db, 'task', 'pass'))?.time).toBe(9 * 60);
  });
});

describe('a one off whose time or date changes', () => {
  const passport = (w: Writer) =>
    w.create('task', { kind: 'one_off', title: 'Renew passport', estimate_min: 30, schedule: { type: 'once', from: '2026-12-02' }, next_due: '2026-12-02', time: 9 * 60 }, 'pass');
  const change = (t: Awaited<ReturnType<typeof setup>>, fields: Fields<'task'>) =>
    t.run(async (w) => {
      const before = (await getRecord(w.sql, 'task', 'pass'))!;
      const back = await applyPlanChange(w, { writes: [{ type: 'task', id: 'pass', fields }] });
      const follow = await followOneOff(w, before, { ...before, ...fields }, t.clock);
      return { ...follow, writes: [...follow.writes, ...back.writes] };
    });
  const block = async (t: Awaited<ReturnType<typeof setup>>, id = 'due:pass:2026-12-02') => getRecord(t.db, 'time_block', id);

  it('moves to a new time that day, and Undo puts it back', async () => {
    const t = await setup(FRI, passport);
    await t.place();
    const done = await change(t, { time: 10 * 60 });
    expect(done.said).toBe('Moved Renew passport to Wed 10am.');
    expect(await block(t)).toMatchObject({ start: at('2026-12-02', '10:00'), end: at('2026-12-02', '10:30') });
    await t.run((w) => applyPlanChange(w, done));
    expect(await block(t)).toMatchObject({ start: at('2026-12-02', '09:00') });
    expect((await getRecord(t.db, 'task', 'pass'))?.time).toBe(9 * 60);
  });

  it('comes off its old day and lands on a new one', async () => {
    const t = await setup(FRI, passport);
    await t.place();
    const done = await change(t, { schedule: { type: 'once', from: '2026-12-03' }, next_due: '2026-12-03' });
    expect(done.said).toBe('Placed Renew passport at its set time, Thu 9am.');
    expect((await block(t))?.cancelled).toBe(true);
    expect(await block(t, 'due:pass:2026-12-03')).toMatchObject({ start: at('2026-12-03', '09:00') });
  });

  it('waits when the new time is taken, and stays put when its time is cleared', async () => {
    const t = await setup(FRI, passport);
    await t.place();
    const taken = await change(t, { time: 7 * 60 });
    expect(taken.said).toBe("Took Renew passport off Wed 9am. It's in To schedule.");
    await t.run((w) => applyPlanChange(w, taken));
    const cleared = await change(t, { time: null });
    expect(cleared.said).toBe('');
    expect(await block(t)).toMatchObject({ start: at('2026-12-02', '09:00') });
    expect((await block(t))?.cancelled).toBeFalsy();
  });
});
