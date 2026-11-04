import { describe, expect, it } from 'vitest';
import { cadenceBefore, currentStretch, nextStretch, pinStretch, planningDue, planningOpens, planStretch, stretchError } from './plan';
import type { CadenceSettings } from './plan';
import type { Milestone } from './types';

const quarters: CadenceSettings = { plan_cadence: { every: 1, unit: 'quarters' }, plan_stretch: {} };
const ON = '2026-11-02';
const NEXT = { start: '2027-01-01', end: '2027-03-31' };

const milestones: Milestone[] = [
  { id: 'm1', project_id: 'p1', title: 'First loaf', stretch: '2027-01-01' },
  { id: 'm2', project_id: 'p1', title: 'Share a loaf', due: '2027-02-10' },
  { id: 'm3', project_id: 'p1', title: 'Gone', stretch: '2027-01-01', deleted_at: '2026-10-01T00:00:00Z' },
];

describe('pinStretch', () => {
  it('gives the next stretch new dates and lets the cadence carry on after it', () => {
    const { settings, change } = pinStretch(quarters, milestones, NEXT, { start: '2027-01-01', end: '2027-02-15' });
    expect(nextStretch(settings, ON)).toEqual({ start: '2027-01-01', end: '2027-02-15' });
    expect(currentStretch(settings, ON)).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(currentStretch(settings, '2027-02-20')).toEqual({ start: '2027-02-16', end: '2027-03-31' });
    expect(change.writes).toEqual([]);
  });

  it('moves milestones added to the stretch with its start, and ends the current one the day before', () => {
    const { settings, change } = pinStretch({ ...quarters, plan_stretch: { last_planned: '2027-01-01' } }, milestones, NEXT, {
      start: '2026-12-15',
      end: '2027-03-31',
    });
    expect(currentStretch(settings, ON)).toEqual({ start: '2026-10-01', end: '2026-12-14' });
    expect(settings.plan_stretch.last_planned).toBe('2026-12-15');
    expect(change.writes).toEqual([{ type: 'milestone', id: 'm1', fields: { stretch: '2026-12-15' } }]);
  });

  it('replaces dates pinned for the same stretch rather than stacking them', () => {
    const once = pinStretch(quarters, milestones, NEXT, { start: '2027-01-01', end: '2027-02-15' }).settings;
    const twice = pinStretch(once, milestones, { start: '2027-01-01', end: '2027-02-15' }, { start: '2027-01-01', end: '2027-02-28' }).settings;
    expect(twice.plan_stretch.one_offs).toEqual([{ start: '2027-01-01', end: '2027-02-28' }]);
  });
});

describe('stretchError', () => {
  it('needs a start after today and an end on or after it', () => {
    expect(stretchError({ start: '2027-01-01', end: '2027-02-15' }, ON)).toBeNull();
    expect(stretchError({ start: ON, end: '2027-02-15' }, ON)).toBe('Start after today.');
    expect(stretchError({ start: '2027-01-01', end: '2026-12-31' }, ON)).toBe('End on or after the start.');
    expect(stretchError({ start: 'nope', end: '2026-12-31' }, ON)).toBe('Pick a start and an end.');
  });

  it('keeps a first stretch holding today', () => {
    expect(stretchError({ start: ON, end: '2027-03-31' }, ON, true)).toBeNull();
    expect(stretchError({ start: '2026-10-01', end: '2026-12-31' }, ON, true)).toBeNull();
    expect(stretchError({ start: '2026-11-03', end: '2026-12-31' }, ON, true)).toBe('Start today or earlier.');
    expect(stretchError({ start: '2026-10-01', end: '2026-11-01' }, ON, true)).toBe('End today or later.');
  });
});

