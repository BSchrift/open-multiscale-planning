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
  await card(page).getByRole('button', { name: 'Delete/done' }).click();
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
  const undo = card(page).getByRole('button', { name: phone ? '‹ Undo' : '‹ Undo and go back' });
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

test('Add to this week is off again on each new card, and the item it adds waits in the week to be scheduled', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone);
  await pane(page, 'Inbox').getByRole('button', { name: 'Process 3 items' }).click();
  const week = card(page).getByRole('button', { name: 'Add to this week' });
  if (phone) await expectTapTarget(week);
  await expect(week).toHaveAttribute('aria-pressed', 'false');
  await week.click();
  await expect(card(page).getByRole('button', { name: 'Adding to this week' })).toHaveAttribute('aria-pressed', 'true');
  await processTo(page, phone, 'Paint the fence');
  await expect(toast(page)).toContainText('Added Call the bank to Paint the fence and to this week.');

  // The next card starts with it off, so this one goes to the project alone.
  await expect(title(page, 'Fix the gate')).toBeVisible();
  await expect(week).toHaveAttribute('aria-pressed', 'false');
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
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', '30m');
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
  await expect(card(page).getByRole('button', { name: 'Adding to this week' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Alt+KeyW');
  await expect(card(page).getByRole('button', { name: 'Add to this week' })).toHaveAttribute('aria-pressed', 'false');

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
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
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
