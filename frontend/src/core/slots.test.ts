import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock';
import {
  closestFit,
  dayOffer,
  defaultSlot,
  dragResult,
  fits,
  infoSpans,
  isOpen,
  offers,
  otherOffers,
  placePractices,
  placeRest,
  slotContext,
  slotInstants,
  slotNotes,
} from './slots';
import type { SlotContext, Span } from './slots';
import type { AvailabilityBlock, CalendarSource, Practice } from './types';

const MON = '2026-11-02';
const TUE = '2026-11-03';
const WED = '2026-11-04';
const THU = '2026-11-05';
const FRI = '2026-11-06';
const SAT = '2026-11-07';
const SUN = '2026-11-08';
const DAYS = [MON, TUE, WED, THU, FRI, SAT, SUN];

const NIGHT: AvailabilityBlock = { days: 'all', from: 1320, to: 420, projects: true, one_offs: true };
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
const allDay = (date: string) => span(date, 0, 1440);
const project = { kind: 'project' } as const;

describe('isOpen', () => {
  it('closes both sides of midnight for an overnight block', () => {
    const list = [NIGHT];
    expect(isOpen(list, MON, 1319, 'project')).toBe(true);
    expect(isOpen(list, MON, 1320, 'project')).toBe(false);
    expect(isOpen(list, MON, 419, 'project')).toBe(false);
    expect(isOpen(list, MON, 420, 'project')).toBe(true);
  });

  it('gives each kind of work its own hours', () => {
    const job: AvailabilityBlock = { days: 'weekdays', from: 540, to: 1020, projects: true, one_offs: false };
    expect(isOpen([job], MON, 600, 'project')).toBe(false);
    expect(isOpen([job], MON, 600, 'one_off')).toBe(true);
    expect(isOpen([job], SAT, 600, 'project')).toBe(true);
  });

  it('honours weekends', () => {
    const block: AvailabilityBlock = { days: 'weekends', from: 600, to: 660, projects: true, one_offs: true };
    expect(isOpen([block], SUN, 630, 'project')).toBe(false);
    expect(isOpen([block], MON, 630, 'project')).toBe(true);
  });

  it('a block with no length closes nothing', () => {
    const block: AvailabilityBlock = { days: 'all', from: 600, to: 600, projects: true, one_offs: true };
    expect(isOpen([block], MON, 600, 'project')).toBe(true);
    expect(isOpen([block], MON, 0, 'project')).toBe(true);
  });

  it('counts the morning after an overnight block under the night it started', () => {
    const block: AvailabilityBlock = { days: 'weekdays', from: 1320, to: 420, projects: true, one_offs: true };
    expect(isOpen([block], SAT, 300, 'project')).toBe(false);
    expect(isOpen([block], MON, 300, 'project')).toBe(true);
    expect(isOpen([block], SAT, 1380, 'project')).toBe(true);
  });

  it('a block running to midnight stops there', () => {
    const block: AvailabilityBlock = { days: 'weekends', from: 720, to: 0, projects: true, one_offs: true };
    expect(isOpen([block], SAT, 750, 'project')).toBe(false);
    expect(isOpen([block], SUN, 300, 'project')).toBe(true);
    expect(isOpen([block], MON, 300, 'project')).toBe(true);
  });
});

describe('fits', () => {
  it('sees a span that runs into closed time', () => {
    expect(fits(MON, 1305, 30, 'project', ctx())).toBe(false);
    expect(fits(MON, 1290, 30, 'project', ctx())).toBe(true);
  });

  it('rejects a block, an event, the past and the day end', () => {
    expect(fits(MON, 600, 60, 'project', ctx({ busy: [span(MON, 630, 690)] }))).toBe(false);
    expect(fits(MON, 600, 60, 'project', ctx({ placed: [span(MON, 630, 690)] }))).toBe(false);
    expect(fits(MON, 600, 60, 'project', ctx({ earliest: { date: MON, minutes: 601 } }))).toBe(false);
    expect(fits(MON, 601, 60, 'project', ctx({ earliest: { date: MON, minutes: 601 } }))).toBe(true);
    expect(fits(MON, 1410, 60, 'project', ctx({ availability: [] }))).toBe(false);
  });

  it('touching spans do not overlap', () => {
    expect(fits(MON, 600, 60, 'project', ctx({ busy: [span(MON, 660, 690), span(MON, 570, 600)] }))).toBe(true);
  });

  it('notices an event between grid lines', () => {
    expect(fits(MON, 600, 15, 'project', ctx({ busy: [span(MON, 607, 608)] }))).toBe(false);
  });
});

