// Seeds and opens the planning flow in tests. Tests import this file; the app never does.

import { vi } from 'vitest';
import type { Writer } from '../../../core/records';
import { renderScreen } from '../../app/testing';
import type { HarnessOptions } from '../../app/testing';

// The harness clock is Monday Nov 2 2026, 2pm in Chicago.
export async function seedWeek(w: Writer) {
  await w.create('project', { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-15', weekly_aim: 240 }, 'report');
  await w.create('milestone', { project_id: 'report', title: 'Gather notes', due: '2026-10-18' }, 'm1');
  await w.create('milestone', { project_id: 'report', title: 'Draft chapters', due: '2026-11-09' }, 'm2');
  await w.create('task', { kind: 'project', project_id: 'report', milestone_id: 'm1', title: 'Collect the sources', estimate_min: 120 }, 't1');
  await w.create('task', { kind: 'project', project_id: 'report', milestone_id: 'm2', title: 'Write chapter one', estimate_min: 240 }, 't2');
  await w.create('project', { title: 'Learn to bake bread', state: 'active', start: '2026-10-15', end: '2027-02-28', weekly_aim: 120 }, 'bread');
  await w.create('milestone', { project_id: 'bread', title: 'Shape the first loaf', due: '2026-12-01' }, 'm3');
  await w.create('task', { kind: 'project', project_id: 'bread', milestone_id: 'm3', title: 'Bake a test loaf', estimate_min: 180 }, 'b1');
  await w.create('project', { title: 'Plan the garden', state: 'paused', start: '2026-09-01', end: '2027-03-01' }, 'garden');
  await w.create('task', { kind: 'one_off', title: 'Paint the fence', estimate_min: 90, schedule: { type: 'once', from: '2026-11-04' } }, 'o1');
  await w.create('task', { kind: 'one_off', title: 'Fix the gate', estimate_min: 60, schedule: { type: 'once' } }, 'o2');
}

export function openPlanning(options: HarnessOptions & { step?: number; params?: Record<string, string>; close?(): void } = {}) {
  if (options.step !== undefined) localStorage.setItem(`multiscale.planning.step.${options.params?.week ?? '2026-11-02'}`, String(options.step));
  return renderScreen('planning', { presentation: 'flow', ...options, close: options.close ?? vi.fn() });
}
