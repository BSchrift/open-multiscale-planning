import { afterEach, describe, expect, it } from 'vitest';
import type { PlanChange } from '../../../core/plan';
import type { PlanProgress } from '../../../core/types';
import { adoptProgress, beginFlow, goToStep, logChange, markDone, progressOf, readFlow, stepOf, unlogChange, withProgress, writeFlow } from './flowState';
import type { StepKey } from './flowState';

afterEach(() => localStorage.clear());

const FIVE: StepKey[] = ['goals', 'practices', 'projects', 'inbox', 'finish'];
const SIX: StepKey[] = ['start', ...FIVE];
const stored = () => JSON.parse(localStorage.getItem('multiscale.plan.flow')!) as Record<string, unknown>;
const reverse = (id: string): PlanChange => ({ writes: [{ type: 'milestone', id, fields: { due: null } }] });

describe('planning ahead, kept on this device', () => {
  // Released apps number their steps Look back or Start, Practices, Projects, Time and Finish.
  it.each([
    [0, FIVE, 'goals'],
    [0, SIX, 'start'],
    [1, FIVE, 'practices'],
    [2, FIVE, 'projects'],
    [3, FIVE, 'finish'],
    [4, FIVE, 'finish'],
  ] as const)('maps a released app’s step %s, with no key, to a step', (step, steps, key) => {
    localStorage.setItem('multiscale.plan.flow', JSON.stringify({ begun: true, step }));
    expect(stepOf(readFlow(), steps)).toBe(key);
  });

  it.each([
    ['start', 0],
    ['goals', 0],
    ['practices', 1],
    ['projects', 2],
    ['inbox', 2],
    ['finish', 4],
  ] as const)('writes %s with the number a released app reads, %s', (key, step) => {
    goToStep(key);
    expect(stored()).toMatchObject({ stepKey: key, step });
    expect(stepOf(readFlow(), SIX)).toBe(key);
  });

  it('follows a released app that moved the step since, and a key no longer on offer', () => {
    goToStep('inbox');
    writeFlow({ step: 1 });
    expect(stepOf(readFlow(), FIVE)).toBe('practices');
    goToStep('start');
    expect(stepOf(readFlow(), FIVE)).toBe('goals');
  });

  it('notes each step opened, and begins afresh with nothing done or seen', () => {
    goToStep('projects');
    goToStep('finish');
    writeFlow({ done: ['goals'], inbox: ['i1'] });
    expect(readFlow().seen).toEqual(['projects', 'finish']);
    // A released app's Finish resets only the fields it knows, so beginning again clears the rest.
    writeFlow({ begun: false, step: 0, note: '', changes: [] });
    beginFlow();
    expect(readFlow()).toMatchObject({ begun: true, step: 0, stepKey: null, done: [], seen: [], inbox: null });
  });

  it('keeps each change’s reverse, and its Undo puts back the line it replaced', () => {
    logChange('ms-m1', 'Added Make a starter to this plan, by Mar 31.', reverse('m1'));
    logChange('aim-p1', 'Weekly aim changed: Bake a sourdough loaf');
    logChange('ms-m1', 'Make a starter, Feb 2.', reverse('m1b'));
    const [aim, moved] = readFlow().changes;
    expect(aim).toEqual({ key: 'aim-p1', text: 'Weekly aim changed: Bake a sourdough loaf' });
    expect(moved).toMatchObject({ key: 'ms-m1', text: 'Make a starter, Feb 2.', reverse: reverse('m1b'), prev: { text: 'Added Make a starter to this plan, by Mar 31.' } });
    // Read back as a remount would, from storage.
    localStorage.setItem('multiscale.plan.flow', localStorage.getItem('multiscale.plan.flow')!);
    unlogChange('ms-m1');
    expect(readFlow().changes.map((c) => c.text)).toEqual(['Weekly aim changed: Bake a sourdough loaf', 'Added Make a starter to this plan, by Mar 31.']);
    expect(readFlow().changes[1]?.reverse).toEqual(reverse('m1'));
    unlogChange('ms-m1');
    expect(readFlow().changes.map((c) => c.key)).toEqual(['aim-p1']);
  });

  it('keeps the first reverse while a change goes on, as a slider does', () => {
    logChange('aim-p1', 'Weekly aim changed: Bake a sourdough loaf', reverse('p1'), true);
    logChange('aim-p1', 'Weekly aim changed: Bake a sourdough loaf', reverse('p1b'), true);
    expect(readFlow().changes).toEqual([{ key: 'aim-p1', text: 'Weekly aim changed: Bake a sourdough loaf', reverse: reverse('p1'), prev: null }]);
  });
});

