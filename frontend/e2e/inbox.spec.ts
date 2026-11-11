import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded } from './seed';
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
  await expect(card(page).getByRole('status')).toHaveText('Sent to One offs and added to this week, not on the calendar yet.');

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
    await card(page).getByRole('button', { name: 'Find a project' }).click();
    await card(page).getByRole('combobox', { name: 'Find a project' }).fill('report');
    await card(page).getByRole('option', { name: /Write the report/ }).click();
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

// The owner's request for a long Inbox: select many items and give them a home at once, each action with one Undo.
test('select mode sends, deletes and makes one offs of many items at once', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await open(page, phone);
  const pane = inboxPane(page);
  const rows = pane.locator('.inboxrow');
  const toggle = pane.getByRole('button', { name: 'Select', exact: true });
  const undo = page.getByRole('button', { name: 'Undo' });

  await toggle.click();
  await expect(pane.getByRole('status')).toHaveText('0 selected');
  if (phone) {
    // The docked Process button steps aside while selecting.
    await expect(pane.getByRole('button', { name: 'Process 3 items' })).toBeHidden();
    for (const name of ['Select all', 'Cancel', 'Send', 'Make one offs', 'Delete/done']) await expectTapTarget(pane.getByRole('button', { name, exact: true }));
    await expectTapTarget(pane.getByRole('combobox', { name: 'Send to project' }));
    // The whole row is the checkbox's label, so the row is what a finger hits.
    for (const row of await rows.all()) await expectTapTarget(row);
  }
  await pane.getByRole('checkbox', { name: 'Call the bank' }).check();
  await pane.getByText('Buy stamps').click();
  await expect(pane.getByRole('status')).toHaveText('2 selected');
  await pane.getByRole('combobox', { name: 'Send to project' }).selectOption({ label: 'Paint the fence' });
  await pane.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Sent 2 items to Paint the fence.')).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(pane.getByRole('button', { name: 'Fix the gate', exact: true })).toBeFocused();
  await undo.click();
  await expect(rows).toHaveCount(3);

  // Select all, then Delete/done asks first, and one Undo brings every item back.
  await toggle.click();
  await pane.getByRole('button', { name: 'Select all' }).click();
  await expect(pane.getByRole('status')).toHaveText('3 selected');
  await pane.getByRole('button', { name: 'Delete/done' }).click();
  await expect(pane.getByRole('alert')).toContainText('Delete 3 items?');
  if (phone) for (const name of ['Yes, delete', 'Keep them']) await expectTapTarget(pane.getByRole('button', { name }));
  await pane.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(page.getByText('Deleted 3 items.')).toBeVisible();
  await expect(pane.getByText(phone ? 'Inbox is empty. Anything you capture lands here.' : 'Inbox is empty.')).toBeVisible();
  await expect(undo).toBeFocused();
  await undo.click();
  await expect(rows).toHaveCount(3);

  // Leaving select mode forgets the ticks; One offs then saves, and stays after a reload.
  await toggle.click();
  await pane.getByRole('checkbox', { name: 'Call the bank' }).check();
  await pane.getByRole('button', { name: 'Cancel' }).click();
  await expect(toggle).toBeFocused();
  await toggle.click();
  await expect(pane.getByRole('status')).toHaveText('0 selected');
  await pane.getByRole('checkbox', { name: 'Fix the gate' }).check();
  await pane.getByRole('button', { name: 'Make one offs' }).click();
  await expect(page.getByText('Made 1 one off.')).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect(pane.getByRole('button', { name: 'Buy stamps', exact: true })).toBeFocused();
  // Phone WebKit saves the database 200ms after a change.
  await page.waitForTimeout(600);
  await page.reload();
  await nav(page).getByRole('button', { name: phone ? 'Inbox, 2 to sort' : 'Inbox' }).click();
  await expect(rows).toHaveCount(2);
});

