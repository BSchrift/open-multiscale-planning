// Pick's rule for this stretch, on the proposal's sample week: filters hide only what can wait. Each walk case from
// "How nothing gets missed" has a test here; the focus and layout parts are in pick.test.tsx and the e2e run.

import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../../../core/clock';
import { openDb } from '../../../../core/db';
import { outcomeId, transact, updateSettings, weekPickId } from '../../../../core/records';
import type { Writer } from '../../../../core/records';
import { nodeSqliteDriver } from '../../../../platform/node-sqlite';
import { loadPlanning, weekModel } from '../model';
import { needWords, pickModel } from './model';
import type { PickView } from './model';

// Monday Nov 16, 2pm in Chicago. This stretch is Oct 1 to Dec 31, planned.
const NOW = '2026-11-16T20:00:00Z';
const WEEK = '2026-11-16';

async function viewOf(seed: (w: Writer) => Promise<void>, now = NOW, week = WEEK): Promise<PickView> {
  const clock = fixedClock(now, 'America/Chicago');
  const db = await openDb(nodeSqliteDriver());
  await transact(db, clock, seed);
  const data = await loadPlanning(db, clock, week);
  return pickModel(data, weekModel(data, clock), clock);
}

const pick = (w: Writer, week: string, task: string, minutes: number) => w.create('week_pick', { week_start: week, task_id: task, minutes }, weekPickId(week, task));
const task = (w: Writer, id: string, project: string, milestone: string | null, title: string, estimate: number | null, extra = {}) =>
  w.create('task', { kind: 'project', project_id: project, milestone_id: milestone, title, estimate_min: estimate, ...extra }, id);