describe('a first plan', () => {
  const CUR = { start: '2026-10-01', end: '2026-12-31' };

  it('is for the stretch that holds today, from today to its end, not the next one', () => {
    expect(planStretch(quarters, ON, true)).toEqual({ start: ON, end: '2026-12-31' });
    expect(planStretch(quarters, ON)).toEqual(CUR);
  });

  it('gives a late start a short first stretch, and diamonds keep to it rather than the next', () => {
    expect(planStretch(quarters, '2026-12-26', true)).toEqual({ start: '2026-12-26', end: '2026-12-31' });
    expect(planStretch(quarters, '2026-12-26')).toEqual(CUR);
  });

  it('keeps the start it was pinned with on later days, with milestones already in today’s stretch', () => {
    const inCur: Milestone = { id: 'm4', project_id: 'p1', title: 'Feed the starter', stretch: CUR.start };
    const { settings, change } = pinStretch(quarters, [inCur], CUR, { start: ON, end: CUR.end });
    expect(planStretch(settings, '2026-11-05', true)).toEqual({ start: ON, end: CUR.end });
    expect(planStretch(settings, '2026-11-05')).toEqual({ start: ON, end: CUR.end });
    expect(change.writes).toEqual([{ type: 'milestone', id: 'm4', fields: { stretch: ON } }]);
  });

  it('is due from the first day, rather than only in the stretch’s last week', () => {
    expect(planningDue(quarters, ON)).toBe(true);
    expect(planningDue(quarters, '2026-12-23')).toBe(true);
    // With no cadence there are no prompts, and with none started yet there's nothing to plan.
    expect(planningDue({ plan_cadence: null, plan_stretch: { one_offs: [CUR] } }, ON)).toBe(false);
    expect(planningDue({ plan_cadence: { every: 1, unit: 'quarters', anchor: '2027-01-01' }, plan_stretch: {} }, ON)).toBe(false);
  });

  it('started late and finished, isn’t asked for again until the next day', () => {
    const late = { start: '2026-12-24', end: CUR.end };
    const saved: CadenceSettings = { ...quarters, plan_stretch: { one_offs: [late], last_planned: late.start } };
    expect(planningOpens(late)).toBe('2026-12-25');
    expect(planningDue(saved, '2026-12-24')).toBe(false);
    expect(planStretch(saved, '2026-12-24')).toEqual(late);
    expect(planningDue(saved, '2026-12-25')).toBe(true);
    expect(planStretch(saved, '2026-12-25')).toEqual(NEXT);
    // Otherwise it opens a week before the end, and a stretch of one day opens it on that day, since it ends then.
    expect(planningOpens(CUR)).toBe('2026-12-24');
    expect(planningOpens({ start: CUR.end, end: CUR.end })).toBe(CUR.end);
    expect(planningDue({ ...quarters, plan_stretch: { one_offs: [{ start: CUR.end, end: CUR.end }], last_planned: CUR.end } }, CUR.end)).toBe(true);
  });

  it('once saved, works as before: planning comes near its end, for the stretch after', () => {
    const saved: CadenceSettings = { ...quarters, plan_stretch: { one_offs: [{ start: ON, end: CUR.end }], last_planned: ON } };
    expect(planStretch(saved, ON)).toEqual({ start: ON, end: CUR.end });
    expect(planStretch(saved, ON, true)).toEqual(NEXT);
    expect(planningDue(saved, '2026-12-23')).toBe(false);
    expect(planningDue(saved, '2026-12-24')).toBe(true);
    expect(nextStretch(saved, '2026-12-24')).toEqual(NEXT);
  });
});

describe('cadenceBefore', () => {
  it('is one cadence back: a quarter by default, else its weeks or months', () => {
    expect(cadenceBefore(quarters, ON)).toBe('2026-08-02');
    expect(cadenceBefore({ plan_cadence: null, plan_stretch: {} }, ON)).toBe('2026-08-02');
    expect(cadenceBefore({ plan_cadence: { every: 2, unit: 'weeks' }, plan_stretch: {} }, ON)).toBe('2026-10-19');
    expect(cadenceBefore({ plan_cadence: { every: 1, unit: 'months' }, plan_stretch: {} }, '2026-03-31')).toBe('2026-02-28');
  });
});
