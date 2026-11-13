import { describe, expect, it } from 'vitest';
import {
  availableHours,
  dayLoads,
  openTime,
  pickWarning,
  plannedByKind,
  pushbackLately,
  recentPushback,
  ringColor,
  weekAlerts,
  weeklyAims,
  weekUse,
} from './capacity';
import type { AnalyticsData } from './analytics';
import { fixedClock } from './clock';
import { slotContext } from './slots';
import type { SlotContext, Span } from './slots';
import type { AvailabilityBlock, Project } from './types';

const MON = '2026-11-02';
const TUE = '2026-11-03';
const WED = '2026-11-04';
const SUN = '2026-11-08';

const NIGHT: AvailabilityBlock = { days: 'all', from: 1320, to: 420, projects: true, one_offs: true };
const JOB: AvailabilityBlock = { days: 'weekdays', from: 540, to: 1140, projects: true, one_offs: false };
const ctx = (over: Partial<SlotContext> = {}): SlotContext => ({
  week: MON,
  availability: [NIGHT],
  busy: [],
  placed: [],
  avoided: [],
  earliest: { date: '2026-11-01', minutes: 720 },
  ...over,
});
const span = (date: string, start: number, end: number, more: Partial<Span> = {}): Span => ({ date, start, end, ...more });

describe('availableHours', () => {
  it('gives each kind its own weekly hours from the unavailable list', () => {
    expect(availableHours([NIGHT, JOB], MON)).toEqual({ project: 55 * 60, one_off: 105 * 60 });
  });

  it('an empty list leaves the whole week open', () => {
    expect(availableHours([], MON)).toEqual({ project: 168 * 60, one_off: 168 * 60 });
  });

  it('removing a block gives its time back', () => {
    expect(availableHours([NIGHT], MON).project).toBe(105 * 60);
  });
});

describe('openTime', () => {
  it('takes calendar events out of open hours, counting overlaps once', () => {
    const c = ctx({ busy: [span(MON, 600, 720), span(MON, 660, 780), span(TUE, 60, 120)] });
    expect(openTime(c)).toBe(105 * 60 - 180);
  });

  it('uses the kind of work asked for', () => {
    const c = ctx({ availability: [NIGHT, JOB] });
    expect(openTime(c)).toBe(55 * 60);
    expect(openTime(c, 'one_off')).toBe(105 * 60);
  });

  it('counts only time still to come, so a week in progress offers only its rest', () => {
    // Saturday at 6:30pm: 3h 30m left that day, then Sunday's 15h.
    expect(openTime(ctx({ earliest: { date: '2026-11-07', minutes: 18 * 60 + 30 } }))).toBe(18 * 60 + 30);
  });

  it('ignores placed blocks, which spend open time rather than reduce it', () => {
    expect(openTime(ctx({ placed: [span(MON, 600, 720)] }))).toBe(105 * 60);
  });
});

describe('plannedByKind', () => {
  it('adds time up by kind', () => {
    const spans = [
      span(MON, 600, 660, { kind: 'project' }),
      span(MON, 660, 690, { kind: 'one_off' }),
      span(TUE, 420, 450, { kind: 'practice' }),
      span(TUE, 450, 480, { kind: 'practice' }),
      span(TUE, 500, 515),
    ];
    expect(plannedByKind(spans)).toEqual({ project: 75, one_off: 30, practice: 60, total: 165 });
  });

  it('leaves planning out: it is busy time, which takes open time instead', () => {
    const blocks = [{ id: 'p', start: '2026-11-02T16:00:00Z', end: '2026-11-02T17:00:00Z', task_kind: 'planning' as const }];
    const c = slotContext({ week: MON, availability: [NIGHT], avoided: [], sources: [], calendar: null, blocks, clock: fixedClock('2026-11-01T00:00:00Z') });
    expect(plannedByKind(c.placed)).toEqual({ project: 0, one_off: 0, practice: 0, total: 0 });
    expect(openTime(c)).toBe(105 * 60 - 60);
  });
});

