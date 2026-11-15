// Process into a goal's backlog: B then a goal's number on desktop, Goal backlog then Add on phone.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded, readRecord } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm
const SHOTS = process.env.E2E_SHOTS;

const records: Seed[] = [
  { type: 'objective', id: 'g1', fields: { title: 'Learn to bake bread', state: 'active', order: 1 } },
  { type: 'objective', id: 'g2', fields: { title: 'Stay fit', state: 'active', order: 2 } },
  { type: 'task', id: 'i1', fields: { kind: 'inbox', title: 'Buy a banneton', order: 1 } },
  { type: 'task', id: 'i2', fields: { kind: 'inbox', title: 'Order rye flour', order: 2 } },
  { type: 'task', id: 'i3', fields: { kind: 'inbox', title: 'Book a dentist check-up', order: 3 } },
];

const card = (page: Page) => page.getByRole('dialog', { name: 'Process Inbox' });

async function openProcess(page: Page, phone: boolean) {
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: phone ? 'Inbox, 3 to sort' : 'Inbox' }).click();
  await page.locator(".pane[aria-label='Inbox']:visible").getByRole('button', { name: 'Process 3 items' }).click();
  await expect(card(page).getByRole('heading', { name: 'Buy a banneton', level: 1 })).toBeVisible();
}

test("files Inbox items to a goal's backlog in two keys or two taps, with Undo", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await openProcess(page, phone);
  if (phone) {
    const opener = card(page).getByRole('button', { name: 'Goal backlog' });
    await expectTapTarget(opener);
    await opener.click();
    const sheet = page.getByRole('dialog', { name: "Which goal's backlog?" });
    await sheet.getByRole('button', { name: /^Learn to bake bread/ }).click();
    for (const target of [sheet.getByRole('button', { name: /^Stay fit/ }), sheet.getByRole('button', { name: 'Add to the backlog for Learn to bake bread' })]) await expectTapTarget(target);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/process-backlog-phone.png` });
    await sheet.getByRole('button', { name: 'Add to the backlog for Learn to bake bread' }).click();
    await expect(card(page).getByRole('heading', { name: 'Order rye flour', level: 1 })).toBeVisible();
    // The same goal again: two taps.
    await card(page).getByRole('button', { name: 'Goal backlog' }).click();
    await page.getByRole('dialog', { name: "Which goal's backlog?" }).getByRole('button', { name: 'Add to the backlog for Learn to bake bread' }).click();
  } else {
    // Keys work with Option or Alt until Settings makes them work alone.
    await page.keyboard.press('Alt+KeyB');
    const chooser = card(page).getByRole('group', { name: "Which goal's backlog?" });
    await expect(chooser).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/process-backlog-desktop.png` });
    await page.keyboard.press('Alt+Digit1');
    await expect(card(page).getByRole('heading', { name: 'Order rye flour', level: 1 })).toBeVisible();
    await page.keyboard.press('Alt+KeyB');
    await page.keyboard.press('Alt+Digit1');
  }
  await expect(card(page).getByRole('heading', { name: 'Book a dentist check-up', level: 1 })).toBeVisible();
  expect(await readRecord(page, 'task', 'i1')).toMatchObject({ kind: 'project', project_id: 'backlog:g1' });
  expect(await readRecord(page, 'task', 'i2')).toMatchObject({ kind: 'project', project_id: 'backlog:g1' });
  expect(await readRecord(page, 'project', 'backlog:g1')).toMatchObject({ objective_id: 'g1', state: 'active' });
  await card(page).getByRole('button', { name: /^‹ Undo/ }).click();
  await expect(card(page).getByRole('heading', { name: 'Order rye flour', level: 1 })).toBeVisible();
  await expect.poll(async () => (await readRecord(page, 'task', 'i2'))?.kind).toBe('inbox');
});