/** The proposal's sample week, near enough: every way a task could go unseen has a project here. */
async function sample(w: Writer) {
  await updateSettings(w, { plan_stretch: { last_planned: '2026-10-01' } });
  // Overdue from the last stretch: its milestone was due Sep 28, and nothing of it is in this stretch's plan.
  await w.create('project', { title: 'Sort the photo albums', state: 'active', start: '2026-07-01', end: '2027-01-31' }, 'photo');
  await w.create('milestone', { project_id: 'photo', title: 'Scan the 1990s albums', due: '2026-09-28' }, 'scan');
  await task(w, 'p1', 'photo', 'scan', 'Scan the first box', 60, { done_at: '2026-09-20T15:00:00Z' });
  await task(w, 'p2', 'photo', 'scan', 'Scan the last box', 90);
  // In this stretch: an overdue milestone, one later in it, and one with no date.
  await w.create('project', { title: 'Write the quarterly report', state: 'active', start: '2026-10-01', end: '2026-12-15' }, 'report');
  await w.create('milestone', { project_id: 'report', title: 'Gather notes', due: '2026-11-09' }, 'notes');
  await w.create('milestone', { project_id: 'report', title: 'Draft chapters', due: '2026-11-27' }, 'draft');
  await w.create('milestone', { project_id: 'report', title: 'Print and bind' }, 'print');
  await task(w, 'r1', 'report', 'notes', 'Collect the sources', 120);
  await task(w, 'r2', 'report', 'notes', 'Interview the finance team', 60);
  await task(w, 'r3', 'report', 'draft', 'Write chapter one', 240);
  await task(w, 'r4', 'report', 'draft', 'Make the charts', null);
  await task(w, 'r5', 'report', 'print', 'Get a print quote', 30);
  await pick(w, WEEK, 'r1', 120);
  // In this stretch, with a milestone after it, and a task that wasn't done in its block last week.
  await w.create('project', { title: 'Kitchen renovation', state: 'active', start: '2026-09-01', end: '2027-03-31' }, 'kitchen');
  await w.create('milestone', { project_id: 'kitchen', title: 'Pick the cabinets', due: '2026-11-30' }, 'cabinets');
  await w.create('milestone', { project_id: 'kitchen', title: 'Book the fitters', due: '2027-01-15' }, 'fitters');
  await task(w, 'k1', 'kitchen', 'cabinets', 'Visit the showroom', 120, { done_at: '2026-10-10T15:00:00Z', estimate_min: 400 });
  await task(w, 'k2', 'kitchen', 'cabinets', 'Get three quotes', 90);
  await task(w, 'k3', 'kitchen', 'cabinets', 'Measure the walls', 60);
  await task(w, 'k4', 'kitchen', 'fitters', 'Ask neighbours for fitter recommendations', 30);
  await w.create('time_block', { task_id: 'k3', start: '2026-11-12T23:00:00Z', end: '2026-11-13T00:00:00Z', tz: 'America/Chicago' }, 'tbk3');
  await w.create('block_outcome', { result: 'not', answered_at: '2026-11-13T00:05:00Z' }, outcomeId('tbk3'));
  // Outside this stretch, but a task of it is in the week.
  await w.create('project', { title: 'Build the garden shed', state: 'active', start: '2026-09-01', end: '2027-04-30' }, 'shed');
  await w.create('milestone', { project_id: 'shed', title: 'Lay the base', due: '2027-02-06' }, 'base');
  await w.create('milestone', { project_id: 'shed', title: 'Raise the walls', due: '2027-03-20' }, 'walls');
  await task(w, 's1', 'shed', 'base', 'Draw the plans', 120);
  await task(w, 's2', 'shed', 'base', 'Order the timber', 30);
  await task(w, 's3', 'shed', 'walls', 'Buy the cladding', 60);
  await task(w, 's4', 'shed', 'walls', 'Book a helper', 30);
  await pick(w, WEEK, 's1', 60);
  // Outside this stretch, on track, and nothing of it needs you.
  await w.create('project', { title: 'Write a cookbook', state: 'active', start: '2026-06-01', end: '2027-05-31' }, 'cookbook');
  await w.create('milestone', { project_id: 'cookbook', title: 'Draft ten recipes', due: '2027-03-01' }, 'recipes');
  await task(w, 'c0', 'cookbook', null, 'Plan the book', 900, { done_at: '2026-08-01T15:00:00Z' });
  for (const [id, title, minutes] of [['c1', 'List the recipes', 60], ['c2', 'Test the bread recipe', 120], ['c3', 'Photograph the dishes', 180], ['c4', 'Find a printer', 30]] as const) {
    await task(w, id, 'cookbook', 'recipes', title, minutes);
  }
  // Behind pace outside this stretch, with an undated milestone and a task with no estimate.
  await w.create('project', { title: 'Learn the guitar', state: 'active', start: '2026-05-01', end: '2027-01-31' }, 'guitar');
  await w.create('milestone', { project_id: 'guitar', title: 'Learn three songs' }, 'songs');
  await task(w, 'g1', 'guitar', 'songs', 'Practise the chords', 30);
  await task(w, 'g2', 'guitar', 'songs', 'Learn the first song', 60);
  await task(w, 'g3', 'guitar', 'songs', 'Record it', null);
  // Made since this stretch was planned, and in no stretch's plan yet.
  await w.create('project', { title: 'Plan the garden', state: 'active', start: '2026-09-01', end: '2027-02-28', added_on: '2026-11-10' }, 'garden');
  await task(w, 'pg1', 'garden', null, 'Choose the beds', 60);
  await task(w, 'pg2', 'garden', null, 'Measure the plot', null);
  // Paused, so it can't be planned now.
  await w.create('project', { title: 'Learn Spanish', state: 'paused', start: '2026-03-01', end: '2027-03-01' }, 'spanish');
  await task(w, 'sp1', 'spanish', null, 'Book a tutor', 60);
  // One offs: one this week, one due this week but not in it, one with no date; and two still in the Inbox.
  await w.create('task', { kind: 'one_off', title: 'Renew the passport', estimate_min: 45, schedule: { type: 'once', from: '2026-11-18' } }, 'o1');
  await w.create('task', { kind: 'one_off', title: 'Pay the water bill', estimate_min: 20, schedule: { type: 'once', from: '2026-11-20' } }, 'o2');
  await w.create('task', { kind: 'one_off', title: 'Paint the fence', estimate_min: 90, schedule: { type: 'once' } }, 'o3');
  await pick(w, WEEK, 'o1', 45);
  await w.create('task', { kind: 'inbox', title: 'Call the bank' }, 'i1');
  await w.create('task', { kind: 'inbox', title: 'Fix the shelf' }, 'i2');
}

