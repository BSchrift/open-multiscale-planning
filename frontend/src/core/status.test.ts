import { describe, expect, it } from 'vitest';
import { context, milestone, reportPlan, task } from './plan-testing';
import { dropMilestone, moveMilestone, withChange } from './plan';
import type { ProjectPlan } from './plan';
import { fixSummary, previewMove, status, withStatusLine } from './status';

/** Past its first two weeks with no milestones, and enough done to be on pace. */
function paced(done: number, left: number, project = {}): ProjectPlan {
  return {
    ...reportPlan(project),
    milestones: [],
    tasks: [task('a', null, done, { done_at: '2026-10-10T12:00:00Z' }), task('b', null, left)],
  };
}

describe('status, where the first match wins', () => {
  it('is Overdue for the earliest late milestone', () => {
    const s = status(reportPlan(), context());
    expect(s).toMatchObject({ tone: 'red', pill: 'Overdue', word: 'Gather notes was due 12 days ago', rank: 3 });
    expect(s.late?.id).toBe('m1');
    expect(s.ended).toBeUndefined();
  });

  it('clears Overdue when the last task is ticked, the milestone is met, or it is dropped', () => {
    const ticked = reportPlan();
    ticked.tasks = ticked.tasks.map((t) => (t.id === 't2' ? { ...t, done_at: '2026-10-29T12:00:00Z' } : t));
    expect(status(ticked, context()).pill).not.toBe('Overdue');
    for (const fields of [{ met_at: '2026-10-29T12:00:00Z' }, { dropped_at: '2026-10-29T12:00:00Z' }]) {
      const p = reportPlan();
      p.milestones[0] = { ...p.milestones[0]!, ...fields };
      expect(status(p, context()).pill).not.toBe('Overdue');
    }
  });

  it('does not count a milestone with only cancelled tasks as done', () => {
    const p = reportPlan();
    p.tasks = p.tasks.filter((t) => t.milestone_id !== 'm1').concat(task('x', 'm1', 1, { cancelled_at: '2026-10-29T12:00:00Z' }));
    expect(status(p, context()).pill).toBe('Overdue');
  });

  it('never shows an undated milestone Overdue during its stretch, and does once it has passed', () => {
    const p = paced(1, 0);
    p.milestones = [milestone('u', 'Pick a title', null, { stretch: '2026-08-01' })];
    p.tasks.push(task('c', 'u', 1));
    expect(status(p, context()).late).toBeUndefined();
    const after = context({ clock: { now: () => Date.parse('2026-11-05T12:00:00Z'), zone: () => 'UTC' } });
    expect(status(p, after)).toMatchObject({ pill: 'Overdue', word: 'Pick a title was due 5 days ago' });
  });

  it('never shows an undated milestone outside any plan Overdue', () => {
    const p = paced(1, 0);
    p.milestones = [milestone('u', 'Pick a title', null)];
    p.tasks.push(task('c', 'u', 1));
    expect(status(p, context()).late).toBeUndefined();
  });

  it('is Past end date when ended with nothing overdue', () => {
    const s = status(paced(1, 3, { end: '2026-10-20' }), context());
    expect(s).toMatchObject({ tone: 'red', pill: 'Past end date', word: 'Should have ended 10 days ago; 3h left', ended: true });
  });

  it('prefers Overdue to Past end date', () => {
    const s = status(reportPlan({ end: '2026-10-20' }), context());
    expect(s.pill).toBe('Overdue');
    expect(s.ended).toBeUndefined();
  });

  it('is No tasks only after its first week', () => {
    const empty = (start: string) => ({ ...reportPlan({ start }), milestones: [], tasks: [] });
    expect(status(empty('2026-10-23'), context())).toMatchObject({
      tone: 'amber',
      pill: 'No tasks',
      word: 'Add tasks so this can be scheduled',
      leftMin: 0,
    });
    expect(status(empty('2026-10-24'), context()).pill).toBe('On track');
  });

  it('is Behind when done lags time elapsed by over 15 points, after two weeks', () => {
    // 29 of 75 days is 39% expected.
    expect(status(paced(1, 9), context())).toMatchObject({ tone: 'amber', pill: 'Behind', pct: 10, expected: 39, word: '10% done, 39% expected by now' });
    expect(status(paced(1, 3), context())).toMatchObject({ tone: 'green', pill: 'On track', pct: 25, rank: 1 });
    expect(status(paced(0, 9, { start: '2026-10-16', end: '2026-12-15' }), context()).pill).toBe('On track');
    expect(status(paced(0, 9, { start: '2026-10-15', end: '2026-12-15' }), context()).pill).toBe('Behind');
  });

  it('caps expected progress at 100', () => {
    expect(status(paced(1, 1, { start: '2026-10-01', end: '2026-10-30' }), context()).expected).toBe(100);
  });

  it('pauses pace during away dates', () => {
    const away = [{ id: 'away', start: '2026-10-10', end: '2026-10-19' }];
    expect(status(paced(1, 3), context({ away })).expected).toBe(29);
    expect(status(paced(1, 3), context({ away: [{ ...away[0]!, deleted_at: '2026-10-20T00:00:00Z' }] })).expected).toBe(39);
  });

  it('shows the grey states first, whatever else is true', () => {
    expect(status(reportPlan({ state: 'paused' }), context())).toMatchObject({ tone: 'grey', pill: 'Paused', word: '1h done, 8h left', rank: 0 });
    expect(status(reportPlan({ state: 'finished' }), context())).toMatchObject({ tone: 'grey', pill: 'Finished', word: '1h logged' });
    expect(status(reportPlan({ state: 'dropped' }), context())).toMatchObject({ tone: 'grey', pill: 'Dropped' });
    expect(status(reportPlan({ start: '2026-11-15' }), context())).toMatchObject({ tone: 'grey', pill: 'Not started', word: 'Starts Nov 15' });
  });

  it('counts hours from tasks: open ones by what remains, with partial work as done', () => {
    const p = paced(1, 0);
    p.tasks = [
      task('a', null, 1, { done_at: '2026-10-10T12:00:00Z' }),
      task('b', null, 4, { remaining_min: 60 }),
      task('c', null, 1, { cancelled_at: '2026-10-10T12:00:00Z' }),
      task('d', null, 0, { estimate_min: null }),
    ];
    expect(status(p, context())).toMatchObject({ doneMin: 240, leftMin: 60, pct: 80 });
  });
});