test('keyboard shortcuts on the desktop card: with Option or Alt, or alone once Settings turns them on', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'Keyboard shortcuts are for the desktop card.');
  await open(page, false);
  await inboxPane(page).getByRole('button', { name: 'Assign Fix the gate' }).click();
  await expect(card(page).getByRole('heading', { name: 'Fix the gate', level: 1 })).toBeFocused();
  // Off, as by default: a key alone does nothing, and with Alt (Option on a Mac) it works.
  await page.keyboard.press('o');
  await expect(card(page).getByRole('heading', { name: 'Fix the gate' })).toBeVisible();
  await expect(card(page).getByText('Keys work with Option or Alt held. Settings can make them work alone.')).toBeVisible();
  await page.keyboard.press('Alt+KeyO');
  await expect(card(page).getByRole('heading', { name: 'Call the bank' })).toBeVisible();
  await page.keyboard.press('Alt+KeyZ');
  await expect(card(page).getByRole('heading', { name: 'Fix the gate' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('checkbox', { name: 'Single-key shortcuts in Process' }).check();
  await nav(page).getByRole('button', { name: /^Inbox/ }).click();
  await inboxPane(page).getByRole('button', { name: 'Assign Fix the gate' }).click();
  await expect(card(page).getByRole('heading', { name: 'Fix the gate', level: 1 })).toBeFocused();
  await page.keyboard.press('o');
  await expect(card(page).getByRole('heading', { name: 'Call the bank' })).toBeVisible();
  await page.keyboard.press('1');
  await expect(card(page).getByRole('status')).toHaveText('Sent to Paint the fence.');
  await page.keyboard.press('z');
  await expect(card(page).getByRole('heading', { name: 'Call the bank' })).toBeVisible();
  // The finder: / opens it, typing filters, Enter sends.
  await page.keyboard.press('/');
  await page.keyboard.type('report');
  await page.keyboard.press('Enter');
  await expect(card(page).getByRole('status')).toHaveText('Sent to Write the report.');
  // N opens the form on the name, selected; Esc goes back to the button that opened it.
  await page.keyboard.press('n');
  const form = card(page).getByRole('form', { name: 'New project' });
  await expect(form.getByRole('textbox', { name: 'Name' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0);
  await expect(card(page).getByRole('button', { name: 'New project from this item' })).toBeFocused();
  await page.keyboard.press('s');
  await expect(card(page).getByRole('heading', { name: "That's everything for now" })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await expect(inboxPane(page).locator('.inboxrow')).toHaveText([/Buy stamps/]);
});

test('makes a project under a new goal, a practice and a goal from cards, each one change with its own Undo', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await open(page, phone);
  await inboxPane(page).getByRole('button', { name: 'Process 3 items' }).click();
  // A form in place of the destinations on desktop, a sheet on phone.
  const form = (name: string) => (phone ? page.getByRole('dialog', { name }) : card(page).getByRole('form', { name }));

  // Call the bank: a project under a new goal, with the item as its first task.
  await expect(card(page).getByRole('heading', { name: 'Call the bank', level: 1 })).toBeVisible();
  await card(page).getByRole('button', { name: 'New project from this item' }).click();
  const project = form('New project');
  await expect(project.getByRole('textbox', { name: 'Name' })).toHaveValue('Call the bank');
  await project.getByRole('textbox', { name: 'Name' }).fill('Sort out the bank');
  await project.getByRole('button', { name: '+ New goal' }).click();
  await project.getByRole('textbox', { name: 'New goal name' }).fill('Money in order');
  await expect(project.getByText('Today to Dec 31')).toBeVisible();
  await page.screenshot({ path: info.outputPath('home-form.png') });
  await project.getByRole('button', { name: 'Add project and send it there' }).click();
  await expect(card(page).getByRole('status')).toHaveText('Added goal Money in order and project Sort out the bank, and sent "Call the bank" to it.');

  // Fix the gate: a practice it becomes, then Undo takes back both the practice and the closing.
  await expect(card(page).getByRole('heading', { name: 'Fix the gate', level: 1 })).toBeVisible();
  await card(page).getByRole('button', { name: 'New practice from this item' }).click();
  await expect(form('New practice').getByRole('combobox', { name: 'Goal' })).toHaveValue(/.+/);
  await form('New practice').getByRole('button', { name: 'Make it a practice' }).click();
  await expect(card(page).getByRole('status')).toHaveText('"Fix the gate" is now a practice, 30m a day. It left your Inbox.');
  await card(page).getByRole('button', { name: phone ? '‹ Undo' : '‹ Undo and go back' }).click();
  await expect(card(page).getByRole('status')).toHaveText('Undone: Fix the gate removed, "Fix the gate" is back in your Inbox.');
  await expect(card(page).getByRole('heading', { name: 'Fix the gate', level: 1 })).toBeVisible();

  // A goal, keeping the item on the card to file next.
  await card(page).getByRole('button', { name: 'New goal from this item' }).click();
  await form('New goal').getByRole('textbox', { name: 'Name' }).fill('Keep the house');
  await form('New goal').getByRole('checkbox', { name: 'Keep it on this card to file next' }).check();
  await form('New goal').getByRole('button', { name: 'Add goal' }).click();
  await expect(card(page).getByRole('status')).toHaveText('Added goal Keep the house. Now file "Fix the gate".');
  await card(page).getByRole('button', { name: 'Paint the fence' }).click();
  await expect(card(page).getByRole('status')).toHaveText('Sent to Paint the fence.');
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);

  // Both goals are on the Goals page, and only Buy stamps is left to sort.
  await expect(inboxPane(page).locator('.inboxrow, .morerow')).toHaveText([/Buy stamps/]);
  await nav(page).getByRole('button', { name: /^Goals/ }).click();
  const goals = page.locator(".pane[aria-label='Goals']:visible");
  await expect(goals.getByText('Money in order').first()).toBeVisible();
  await expect(goals.getByText('Keep the house').first()).toBeVisible();
});

test('phone: the form for a new home rises above the keyboard with its button in view', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'The keyboard is a phone matter');
  await open(page, true);
  await inboxPane(page).getByRole('button', { name: 'Process 3 items' }).click();
  await card(page).getByRole('button', { name: 'New project from this item' }).click();
  const sheet = page.getByRole('dialog', { name: 'New project' });
  const height = page.viewportSize()!.height;
  // As app/keyboard.ts sets it for a 336pt keyboard.
  await page.evaluate(() => document.documentElement.style.setProperty('--keyboard', '336px'));
  await expect.poll(async () => Math.round((await sheet.boundingBox())!.y + (await sheet.boundingBox())!.height)).toBe(height - 336);
  const add = sheet.getByRole('button', { name: 'Add project and send it there' });
  await expect(add).toBeInViewport();
  expect((await add.boundingBox())!.y + (await add.boundingBox())!.height).toBeLessThanOrEqual(height - 336);
  for (const name of ['Clear name', '+ New goal', 'Cancel']) {
    const box = await sheet.getByRole('button', { name, exact: true }).boundingBox();
    expect(box!.height, name).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: info.outputPath('home-sheet.png') });
});

test('phone: the Capture sheet rises above the keyboard, which covers the page rather than shrinking it', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'The keyboard is a phone matter');
  await open(page, true);
  await page.getByRole('button', { name: 'Capture a task' }).click();
  const sheet = page.getByRole('dialog', { name: 'Capture' });
  const height = page.viewportSize()!.height;
  // A browser can't open a keyboard in a test, so this sets what app/keyboard.ts would for a 336pt keyboard.
  await page.evaluate(() => document.documentElement.style.setProperty('--keyboard', '336px'));
  await expect.poll(async () => Math.round((await sheet.boundingBox())!.y + (await sheet.boundingBox())!.height)).toBe(height - 336);
  await expect(sheet.getByRole('textbox', { name: 'Capture to Inbox' })).toBeInViewport();
});
