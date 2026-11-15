// Finishing a project with tasks left: one unticked box moves them to the goal's backlog, at desktop and phone sizes.

import { expect, test } from '@playwright/test';
import { expectTapTarget, openSeeded, readRecord } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm
const SHOTS = process.env.E2E_SHOTS;

const records: Seed[] = [
  { type: 'objective', id: 'g1', fields: { title: 'Learn to bake bread', state: 'active' } },
  { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: 'Rye bread', state: 'active', start: '2026-10-01', end: '2026-12-15' } },
  { type: 'milestone', id: 'm1', fields: { project_id: 'p1', title: 'First loaf', due: '2026-11-20' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Shape the dough', estimate_min: 60 } },
  { type: 'task', id: 't2', fields: { kind: 'project', project_id: 'p1', title: 'Bake it', estimate_min: 30 } },
];

test("Finish moves the open tasks to the goal's backlog only when its box is ticked, with Undo", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Goals' }).click();
  await page.getByRole('button', { name: /^Learn to bake bread/ }).click();
  await page.getByRole('button', { name: /^Rye bread/ }).click();
  await page.getByRole('button', { name: 'Project settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Project settings' });
  await dialog.getByRole('button', { name: 'Finish' }).click();
  const ask = dialog.getByRole('alert');
  await expect(ask).toContainText('2 tasks are still open, 1h 30m.');
  const box = ask.getByRole('checkbox', { name: 'Move them to the backlog for Learn to bake bread' });
  await expect(box).not.toBeChecked();
  await expect(ask.getByRole('button', { name: 'Cancel finishing' })).toBeFocused();
  if (phone) await expectTapTarget(box.locator('xpath=ancestor::label'));
  await box.check();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/finish-move-${info.project.name}.png` });
  await ask.getByRole('button', { name: 'Yes, finish' }).click();
  await expect(page.getByText('Finished. 2 open tasks moved to the backlog for Learn to bake bread.')).toBeVisible();
  expect(await readRecord(page, 'task', 't1')).toMatchObject({ project_id: 'backlog:g1', milestone_id: null });
  expect(await readRecord(page, 'milestone', 'm1')).toHaveProperty('dropped_at');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await readRecord(page, 'task', 't1'))?.project_id).toBe('p1');
  expect((await readRecord(page, 'project', 'p1'))?.state).toBe('active');
});
