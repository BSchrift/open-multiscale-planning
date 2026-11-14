import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openProject } from './journeys/journey';
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

test("Process's Done finishes an item, so Done lists it: a tap on phone, Option or Alt and F on desktop", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await open(page, phone);
  await inboxPane(page).getByRole('button', { name: 'Process 3 items' }).click();
  await expect(card(page).getByRole('heading', { name: 'Call the bank', level: 1 })).toBeVisible();
  if (phone) await card(page).getByRole('button', { name: 'Done', exact: true }).click();
  else await page.keyboard.press('Alt+KeyF');
  await expect(card(page).getByRole('heading', { name: 'Fix the gate', level: 1 })).toBeVisible();
  await expect(page.locator('.toast')).toContainText('Marked Call the bank done.');
  await card(page).getByRole('button', { name: 'Exit' }).click();

  const done = page.locator(".pane[aria-label='Done']:visible");
  if (phone) {
    await nav(page).getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: /^Done/ }).click();
  } else {
    await nav(page).getByRole('button', { name: 'Done' }).click();
  }
  await expect(done.getByRole('region', { name: 'Finished' }).getByRole('listitem')).toHaveText([/^2pmCall the bank/]);
  await page.screenshot({ path: info.outputPath('process-done.png') });
});

test('processes the Inbox one card at a time: one picker for where it goes, and a toast for each, with Undo', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await open(page, phone);
  const rows = inboxPane(page).locator('.inboxrow, .morerow');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('Call the bank');
  await expect(rows.nth(1)).toContainText('Fix the gate2h estimate');

  await inboxPane(page).getByRole('button', { name: 'Process 3 items' }).click();
  await expect(card(page).getByRole('heading', { name: 'Call the bank', level: 1 })).toBeVisible();
  // Focus starts in Add to, ready to type where the item goes.
  const field = phone ? card(page).getByRole('button', { name: /^Add to a project or One offs/ }) : page.getByRole('combobox', { name: 'Add to a project or One offs' });
  await expect(field).toBeFocused();
  await page.screenshot({ path: info.outputPath('process.png') });
  if (phone) for (const name of ['Add to a project or One offs', 'New practice from this item', '‹ Undo', 'Skip', 'Done', 'Delete']) await expectTapTarget(card(page).getByRole('button', { name, exact: true }));

  /** Picks a place: typed and Enter on desktop, a tap in the sheet on phone. */
  const addTo = async (typed: string, option: string) => {
    if (!phone) {
      await field.fill(typed);
      await expect(page.getByRole('option', { name: option })).toHaveAttribute('aria-selected', 'true');
      return field.press('Enter');
    }
    await field.click();
    const sheet = page.getByRole('dialog', { name: 'Add to' });
    await sheet.getByRole('combobox', { name: 'Add to a project or One offs' }).fill(typed);
    for (const row of await sheet.getByRole('option').all()) await expectTapTarget(row);
    await sheet.getByRole('option', { name: option }).click();
  };
  const toast = page.locator('.toast');

  await addTo('paint', 'Paint the fence');
  await expect(card(page).getByRole('heading', { name: 'Fix the gate' })).toBeVisible();
  await expect(toast).toContainText('Added Call the bank to Paint the fence.');
  // The toast is the app speaking, apart from the card: above the dimmed page in the band the card leaves free on
  // desktop, and just above the bottom row on phone, clear of the picker.
  const box = (await toast.boundingBox())!;
  expect(await toast.evaluate((t) => { const r = t.getBoundingClientRect(); return t.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
  if (phone) {
    expect(box.y + box.height).toBeLessThanOrEqual((await card(page).getByRole('button', { name: 'Skip' }).boundingBox())!.y);
    const add = (await card(page).getByRole('button', { name: 'Add to Paint the fence' }).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(add.y + add.height);
  } else {
    const c = (await card(page).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(c.y + c.height);
  }
  await page.screenshot({ path: info.outputPath('process-toast.png') });

  await card(page).getByRole('button', { name: 'Add to this week' }).click();
  await addTo('one', 'One offs, and to this week');
  await expect(card(page).getByRole('heading', { name: 'Buy stamps' })).toBeVisible();
  await expect(toast).toContainText('Added Fix the gate to One offs and to this week.');

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(card(page).getByRole('heading', { name: 'Fix the gate' })).toBeVisible();
  // Undo returns the card as it was when the choice was made, toggle included.
  await card(page).getByRole('button', { name: 'Adding to this week' }).click();
  await addTo('report', 'Write the report');
  await expect(toast).toContainText('Added Fix the gate to Write the report.');

  await card(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(card(page).getByRole('alert')).toContainText('Delete this item?');
  await card(page).getByRole('button', { name: 'Yes, delete' }).click();
  // That was the last: Process closes itself, and a green check over the empty Inbox says so, then fades.
  await expect(card(page)).toHaveCount(0);
  const check = page.locator('.clearveil');
  await expect(check).toHaveText('Inbox clear3 items processed');
  await expect(inboxPane(page).getByText(phone ? 'Inbox is empty. Anything you capture lands here.' : 'Inbox is empty.')).toBeVisible();
  // The Process button went with the last item, so focus goes to the Inbox's heading.
  await expect(inboxPane(page).getByRole('heading', { name: 'Inbox', level: 1 })).toBeFocused();
  await page.screenshot({ path: info.outputPath('inbox-clear.png') });
  // The last item's toast waits until the check has gone.
  await expect(check).toHaveCount(0, { timeout: 4000 });
  await expect(toast).toContainText('Deleted Buy stamps.');
});

test('a new project from the picker: the form, a Created toast, then a second Enter adds the item', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await open(page, phone);
  await inboxPane(page).getByRole('button', { name: 'Process 3 items' }).click();
  await expect(card(page).getByRole('heading', { name: 'Call the bank', level: 1 })).toBeVisible();
  if (phone) await card(page).getByRole('button', { name: 'Add to a project or One offs' }).click();
  const picker = page.getByRole('combobox', { name: 'Add to a project or One offs' });
  await picker.fill('Fix up the shed');
  if (phone) await page.getByRole('option', { name: '+ New project “Fix up the shed”' }).click();
  else await picker.press('Enter');
  const form = page.getByRole('form', { name: 'New project' });
  await expect(form.getByRole('textbox', { name: 'Name' })).toHaveValue('Fix up the shed');
  await form.getByRole('textbox', { name: 'Milestone to put it under, if any' }).fill('Roof watertight');
  await page.screenshot({ path: info.outputPath('process-new-project.png') });
  await form.getByRole('button', { name: 'Add project' }).click();
  await expect(page.locator('.toast')).toContainText('Created Fix up the shed, with the milestone Roof watertight.');
  await expect(card(page).getByRole('heading', { name: 'Call the bank', level: 1 })).toBeVisible();
  const add = card(page).getByRole('button', { name: 'Add to Fix up the shed' });
  if (!phone) await expect(add).toBeFocused();
  await page.screenshot({ path: info.outputPath('process-created.png') });
  await (phone ? add.click() : page.keyboard.press('Enter'));
  await expect(card(page).getByRole('heading', { name: 'Fix the gate', level: 1 })).toBeVisible();
  await expect(page.locator('.toast')).toContainText('Added Call the bank to Fix up the shed, under Roof watertight.');
});

// The owner's request for a long Inbox: select many items and give them a home at once, each action with one Undo.
test('edits the item on the card: its title, a description and a link, and Undo puts it back as it arrived', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await open(page, phone);
  await inboxPane(page).getByRole('button', { name: 'Process 3 items' }).click();
  const title = card(page).getByRole('heading', { name: 'Call the bank', level: 1 }).getByRole('button');
  await expect(title).toBeVisible();
  if (phone) {
    await expectTapTarget(card(page).locator('.pxedit .pen'));
    for (const name of ['Add description', 'Add link']) await expectTapTarget(card(page).getByRole('button', { name, exact: true }));
  }
  await title.click();
  const field = card(page).getByRole('textbox', { name: 'Title' });
  await expect(field).toBeFocused();
  await field.press('End');
  await field.pressSequentially(' about the loan');
  await card(page).getByRole('button', { name: 'Save' }).click();
  await expect(card(page).getByRole('heading', { name: 'Call the bank about the loan', level: 1 })).toBeVisible();

  await card(page).getByRole('button', { name: 'Add description' }).click();
  await card(page).getByRole('textbox', { name: 'Description' }).fill('Ask about the **rate**');
  await card(page).getByRole('button', { name: 'Save' }).click();
  await expect(card(page).locator('.pxnotes strong')).toHaveText('rate');

  await card(page).getByRole('button', { name: 'Add link' }).click();
  await card(page).getByRole('textbox', { name: 'Address' }).fill('https://bank.example.com/loans');
  await card(page).getByRole('textbox', { name: 'Address' }).press('Enter');
  await expect(card(page).getByRole('link', { name: 'bank.example.com' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('process-edited.png') });

  await card(page).getByRole('button', { name: phone ? '‹ Undo' : '‹ Undo and go back' }).click();
  await expect(page.locator('.toast')).toContainText('Call the bank is back as it arrived.');
  await expect(card(page).getByRole('heading', { name: 'Call the bank', level: 1 })).toBeVisible();
  await expect(card(page).getByRole('link', { name: 'bank.example.com' })).toHaveCount(0);
  await expect(card(page).getByRole('button', { name: 'Add description' })).toBeVisible();
});

test("a date set on the card goes with the item to a project, warned in the picker and on the project page when it's after the end", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await page.clock.install({ time: NOW });
  await openSeeded(page, [
    { type: 'objective', id: 'g1', fields: { title: 'Keep the house', state: 'active' } },
    { type: 'project', id: 'p1', fields: { title: 'Paint the fence', objective_id: 'g1', ...running } },
    { type: 'task', fields: { kind: 'inbox', title: 'Call the bank' } },
  ]);
  await nav(page).getByRole('button', { name: phone ? 'Inbox, 1 to sort' : 'Inbox' }).click();
  await inboxPane(page).getByRole('button', { name: 'Process 1 item' }).click();
  await expect(card(page).getByRole('heading', { name: 'Call the bank', level: 1 })).toBeVisible();
  if (phone) await expectTapTarget(card(page).getByRole('button', { name: 'Add date' }));
  await card(page).getByRole('button', { name: 'Add date' }).click();
  await card(page).getByLabel('Date', { exact: true }).fill('2027-02-10');
  await page.screenshot({ path: info.outputPath('process-date-form.png') });
  await card(page).getByRole('button', { name: 'Set date' }).click();
  await expect(card(page).getByRole('button', { name: 'Change date, Feb 10' })).toBeVisible();

  if (phone) await card(page).getByRole('button', { name: 'Add to a project or One offs' }).click();
  await page.getByRole('combobox', { name: 'Add to a project or One offs' }).fill('paint');
  const option = page.getByRole('option', { name: 'Paint the fence, Keep the house, due after the project ends (Jan 31)' });
  await expect(option.locator('.latewarn')).toHaveText('Due after the project ends (Jan 31)');
  await page.screenshot({ path: info.outputPath('process-late.png') });
  // It only warns: the item is added, date and all.
  await (phone ? option.click() : page.keyboard.press('Enter'));
  await expect(page.locator('.toast')).toContainText('Added Call the bank to Paint the fence, for Feb 10.');
  await expect(card(page)).toHaveCount(0);

  await openProject(page, phone, 'Keep the house', 'Paint the fence');
  const row = page.getByRole('button', { name: 'Edit task Call the bank, Feb 10, No estimate, due after the project ends (Jan 31)' });
  await expect(row).toBeVisible();
  await expect(row.locator('.latewarn')).toHaveText('Due after the project ends (Jan 31)');
  await page.screenshot({ path: info.outputPath('project-late.png') });
});

test('an Inbox row opens its popup from anywhere on it, and its pencil renames it in place', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await open(page, phone);
  const row = inboxPane(page).locator('.inboxrow').nth(1);
  // The estimate's line opens it too, not only the words of the title.
  await row.getByText('2h estimate').click();
  const popup = page.getByRole('dialog', { name: 'Fix the gate' });
  await expect(popup).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);

  const pen = row.getByRole('button', { name: 'Rename Fix the gate' });
  if (phone) for (const target of [pen, row.getByRole('button', { name: 'Process Fix the gate' })]) await expectTapTarget(target);
  else await row.hover();
  await page.screenshot({ path: info.outputPath('inbox-rows.png') });
  await pen.click();
  const field = inboxPane(page).getByRole('textbox', { name: 'Title' });
  await expect(field).toBeFocused();
  await field.press('End');
  await field.pressSequentially(' latch');
  await page.screenshot({ path: info.outputPath('inbox-renaming.png') });
  await field.press('Enter');
  await expect(page.locator('.toast')).toContainText('Renamed to Fix the gate latch.');
  await expect(inboxPane(page).getByRole('button', { name: 'Rename Fix the gate latch' })).toBeFocused();
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(row.getByRole('button', { name: 'Fix the gate', exact: true })).toBeVisible();
});

test('select mode adds, deletes and makes one offs of many items at once', async ({ page }, info) => {
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
    for (const name of ['Select all', 'Cancel', 'Add', 'Make one offs', 'Delete/done']) await expectTapTarget(pane.getByRole('button', { name, exact: true }));
    await expectTapTarget(pane.getByRole('combobox', { name: 'Project to add to' }));
    // The whole row is the checkbox's label, so the row is what a finger hits.
    for (const row of await rows.all()) await expectTapTarget(row);
  }
  await pane.getByRole('checkbox', { name: 'Call the bank' }).check();
  await pane.getByText('Buy stamps').click();
  await expect(pane.getByRole('status')).toHaveText('2 selected');
  await pane.getByRole('combobox', { name: 'Project to add to' }).selectOption({ label: 'Paint the fence' });
  await pane.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Added 2 items to Paint the fence.')).toBeVisible();
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
  await expect(card(page).getByRole('heading', { name: 'Fix the gate', level: 1 })).toBeVisible();
  const picker = page.getByRole('combobox', { name: 'Add to a project or One offs' });
  await expect(picker).toBeFocused();
  // In Add to, letters search, and Enter adds to the lit row.
  await page.keyboard.type('paint');
  await page.keyboard.press('Enter');
  await expect(card(page).getByRole('heading', { name: 'Call the bank' })).toBeVisible();
  await expect(page.locator('.toast')).toContainText('Added Fix the gate to Paint the fence.');
  // It starts on the place last used, so Enter adds there again.
  await expect(picker).toHaveValue('Paint the fence');
  await expect(card(page).getByText('Keys work with Option or Alt held. Settings can make them work alone.')).toBeVisible();
  // Option or Alt keys work from Add to as anywhere on the card.
  await page.keyboard.press('Alt+KeyZ');
  await expect(card(page).getByRole('heading', { name: 'Fix the gate' })).toBeVisible();
  await page.keyboard.press('Alt+KeyS');
  await expect(card(page).getByRole('heading', { name: 'Call the bank' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('checkbox', { name: 'Single-key shortcuts in Process' }).check();
  await nav(page).getByRole('button', { name: /^Inbox/ }).click();
  await inboxPane(page).getByRole('button', { name: 'Assign Fix the gate' }).click();
  await expect(picker).toBeFocused();
  // Single keys work once focus leaves the field.
  await page.keyboard.press('Escape');
  await expect(card(page).getByRole('heading', { name: 'Fix the gate', level: 1 }).getByRole('button')).toBeFocused();
  await page.keyboard.press('s');
  await expect(card(page).getByRole('heading', { name: 'Call the bank' })).toBeVisible();
  // Each new item puts focus back in Add to, where a letter searches; Esc leaves it.
  await expect(picker).toBeFocused();
  await page.keyboard.press('Escape');
  await page.keyboard.press('z');
  await expect(card(page).getByRole('heading', { name: 'Fix the gate' })).toBeVisible();
  // P opens the form on the name, selected; Esc goes back to the button that opened it.
  await page.keyboard.press('Escape');
  await page.keyboard.press('p');
  const form = card(page).getByRole('form', { name: 'New practice' });
  await expect(form.getByRole('textbox', { name: 'Name' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0);
  await expect(card(page).getByRole('button', { name: 'New practice from this item' })).toBeFocused();
  for (const next of ['Call the bank', 'Buy stamps']) {
    await page.keyboard.press('s');
    await expect(card(page).getByRole('heading', { name: next })).toBeVisible();
    await page.keyboard.press('Escape');
  }
  // The last skipped, Process closes, and its check says none were processed and all three are still here.
  await page.keyboard.press('s');
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator('.clearveil')).toHaveText('0 items processed3 still in your Inbox');
  await expect(inboxPane(page).locator('.inboxrow')).toHaveCount(3);
});

test('makes a project under a new goal, a practice and a goal from cards, each one change with its own Undo', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await open(page, phone);
  await inboxPane(page).getByRole('button', { name: 'Process 3 items' }).click();
  // A form in place of the picker on desktop, a sheet on phone.
  const form = (name: string) => (phone ? page.getByRole('dialog', { name }) : card(page).getByRole('form', { name }));
  const toast = page.locator('.toast');

  // Call the bank: a project under a new goal, named as typed in the picker, then the item added to it.
  await expect(card(page).getByRole('heading', { name: 'Call the bank', level: 1 })).toBeVisible();
  if (phone) await card(page).getByRole('button', { name: 'Add to a project or One offs' }).click();
  await page.getByRole('combobox', { name: 'Add to a project or One offs' }).fill('Sort out the bank');
  await page.getByRole('option', { name: '+ New project “Sort out the bank”' }).click();
  const project = form('New project');
  await expect(project.getByRole('textbox', { name: 'Name' })).toHaveValue('Sort out the bank');
  await project.getByRole('button', { name: '+ New goal' }).click();
  await project.getByRole('textbox', { name: 'New goal name' }).fill('Money in order');
  await expect(project.getByText('Today to Dec 31')).toBeVisible();
  await page.screenshot({ path: info.outputPath('home-form.png') });
  await project.getByRole('button', { name: 'Add project' }).click();
  await expect(toast).toContainText('Created Sort out the bank, under Money in order.');
  await card(page).getByRole('button', { name: 'Add to Sort out the bank' }).click();
  await expect(toast).toContainText('Added Call the bank to Sort out the bank.');

  // Fix the gate: a practice it becomes, then Undo takes back both the practice and the closing.
  await expect(card(page).getByRole('heading', { name: 'Fix the gate', level: 1 })).toBeVisible();
  await card(page).getByRole('button', { name: 'New practice from this item' }).click();
  await expect(form('New practice').getByRole('combobox', { name: 'Goal' })).toHaveValue(/.+/);
  await form('New practice').getByRole('button', { name: 'Make it a practice' }).click();
  await expect(toast).toContainText('Fix the gate is now a practice.');
  await card(page).getByRole('button', { name: phone ? '‹ Undo' : '‹ Undo and go back' }).click();
  await expect(toast).toContainText('Undone: Fix the gate removed. Fix the gate is back.');
  await expect(card(page).getByRole('heading', { name: 'Fix the gate', level: 1 })).toBeVisible();

  // A goal, keeping the item on the card to file next.
  await card(page).getByRole('button', { name: 'New goal from this item' }).click();
  await form('New goal').getByRole('textbox', { name: 'Name' }).fill('Keep the house');
  await form('New goal').getByRole('checkbox', { name: 'Keep it on this card to file next' }).check();
  await form('New goal').getByRole('button', { name: 'Add goal' }).click();
  await expect(toast).toContainText('Created Keep the house.');
  if (phone) {
    await card(page).getByRole('button', { name: /^Add to a project or One offs/ }).click();
    await page.getByRole('dialog', { name: 'Add to' }).getByRole('option', { name: 'Paint the fence' }).click();
  } else {
    await page.getByRole('combobox', { name: 'Add to a project or One offs' }).fill('paint');
    await page.keyboard.press('Enter');
  }
  await expect(toast).toContainText('Added Fix the gate to Paint the fence.');
  await card(page).getByRole('button', { name: 'Exit' }).click();
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
  await card(page).getByRole('button', { name: 'Add to a project or One offs' }).click();
  await page.getByRole('option', { name: '+ New project' }).click();
  const sheet = page.getByRole('dialog', { name: 'New project' });
  const height = page.viewportSize()!.height;
  // As app/keyboard.ts sets it for a 336pt keyboard.
  await page.evaluate(() => document.documentElement.style.setProperty('--keyboard', '336px'));
  await expect.poll(async () => Math.round((await sheet.boundingBox())!.y + (await sheet.boundingBox())!.height)).toBe(height - 336);
  const add = sheet.getByRole('button', { name: 'Add project' });
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
