import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { processTo } from './journeys/journey';
import { expectTapTarget, oneOffRow, openSeeded, pane } from './seed';
import type { Seed } from './seed';

// Process's choices one by one, beyond the tour of them in inbox.spec.ts, and Capture's ways out and past the Inbox.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm.

const records: Seed[] = [
  // This week is planned, so the Week page shows what waits in it to be scheduled.
  { type: 'week_plan', id: 'week:2026-11-02', fields: { week_start: '2026-11-02', finished_at: '2026-11-02T14:00:00Z' } },
  { type: 'project', id: 'p1', fields: { title: 'Paint the fence', state: 'active', start: '2026-10-01', end: '2027-01-31' } },
  { type: 'task', fields: { kind: 'inbox', title: 'Call the bank' } },
  { type: 'task', fields: { kind: 'inbox', title: 'Fix the gate', estimate_min: 120 } },
  { type: 'task', fields: { kind: 'inbox', title: 'Buy stamps' } },
];

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const card = (page: Page) => page.getByRole('dialog', { name: 'Process Inbox' });
const title = (page: Page, name: string) => card(page).getByRole('heading', { name, level: 1 });
const rows = (page: Page) => pane(page, 'Inbox').locator('.inboxrow, .morerow');
const toast = (page: Page) => page.locator('.toast');

async function open(page: Page, phone: boolean) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await nav(page).getByRole('button', { name: phone ? 'Inbox, 3 to sort' : 'Inbox' }).click();
  await expect(rows(page)).toHaveCount(3);
  return errors;
}

