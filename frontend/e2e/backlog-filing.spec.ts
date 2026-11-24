// Filing into a goal's backlog from Capture and from a task's Belongs to, at desktop and phone sizes.

import { expect, test } from '@playwright/test';
import { belongsTo, openSeeded, readRecord } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm
const SHOTS = process.env.E2E_SHOTS;

const records: Seed[] = [
  { type: 'objective', id: 'g1', fields: { title: 'Learn to bake bread', state: 'active' } },
  { type: 'task', id: 'o1', fields: { kind: 'one_off', title: 'Order rye flour', schedule: { type: 'once', from: '2026-11-20' }, next_due: '2026-11-20' } },
];

test("Capture saves straight to a goal's backlog, which it makes", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await (phone ? page.getByRole('button', { name: 'Capture a task' }) : page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Capture/ })).click();
  const capture = page.getByRole('dialog', { name: 'Capture' });
  await capture.getByRole('button', { name: 'Add details' }).click();
  await capture.getByRole('combobox', { name: 'Send to' }).selectOption({ label: 'Learn to bake bread, Backlog' });
  await expect(capture.getByRole('combobox', { name: 'Milestone' })).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/capture-backlog-${info.project.name}.png` });
  await capture.getByRole('textbox', { name: /Capture to/ }).fill('Buy a banneton');
  await capture.getByRole('textbox', { name: /Capture to/ }).press('Enter');
  await expect(page.getByText('Saved to the backlog for Learn to bake bread')).toBeVisible();
  expect(await readRecord(page, 'project', 'backlog:g1')).toMatchObject({ objective_id: 'g1', state: 'active', title: 'Learn to bake bread, Backlog' });
});

test("Belongs to moves a dated one off into a goal's backlog, saying first that its date goes, with Undo", async ({ page }, info) => {
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  const nav = page.getByRole('navigation', { name: 'Main' });
  if (info.project.name === 'phone') {
    await nav.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: /^One offs/ }).click();
  } else {
    await nav.getByRole('button', { name: 'One offs' }).click();
  }
  await page.getByRole('button', { name: /Order rye flour/ }).first().click();
  const popup = page.getByRole('dialog', { name: 'Order rye flour' });
  await belongsTo(page, popup, 'Learn to bake bread, Backlog');
  await expect(popup.getByRole('status')).toHaveText('Backlog tasks have no date, so Fri Nov 20 will be cleared.');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/belongs-to-backlog-${info.project.name}.png` });
  await popup.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Moved Order rye flour to the backlog for Learn to bake bread.')).toBeVisible();
  expect(await readRecord(page, 'task', 'o1')).toMatchObject({ kind: 'project', project_id: 'backlog:g1', schedule: null });
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await readRecord(page, 'task', 'o1'))?.kind).toBe('one_off');
});
