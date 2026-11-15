// Goal backlogs in Pick tasks, at desktop and phone size: one Backlogs band after the projects, groups closed at first.

import { expect, test } from '@playwright/test';
import { NOW, SAMPLE } from './pick-sample';
import { expectTapTarget, openSeeded, readRecord } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const SHOTS = process.env.E2E_SHOTS;

const records: Seed[] = [
  ...SAMPLE,
  { type: 'objective', id: 'gb', fields: { title: 'Learn to bake bread', state: 'active' } },
  { type: 'project', id: 'backlog:gb', fields: { objective_id: 'gb', title: 'Learn to bake bread, Backlog', state: 'active', start: '2026-10-01', end: '2027-03-31' } },
  { type: 'task', id: 'kb1', fields: { kind: 'project', project_id: 'backlog:gb', milestone_id: null, title: 'Watch a shaping video', estimate_min: 60, order: 1 } },
  { type: 'task', id: 'kb2', fields: { kind: 'project', project_id: 'backlog:gb', milestone_id: null, title: 'Read the book', estimate_min: 90, order: 2 } },
];

test('picks a backlog task for the week from its closed group, and takes it off again', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await page.getByRole('button', { name: 'Start planning' }).first().click();
  await page.getByRole('button', { name: 'Continue to picking tasks' }).click();
  await expect(page.getByRole('heading', { name: /^Pick tasks/ })).toBeVisible();

  const band = page.getByRole('region', { name: 'Backlogs', exact: true });
  const sections = await page.locator('.plist > section').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(sections.indexOf('Backlogs')).toBeLessThan(sections.indexOf('One offs'));
  const group = band.getByRole('button', { name: /^Learn to bake bread/ });
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  if (phone) await expectTapTarget(group);
  await group.click();
  await expect(band.getByRole('button', { name: 'Edit task Watch a shaping video', exact: true })).toBeVisible();
  await band.scrollIntoViewIfNeeded();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pick-backlogs-${info.project.name}.png` });
  // The row's time button is the same as a project row's.
  await band.getByRole('button', { name: 'Add 1h to this week: Watch a shaping video' }).click();
  await expect.poll(async () => (await readRecord(page, 'week_pick', `pick:2026-11-16:kb1`))?.minutes).toBe(60);
});