/** Leaves Process: Exit on phone; on desktop Esc leaves Add to, where focus starts, then closes the card. */
async function exit(page: Page, phone: boolean) {
  if (phone) await card(page).getByRole('button', { name: 'Exit' }).click();
  else {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
  await expect(card(page)).toHaveCount(0);
}

async function openCapture(page: Page, phone: boolean) {
  await (phone ? page.getByRole('button', { name: 'Capture a task' }) : nav(page).getByRole('button', { name: /Capture/ })).click();
  const capture = page.getByRole('dialog', { name: 'Capture' });
  await expect(capture.getByRole('textbox', { name: /^Capture to/ })).toBeFocused();
  return capture;
}

test('an Inbox item with a block shows its time on its row and its card, and filing it keeps the block, then Delete takes one off', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  // As hold to create leaves them: Inbox items with their blocks on the calendar, at 5:45pm and 7pm today.
  const held = (id: string, title: string, start: string, end: string): Seed[] => [
    { type: 'task', id, fields: { kind: 'inbox', title, estimate_min: 60 } },
    { type: 'time_block', id: `b-${id}`, fields: { task_id: id, start, end, tz: 'America/Chicago' } },
  ];
  await openSeeded(page, [records[0]!, records[1]!, ...held('a1', 'Book dentist', '2026-11-02T23:45:00Z', '2026-11-03T00:45:00Z'), ...held('a2', 'Call the plumber', '2026-11-03T01:00:00Z', '2026-11-03T02:00:00Z')]);
  await nav(page).getByRole('button', { name: phone ? 'Inbox, 2 to sort' : 'Inbox' }).click();
  await expect(rows(page)).toHaveText([/Book dentist.*Today, 5:45pm to 6:45pm/, /Call the plumber.*Today, 7pm to 8pm/]);
  await page.screenshot({ path: info.outputPath('inbox-rows-with-blocks.png') });

  await pane(page, 'Inbox').getByRole('button', { name: 'Process 2 items' }).click();
  await expect(title(page, 'Book dentist')).toBeVisible();
  await expect(card(page).getByText('On the calendar today, 5:45pm to 6:45pm. It keeps this time wherever it goes.')).toBeVisible();
  await page.screenshot({ path: info.outputPath('process-card-with-block.png') });
  await processTo(page, phone, 'One offs');
  await expect(toast(page)).toContainText('Added Book dentist to One offs. Its block at 5:45pm stays.');

  await expect(title(page, 'Call the plumber')).toBeVisible();
  await card(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await card(page).getByRole('alert').getByRole('button', { name: 'Yes, delete' }).click();
  await expect(card(page)).toHaveCount(0);
  // The last item's toast waits until the Inbox clear check has gone.
  await expect(page.locator('.clearveil')).toHaveCount(0, { timeout: 4000 });
  await expect(toast(page)).toContainText('Deleted Call the plumber and its block at 7pm.');

  // On Today the filed one keeps its time, now drawn as a one off, and the deleted one's is gone.
  await nav(page).getByRole('button', { name: 'Today' }).click();
  const filed = page.getByRole(phone ? 'slider' : 'button', { name: /^Book dentist, 5:45pm to 6:45pm, One off\./ });
  await expect(filed).toHaveClass(/\bk-oneoff\b/);
  await expect(page.getByRole(phone ? 'slider' : 'button', { name: /^Call the plumber/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Skip keeps an item for later, Delete's Cancel keeps it too, and leaving part way, Process starts again on what's left", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone);
  await pane(page, 'Inbox').getByRole('button', { name: 'Process 3 items' }).click();
  await expect(title(page, 'Call the bank')).toBeVisible();
  await expect(card(page).getByText('1 of 3')).toBeVisible();
  await card(page).getByRole('button', { name: 'Skip' }).click();
  await expect(toast(page)).toContainText('Skipped Call the bank. It stays in your Inbox.');

  await expect(title(page, 'Fix the gate')).toBeVisible();
  await expect(card(page).getByText('2 of 3')).toBeVisible();
  await card(page).getByRole('button', { name: 'Delete', exact: true }).click();
  const ask = card(page).getByRole('alert');
  await expect(ask).toContainText('Delete this item?');
  if (phone) for (const name of ['Yes, delete', 'Cancel']) await expectTapTarget(ask.getByRole('button', { name }));
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  await expect(title(page, 'Fix the gate')).toBeVisible();
  await processTo(page, phone, 'One offs');
  await expect(toast(page)).toContainText('Added Fix the gate to One offs.');
  await expect(title(page, 'Buy stamps')).toBeVisible();

  // Leaving part way shows no check: it only comes after the last item.
  await exit(page, phone);
  await expect(page.locator('.clearveil')).toHaveCount(0);
  await expect(rows(page)).toHaveText([/Call the bank/, /Buy stamps/]);
  await pane(page, 'Inbox').getByRole('button', { name: 'Process 2 items' }).click();
  await expect(title(page, 'Call the bank')).toBeVisible();
  await expect(card(page).getByText('1 of 2')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Undo steps back over each card in turn, a skip as well as an add, until there is nothing left to undo', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone);
  await pane(page, 'Inbox').getByRole('button', { name: 'Process 3 items' }).click();
  const undo = card(page).getByRole('button', { name: phone ? 'Undo' : 'Undo and go back' });
  // Nothing has happened yet, so there's nothing to step back over.
  await expect(undo).toBeDisabled();
  await processTo(page, phone, 'Paint the fence');
  await expect(toast(page)).toContainText('Added Call the bank to Paint the fence.');
  await card(page).getByRole('button', { name: 'Skip' }).click();
  await expect(title(page, 'Buy stamps')).toBeVisible();
  await expect(card(page).getByText('3 of 3')).toBeVisible();

  await undo.click();
  await expect(toast(page)).toContainText('Fix the gate is back.');
  await expect(title(page, 'Fix the gate')).toBeVisible();
  await expect(card(page).getByText('2 of 3')).toBeVisible();
  await undo.click();
  await expect(toast(page)).toContainText('Call the bank is back.');
  await expect(title(page, 'Call the bank')).toBeVisible();
  await expect(card(page).getByText('1 of 3')).toBeVisible();
  await expect(undo).toBeDisabled();

  // Call the bank left the project and is in the Inbox again.
  await exit(page, phone);
  await expect(rows(page)).toHaveText([/Call the bank/, /Fix the gate/, /Buy stamps/]);
  expect(errors).toEqual([]);
});

test('picking a place in Add to only chooses it: the item stays until Add to adds it there', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone);
  await pane(page, 'Inbox').getByRole('button', { name: 'Process 3 items' }).click();
  if (phone) await card(page).getByRole('button', { name: /^Add to a project or One offs/ }).click();
  await page.getByRole('combobox', { name: 'Add to a project or One offs' }).click();
  await page.getByRole('option', { name: 'Paint the fence' }).click();
  await expect(page.getByRole('listbox', { name: 'Projects and One offs' })).toHaveCount(0);
  await expect(title(page, 'Call the bank')).toBeVisible();
  await expect(card(page).getByText('1 of 3')).toBeVisible();
  await card(page).getByRole('button', { name: 'Add to Paint the fence', exact: true }).click();
  await expect(toast(page)).toContainText('Added Call the bank to Paint the fence.');
  await expect(title(page, 'Fix the gate')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Add to this week is off again on each new card, and the item it adds waits in the week to be scheduled', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone);
  await pane(page, 'Inbox').getByRole('button', { name: 'Process 3 items' }).click();
  const week = card(page).getByRole('switch', { name: 'Add to this week' });
  if (phone) await expectTapTarget(week);
  await expect(week).toHaveAttribute('aria-checked', 'false');
  await week.click();
  await expect(week).toHaveAttribute('aria-checked', 'true');
  await processTo(page, phone, 'Paint the fence');
  await expect(toast(page)).toContainText('Added Call the bank to Paint the fence and to this week.');

  // The next card starts with it off, so this one goes to the project alone.
  await expect(title(page, 'Fix the gate')).toBeVisible();
  await expect(week).toHaveAttribute('aria-checked', 'false');
  await processTo(page, phone, 'Paint the fence');
  await expect(toast(page)).toContainText('Added Fix the gate to Paint the fence.');
  await exit(page, phone);

  await nav(page).getByRole('button', { name: 'Week' }).click();
  const lane = page.getByRole('region', { name: 'To schedule' });
  // With no estimate, an item added to a project counts as an hour.
  await expect(lane.getByRole('button', { name: /^Call the bank, Project, 1h\b/ })).toBeVisible();
  await expect(lane.getByRole('button', { name: /^Fix the gate,/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the Time slider saves the estimate as it moves, even for an item skipped, and each card starts from its own', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone);
  await pane(page, 'Inbox').getByRole('button', { name: 'Process 3 items' }).click();
  const slider = card(page).getByRole('slider', { name: 'Time' });
  await expect(slider).toHaveAttribute('aria-valuetext', 'No estimate');
  await slider.focus();
  // Five minutes a step, each checked before the next, as each one saves.
  for (const text of ['5m', '10m', '15m', '20m', '25m', '30m']) {
    await page.keyboard.press('ArrowRight');
    await expect(slider).toHaveAttribute('aria-valuetext', text);
  }
  await processTo(page, phone, 'One offs');
  await expect(toast(page)).toContainText('Added Call the bank to One offs.');

  // Not the 30m just set: Fix the gate came with 2h.
  await expect(title(page, 'Fix the gate')).toBeVisible();
  await expect(slider).toHaveAttribute('aria-valuetext', '2h');
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', '2h 30m');
  await card(page).getByRole('button', { name: 'Skip' }).click();
  await expect(title(page, 'Buy stamps')).toBeVisible();
  await expect(slider).toHaveAttribute('aria-valuetext', 'No estimate');
  await exit(page, phone);

  await expect(rows(page).filter({ hasText: 'Fix the gate' })).toContainText('2h 30m estimate');
  await (phone ? nav(page).getByRole('button', { name: 'More' }).click().then(() => pane(page, 'More').getByRole('button', { name: /^One offs/ }).click()) : nav(page).getByRole('button', { name: 'One offs' }).click());
  await expect(oneOffRow(page, 'Call the bank')).toContainText('30m');
  expect(errors).toEqual([]);
});

test('a title being edited when the item is added is saved to that item, and the next card shows its own title', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone);
  await pane(page, 'Inbox').getByRole('button', { name: 'Process 3 items' }).click();
  await title(page, 'Call the bank').getByRole('button').click();
  await card(page).getByRole('textbox', { name: 'Title' }).fill('Call the bank about the loan');
  await processTo(page, phone, 'One offs');
  await expect(toast(page)).toContainText('Added Call the bank about the loan to One offs.');
  await expect(title(page, 'Fix the gate')).toBeVisible();
  await expect(card(page).getByRole('textbox', { name: 'Title' })).toHaveCount(0);
  await exit(page, phone);

  await expect(rows(page)).toHaveText([/Fix the gate/, /Buy stamps/]);
  await (phone ? nav(page).getByRole('button', { name: 'More' }).click().then(() => pane(page, 'More').getByRole('button', { name: /^One offs/ }).click()) : nav(page).getByRole('button', { name: 'One offs' }).click());
  await expect(oneOffRow(page, 'Call the bank about the loan')).toBeVisible();
  expect(errors).toEqual([]);
});

test('desktop: W, E and G do what their buttons do, D asks and Enter or a second D deletes, and Ctrl or Cmd with Z steps back', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'Keyboard shortcuts are for the desktop card.');
  const errors = await open(page, false);
  await pane(page, 'Inbox').getByRole('button', { name: 'Process 3 items' }).click();
  const picker = page.getByRole('combobox', { name: 'Add to a project or One offs' });
  await expect(picker).toBeFocused();

  // From Add to, Enter answers the question.
  await page.keyboard.press('Alt+KeyD');
  await expect(card(page).getByRole('alert')).toContainText('Delete this item?');
  await page.keyboard.press('Enter');
  await expect(toast(page)).toContainText('Deleted Call the bank.');
  await expect(title(page, 'Fix the gate')).toBeVisible();
  // Focus is back in Add to with nothing typed, so the shortcut steps back rather than undoing typing.
  await expect(picker).toBeFocused();
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect(toast(page)).toContainText('Call the bank is back.');
  await expect(title(page, 'Call the bank')).toBeVisible();

  await page.keyboard.press('Alt+KeyW');
  await expect(card(page).getByRole('switch', { name: 'Add to this week' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Alt+KeyW');
  await expect(card(page).getByRole('switch', { name: 'Add to this week' })).toHaveAttribute('aria-checked', 'false');

  await page.keyboard.press('Alt+KeyE');
  await expect(card(page).getByRole('textbox', { name: 'Title' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(title(page, 'Call the bank').getByRole('button')).toBeFocused();

  await page.keyboard.press('Alt+KeyG');
  const goal = card(page).getByRole('form', { name: 'New goal' });
  await expect(goal.getByRole('textbox', { name: 'Name' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(goal).toHaveCount(0);
  await expect(card(page).getByRole('button', { name: 'New goal from this item' })).toBeFocused();

  // On a button, Enter is that button's, so a second D answers.
  await page.keyboard.press('Alt+KeyD');
  await expect(card(page).getByRole('alert')).toContainText('Delete this item?');
  await page.keyboard.press('Alt+KeyD');
  await expect(toast(page)).toContainText('Deleted Call the bank.');
  await expect(title(page, 'Fix the gate')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Done and Delete stand apart: Done in the success colour with a tick, Delete red with a bin, and Yes, delete solid red', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone);
  await pane(page, 'Inbox').getByRole('button', { name: 'Process 3 items' }).click();
  const done = card(page).getByRole('button', { name: 'Done', exact: true });
  const remove = card(page).getByRole('button', { name: 'Delete', exact: true });
  // A token as the page has it now, as the rgb() a computed style gives.
  const token = (name: string) =>
    page.evaluate((n) => {
      const probe = document.createElement('i');
      probe.style.color = `var(${n})`;
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    }, name);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(done).toHaveCSS('color', await token('--ok'));
    await expect(done).toHaveCSS('border-top-color', await token('--ok'));
    await expect(remove).toHaveCSS('color', await token('--danger'));
    await expect(done.locator('[data-icon="done"]')).toBeVisible();
    await expect(remove.locator('[data-icon="bin"]')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`process-done-delete-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  if (phone) {
    // Undo keeps its icon and drops its word, still named for VoiceOver, and every button still fits the row.
    const undo = card(page).getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toHaveText('');
    for (const name of ['Undo', 'Skip', 'Done', 'Delete']) await expectTapTarget(card(page).getByRole('button', { name, exact: true }));
    const row = (await card(page).locator('.pxacts').boundingBox())!;
    const end = (await remove.boundingBox())!;
    expect(end.x + end.width).toBeLessThanOrEqual(row.x + row.width + 0.5);
  }
  await remove.click();
  const yes = card(page).getByRole('button', { name: 'Yes, delete' });
  await expect(yes).toHaveCSS('background-color', await token('--danger'));
  await page.screenshot({ path: info.outputPath('process-delete-ask.png') });
  expect(errors).toEqual([]);
});

test('desktop: Enter adds the item from Time and from the title field, with the title as typed, as Add to does', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'Keys are for the desktop card.');
  const errors = await open(page, false);
  await pane(page, 'Inbox').getByRole('button', { name: 'Process 3 items' }).click();
  await processTo(page, false, 'One offs');
  await expect(toast(page)).toContainText('Added Call the bank to One offs.');

  // On Time, Enter adds the item to the place Add to shows.
  await expect(title(page, 'Fix the gate')).toBeVisible();
  const slider = card(page).getByRole('slider', { name: 'Time' });
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', '2h 30m');
  await page.keyboard.press('Enter');
  await expect(toast(page)).toContainText('Added Fix the gate to One offs.');

  // In the title field, Enter saves what's typed, then adds the item.
  await title(page, 'Buy stamps').getByRole('button').click();
  await card(page).getByRole('textbox', { name: 'Title' }).fill('Buy stamps for the cards');
  await page.keyboard.press('Enter');
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator('.clearveil')).toHaveCount(0, { timeout: 4000 });
  await expect(toast(page)).toContainText('Added Buy stamps for the cards to One offs.');

  await nav(page).getByRole('button', { name: 'One offs' }).click();
  await expect(oneOffRow(page, 'Fix the gate')).toContainText('2h 30m');
  await expect(oneOffRow(page, 'Buy stamps for the cards')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a new project from Process needs a goal: Add project says so with focus on Goal, then makes it under the one chosen', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, [{ type: 'objective', id: 'g1', fields: { title: 'Keep the house', state: 'active' } }, ...records]);
  await nav(page).getByRole('button', { name: phone ? 'Inbox, 3 to sort' : 'Inbox' }).click();
  await pane(page, 'Inbox').getByRole('button', { name: 'Process 3 items' }).click();
  if (phone) await card(page).getByRole('button', { name: /^Add to a project or One offs/ }).click();
  const picker = page.getByRole('combobox', { name: 'Add to a project or One offs' });
  await picker.fill('Fix up the shed');
  if (phone) await page.getByRole('option', { name: '+ New project “Fix up the shed”' }).click();
  else await picker.press('Enter');
  const form = phone ? page.getByRole('dialog', { name: 'New project' }) : card(page).getByRole('form', { name: 'New project' });
  const goal = form.getByRole('combobox', { name: 'Goal' });
  await expect(goal).toHaveValue('');
  await expect(form.getByText('Every project sits under a goal.')).toBeVisible();
  await form.getByRole('button', { name: 'Add project' }).click();
  await expect(form.getByRole('alert')).toHaveText('Choose a goal for Fix up the shed, or make a new one.');
  await expect(goal).toBeFocused();
  await page.screenshot({ path: info.outputPath('process-project-needs-goal.png') });
  await goal.selectOption({ label: 'Keep the house' });
  await form.getByRole('button', { name: 'Add project' }).click();
  await expect(toast(page)).toContainText('Created Fix up the shed, under Keep the house.');
  await card(page).getByRole('button', { name: 'Add to Fix up the shed', exact: true }).click();
  await expect(toast(page)).toContainText('Added Call the bank to Fix up the shed.');
  expect(errors).toEqual([]);
});

test('the project Add to holds shows its milestones, the next one chosen, and a new one is made as the item is added', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, [
    ...records,
    { type: 'milestone', id: 'm1', fields: { project_id: 'p1', title: 'First coat', due: '2026-11-20' } },
    { type: 'milestone', id: 'm2', fields: { project_id: 'p1', title: 'Second coat', due: '2026-12-10' } },
  ]);
  await nav(page).getByRole('button', { name: phone ? 'Inbox, 3 to sort' : 'Inbox' }).click();
  await pane(page, 'Inbox').getByRole('button', { name: 'Process 3 items' }).click();
  if (phone) await card(page).getByRole('button', { name: /^Add to a project or One offs/ }).click();
  const picker = page.getByRole('combobox', { name: 'Add to a project or One offs' });
  await picker.fill('Paint');
  if (phone) await page.getByRole('dialog', { name: 'Add to' }).getByRole('option', { name: 'Paint the fence' }).click();
  else await picker.press('Enter');
  const row = card(page).getByRole('radiogroup', { name: 'Milestone in Paint the fence' });
  await expect(row.getByRole('radio', { name: 'First coat, due Nov 20' })).toHaveAttribute('aria-checked', 'true');
  if (phone) for (const name of ['First coat, due Nov 20', 'Second coat, due Dec 10', 'No milestone']) await expectTapTarget(row.getByRole('radio', { name }));
  await page.screenshot({ path: info.outputPath('process-milestones.png') });

  // New milestone: Option M on desktop, a tap on phone. It's chosen once named, and made as the item is added.
  if (phone) await row.getByRole('button', { name: 'New milestone' }).click();
  else await page.keyboard.press('Alt+KeyM');
  const name = row.getByRole('textbox', { name: 'New milestone name' });
  await expect(name).toBeFocused();
  await name.fill('Sand it down');
  await name.press('Enter');
  await expect(row.getByRole('radio', { name: 'Sand it down, new' })).toHaveAttribute('aria-checked', 'true');
  await card(page).getByRole('button', { name: 'Add to Paint the fence', exact: true }).click();
  await expect(toast(page)).toContainText('Added Call the bank to Paint the fence, under the new milestone Sand it down.');

  // The next card starts on it. On desktop the arrows move the choice and Enter files the item; on phone, a tap.
  await expect(title(page, 'Fix the gate')).toBeVisible();
  const made = row.getByRole('radio', { name: /^Sand it down, due / });
  await expect(made).toHaveAttribute('aria-checked', 'true');
  if (phone) {
    await row.getByRole('radio', { name: 'Second coat, due Dec 10' }).click();
    await card(page).getByRole('button', { name: 'Add to Paint the fence', exact: true }).click();
  } else {
    await made.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(row.getByRole('radio', { name: 'Second coat, due Dec 10' })).toBeFocused();
    await page.keyboard.press('Enter');
  }
  await expect(toast(page)).toContainText('Added Fix the gate to Paint the fence, under Second coat.');
  expect(errors).toEqual([]);
});

test('desktop: a click outside the card closes Process, as Exit does, and what was changed on the card stays', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'On phone Process fills the screen, so there is no outside to click.');
  const errors = await open(page, false);
  await pane(page, 'Inbox').getByRole('button', { name: 'Process 3 items' }).click();
  const slider = card(page).getByRole('slider', { name: 'Time' });
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', '10m');
  // A click on the card itself leaves it open.
  await card(page).getByText('1 of 3').click();
  await expect(card(page)).toBeVisible();
  await page.mouse.click(20, 980);
  await expect(card(page)).toHaveCount(0);
  await expect(rows(page)).toHaveText([/Call the bank/, /Fix the gate/, /Buy stamps/]);
  await expect(rows(page).filter({ hasText: 'Call the bank' })).toContainText('10m estimate');
  expect(errors).toEqual([]);
});

test('Add details sends a task with its time straight to One offs, past the Inbox', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone);
  const capture = await openCapture(page, phone);
  await capture.getByRole('textbox', { name: 'Capture to Inbox' }).fill('Return the books');
  await capture.getByRole('button', { name: 'Add details' }).click();
  await capture.getByLabel('Send to').selectOption({ label: 'One offs' });
  const field = capture.getByRole('textbox', { name: 'Capture to One offs' });
  await expect(field).toHaveValue('Return the books');
  if (!phone) await expect(capture.getByText('Saves to One offs')).toBeVisible();
  const slider = capture.getByRole('slider', { name: 'Time' });
  await slider.focus();
  // Five minutes a step, each checked before the next.
  for (let m = 5; m < 60; m += 5) {
    await page.keyboard.press('ArrowRight');
    await expect(slider).toHaveAttribute('aria-valuetext', `${m}m`);
  }
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', '1h');
  if (phone) await capture.getByRole('button', { name: 'Save' }).click();
  else await field.press('Enter');
  await expect(phone ? toast(page) : capture.getByRole('status')).toContainText('Saved to One offs');
  await expect(capture).toHaveCount(0);

  await expect(rows(page)).toHaveCount(3);
  await (phone ? nav(page).getByRole('button', { name: 'More' }).click().then(() => pane(page, 'More').getByRole('button', { name: /^One offs/ }).click()) : nav(page).getByRole('button', { name: 'One offs' }).click());
  await expect(oneOffRow(page, 'Return the books')).toContainText('1h');
  expect(errors).toEqual([]);
});

test('Esc and Cancel drop what was typed, and on desktop a click outside keeps it until the field is empty', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone);
  let capture = await openCapture(page, phone);
  await capture.getByRole('textbox', { name: 'Capture to Inbox' }).fill('Half a thought');
  await page.keyboard.press('Escape');
  await expect(capture).toHaveCount(0);
  await expect(rows(page)).toHaveCount(3);

  if (!phone) {
    // A click outside would lose what's typed, so it's kept; with the field empty, the click closes it.
    capture = await openCapture(page, phone);
    const field = capture.getByRole('textbox', { name: 'Capture to Inbox' });
    await expect(field).toHaveValue('');
    await field.fill('Half a thought');
    await page.mouse.click(20, 980);
    await expect(field).toHaveValue('Half a thought');
    await capture.getByRole('button', { name: 'Cancel' }).click();
    await expect(capture).toHaveCount(0);
    await expect(rows(page)).toHaveCount(3);
    capture = await openCapture(page, phone);
    await page.mouse.click(20, 980);
    await expect(capture).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test('a shared description that was cut to fit says so under it', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // As share import leaves it on this device, for the item whose description it cut.
  await page.addInitScript(() => localStorage.setItem('multiscale.cutShares', '["shared"]'));
  await page.clock.install({ time: NOW });
  await openSeeded(page, [{ type: 'task', id: 'shared', fields: { kind: 'inbox', title: 'Notes from the talk', notes: 'word '.repeat(4000).trim() } }]);
  await nav(page).getByRole('button', { name: phone ? 'Inbox, 1 to sort' : 'Inbox' }).click();
  await pane(page, 'Inbox').getByRole('button', { name: 'Process 1 item' }).click();
  await expect(title(page, 'Notes from the talk')).toBeVisible();
  const said = card(page).getByText('The description was cut to 20,000 characters.');
  await expect(said).toBeVisible();
  // Under the description's first lines, not over them.
  const lines = (await card(page).locator('.pxnotes .notes').boundingBox())!;
  expect((await said.boundingBox())!.y).toBeGreaterThanOrEqual(lines.y + lines.height);
  expect(errors).toEqual([]);
});