describe('recentPushback', () => {
  it('averages planned minus done and rounds to 30 minutes', () => {
    expect(
      recentPushback([
        { planned: 600, done: 300 },
        { planned: 600, done: 340 },
      ]),
    ).toBe(270);
  });

  it('with no finished weeks, or more done than planned, it is nothing', () => {
    expect(recentPushback([])).toBe(0);
    expect(recentPushback([{ planned: 60, done: 300 }])).toBe(0);
  });
});

describe('pushbackLately', () => {
  it('reads the last four weeks planned and finished before this one', () => {
    const at = (date: string, h: number) => `${date}T${String(h).padStart(2, '0')}:00:00Z`;
    const data: AnalyticsData = {
      objectives: [],
      projects: [],
      milestones: [],
      tasks: [{ id: 't', kind: 'one_off', title: 'Paint the fence' }],
      // An hour planned and not done in each week from Oct 5 on, two hours this week, and five the week before Oct 5.
      blocks: [
        ...['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', MON, TUE].map((d, i) => ({ id: `b${i}`, task_id: 't', start: at(d, 9), end: at(d, 10), tz: 'UTC' })),
        { id: 'old', task_id: 't', start: at('2026-09-28', 9), end: at('2026-09-28', 14), tz: 'UTC' },
      ],
      outcomes: [],
      practices: [],
      away: [],
      avoided_slots: [],
    };
    const finished = (week_start: string) => ({ id: `week:${week_start}`, week_start, finished_at: at(week_start, 8) });
    const plans = ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', MON].map(finished);
    const clock = fixedClock('2026-11-04T12:00:00Z');
    // Sep 28 is the fifth week back and this week isn't over, so both stay out of the average.
    expect(pushbackLately(plans, data, clock)).toBe(60);
    expect(pushbackLately([{ ...finished('2026-10-26'), finished_at: null }], data, clock)).toBe(0);
  });
});

describe('weekUse', () => {
  it('adds picks to placed time, as a share of open time', () => {
    expect(weekUse({ open: 600, placed: 120, picked: 180 })).toEqual({ used: 300, free: 300, over: 0, share: 0.5 });
  });

  it('says how much over', () => {
    expect(weekUse({ open: 600, placed: 300, picked: 400 })).toMatchObject({ free: -100, over: 100 });
    expect(weekUse({ open: 600, placed: 300, picked: 400 }).share).toBeCloseTo(7 / 6);
  });

  it('with no open time, any use fills the ring', () => {
    expect(weekUse({ open: 0, placed: 0, picked: 0 }).share).toBe(0);
    expect(weekUse({ open: 0, placed: 0, picked: 60 }).share).toBeGreaterThanOrEqual(1);
  });
});

describe('ringColor', () => {
  const red = (share: number) => Number(/var\(--red\) (\d+)%/.exec(ringColor(share))![1]);

  it("is the theme's blue when empty and its red when full or past it", () => {
    expect(ringColor(0)).toBe('color-mix(in srgb, var(--red) 0%, var(--blue))');
    expect(ringColor(1)).toBe('color-mix(in srgb, var(--red) 100%, var(--blue))');
    expect(ringColor(2)).toBe(ringColor(1));
    expect(ringColor(-1)).toBe(ringColor(0));
  });

  it('moves toward red as it fills, and half full still looks calm', () => {
    expect(red(0.25)).toBeLessThan(red(0.5));
    expect(red(0.5)).toBeLessThan(red(0.75));
    expect(red(0.75)).toBeLessThan(red(0.95));
    expect(red(0.5)).toBe(25);
  });
});

describe('pickWarning', () => {
  it('stays quiet with room to spare', () => {
    expect(pickWarning(300, 270)).toBeNull();
    expect(pickWarning(0, 0)).toBeNull();
  });

  it('warns when what is left is less than what usually gets pushed back', () => {
    expect(pickWarning(90, 270)).toBe("That leaves 1h 30m free. You've pushed back about 4h 30m a week lately.");
  });

  // How far over is said beside it, as Over by, so the warning says only what happens to the rest.
  it('says what happens to what does not fit when the picks pass the open time', () => {
    expect(pickWarning(-120, 270)).toBe("What doesn't fit stays on its project or in One offs.");
  });
});