describe('an overdue milestone asks one question', () => {
  const ctx = context();

  it('sums up what is under it', () => {
    expect(fixSummary(reportPlan(), 'm1', ctx)).toMatchObject({
      title: 'Gather notes was due Oct 18',
      sub: '1 of 2 tasks done, 2h left.',
      doneCount: 1,
      markLabel: 'Mark 1 task done',
      keepLabel: 'Move to Draft chapters, due Nov 9',
      cancelLabel: 'Cancel it, 2h off the project',
    });
    expect(fixSummary(reportPlan(), 'm1', ctx).target?.id).toBe('m2');
  });

  it('words a milestone with no tasks, or nowhere for them to go', () => {
    const p = reportPlan();
    p.milestones = [p.milestones[0]!];
    p.tasks = [];
    expect(fixSummary(p, 'm1', ctx)).toMatchObject({
      sub: 'No tasks under this milestone.',
      markLabel: 'Mark done',
      keepLabel: 'Move to Done, Dec 15',
    });
  });

  it('previews the status a move leads to, and needs a date after today', () => {
    expect(previewMove(reportPlan(), 'm1', '2026-11-06', ctx)).toEqual({
      valid: true,
      moveLabel: 'Move to Nov 6',
      preview: 'Project goes from Overdue to Behind.',
      warnings: [],
    });
    expect(previewMove(reportPlan(), 'm1', '2026-11-20', ctx).warnings).toEqual(['This puts it after Draft chapters.']);
    expect(previewMove(reportPlan(), 'm1', '2027-01-05', ctx).warnings).toContain("That moves the project's end to Jan 5.");
    for (const date of ['', '2026-10-30', 'soon']) {
      expect(previewMove(reportPlan(), 'm1', date, ctx)).toEqual({
        valid: false,
        moveLabel: 'Move date',
        preview: 'Pick a date after Oct 30.',
        warnings: [],
      });
    }
  });

  it('says when the status stays the same', () => {
    const p = reportPlan();
    p.milestones.unshift(milestone('m0', 'Earlier one', '2026-10-05'));
    expect(previewMove(p, 'm1', '2026-11-06', ctx).preview).toBe('Project stays Overdue.');
  });

  it('adds what happened to the status to the log line', () => {
    const p = reportPlan();
    const moved = withStatusLine(p, moveMilestone(p, 'm1', '2026-11-06', ctx), ctx);
    expect(withChange(p, moved).project.slip_log?.[0]?.text).toBe('Oct 30: Moved Gather notes from Oct 18 to Nov 6. Project went from Overdue to Behind.');
    const dropped = withStatusLine(p, dropMilestone(p, 'm1', { cancelOpen: false }, ctx), ctx);
    expect(withChange(p, dropped).project.slip_log?.[0]?.text).toBe(
      'Oct 30: Dropped Gather notes. Moved 1 task to Draft chapters. Project went from Overdue to Behind.',
    );
    const q = reportPlan();
    q.milestones.unshift(milestone('m0', 'Earlier one', '2026-10-05'));
    const still = withStatusLine(q, moveMilestone(q, 'm1', '2026-11-06', ctx), ctx);
    expect(withChange(q, still).project.slip_log?.[0]?.text).toContain('Project is still Overdue.');
  });

  it('leaves a change with no log line alone', () => {
    const p = reportPlan();
    p.milestones.push(milestone('new', 'Book a room', '2026-11-05', { added_on: '2026-10-30' }));
    const change = moveMilestone(p, 'new', '2026-11-06', ctx);
    expect(withStatusLine(p, change, ctx)).toEqual(change);
  });
});