const project = (v: PickView, title: string) => v.projects.find((p) => p.plan.project.title === title)!;
const group = (v: PickView, title: string, head: RegExp) => project(v, title).groups.find((g) => head.test(g.head))!;
const titles = (rows: readonly { title: string }[]) => rows.map((r) => r.title);

describe('Pick: what this stretch means', () => {
  it("filters only once this stretch is planned, and says why it doesn't otherwise", async () => {
    const v = await viewOf(sample);
    expect(v.filter).toBe(true);
    expect(v.stretches).toEqual([{ start: '2026-10-01', end: '2026-12-31' }]);

    const unplanned = await viewOf(async (w) => {
      await sample(w);
      await updateSettings(w, { plan_stretch: {} });
    });
    expect(unplanned.filter).toBe(false);
    expect(unplanned.why).toEqual({ unplanned: { start: '2026-10-01', end: '2026-12-31' } });
    expect(unplanned.projects.every((p) => p.shown && !p.reason && p.groups.every((g) => !g.folded))).toBe(true);

    const none = await viewOf(async (w) => {
      await sample(w);
      await updateSettings(w, { plan_cadence: null });
    });
    expect(none.filter).toBe(false);
    expect(none.why).toBe('no cadence');
    expect(none.stretch).toBeUndefined();
  });

  it('walk case 1: work that needs you from outside this stretch shows, with the reason, first by date', async () => {
    const v = await viewOf(sample);
    const photo = v.projects[0]!;
    expect(photo.plan.project.title).toBe('Sort the photo albums');
    expect(photo).toMatchObject({ inStretch: false, shown: true });
    expect(photo.reason).toMatchObject({ long: 'Overdue, from last stretch', short: 'Overdue, last stretch', sr: 'overdue from the last stretch, outside this stretch' });
    expect(group(v, 'Sort the photo albums', /^Scan the 1990s albums/)).toMatchObject({ must: true, folded: false, short: 'Scan the 1990s albums, overdue' });
    expect(titles(group(v, 'Sort the photo albums', /^Scan/).rows)).toEqual(['Scan the last box']);
  });

  it('walk case 2: with the next stretch planned early, both plans count, and only work in neither folds, under its own date', async () => {
    const v = await viewOf(
      async (w) => {
        await updateSettings(w, { plan_stretch: { last_planned: '2027-01-01' } });
        await w.create('project', { title: 'Kitchen renovation', state: 'active', start: '2026-09-01', end: '2027-06-30' }, 'kitchen');
        await w.create('milestone', { project_id: 'kitchen', title: 'Fit the worktops', due: '2026-12-20' }, 'tops');
        await w.create('milestone', { project_id: 'kitchen', title: 'Book the fitters', due: '2027-01-15' }, 'fitters');
        await w.create('milestone', { project_id: 'kitchen', title: 'Order the appliances', due: '2027-04-10' }, 'apps');
        await task(w, 'k1', 'kitchen', 'tops', 'Choose the worktop', 60);
        await task(w, 'k2', 'kitchen', 'fitters', 'Ask neighbours for fitter recommendations', 30);
        await task(w, 'k3', 'kitchen', 'apps', 'Pick the fridge', 120);
      },
      '2026-12-07T20:00:00Z',
      '2026-12-07',
    );
    expect(v.stretches).toEqual([{ start: '2026-10-01', end: '2026-12-31' }, { start: '2027-01-01', end: '2027-03-31' }]);
    expect(v.stretch).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    const k = project(v, 'Kitchen renovation');
    expect(k.groups.map((g) => [g.head, g.folded])).toEqual([
      ['Fit the worktops, due Dec 20', false],
      ['Book the fitters, due Jan 15', false],
      ['Order the appliances, due Apr 10', true],
    ]);
    expect(k.groups[2]!.counts).toBe('1 task, 2h');
  });

  it('walk case 3: a milestone with no date never folds in a stretch project; elsewhere a new one shows, tagged New milestone', async () => {
    const v = await viewOf(async (w) => {
      await sample(w);
      await w.create('project', { title: 'Build a pond', state: 'active', start: '2026-08-01', end: '2027-05-31' }, 'pond');
      await w.create('milestone', { project_id: 'pond', title: 'Dig the hole', due: '2027-04-01' }, 'dig');
      await w.create('milestone', { project_id: 'pond', title: 'Paint the liner', added_on: '2026-11-12' }, 'liner');
      await task(w, 'pd0', 'pond', null, 'Draw the pond', 600, { done_at: '2026-09-01T15:00:00Z' });
      await task(w, 'pd1', 'pond', 'dig', 'Hire a digger', 60);
      await task(w, 'pd2', 'pond', 'liner', 'Choose a colour', 15);
    });
    expect(group(v, 'Write the quarterly report', /^Print and bind/)).toMatchObject({ outside: false, folded: false });
    const pond = project(v, 'Build a pond');
    expect(pond).toMatchObject({ shown: true, reason: { long: 'New milestone, outside this stretch', short: 'New milestone' } });
    expect(pond.groups.map((g) => [g.head.split(',')[0], g.folded])).toEqual([
      ['Dig the hole', true],
      ['Paint the liner', false],
    ]);
  });

  it('walk case 4: a project behind pace outside this stretch shows in place with the reason, its tasks folded with a count', async () => {
    const v = await viewOf(async (w) => {
      await sample(w);
      await w.create('project', { title: 'Learn to sail', state: 'active', start: '2026-09-01', end: '2027-03-31' }, 'sail');
    });
    const guitar = project(v, 'Learn the guitar');
    expect(guitar.status.pill).toBe('Behind');
    expect(guitar).toMatchObject({ inStretch: false, shown: true, more: 3, reason: { long: 'Behind pace, outside this stretch', short: 'Behind pace' } });
    expect(guitar.groups).toHaveLength(1);
    expect(guitar.groups[0]).toMatchObject({ folded: true, counts: '3 tasks, 1h 30m, 1 with no estimate' });
    // No tasks shows the same way.
    expect(project(v, 'Learn to sail')).toMatchObject({ shown: true, reason: { short: 'No tasks' } });
  });

  it('walk case 5: a task that needs a new time asks, and counts in "need you" until it is answered', async () => {
    const v = await viewOf(sample);
    const carried = group(v, 'Kitchen renovation', /^Needs a new time/);
    expect(carried).toMatchObject({ must: true, folded: false });
    expect(titles(carried.rows)).toEqual(['Measure the walls']);
    expect(titles(v.needYou.newTime)).toEqual(['Measure the walls']);

    const kept = await viewOf(async (w) => {
      await sample(w);
      await pick(w, WEEK, 'k3', 60);
    });
    expect(kept.needYou.newTime).toEqual([]);
  });

  it('walk case 6: every fold names its milestone and date, and counts tasks and time', async () => {
    const v = await viewOf(sample);
    expect(group(v, 'Kitchen renovation', /^Book the fitters/)).toMatchObject({ head: 'Book the fitters, due Jan 15', folded: true, counts: '1 task, 30m' });
    // A milestone with a task in the week shows whole; the other folds.
    expect(group(v, 'Build the garden shed', /^Lay the base/)).toMatchObject({ must: true, folded: false });
    expect(titles(group(v, 'Build the garden shed', /^Lay the base/).rows)).toEqual(['Draw the plans', 'Order the timber']);
    expect(group(v, 'Build the garden shed', /^Raise the walls/)).toMatchObject({ head: 'Raise the walls, due Mar 20', folded: true, counts: '2 tasks, 1h 30m' });
    expect(project(v, 'Build the garden shed').reason).toMatchObject({ long: 'In this week, outside this stretch', sr: '1 task in this week, outside this stretch' });
    // Nothing of the cookbook needs you, so it's hidden whole, and the toggle counts it by project.
    expect(project(v, 'Write a cookbook')).toMatchObject({ shown: false, more: 4 });
    expect(v.outside.n).toBe(1 + 2 + 3 + 4);
    expect(v.outside.folded).toBe(1 + 2 + 3);
    expect(v.outside.where).toEqual([
      { id: 'kitchen', title: 'Kitchen renovation', n: 1, hidden: false },
      { id: 'guitar', title: 'Learn the guitar', n: 3, hidden: false },
      { id: 'shed', title: 'Build the garden shed', n: 2, hidden: false },
      { id: 'cookbook', title: 'Write a cookbook', n: 4, hidden: true },
    ]);
    expect(v.outside.earliest).toBe('2027-01-15');
  });

  it('walk case 9: a new project shows whole, tagged, until it joins a stretch; with no added_on it is not new', async () => {
    const v = await viewOf(async (w) => {
      await sample(w);
      await w.create('project', { title: 'Plan a party', state: 'active', start: '2026-09-01', end: '2027-02-28' }, 'party');
      await task(w, 'pp0', 'party', null, 'Book the hall', 600, { done_at: '2026-09-10T15:00:00Z' });
      await task(w, 'pp1', 'party', null, 'Write the list', 30);
      await w.create('project', { title: 'Learn to knit', state: 'active', start: '2026-09-01', end: '2027-02-28', added_on: '2026-11-11' }, 'knit');
      await w.create('milestone', { project_id: 'knit', title: 'A scarf', stretch: '2027-01-01' }, 'scarf');
      await task(w, 'kn0', 'knit', null, 'Learn the stitches', 600, { done_at: '2026-09-10T15:00:00Z' });
      await task(w, 'kn1', 'knit', 'scarf', 'Buy the wool', 30);
    });
    const garden = project(v, 'Plan the garden');
    expect(garden).toMatchObject({ shown: true, whole: true, reason: { long: 'New since you planned this stretch', short: 'New', tone: 'new' } });
    expect(garden.groups.map((g) => [g.head, g.folded])).toEqual([['Done, by Feb 28', false]]);
    // Older projects have no added_on, which never counts as new.
    expect(project(v, 'Plan a party')).toMatchObject({ shown: false, whole: false });
    // One with a milestone tagged to a stretch has joined planning, so it isn't new.
    expect(project(v, 'Learn to knit')).toMatchObject({ shown: false, whole: false });
  });

  it('walk case 10: no estimate shows on the row, folds count it, and the count before Continue takes it by its date', async () => {
    const v = await viewOf(async (w) => {
      await sample(w);
      await task(w, 'r6', 'report', 'notes', 'Book the venue', null);
    });
    expect(group(v, 'Write the quarterly report', /^Draft chapters/).rows.find((r) => r.title === 'Make the charts')).toBeTruthy();
    expect(group(v, 'Learn the guitar', /^Learn three songs/).counts).toMatch(/, 1 with no estimate$/);
    expect(titles(v.needYou.due)).toContain('Book the venue');
  });

  it('walk case 11: One offs always show, as This week and Later or no date, and Inbox items are counted', async () => {
    const v = await viewOf(sample);
    expect(v.oneOffs.groups.map((g) => [g.head, titles(g.rows)])).toEqual([
      ['This week', ['Renew the passport', 'Pay the water bill']],
      ['Later or no date', ['Paint the fence']],
    ]);
    expect(v.inbox).toBe(2);
  });

  it('walk case 12: one number before Continue for everything that needs you and is not in the week or answered', async () => {
    const v = await viewOf(sample);
    expect(titles(v.needYou.questions)).toEqual(['Scan the 1990s albums', 'Gather notes']);
    expect(v.needYou.questions.map((q) => q.where)).toEqual(['Sort the photo albums', 'Write the quarterly report']);
    expect(titles(v.needYou.newTime)).toEqual(['Measure the walls']);
    expect(titles(v.needYou.due)).toEqual(['Scan the last box', 'Interview the finance team', 'Pay the water bill']);
    const words = needWords(v.needYou);
    expect(words).toMatchObject({
      n: 6,
      line: '2 questions to answer, 1 task that needs a new time, 3 due or overdue not in the week.',
      short: '2 to answer, 1 new time, 3 due',
      link: 'Show the 6 that need you: 2 to answer, 1 needs a new time, 3 due or overdue.',
      next: 'Continue to scheduling, 6 need you',
    });

    const none = needWords({ questions: [], newTime: [], due: [] });
    expect(none).toMatchObject({ n: 0, line: 'Everything due or overdue is in the week, and nothing is waiting for an answer.', next: 'Continue to scheduling' });
  });

  it('counts planned milestones with no tasks yet, as stretch planning does', async () => {
    const v = await viewOf(async (w) => {
      await sample(w);
      await w.create('milestone', { project_id: 'report', title: 'Send it out', due: '2026-12-10' }, 'send');
    });
    expect(v.noTasks).toBe(1);
  });
});