describe('offers', () => {
  it('gives one time a day, at most five, starting in the evening on weekdays and at 9am on weekends', () => {
    const all = offers(60, project, ctx());
    expect(all).toHaveLength(5);
    expect(all[0]).toMatchObject({ date: MON, start: 1020, end: 1080 });
    expect(new Set(all.map((o) => o.date)).size).toBe(5);
    const weekend = offers(60, { kind: 'project', opens: SAT }, ctx());
    expect(weekend.map((o) => [o.date, o.start])).toEqual([
      [SAT, 540],
      [SUN, 540],
    ]);
  });

  it('with no dates the emptiest day comes first', () => {
    const c = ctx({ placed: [span(MON, 600, 720), span(TUE, 600, 660), span(THU, 600, 630)] });
    const all = offers(60, project, c);
    expect(all.map((o) => o.date)).toEqual([WED, FRI, SAT, SUN, THU]);
    expect(all[0]!.note).toBe('Lightest day');
    expect(all[1]!.note).toBe('');
  });

  it('a due date puts days before it first, and labels later ones', () => {
    const c = ctx({ placed: [span(MON, 600, 720)] });
    const all = offers(60, { kind: 'project', due: WED }, c);
    expect(all.map((o) => o.date)).toEqual([MON, TUE, WED, THU, FRI]);
    expect(all[0]!.note).toBe("Before it's due");
    expect(all.filter((o) => o.date > WED).every((o) => o.note === 'After due date' && o.late)).toBe(true);
  });

  it('a due date past this week does not rank the days', () => {
    const c = ctx({ placed: [span(MON, 600, 720)] });
    const all = offers(60, { kind: 'project', due: '2026-11-20' }, c);
    expect(all[0]!.date).toBe(TUE);
    expect(all[0]!.note).toBe('Lightest day');
    expect(all.some((o) => o.late)).toBe(false);
  });

  it('overdue work takes the earliest open slot', () => {
    const c = ctx({ placed: [span(MON, 1020, 1200)] });
    const all = offers(60, { kind: 'project', due: '2026-10-18' }, c);
    expect(all[0]).toMatchObject({ date: MON, start: 420, note: 'Earliest open', late: false });
    expect(all.map((o) => o.date)).toEqual([MON, TUE, WED, THU, FRI]);
  });

  it('work that came due earlier this week is overdue, not late', () => {
    const c = ctx({ earliest: { date: WED, minutes: 670 } });
    const all = offers(60, { kind: 'project', due: TUE }, c);
    expect(all[0]).toMatchObject({ date: WED, start: 675, note: 'Earliest open', late: false });
  });

  it('only suggests time still to come', () => {
    const c = ctx({ earliest: { date: WED, minutes: 1080 } });
    const all = offers(60, project, c);
    expect(all.every((o) => o.date >= WED)).toBe(true);
    expect(all.find((o) => o.date === WED)!.start).toBe(1080);
  });

  it('skips days before a date that opens this week, and ignores one past it', () => {
    expect(offers(60, { kind: 'one_off', opens: THU }, ctx()).map((o) => o.date)).toEqual([THU, FRI, SAT, SUN]);
    expect(offers(60, { kind: 'one_off', opens: '2026-12-01' }, ctx())).toHaveLength(5);
  });

  it('ranks a tight day after roomy ones', () => {
    const c = ctx({ busy: [span(MON, 420, 1020), span(MON, 1080, 1320)] });
    const all = offers(30, project, c);
    expect(all.map((o) => o.date)).not.toContain(MON);
    const six = offers(30, { kind: 'project', opens: SUN }, ctx({ busy: [span(SUN, 420, 540), span(SUN, 600, 1320)] }));
    expect(six[0]).toMatchObject({ date: SUN, start: 540, tight: true, note: 'Tight day' });
  });

  it('weighs today by its rest alone', () => {
    // Wednesday at 7:30pm after a full day: the rest of it is open, so it isn't tight.
    const c = ctx({ earliest: { date: WED, minutes: 1170 }, placed: [span(WED, 420, 1170)] });
    expect(offers(30, project, c).find((o) => o.date === WED)).toMatchObject({ start: 1170, tight: false });
  });

  it('wraps to earlier in the day when the evening is taken', () => {
    const all = offers(60, { kind: 'project', opens: FRI }, ctx({ busy: [span(FRI, 1020, 1320)] }));
    expect(all.find((o) => o.date === FRI)!.start).toBe(420);
  });

  it('leaves out stopped patterns', () => {
    const avoided = [{ day: 1 as const, from: 1020, to: 1440 }];
    const tue = () => offers(60, project, ctx({ avoided })).find((o) => o.date === TUE);
    expect(tue()!.start).toBeLessThan(1020);
    expect(offers(60, project, ctx()).find((o) => o.date === TUE)!.start).toBe(1020);
  });

  it('honours the hours of the kind of work', () => {
    const job: AvailabilityBlock = { days: 'weekdays', from: 420, to: 1320, projects: true, one_offs: false };
    const c = ctx({ availability: [NIGHT, job] });
    expect(offers(60, project, c).map((o) => o.date)).toEqual([SAT, SUN]);
    expect(offers(60, { kind: 'one_off' }, c)).toHaveLength(5);
  });

  it('is empty when nothing is open', () => {
    expect(offers(60, project, ctx({ busy: DAYS.map(allDay) }))).toEqual([]);
  });
});

