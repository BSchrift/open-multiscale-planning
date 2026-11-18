import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded, readRecord } from './seed';
import type { Seed } from './seed';

// Notes: an Inbox item saved as a note from Process in one tap, found again by search on the Notes screen, opened in its
// popup, deleted and brought back from Recently deleted, and made a task again.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm.

const records: Seed[] = [
  { type: 'task', id: 'i1', fields: { kind: 'inbox', title: 'Émile’s gate code', notes: 'Ask at the café for the new one.', order: 1 } },
  { type: 'attachment', id: 'a1', fields: { task_id: 'i1', kind: 'link', name: 'example.com', url: 'https://example.com/gate' } },
  { type: 'task', id: 'i2', fields: { kind: 'inbox', title: 'Book the boiler service', order: 2 } },
  // Held for later today, by hold to create: a note is never timed, so it comes off the calendar.
  { type: 'time_block', id: 'b1', fields: { task_id: 'i1', start: '2026-11-02T22:00:00Z', end: '2026-11-02T22:30:00Z', tz: 'America/Chicago' } },
];

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const card = (page: Page) => page.getByRole('dialog', { name: 'Process Inbox' });
const popup = (page: Page) => page.getByRole('dialog', { name: /^Note: / });

async function openNotes(page: Page, phone: boolean) {
  if (phone) {
    await nav(page).getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: /^Notes/ }).click();
  } else {
    await nav(page).getByRole('button', { name: 'Notes' }).click();
  }
  const notes = page.locator('.pane:visible').filter({ has: page.getByRole('heading', { level: 1, name: 'Notes' }) });
  await expect(notes).toBeVisible();
  return notes;
}

test('an Inbox item saved as a note in one tap is found by search, opened, deleted, restored and made a task again', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await nav(page).getByRole('button', { name: phone ? 'Inbox, 2 to sort' : 'Inbox' }).click();
  await page.locator(".pane[aria-label='Inbox']:visible").getByRole('button', { name: 'Process 2 items' }).click();

  // Beside Goal backlog, or in its place with no goals, one tap.
  const save = card(page).getByRole('button', { name: /Save as note$/ });
  if (phone) await expectTapTarget(save);
  await page.screenshot({ path: info.outputPath('process.png'), fullPage: true, animations: 'disabled' });
  await save.click();
  await expect(page.locator('.toast')).toContainText('Saved Émile’s gate code in Notes. Its block at 4pm came off the calendar.');
  await expect(card(page).getByRole('heading', { level: 1, name: 'Book the boiler service' })).toBeVisible();
  expect((await readRecord(page, 'time_block', 'b1'))?.cancelled).toBe(true);
  await card(page).getByRole('button', { name: 'Exit' }).click();

  const notes = await openNotes(page, phone);
  const search = notes.getByRole('searchbox', { name: 'Search notes' });
  await search.fill('emile');
  await expect(notes.getByText('1 note matches “emile”')).toBeVisible();
  const row = notes.getByRole('button', { name: /^Émile’s gate code/ });
  await expect(row).toHaveAccessibleDescription('Ask at the café for the new one. Saved Nov 2 · 1 link');
  await expect(row.locator('mark')).toHaveText('Émile');
  if (phone) await expectTapTarget(row);
  await page.screenshot({ path: info.outputPath('notes.png'), fullPage: true, animations: 'disabled' });

  await row.click();
  await expect(popup(page).getByRole('heading', { level: 2 })).toBeFocused();
  await expect(popup(page).getByRole('link', { name: 'example.com' })).toHaveAttribute('href', 'https://example.com/gate');
  await page.screenshot({ path: info.outputPath('note.png'), fullPage: true, animations: 'disabled' });
  await popup(page).getByRole('button', { name: 'Delete note' }).click();
  await expect(page.locator('.toast')).toContainText('Deleted Émile’s gate code.');
  await expect(page.locator('.toast').getByRole('button', { name: /^Undo/ })).toBeFocused();

  await search.fill('');
  const bin = notes.getByRole('button', { name: /^Recently deleted/ });
  await bin.click();
  await notes.getByRole('button', { name: 'Restore Émile’s gate code' }).click();
  await expect(page.locator('.toast')).toContainText('Restored Émile’s gate code.');

  // Belongs to: Inbox makes it a task again, with its link.
  await notes.getByRole('button', { name: /^Émile’s gate code/ }).click();
  await popup(page).getByRole('combobox', { name: 'Belongs to' }).selectOption('inbox');
  await popup(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.toast')).toContainText('Moved Émile’s gate code to your Inbox.');
  await nav(page).getByRole('button', { name: phone ? 'Inbox, 2 to sort' : /^Inbox/ }).click();
  await expect(page.locator(".pane[aria-label='Inbox']:visible").getByText('Émile’s gate code')).toBeVisible();
});
