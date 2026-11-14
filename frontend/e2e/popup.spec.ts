import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, go, openSeeded } from './seed';
import type { Seed } from './seed';

// The task popup's ways out: Delete task with Undo, Cancel dropping changes, and the others (Esc, the close button, a
// tap outside) keeping changes until Save or Cancel.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm

const records: Seed[] = [
  { type: 'objective', id: 'g1', fields: { title: 'Write the quarterly report', state: 'active' } },
  { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: 'Report', state: 'active', start: '2026-10-01', end: '2026-12-15' } },
  { type: 'milestone', id: 'm1', fields: { project_id: 'p1', title: 'Drafts', due: '2026-11-20' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Draft the summary', estimate_min: 120 } },
  { type: 'week_plan', id: 'week:2026-11-02', fields: { week_start: '2026-11-02', finished_at: '2026-11-02T14:00:00Z' } },
  { type: 'time_block', id: 'b1', fields: { task_id: 't1', start: '2026-11-02T22:00:00Z', end: '2026-11-02T23:00:00Z', tz: 'America/Chicago' } },
];

const popupOf = (page: Page, title: string) => page.locator(`.sheet.taskpop[aria-label="${title}"]`);

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  return errors;
}

async function openProject(page: Page, phone: boolean) {
  await go(page, 'Goals');
  await page.getByRole('button', { name: /^Write the quarterly report/ }).click();
  await page.getByRole('button', { name: /^Report/ }).click();
  if (phone) await expect(page.getByRole('heading', { level: 1, name: 'Report' })).toBeVisible();
}

test('Delete task takes the task and its block off Today, and Undo, which takes focus, puts both back', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page);
  // On phone a block still to come is a slider.
  const block = page.getByRole(phone ? 'slider' : 'button', { name: /^Draft the summary, 4pm to 5pm/ });
  await block.click();
  const popup = popupOf(page, 'Draft the summary');
  const del = popup.getByRole('button', { name: 'Delete task' });
  if (phone) await expectTapTarget(del);
  await del.click();
  await expect(popup).toHaveCount(0);
  await expect(page.getByText('Deleted Draft the summary.')).toBeVisible();
  await expect(block).toHaveCount(0);
  const undo = page.locator('.toast').getByRole('button', { name: 'Undo' });
  await expect(undo).toBeFocused();
  await undo.click();
  await expect(block).toBeVisible();

  await openProject(page, phone);
  await expect(page.getByRole('button', { name: 'Edit task Draft the summary, 2h' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Cancel drops the popup’s changes, and Esc, the close button or a tap outside keep them until Save', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page);
  await openProject(page, phone);
  const row = page.getByRole('button', { name: 'Edit task Draft the summary, 2h' });
  const popup = popupOf(page, 'Draft the summary');

  // Unchanged, Esc just closes it.
  await row.click();
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);

  await row.click();
  await popup.getByRole('textbox', { name: 'Description' }).fill('Start from the **Q3 numbers**.');
  await page.keyboard.press('Escape');
  const unsaved = popup.getByRole('alert');
  await expect(unsaved).toHaveText("Your changes aren't saved. Save them, or Cancel to drop them.");
  await expect(popup.getByRole('button', { name: 'Save' })).toBeFocused();
  // A tap outside keeps them too, as does the close button on desktop.
  await page.mouse.click(10, 10);
  await expect(popup).toBeVisible();
  if (!phone) {
    await popup.getByRole('button', { name: 'Close' }).click();
    await expect(unsaved).toBeVisible();
  }
  await expect(popup.getByRole('textbox', { name: 'Description' })).toHaveValue('Start from the **Q3 numbers**.');

  // Cancel drops them, with nothing to undo.
  await popup.getByRole('button', { name: 'Cancel' }).click();
  await expect(popup).toHaveCount(0);
  await expect(page.locator('.toast')).toHaveCount(0);
  await expect(row).toBeVisible();
  await row.click();
  await expect(popup.getByRole('textbox', { name: 'Description' })).toHaveValue('');

  // A name can't be saved blank.
  await popup.getByRole('button', { name: 'Rename Draft the summary' }).click();
  await popup.getByRole('textbox', { name: 'Name' }).fill('  ');
  await popup.getByRole('button', { name: 'Save' }).click();
  await expect(unsaved).toHaveText('Give it a title.');
  await popup.getByRole('textbox', { name: 'Name' }).fill('Draft the executive summary');
  await popup.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved Draft the executive summary.')).toBeVisible();
  expect(errors).toEqual([]);
});
