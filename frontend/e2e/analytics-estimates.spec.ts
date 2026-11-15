import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openSeeded, pane } from './seed';
import type { Seed } from './seed';

// Analytics' estimate pattern: a project whose finished tasks ran well over their estimates offers to raise the
// estimates of its open tasks, with Undo.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-06T18:00:00Z'); // Friday noon.

// Five tasks estimated at an hour that each took an hour and a half: half as long again.
const ranOver = ['Mix the dough', 'Feed the starter', 'Shape the loaf', 'Score the top', 'Bake the loaf'].flatMap((title, i): Seed[] => {
  const start = `2026-10-${String(12 + i).padStart(2, '0')}T15:00:00Z`;
  const end = `2026-10-${String(12 + i).padStart(2, '0')}T16:30:00Z`;
  return [
    { type: 'task', id: `done${i}`, fields: { kind: 'project', project_id: 'p1', title, estimate_min: 60, done_at: end } },
    { type: 'time_block', id: `blk${i}`, fields: { task_id: `done${i}`, start, end, tz: 'America/Chicago' } },
    { type: 'block_outcome', id: `outcome:blk${i}`, fields: { result: 'done', answered_at: end } },
  ];
});

const records: Seed[] = [
  { type: 'objective', id: 'g1', fields: { title: 'Learn to bake bread', state: 'active' } },
  { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: 'Sourdough', state: 'active', start: '2026-10-01', end: '2026-12-31' } },
  ...ranOver,
  { type: 'task', id: 'open1', fields: { kind: 'project', project_id: 'p1', title: 'Bake for friends', estimate_min: 60 } },
  { type: 'task', id: 'open2', fields: { kind: 'project', project_id: 'p1', title: 'Try a rye loaf', estimate_min: 120 } },
];

async function openAnalytics(page: Page, phone: boolean) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  const nav = page.getByRole('navigation', { name: 'Main' });
  if (phone) {
    await nav.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: /^Analytics/ }).click();
  } else {
    await nav.getByRole('button', { name: 'Analytics' }).click();
  }
  await expect(pane(page, 'Analytics').getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
  await pane(page, 'Analytics').getByRole('button', { name: 'This stretch' }).click();
  return errors;
}

test("Raise estimates lengthens a project's open tasks by how far its work ran over, and Undo puts them back", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await openAnalytics(page, phone);
  const p = pane(page, 'Analytics');
  await expect(p.getByText('Sourdough tasks take about 50% longer than you estimate.')).toBeVisible();
  await p.getByRole('button', { name: 'Raise estimates' }).click();
  await expect(page.locator('.toast')).toContainText('Estimates raised');
  await expect(p.getByText('Sourdough tasks now start with longer estimates.')).toBeVisible();
  await expect(p.getByRole('button', { name: 'Raise estimates' })).toHaveCount(0);
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(p.getByRole('button', { name: 'Raise estimates' })).toBeVisible();
  await expect(p.getByText('Sourdough tasks now start with longer estimates.')).toHaveCount(0);

  // Raised again, the open tasks start half as long again, to the next quarter hour, and the pattern isn't asked again.
  await p.getByRole('button', { name: 'Raise estimates' }).click();
  await expect(p.getByText('Sourdough tasks now start with longer estimates.')).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Goals' }).click();
  await page.getByRole('button', { name: /^Learn to bake bread/ }).click();
  await page.getByRole('button', { name: /^Sourdough/ }).click();
  await expect(page.getByRole('button', { name: 'Edit task Bake for friends, 1h 30m' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit task Try a rye loaf, 3h' })).toBeVisible();
  expect(errors).toEqual([]);
});