describe('weeklyAims', () => {
  const project = (id: string, over: Partial<Project> = {}): Project => ({
    id,
    title: id,
    state: 'active',
    start: '2026-10-01',
    end: '2026-12-01',
    weekly_aim: 120,
    ...over,
  });

  it('lists active projects with an aim, then One offs', () => {
    const rows = weeklyAims({
      projects: [project('a'), project('b', { state: 'paused' }), project('c', { weekly_aim: 0 }), project('d', { deleted_at: '2026-10-02T00:00:00Z' })],
      oneOffsAim: 60,
      weekPlan: null,
      got: { a: 30, one_offs: 90 },
    });
    expect(rows.map((r) => r.bucket)).toEqual(['a', 'one_offs']);
    expect(rows[0]).toEqual({ bucket: 'a', aim: 120, got: 30, short: 90, skipped: false, met: false, pct: 25, tickPct: 100 });
    expect(rows[1]).toEqual({ bucket: 'one_offs', aim: 60, got: 90, short: 0, skipped: false, met: true, pct: 100, tickPct: 67 });
  });

  it("uses this week's change over the usual aim, and notes a skipped one", () => {
    const rows = weeklyAims({
      projects: [project('a'), project('c', { weekly_aim: null })],
      oneOffsAim: null,
      weekPlan: { aims: { a: 240, c: 60 }, skipped_aims: ['c', 'one_offs'] },
      got: {},
    });
    expect(rows.map((r) => [r.bucket, r.aim, r.short, r.skipped])).toEqual([
      ['a', 240, 240, false],
      ['c', 60, 0, true],
      ['one_offs', 0, 0, true],
    ]);
  });
});

describe('dayLoads', () => {
  it('gives each day its open and free time and marks it tight under 15 percent free', () => {
    const c = ctx({ placed: [span(MON, 420, 1200)] });
    const days = dayLoads(c);
    expect(days).toHaveLength(7);
    expect(days[0]).toEqual({ date: MON, base: 900, free: 120, tight: true });
    expect(days[1]).toEqual({ date: TUE, base: 900, free: 900, tight: false });
  });

  it('counts events as congestion too', () => {
    expect(dayLoads(ctx({ busy: [span(SUN, 420, 1300)] }))[6]).toMatchObject({ free: 20, tight: true });
  });

  it('a day with no open time is not tight', () => {
    const closed: AvailabilityBlock = { days: 'all', from: 0, to: 1440, projects: true, one_offs: true };
    expect(dayLoads(ctx({ availability: [closed] }))[0]).toMatchObject({ base: 0, free: 0, tight: false });
  });

  it('counts only time still ahead: a day gone by has none and is never tight, and today has only its rest', () => {
    // Wednesday at noon, after a full Monday, with noon to 9pm planned.
    const days = dayLoads(ctx({ earliest: { date: WED, minutes: 720 }, placed: [span(MON, 420, 1200), span(WED, 720, 1260)] }));
    expect(days[0]).toEqual({ date: MON, base: 0, free: 0, tight: false });
    expect(days[2]).toEqual({ date: WED, base: 600, free: 60, tight: true });
    expect(days[3]).toMatchObject({ base: 900, free: 900 });
  });
});