describe('dayOffer', () => {
  it("is the start offers gives that day, even for a day too full to make offers' five", () => {
    const c = ctx({ placed: [span(MON, 600, 720), span(MON, 1020, 1080)] });
    expect(offers(60, project, c).map((o) => o.date)).not.toContain(MON);
    expect(dayOffer(MON, 60, project, c)).toBe(1080);
    expect(dayOffer(TUE, 60, project, c)).toBe(offers(60, project, c).find((o) => o.date === TUE)!.start);
  });

  it('is null when nothing that day fits', () => {
    expect(dayOffer(MON, 60, project, ctx({ busy: [allDay(MON)] }))).toBeNull();
  });
});

describe('defaultSlot', () => {
  it('takes the best offer, at most two hours', () => {
    expect(defaultSlot(60, project, ctx())).toEqual({ date: MON, start: 1020, end: 1080 });
    expect(defaultSlot(240, project, ctx())).toEqual({ date: MON, start: 1020, end: 1140 });
  });

  it('uses a shorter block rather than overlapping', () => {
    const everywhereBut = (from: number, to: number) => DAYS.flatMap((d) => [span(d, 420, from), span(d, to, 1320)]);
    expect(defaultSlot(120, project, ctx({ busy: everywhereBut(1020, 1110) }))).toMatchObject({ start: 1020, end: 1110 });
    expect(defaultSlot(120, project, ctx({ busy: everywhereBut(1020, 1080) }))).toMatchObject({ start: 1020, end: 1080 });
    expect(defaultSlot(120, project, ctx({ busy: everywhereBut(1020, 1050) }))).toMatchObject({ start: 1020, end: 1050 });
  });

  it('keeps a short estimate short', () => {
    expect(defaultSlot(15, project, ctx())).toMatchObject({ start: 1020, end: 1035 });
  });

  it('goes outside available hours before it would overlap', () => {
    const closed: AvailabilityBlock = { days: 'all', from: 0, to: 1440, projects: true, one_offs: true };
    const c = ctx({ availability: [closed], busy: [span(MON, 360, 390)] });
    expect(defaultSlot(120, project, c)).toEqual({ date: MON, start: 390, end: 420 });
  });

  it('returns nothing when every moment is taken', () => {
    expect(defaultSlot(60, project, ctx({ busy: DAYS.map(allDay) }))).toBeNull();
    expect(defaultSlot(0, project, ctx())).toBeNull();
  });
});

describe('otherOffers', () => {
  it('gives up to four other times at the same length', () => {
    const current = defaultSlot(60, project, ctx())!;
    const others = otherOffers(current, project, ctx());
    expect(others).toHaveLength(4);
    expect(others.some((o) => o.date === current.date && o.start === current.start)).toBe(false);
    expect(others.every((o) => o.end - o.start === 60)).toBe(true);
  });

  it('still gives four when the current time was dragged away from every offer', () => {
    expect(otherOffers(span(MON, 600, 660), project, ctx())).toHaveLength(4);
  });
});

