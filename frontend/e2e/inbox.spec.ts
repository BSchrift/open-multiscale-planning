import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openSeeded } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm.
const running = { state: 'active', start: '2026-10-01', end: '2027-01-31' };

const records: Seed[] = [
  { type: 'project', id: 'p1', fields: { title: 'Paint the fence', ...running } },
  { type: 'project', id: 'p2', fields: { title: 'Write the report', ...running, state: 'paused' } },
  { type: 'task', fields: { kind: 'inbox', title: 'Call the bank' } },
  { type: 'task', fields: { kind: 'inbox', title: 'Fix the gate', estimate_min: 120 } },
  { type: 'task', fields: { kind: 'inbox', title: 'Buy stamps' } },
];

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const inboxPane = (page: Page) => page.locator(".pane[aria-label='Inbox']:visible");
const card = (page: Page) => page.getByRole('dialog', { name: 'Process Inbox' });

async function open(page: Page, phone: boolean) {
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await nav(page).getByRole('button', { name: phone ? 'Inbox, 3 to sort' : 'Inbox' }).click();
  await expect(inboxPane(page).getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
}

test('captures to the Inbox from the button and the keyboard', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await open(page, phone);
  await (phone ? page.getByRole('button', { name: 'Capture a task' }) : nav(page).getByRole('button', { name: /Capture/ })).click();
  const capture = page.getByRole('dialog', { name: 'Capture' });
  const field = capture.getByRole('textbox', { name: 'Capture to Inbox' });
  await expect(field).toBeFocused();
  await field.fill('Return the books');
  if (phone) await capture.getByRole('button', { name: 'Save' }).click();
  else await field.press('Enter');
  if (!phone) await expect(capture.getByRole('status')).toHaveText('✓ Saved to Inbox, 4 waiting');
  await expect(capture).toHaveCount(0);
  await expect(inboxPane(page).locator('.inboxrow, .morerow').last()).toContainText('Return the books');

  if (!phone) {
    await page.keyboard.press('Shift+Meta+Space');
    await expect(capture.getByRole('textbox', { name: 'Capture to Inbox' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(capture).toHaveCount(0);
    await expect(nav(page).getByRole('button', { name: /Capture/ })).toBeFocused();
  }
  await page.screenshot({ path: info.outputPath('capture.png') });
});

test("shows the Inbox's count in a circle", async ({ page }, info) => {
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  const badge = await nav(page).locator(info.project.name === 'phone' ? '.tbadge' : '.navcount').boundingBox();
  expect(badge && badge.width).toBe(badge?.height);
});

test('processes the Inbox one card at a time, with Undo', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await open(page, phone);
  const rows = inboxPane(page).locator('.inboxrow, .morerow');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('Call the bank');
  await expect(rows.nth(1)).toContainText('Fix the gate2h estimate');

  await inboxPane(page).getByRole('button', { name: 'Process 3 items' }).click();
  await expect(card(page).getByRole('heading', { name: 'Call the bank', level: 1 })).toBeFocused();
  await page.screenshot({ path: info.outputPath('process.png') });
  if (phone) {
    for (const name of ['Paint the fence', 'One offs', 'Other project', 'Skip', 'Delete/done']) {
      const box = await card(page).getByRole('button', { name, exact: true }).boundingBox();
      expect(box!.height, name).toBeGreaterThanOrEqual(44);
    }
  }

  await card(page).getByRole('button', { name: 'Paint the fence' }).click();
  await expect(card(page).getByRole('heading', { name: 'Fix the gate' })).toBeVisible();
  await expect(card(page).getByRole('status')).toHaveText('Sent to Paint the fence.');

  await card(page).getByRole('button', { name: 'Add to this week' }).click();
  await card(page).getByRole('button', { name: 'One offs, add to this week' }).click();
  await expect(card(page).getByRole('heading', { name: 'Buy stamps' })).toBeVisible();
  await expect(card(page).getByRole('status')).toHaveText('Sent to One offs, Mon 5pm.');

  await card(page).getByRole('button', { name: phone ? '‹ Undo' : '‹ Undo and go back' }).click();
  await expect(card(page).getByRole('heading', { name: 'Fix the gate' })).toBeVisible();
  // Undo returns the card as it was when the choice was made, toggle included.
  await card(page).getByRole('button', { name: 'Adding to this week' }).click();

  if (phone) {
    await card(page).getByRole('button', { name: 'Other project' }).click();
    const sheet = page.getByRole('dialog', { name: 'Send to another project' });
    await sheet.getByRole('button', { name: /Write the report/ }).click();
    await sheet.getByRole('button', { name: 'Send' }).click();
  } else {
    await card(page).getByRole('combobox', { name: 'Send to another project' }).selectOption({ label: 'Write the report (Paused)' });
    await card(page).getByRole('button', { name: 'Send', exact: true }).click();
  }
  await expect(card(page).getByRole('status')).toHaveText('Sent to Write the report.');

  await card(page).getByRole('button', { name: 'Delete/done' }).click();
  await expect(card(page).getByRole('alert')).toContainText('Delete this item?');
  await card(page).getByRole('button', { name: 'Yes, delete' }).click();
  await expect(card(page).getByRole('heading', { name: 'Inbox clear' })).toBeVisible();
  await expect(card(page)).toContainText('2 sorted, 1 deleted.');
  await card(page).getByRole('button', { name: 'Done' }).click();
  await expect(card(page)).toHaveCount(0);
  await expect(inboxPane(page).getByText(phone ? 'Inbox is empty. Anything you capture lands here.' : 'Inbox is empty.')).toBeVisible();
});

test('keyboard shortcuts on the desktop card', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'Keyboard shortcuts are for the desktop card.');
  await open(page, false);
  await inboxPane(page).getByRole('button', { name: 'Assign Fix the gate' }).click();
  await expect(card(page).getByRole('heading', { name: 'Fix the gate', level: 1 })).toBeFocused();
  await page.keyboard.press('o');
  await expect(card(page).getByRole('heading', { name: 'Call the bank' })).toBeVisible();
  await page.keyboard.press('1');
  await expect(card(page).getByRole('status')).toHaveText('Sent to Paint the fence.');
  await page.keyboard.press('z');
  await expect(card(page).getByRole('heading', { name: 'Call the bank' })).toBeVisible();
  await page.keyboard.press('s');
  await expect(card(page).getByRole('heading', { name: 'Buy stamps' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await expect(inboxPane(page).locator('.inboxrow')).toHaveCount(2);
});