describe('weekAlerts', () => {
  const titles = (list: { title: string }[]) => list.map((a) => a.title);

  it('is quiet with room to spare', () => {
    expect(weekAlerts(ctx(), [], 60)).toEqual([]);
  });

  it('warns when wiggle room falls below recent pushback', () => {
    // 105h open, with 104h placed across the week.
    const placed = Array.from({ length: 7 }, (_, i) => span(`2026-11-0${i + 2}`, 420, i === 0 ? 1260 : 1320));
    const alerts = weekAlerts(ctx({ placed }), [], 270);
    expect(alerts[0]).toEqual({
      title: 'Little room to spare',
      text: "Only 1h is free. You've pushed back about 4h 30m a week lately, so unfinished work may not fit.",
    });
  });

  it('says so when no room is left', () => {
    const placed = Array.from({ length: 7 }, (_, i) => span(`2026-11-0${i + 2}`, 420, 1320));
    const alerts = weekAlerts(ctx({ placed }), [], 0);
    expect(titles(alerts)).toEqual(['Mon Nov 2 is packed', 'Tue Nov 3 is packed', 'Wed Nov 4 is packed', 'Thu Nov 5 is packed', 'Fri Nov 6 is packed', 'Sat Nov 7 is packed', 'Sun Nov 8 is packed']);
    const withPushback = weekAlerts(ctx({ placed }), [], 60);
    expect(withPushback[0]).toEqual({
      title: 'No room left this week',
      text: "The plan fills all your available time. You've pushed back about 1h a week lately, so unfinished work may not fit.",
    });
  });

  it('in a week under way, weighs the time left against only the work still ahead', () => {
    const sat = { date: '2026-11-07', minutes: 18 * 60 + 30 };
    // Monday to Friday were full and are behind you; Sunday has 14h 30m planned, leaving 4h of the 18h 30m left.
    const placed = [...Array.from({ length: 5 }, (_, i) => span(`2026-11-0${i + 2}`, 420, 1320)), span(SUN, 420, 1290)];
    expect(weekAlerts(ctx({ earliest: sat, placed }), [], 270)).toContainEqual({
      title: 'Little room to spare',
      text: "Only 4h is free. You've pushed back about 4h 30m a week lately, so unfinished work may not fit.",
    });
    // Aims are for the whole week, so they're still weighed against all of it.
    const aim = { bucket: 'a', aim: 20 * 60, got: 0, short: 20 * 60, skipped: false, met: false, pct: 0, tickPct: 100 };
    expect(titles(weekAlerts(ctx({ earliest: sat }), [aim], 0))).not.toContain("Aims don't fit");
  });

  it('events shrink the wiggle room', () => {
    const busy = Array.from({ length: 7 }, (_, i) => span(`2026-11-0${i + 2}`, 420, 1200));
    expect(titles(weekAlerts(ctx({ busy }), [], 15 * 60))).toContain('Little room to spare');
  });

  it('says when aims add up to more than the available time, leaving out skipped ones', () => {
    const aim = (bucket: string, value: number, skipped = false) => ({ bucket, aim: value, got: 0, short: value, skipped, met: false, pct: 0, tickPct: 100 });
    const c = ctx({ availability: [{ days: 'all', from: 600, to: 420, projects: true, one_offs: true }] });
    expect(titles(weekAlerts(c, [aim('a', 2000), aim('one_offs', 0)], 0))).toContain("Aims don't fit");
    expect(titles(weekAlerts(c, [aim('a', 2000, true), aim('one_offs', 0)], 0))).not.toContain("Aims don't fit");
  });

  it('says when one offs crowd out projects', () => {
    const rows = [
      { bucket: 'a', aim: 120, got: 60, short: 60, skipped: false, met: false, pct: 50, tickPct: 100 },
      { bucket: 'b', aim: 120, got: 120, short: 0, skipped: false, met: true, pct: 100, tickPct: 100 },
      { bucket: 'one_offs', aim: 60, got: 150, short: 0, skipped: false, met: true, pct: 100, tickPct: 40 },
    ];
    expect(weekAlerts(ctx(), rows, 0)).toEqual([
      { title: 'One offs are crowding out projects', text: "They're 1h 30m over their aim while 1 project is short." },
    ]);
  });

  it('names a packed day', () => {
    expect(weekAlerts(ctx({ placed: [span(MON, 420, 1200)] }), [], 0)).toEqual([
      { title: 'Mon Nov 2 is packed', text: '2h free of 15h available that day.' },
    ]);
  });

  it('in a week under way, names only packed days still ahead', () => {
    const c = ctx({ earliest: { date: WED, minutes: 720 }, placed: [span(MON, 420, 1200), span(WED, 720, 1260)] });
    expect(weekAlerts(c, [], 0)).toEqual([{ title: 'Wed Nov 4 is packed', text: '1h free of 10h available that day.' }]);
  });
});