describe('dragResult', () => {
  const b = span(MON, 1020, 1080);

  it('moves freely across days on the grid', () => {
    expect(dragResult(b, 'move', 1, 30, [])).toEqual({ date: TUE, start: 1050, end: 1110 });
    expect(dragResult(b, 'move', 0, 37, []).start).toBe(1050);
  });

  it('snaps to a suggested time within 20 minutes, on that day only', () => {
    expect(dragResult(b, 'move', 0, 95, [{ date: MON, start: 1125 }]).start).toBe(1125);
    expect(dragResult(b, 'move', 0, 60, [{ date: MON, start: 1125 }]).start).toBe(1080);
    expect(dragResult(b, 'move', 0, 90, [{ date: MON, start: 1130 }]).start).toBe(1130);
    expect(dragResult(b, 'move', 0, 90, [{ date: MON, start: 1131 }]).start).toBe(1110);
    expect(dragResult(b, 'move', 0, 95, [{ date: TUE, start: 1125 }]).start).toBe(1110);
  });

  it('resizes from the bottom edge and keeps 15 minutes', () => {
    expect(dragResult(b, 'resize', 0, 30, []).end).toBe(1110);
    expect(dragResult(b, 'resize', 0, -200, []).end).toBe(1035);
    expect(dragResult(b, 'resize', 0, 30, [])).toMatchObject({ date: MON, start: 1020 });
  });

  it('a click leaves an off-grid block alone', () => {
    expect(dragResult(span(THU, 450, 460), 'resize', 0, 2, []).end).toBe(460);
    expect(dragResult(span(THU, 451, 460), 'move', 0, 7, [])).toEqual({ date: THU, start: 451, end: 460 });
  });

  it('stays inside the week and the drawn day', () => {
    expect(dragResult(span(MON, 600, 660), 'move', -3, 0, []).date).toBe(MON);
    expect(dragResult(span(SUN, 600, 660), 'move', 5, 0, []).date).toBe(SUN);
    expect(dragResult(span(MON, 600, 660), 'move', 0, -600, []).start).toBe(360);
    expect(dragResult(span(MON, 600, 660), 'move', 0, 1000, [])).toMatchObject({ start: 1320, end: 1380 });
    expect(dragResult(span(MON, 600, 660), 'resize', 0, 1000, []).end).toBe(1380);
  });

  it('takes the range a shorter timeline draws', () => {
    expect(dragResult(span(MON, 600, 660), 'move', 0, -600, [], { from: 420, to: 1320 }).start).toBe(420);
    expect(dragResult(span(MON, 600, 660), 'resize', 0, 1000, [], { from: 420, to: 1320 }).end).toBe(1320);
  });

  it("doesn't end a block under way before the range starts, now", () => {
    expect(dragResult(span(MON, 780, 900), 'resize', 0, -120, [], { from: 840, to: 1380 }).end).toBe(840);
    expect(dragResult(span(MON, 780, 900), 'resize', 0, -45, [], { from: 840, to: 1380 }).end).toBe(855);
  });
});

describe('closestFit', () => {
  it('keeps a free time and moves a taken one to the nearest free one', () => {
    expect(closestFit(MON, 600, 60, 'project', ctx())).toBe(600);
    expect(closestFit(MON, 600, 60, 'project', ctx({ placed: [span(MON, 585, 645)] }))).toBe(645);
    expect(closestFit(MON, 600, 60, 'project', ctx({ placed: [span(MON, 570, 620)] }))).toBe(630);
  });

  it('is null when nothing fits that day', () => {
    expect(closestFit(MON, 600, 60, 'project', ctx({ busy: [allDay(MON)] }))).toBeNull();
  });
});

