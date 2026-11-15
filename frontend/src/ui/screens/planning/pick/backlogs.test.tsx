import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { getRecord, weekPickId } from '../../../../core/records';
import type { Writer } from '../../../../core/records';
import { openPlanning, seedWeek } from '../testing';

afterEach(cleanup);

const WEEK = '2026-11-02';

async function seed(w: Writer) {
  await seedWeek(w);
  await w.create('objective', { title: 'Learn to bake bread', state: 'active' }, 'g1');
  await w.create('project', { objective_id: 'g1', title: 'Learn to bake bread, Backlog', state: 'active', start: '2026-10-01', end: '2027-03-31' }, 'backlog:g1');
  await w.create('task', { kind: 'project', project_id: 'backlog:g1', title: 'Watch a shaping video', estimate_min: 60, order: 1 }, 'k1');
}

describe.each(['desktop', 'phone'] as const)('Pick tasks with a goal backlog, on %s', (layout) => {
  it('has one Backlogs band after the projects, its groups closed at first, whose rows add to the week and come off it', { timeout: 15000 }, async () => {
    const t = await openPlanning({ layout, seed, step: 1 });
    const band = await screen.findByRole('region', { name: 'Backlogs' }, { timeout: 5000 });
    const sections = [...document.querySelectorAll('.plist > section')].map((s) => s.getAttribute('aria-label'));
    expect(sections.indexOf('Backlogs')).toBeGreaterThan(sections.indexOf('Write the report'));
    expect(sections.indexOf('Backlogs')).toBeLessThan(sections.indexOf('One offs'));
    const group = within(band).getByRole('button', { name: /Learn to bake bread/ });
    expect(group).toHaveAttribute('aria-expanded', 'false');
    expect(within(band).queryByText('Watch a shaping video')).toBeNull();
    await userEvent.click(group);
    expect(group).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(within(band).getByRole('button', { name: 'Add 1h to this week: Watch a shaping video' }));
    await waitFor(async () => expect((await getRecord(t.db, 'week_pick', weekPickId(WEEK, 'k1')))?.minutes).toBe(60));
  });
});
