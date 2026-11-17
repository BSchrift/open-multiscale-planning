import { expect, test } from '@playwright/test';
import { openSeeded } from './seed';

// On phone, planning keeps a toast above its bottom bar, and the sheet in Schedule sits on top of it. Any press puts the
// toast away, so the sheet drops into its place while the finger is still down, and the release lands on whatever has
// moved under it: the button pressed never gets its click. A press that puts away the green check does the same the
// other way, as the toast waiting behind the check comes in and lifts the sheet. Found by offline-flows.spec.ts, whose
// planning test failed now and then as it pressed Place here with Process's check or toast still showing.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm in Chicago, this week not yet planned.
const WEEK = '2026-11-02';

test('phone: a press that puts a toast away still presses the button under it', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'The toast holds the layout in the phone flow only');
  await page.clock.install({ time: NOW });
  await openSeeded(page, [
    { type: 'project', id: 'p', fields: { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-31' } },
    { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p', title: 'Write chapter one', estimate_min: 120 } },
    { type: 'week_pick', id: `pick:${WEEK}:t1`, fields: { week_start: WEEK, task_id: 't1', minutes: 120 } },
    { type: 'task', id: 'i1', fields: { kind: 'inbox', title: 'Rake the leaves' } },
  ]);
  await page.getByRole('button', { name: 'Start planning' }).first().click();
  await page.getByRole('button', { name: 'Process 1 item' }).click();
  await page.getByRole('dialog', { name: 'Process Inbox' }).getByRole('button', { name: /^Add to a project or One offs/ }).click();
  await page.getByRole('dialog', { name: 'Add to' }).getByRole('option', { name: 'Write the report' }).click();
  // The toast stays while the pointer rests on it, and keys don't put it away, so it's still there in Schedule.
  const toast = page.locator('.toast');
  await toast.hover();
  const steps = page.getByRole('navigation', { name: 'Planning steps' });
  await steps.getByRole('button', { name: 'Schedule' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'All picked tasks, 0 of 1 placed' })).toBeVisible();
  await expect(toast).toBeVisible();

  // Pressed as a finger does: down, then up in the same place.
  const place = (await page.getByRole('button', { name: 'Place here' }).boundingBox())!;
  await page.mouse.move(place.x + place.width / 2, place.y + place.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'All picked tasks, 1 of 1 placed' })).toBeVisible();
});