describe('slotNotes', () => {
  const none = ctx();

  it('says nothing about a clear time', () => {
    expect(slotNotes(span(MON, 600, 660), project, none)).toEqual([]);
  });

  it('allows but notes time outside available hours, for that kind of work', () => {
    const job: AvailabilityBlock = { days: 'weekdays', from: 540, to: 1020, projects: true, one_offs: false };
    const c = ctx({ availability: [job] });
    expect(slotNotes(span(MON, 600, 660), project, c)).toEqual(["That's outside your available hours."]);
    expect(slotNotes(span(MON, 600, 660), { kind: 'one_off' }, c)).toEqual([]);
  });

  it('notes an event and each block it lands on, but not itself', () => {
    const c = ctx({
      busy: [span(MON, 630, 690)],
      placed: [span(MON, 600, 660, { id: 'me', title: 'Me' }), span(MON, 640, 700, { id: 'b2', title: 'Paint the fence' })],
    });
    expect(slotNotes(span(MON, 600, 660, { id: 'me' }), project, c)).toEqual([
      'That overlaps busy time on your calendar.',
      'That overlaps Paint the fence.',
    ]);
  });

  it('notes a time after the due date or before the date it opens', () => {
    expect(slotNotes(span(THU, 600, 660), { kind: 'project', due: WED }, none)).toEqual(["That's after it's due."]);
    expect(slotNotes(span(WED, 600, 660), { kind: 'project', due: WED }, none)).toEqual([]);
    expect(slotNotes(span(MON, 600, 660), { kind: 'project', due: '2026-10-18' }, none)).toEqual([]);
    expect(slotNotes(span(MON, 600, 660), { kind: 'one_off', opens: WED }, none)).toEqual(["That's before its date."]);
  });
});

describe('placeRest', () => {
  it('places each task in order, splitting long ones into two-hour blocks', () => {
    const { placed, left } = placeRest(
      [
        { id: 'a', title: 'Write the report', minutes: 240, ...project },
        { id: 'b', title: 'Paint the fence', minutes: 45, kind: 'one_off' },
      ],
      ctx(),
    );
    expect(placed.filter((p) => p.id === 'a').map((p) => p.end - p.start)).toEqual([120, 120]);
    expect(placed.filter((p) => p.id === 'b').map((p) => p.end - p.start)).toEqual([45]);
    expect(left).toEqual([]);
    expect(placed[2]).toMatchObject({ title: 'Paint the fence', kind: 'one_off' });
  });

  it('never overlaps what it just placed or what was there', () => {
    const { placed } = placeRest(
      Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, minutes: 120, ...project })),
      ctx({ busy: [span(MON, 1020, 1140)] }),
    );
    const all = [...placed, span(MON, 1020, 1140)];
    for (const x of placed) {
      expect(all.some((y) => y !== x && y.date === x.date && y.start < x.end && x.start < y.end)).toBe(false);
    }
  });

  it('stays in available hours and hands back what does not fit', () => {
    const only = (d: string) => DAYS.filter((x) => x !== d).map(allDay);
    const c = ctx({ busy: [...only(MON), span(MON, 420, 1200)] });
    const { placed, left } = placeRest([{ id: 'a', title: 'Write the report', minutes: 240, ...project }], c);
    expect(placed.map((p) => [p.start, p.end])).toEqual([[1200, 1320]]);
    expect(left).toEqual([{ id: 'a', minutes: 120 }]);
  });

  it('skips work with no time on it, and does not change the context', () => {
    const c = ctx();
    expect(placeRest([{ id: 'a', title: 'Write the report', minutes: 0, ...project }], c)).toEqual({ placed: [], left: [] });
    placeRest([{ id: 'a', title: 'Write the report', minutes: 60, ...project }], c);
    expect(c.placed).toEqual([]);
  });
});