describe('planning ahead, shared with every device', () => {
  const ON = '2026-12-26';
  const quarters = { plan_cadence: { every: 1, unit: 'quarters' as const }, plan_stretch: { last_planned: '2026-10-01' } };
  const progress = (fields: Partial<PlanProgress> = {}): PlanProgress => ({
    for: '2027-01-01',
    step: 'projects',
    done: ['goals', 'practices'],
    seen: ['goals', 'practices', 'projects'],
    begun_on: '2026-12-24',
    note: 'Fewer projects',
    at: '2026-12-26T10:00:00.000Z',
    ...fields,
  });

  it('brings in another device’s progress where this one has none, at its step, in both numberings', () => {
    const flow = withProgress(readFlow(), { ...quarters, plan_progress: progress() }, ON);
    expect(flow).toMatchObject({ begun: true, for: '2027-01-01', stepKey: 'projects', step: 2, done: ['goals', 'practices'], begunOn: '2026-12-24', note: 'Fewer projects' });
    expect(stepOf(flow, FIVE)).toBe('projects');
    // Reading writes nothing; adopting does.
    expect(localStorage.getItem('multiscale.plan.flow')).toBeNull();
    adoptProgress({ ...quarters, plan_progress: progress() }, ON);
    expect(stored()).toMatchObject({ begun: true, stepKey: 'projects', step: 2 });
  });

  it('keeps this device’s own when it changed since, and the newer of the two otherwise', () => {
    writeFlow({ begun: true, for: '2027-01-01', stepKey: 'inbox', step: 2, done: ['goals'], at: '2026-12-26T11:00:00.000Z' });
    expect(withProgress(readFlow(), { ...quarters, plan_progress: progress() }, ON).stepKey).toBe('inbox');
    expect(withProgress(readFlow(), { ...quarters, plan_progress: progress({ step: 'finish', at: '2026-12-26T12:00:00.000Z' }) }, ON)).toMatchObject({
      stepKey: 'finish',
      step: 4,
      done: ['goals', 'practices'],
    });
  });

  it('is over once its stretch is planned, on any device, or once a later stretch has begun', () => {
    writeFlow({ begun: true, for: '2027-01-01', stepKey: 'inbox', step: 2, changes: [{ key: 'a', text: 'Added goal Keep fit.' }], at: '2026-12-26T11:00:00.000Z' });
    const planned = { ...quarters, plan_stretch: { last_planned: '2027-01-01' } };
    expect(withProgress(readFlow(), { ...planned, plan_progress: progress() }, ON)).toMatchObject({ begun: false, stepKey: null, changes: [] });
    localStorage.clear();
    expect(withProgress(readFlow(), { ...quarters, plan_progress: progress() }, '2027-04-02').begun).toBe(false);
  });

  it('starts another stretch’s planning without this device’s changes, and skips a step it doesn’t know', () => {
    writeFlow({ begun: true, for: '2026-11-02', stepKey: 'goals', step: 0, changes: [{ key: 'a', text: 'Added goal Keep fit.' }], at: '2026-11-02T10:00:00.000Z' });
    expect(withProgress(readFlow(), { ...quarters, plan_progress: progress() }, ON)).toMatchObject({ stepKey: 'projects', changes: [], inbox: null });
    expect(withProgress(readFlow(), { ...quarters, plan_progress: progress({ step: 'review' }) }, ON).stepKey).toBe('goals');
  });

  it('shares its step, done marks, the steps opened, the note and when they changed, once it knows its stretch', () => {
    beginFlow();
    expect(progressOf(readFlow())).toBeNull();
    writeFlow({ for: '2027-01-01', begunOn: '2026-12-24', note: 'Fewer projects' });
    goToStep('practices');
    markDone('goals');
    expect(progressOf(readFlow())).toEqual({
      for: '2027-01-01',
      step: 'practices',
      done: ['goals'],
      seen: ['practices'],
      begun_on: '2026-12-24',
      note: 'Fewer projects',
      at: readFlow().at,
    });
    expect(readFlow().at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});
