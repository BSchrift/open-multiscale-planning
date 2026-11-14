// The proposal's sample week for Pick, near enough: Monday Nov 16, this stretch Oct 1 to Dec 31, planned. Every way a
// task could go unseen has a project here. pick.spec.ts walks them; the unit tests use the same shape.

import type { Seed } from './seed';

export const NOW = new Date('2026-11-16T20:00:00Z');
export const WEEK = '2026-11-16';

const task = (id: string, project: string, milestone: string | null, title: string, estimate: number | null, extra: Record<string, unknown> = {}): Seed => ({
  type: 'task',
  id,
  fields: { kind: 'project', project_id: project, milestone_id: milestone, title, estimate_min: estimate, ...extra },
});
const pick = (task: string, minutes: number): Seed => ({ type: 'week_pick', id: `pick:${WEEK}:${task}`, fields: { week_start: WEEK, task_id: task, minutes } });

export const SAMPLE: Seed[] = [
  { type: 'settings', id: 'settings', fields: { plan_stretch: { last_planned: '2026-10-01' } } },
  // Overdue from the last stretch.
  { type: 'project', id: 'photo', fields: { title: 'Sort the photo albums', state: 'active', start: '2026-07-01', end: '2027-01-31' } },
  { type: 'milestone', id: 'scan', fields: { project_id: 'photo', title: 'Scan the 1990s albums', due: '2026-09-28' } },
  task('p1', 'photo', 'scan', 'Scan the first box', 60, { done_at: '2026-09-20T15:00:00Z' }),
  task('p2', 'photo', 'scan', 'Scan the last box', 90),
  // In this stretch.
  { type: 'project', id: 'report', fields: { title: 'Write the quarterly report', state: 'active', start: '2026-10-01', end: '2026-12-15', weekly_aim: 240 } },
  { type: 'milestone', id: 'notes', fields: { project_id: 'report', title: 'Gather notes', due: '2026-11-09' } },
  { type: 'milestone', id: 'draft', fields: { project_id: 'report', title: 'Draft chapters', due: '2026-11-27' } },
  { type: 'milestone', id: 'review', fields: { project_id: 'report', title: 'Final review', due: '2026-12-11' } },
  task('r1', 'report', 'notes', 'Collect the sources', 120),
  task('r2', 'report', 'notes', 'Interview the finance team', 60),
  task('r3', 'report', 'draft', 'Write chapter one', 240),
  task('r4', 'report', 'draft', 'Write chapter two', 180),
  task('r5', 'report', 'draft', 'Make the charts', null),
  task('r6', 'report', 'review', 'Send the draft to Priya for review', 30),
  pick('r1', 120),
  pick('r3', 120),
  // In this stretch, with a milestone after it, and a task that wasn't done in its block last week.
  { type: 'project', id: 'kitchen', fields: { title: 'Kitchen renovation', state: 'active', start: '2026-09-01', end: '2027-03-31' } },
  { type: 'milestone', id: 'cabinets', fields: { project_id: 'kitchen', title: 'Pick the cabinets', due: '2026-11-30' } },
  { type: 'milestone', id: 'fitters', fields: { project_id: 'kitchen', title: 'Book the fitters', due: '2027-01-15' } },
  task('k0', 'kitchen', null, 'Strip the old units', 600, { done_at: '2026-10-10T15:00:00Z' }),
  task('k1', 'kitchen', 'cabinets', 'Visit the showroom', 120),
  task('k2', 'kitchen', 'cabinets', 'Get three quotes', 90),
  task('k3', 'kitchen', 'cabinets', 'Measure the walls', 60),
  task('k4', 'kitchen', 'fitters', 'Ask neighbours for fitter recommendations', 30),
  { type: 'time_block', id: 'tbk3', fields: { task_id: 'k3', start: '2026-11-12T23:00:00Z', end: '2026-11-13T00:00:00Z', tz: 'America/Chicago' } },
  { type: 'block_outcome', id: 'outcome:tbk3', fields: { result: 'not', answered_at: '2026-11-13T00:05:00Z' } },
  // In this stretch, on track.
  { type: 'project', id: 'bread', fields: { title: 'Learn to bake bread', state: 'active', start: '2026-10-15', end: '2027-02-28', weekly_aim: 120 } },
  { type: 'milestone', id: 'loaf', fields: { project_id: 'bread', title: 'First sourdough loaf', due: '2026-12-01' } },
  task('b0', 'bread', null, 'Read about bread', 300, { done_at: '2026-10-20T15:00:00Z' }),
  task('b1', 'bread', 'loaf', 'Buy a banneton', 15),
  task('b2', 'bread', 'loaf', 'Bake a test loaf', 90),
  pick('b1', 15),
  // Outside this stretch, with a task in the week.
  { type: 'project', id: 'shed', fields: { title: 'Build the garden shed', state: 'active', start: '2026-09-01', end: '2027-04-30' } },
  { type: 'milestone', id: 'base', fields: { project_id: 'shed', title: 'Lay the base', due: '2027-02-06' } },
  { type: 'milestone', id: 'walls', fields: { project_id: 'shed', title: 'Raise the walls', due: '2027-03-20' } },
  task('s1', 'shed', 'base', 'Draw the plans', 120),
  task('s2', 'shed', 'base', 'Order the timber', 30),
  task('s3', 'shed', 'walls', 'Buy the cladding', 60),
  task('s4', 'shed', 'walls', 'Book a helper', 30),
  pick('s1', 60),
  // Outside this stretch, on track, and nothing of it needs you.
  { type: 'project', id: 'cookbook', fields: { title: 'Write a cookbook', state: 'active', start: '2026-06-01', end: '2027-05-31' } },
  { type: 'milestone', id: 'recipes', fields: { project_id: 'cookbook', title: 'Draft ten recipes', due: '2027-03-01' } },
  task('c0', 'cookbook', null, 'Plan the book', 900, { done_at: '2026-08-01T15:00:00Z' }),
  task('c1', 'cookbook', 'recipes', 'List the recipes', 60),
  task('c2', 'cookbook', 'recipes', 'Test the bread recipe', 120),
  task('c3', 'cookbook', 'recipes', 'Photograph the dishes', 180),
  task('c4', 'cookbook', 'recipes', 'Find a printer', 30),
  // Behind pace outside this stretch, with an undated milestone and a task with no estimate.
  { type: 'project', id: 'guitar', fields: { title: 'Learn the guitar', state: 'active', start: '2026-05-01', end: '2027-01-31' } },
  { type: 'milestone', id: 'songs', fields: { project_id: 'guitar', title: 'Learn three songs' } },
  task('g1', 'guitar', 'songs', 'Practise the chords', 30),
  task('g2', 'guitar', 'songs', 'Learn the first song', 60),
  task('g3', 'guitar', 'songs', 'Record it', null),
  // Made since this stretch was planned, and in no stretch's plan yet.
  { type: 'project', id: 'garden', fields: { title: 'Plan the garden', state: 'active', start: '2026-09-01', end: '2027-02-28', added_on: '2026-11-10' } },
  task('pg1', 'garden', null, 'Choose the beds', 60),
  task('pg2', 'garden', null, 'Measure the plot', null),
  // Paused, so it can't be planned now.
  { type: 'project', id: 'spanish', fields: { title: 'Learn Spanish', state: 'paused', start: '2026-03-01', end: '2027-03-01' } },
  task('sp1', 'spanish', null, 'Book a tutor', 60),
  // One offs, and two still in the Inbox.
  { type: 'task', id: 'o1', fields: { kind: 'one_off', title: 'Renew the passport', estimate_min: 45, schedule: { type: 'once', from: '2026-11-18' } } },
  { type: 'task', id: 'o2', fields: { kind: 'one_off', title: 'Pay the water bill', estimate_min: 20, schedule: { type: 'once', from: '2026-11-20' } } },
  { type: 'task', id: 'o3', fields: { kind: 'one_off', title: 'Paint the fence', estimate_min: 90, schedule: { type: 'once' } } },
  pick('o1', 45),
  // Taken out of the week, so it stays out and is counted as due.
  { type: 'week_pick', id: `pick:${WEEK}:o2`, fields: { week_start: WEEK, task_id: 'o2', minutes: 20, deleted_at: '2026-11-16T19:00:00Z' } },
  { type: 'task', id: 'i1', fields: { kind: 'inbox', title: 'Call the bank' } },
  { type: 'task', id: 'i2', fields: { kind: 'inbox', title: 'Fix the shelf' } },
];