describe('placePractices', () => {
  const practice = (over: Partial<Practice> = {}): Practice => ({
    id: 'p1',
    title: 'Stretch',
    target_min: 30,
    per: 'day',
    preferred_times: [420],
    state: 'active',
    ...over,
  });

  it('places a daily practice at its preferred time on its days', () => {
    const out = placePractices([practice({ days: [0, 2] })], ctx());
    expect(out).toEqual([
      { practice_id: 'p1', date: MON, start: 420, end: 450 },
      { practice_id: 'p1', date: WED, start: 420, end: 450 },
    ]);
  });

  it('with no days set, it runs every day', () => {
    expect(placePractices([practice()], ctx()).map((s) => s.date)).toEqual(DAYS);
  });

  it('tries each preferred time, then the first open slot that day', () => {
    const c = ctx({ busy: [span(MON, 420, 450)] });
    const second = placePractices([practice({ days: [0], preferred_times: [420, 600] })], c);
    expect(second[0]).toMatchObject({ start: 600 });
    const first = placePractices([practice({ days: [0] })], c);
    expect(first[0]).toMatchObject({ start: 450 });
  });

  it('leaves the session out when the day has no room', () => {
    expect(placePractices([practice({ days: [0] })], ctx({ busy: [allDay(MON)] }))).toEqual([]);
  });

  it('splits a weekly target into sessions of up to an hour on the first days', () => {
    const out = placePractices([practice({ per: 'week', target_min: 150, days: [1, 3, 5, 6] })], ctx());
    expect(out.map((s) => [s.date, s.end - s.start])).toEqual([
      [TUE, 60],
      [THU, 60],
      [SAT, 60],
    ]);
  });

  it('puts a weekly practice on the days still ahead once the week has begun', () => {
    const thursday = ctx({ earliest: { date: THU, minutes: 600 } });
    const out = placePractices([practice({ per: 'week', target_min: 120 })], thursday);
    expect(out.map((s) => [s.date, s.start])).toEqual([
      [THU, 600],
      [FRI, 420],
    ]);
    const wednesday = ctx({ earliest: { date: WED, minutes: 600 } });
    expect(placePractices([practice({ per: 'week', target_min: 180 })], wednesday).map((s) => s.date)).toEqual([WED, THU, FRI]);
  });

  it('moves a weekly session to its next day when a day has no room', () => {
    const out = placePractices([practice({ per: 'week', target_min: 120, days: [0, 2, 4] })], ctx({ busy: [allDay(MON)] }));
    expect(out.map((s) => s.date)).toEqual([WED, FRI]);
  });

  it('two practices do not share a time', () => {
    const out = placePractices([practice({ days: [0] }), practice({ id: 'p2', title: 'Sketch', days: [0] })], ctx());
    expect(out.map((s) => [s.practice_id, s.start])).toEqual([
      ['p1', 420],
      ['p2', 450],
    ]);
  });

  it('leaves out paused, ended, deleted and skipped practices, and targets of nothing', () => {
    const list = [
      practice({ id: 'a', state: 'paused' }),
      practice({ id: 'b', state: 'ended' }),
      practice({ id: 'c', deleted_at: '2026-10-01T00:00:00Z' }),
      practice({ id: 'd' }),
      practice({ id: 'e', target_min: 0 }),
    ];
    expect(placePractices(list, ctx(), { skipped: ['d'] })).toEqual([]);
  });

  it('leaves an edited session alone, and works around it', () => {
    const edited = span(MON, 420, 450, { id: 'b1', kind: 'practice' });
    const out = placePractices([practice({ id: 'p1', days: [0, 1] })], ctx({ placed: [edited] }), {
      edited: [{ practice_id: 'p1', date: MON }],
    });
    expect(out.map((s) => s.date)).toEqual([TUE]);
  });
});

describe('slotContext', () => {
  const clock = fixedClock('2026-11-02T18:00:00Z', 'America/Chicago');
  const sources: CalendarSource[] = [
    { id: 's1', google_id: 'work', name: 'Work', mode: 'block' },
    { id: 's2', google_id: 'family', name: 'Family', mode: 'info' },
    { id: 's3', google_id: 'other', name: 'Other', mode: 'ignore' },
  ];
  const event = (id: string, calendar: string, start: string, end: string) => ({ id, calendar, title: id, start, end });
  const base = { week: MON, availability: [NIGHT], avoided: [], sources, calendar: null, blocks: [], clock };

  it('reads now in the local zone', () => {
    expect(slotContext(base).earliest).toEqual({ date: MON, minutes: 720 });
  });

  it('counts busy events by the same rule as conflicts: blocking or new calendars, and no all-day events', () => {
    const c = slotContext({
      ...base,
      calendar: {
        id: 'calendar',
        connected: true,
        events: [
          event('e1', 'work', '2026-11-03T15:00:00Z', '2026-11-03T16:00:00Z'),
          event('e2', 'family', '2026-11-03T15:00:00Z', '2026-11-03T16:00:00Z'),
          event('e3', 'other', '2026-11-03T15:00:00Z', '2026-11-03T16:00:00Z'),
          event('e4', 'unknown', '2026-11-03T17:00:00Z', '2026-11-03T18:00:00Z'),
          { ...event('e5', 'work', '2026-11-04T06:00:00Z', '2026-11-05T06:00:00Z'), all_day: true },
        ],
      },
    });
    expect(c.busy).toEqual([
      { date: TUE, start: 540, end: 600, id: 'e1', title: 'e1' },
      { date: TUE, start: 660, end: 720, id: 'e4', title: 'e4' },
    ]);
  });

  it('splits an event over midnight and clips to the week', () => {
    const c = slotContext({
      ...base,
      calendar: {
        id: 'calendar',
        connected: true,
        events: [
          event('late', 'work', '2026-11-03T05:00:00Z', '2026-11-03T07:00:00Z'),
          event('before', 'work', '2026-10-20T15:00:00Z', '2026-10-20T16:00:00Z'),
          event('after', 'work', '2026-11-20T15:00:00Z', '2026-11-20T16:00:00Z'),
          event('long', 'work', '2026-10-01T00:00:00Z', '2026-11-02T07:00:00Z'),
          event('bad', 'work', '2026-11-03T07:00:00Z', '2026-11-03T05:00:00Z'),
        ],
      },
    });
    expect(c.busy.map((s) => [s.id, s.date, s.start, s.end])).toEqual([
      ['late', MON, 1380, 1440],
      ['late', TUE, 0, 60],
      ['long', MON, 0, 60],
    ]);
  });

  it('turns blocks into spans with their kind, leaving out cancelled and deleted ones', () => {
    const c = slotContext({
      ...base,
      blocks: [
        { id: 'b1', start: '2026-11-03T15:00:00Z', end: '2026-11-03T16:00:00Z', title: 'Write the report', task_kind: 'project' },
        { id: 'b2', start: '2026-11-03T17:00:00Z', end: '2026-11-03T18:00:00Z', title: 'Stretch', practice_id: 'p1' },
        { id: 'b3', start: '2026-11-03T19:00:00Z', end: '2026-11-03T20:00:00Z', task_kind: 'one_off', cancelled: true },
        { id: 'b4', start: '2026-11-03T21:00:00Z', end: '2026-11-03T22:00:00Z', task_kind: 'one_off', deleted_at: '2026-11-01T00:00:00Z' },
      ],
    });
    expect(c.placed).toEqual([
      { date: TUE, start: 540, end: 600, id: 'b1', title: 'Write the report', kind: 'project' },
      { date: TUE, start: 660, end: 720, id: 'b2', title: 'Stretch', kind: 'practice' },
    ]);
  });
});

describe('infoSpans', () => {
  it('cuts events on information calendars into day spans, which planning leaves out of busy time', () => {
    const clock = fixedClock('2026-11-02T18:00:00Z', 'America/Chicago');
    const sources: CalendarSource[] = [
      { id: 's1', google_id: 'work', name: 'Work', mode: 'block' },
      { id: 's2', google_id: 'family', name: 'Family', mode: 'info' },
    ];
    const event = (id: string, calendar: string, start: string, end: string) => ({ id, calendar, title: id, start, end });
    const calendar = {
      id: 'calendar',
      connected: true,
      events: [
        event('e1', 'work', '2026-11-03T15:00:00Z', '2026-11-03T16:00:00Z'),
        event('concert', 'family', '2026-11-03T23:30:00Z', '2026-11-04T00:30:00Z'),
        { ...event('trip', 'family', '2026-11-04T06:00:00Z', '2026-11-05T06:00:00Z'), all_day: true },
        event('later', 'family', '2026-11-20T15:00:00Z', '2026-11-20T16:00:00Z'),
      ],
    };
    expect(infoSpans({ week: MON, calendar, sources, clock })).toEqual([{ date: TUE, start: 1050, end: 1110, id: 'concert', title: 'concert' }]);
    expect(infoSpans({ week: MON, calendar: null, sources, clock })).toEqual([]);
  });
});

describe('slotInstants', () => {
  it('gives UTC instants that keep the local time across daylight saving', () => {
    expect(slotInstants(span('2026-10-30', 1020, 1080), 'America/Chicago')).toEqual({
      start: '2026-10-30T22:00:00Z',
      end: '2026-10-30T23:00:00Z',
    });
    expect(slotInstants(span(MON, 1020, 1080), 'America/Chicago')).toEqual({
      start: '2026-11-02T23:00:00Z',
      end: '2026-11-03T00:00:00Z',
    });
  });

  it('ends at the next midnight for a block that runs to the end of the day', () => {
    expect(slotInstants(span(MON, 1380, 1440), 'UTC').end).toBe('2026-11-03T00:00:00Z');
  });
});
