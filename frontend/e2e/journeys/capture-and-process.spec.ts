import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addMilestones, addProject, chicago, firstRun, jumpTo, openProject, pane, processTo, start, tab, TZ } from './journey';

// Capture from anywhere, sort the Inbox to a project with a date, a dated one off, an undated one off, a practice made
// from its card and the bin, then live with the One offs page across days: ticking, Today's one offs, Finished tasks
// and the Repeating group.

test.use({ timezoneId: TZ, actionTimeout: 15_000 });

async function capture(page: Page, phone: boolean, title: string, hotkey: boolean) {
  if (hotkey) await page.keyboard.press('Shift+Meta+Space');
  else await page.getByRole('button', { name: phone ? 'Capture a task' : /^Capture/ }).first().click();
  const field = page.getByRole('dialog', { name: 'Capture' }).getByRole('textbox', { name: 'Capture to Inbox' });
  await expect(field).toBeFocused();
  await field.fill(title);
  await field.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Capture' })).toHaveCount(0);
}

test('capture, process each item to its place, then one offs across the week', async ({ page }, info) => {
  test.setTimeout(180_000);
  const phone = info.project.name === 'phone';
  const errors = await start(page, chicago('2026-11-04', '09:00')); // Wednesday morning.
  await firstRun(page, 'Learn to bake bread');
  await page.getByRole('button', { name: /^Skip (for now|planning this week)$/ }).click();
  await tab(page, phone, 'Goals');
  await addProject(page, phone, 'Learn to bake bread', 'Bake a sourdough loaf', '2027-01-29');
  await addMilestones(page, [{ name: 'A starter that rises', due: '2026-11-20' }]);

  // Capture: the + button everywhere, and the hotkey on desktop.
  await capture(page, phone, 'Buy a proofing basket', false);
  await tab(page, phone, 'Today');
  await capture(page, phone, 'Return the library books', !phone);
  await capture(page, phone, 'Pay the water bill', false);
  await capture(page, phone, 'Stretch every morning', false);
  await capture(page, phone, 'An old idea to let go', !phone);

  await tab(page, phone, 'Inbox');
  const inbox = pane(page, 'Inbox');
  await expect(inbox.locator('.inboxrow, .morerow')).toHaveText([/Buy a proofing basket/, /Return the library books/, /Pay the water bill/, /Stretch every morning/, /An old idea to let go/]);
  await inbox.getByRole('button', { name: 'Process 5 items' }).click();
  const card = page.getByRole('dialog', { name: 'Process Inbox' });

  // Dated on the card before it moves, then to the project, its date going with it.
  await expect(card.getByRole('heading', { name: 'Buy a proofing basket' })).toBeVisible();
  await card.getByRole('button', { name: 'Add date' }).click();
  await card.getByLabel('Date', { exact: true }).fill('2026-11-13');
  await card.getByRole('button', { name: 'Set date' }).click();
  await expect(card.getByRole('button', { name: 'Change date, Nov 13' })).toBeVisible();
  await processTo(page, phone, 'Bake a sourdough loaf');
  await expect(page.locator('.toast')).toContainText('Added Buy a proofing basket to Bake a sourdough loaf, for Nov 13.');

  // To One offs, dated Friday.
  await expect(card.getByRole('heading', { name: 'Return the library books' })).toBeVisible();
  await card.getByRole('button', { name: 'Add date' }).click();
  await card.getByLabel('Date', { exact: true }).fill('2026-11-06');
  await card.getByRole('button', { name: 'Set date' }).click();
  await expect(card.getByRole('button', { name: 'Change date, Nov 6' })).toBeVisible();
  await processTo(page, phone, 'One offs');
  await expect(page.locator('.toast')).toContainText('Added Return the library books to One offs, for Nov 6.');

  // To One offs with no date.
  await expect(card.getByRole('heading', { name: 'Pay the water bill' })).toBeVisible();
  await processTo(page, phone, 'One offs');

  // A practice of its own, made from its card: the item becomes it, and leaves the Inbox.
  await expect(card.getByRole('heading', { name: 'Stretch every morning' })).toBeVisible();
  await card.getByRole('button', { name: 'New practice from this item' }).click();
  const practice = phone ? page.getByRole('dialog', { name: 'New practice' }) : card.getByRole('form', { name: 'New practice' });
  await expect(practice.getByRole('textbox', { name: 'Name' })).toHaveValue('Stretch every morning');
  await practice.getByRole('button', { name: 'Change time' }).click();
  await practice.getByRole('slider', { name: 'Target' }).fill('15');
  await practice.getByRole('button', { name: 'Make it a practice' }).click();
  await expect(page.locator('.toast')).toContainText('Stretch every morning is now a practice.');

  // And the bin, after asking.
  await expect(card.getByRole('heading', { name: 'An old idea to let go' })).toBeVisible();
  await card.getByRole('button', { name: 'Delete', exact: true }).click();
  await card.getByRole('button', { name: 'Yes, delete' }).click();
  // Process closes itself, and a check over the Inbox says it's clear.
  await expect(card).toHaveCount(0);
  await expect(page.locator('.clearveil')).toHaveText('Inbox clear5 items processed');
  await expect(inbox.getByText(/^Inbox is empty\./)).toBeVisible();

  // Each landed where it was sent.
  // A project task keeps its date, shown on its row under the project's Done.
  await openProject(page, phone, 'Learn to bake bread', 'Bake a sourdough loaf');
  const done = page.getByRole('button', { name: 'Done tasks' });
  if ((await done.getAttribute('aria-expanded')) === 'false') await done.click();
  await expect(page.getByRole('button', { name: /^Edit task Buy a proofing basket, Nov 13, / })).toBeVisible();

  await tab(page, phone, 'One offs');
  const oneOffs = pane(page, 'One offs');
  const boxes = oneOffs.getByRole('checkbox');
  await expect(boxes).toHaveCount(2);
  await expect(oneOffs.getByText('An old idea to let go')).toHaveCount(0);
  const names = () => boxes.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(await names()).toEqual(['Return the library books done', 'Pay the water bill done']);

  // A repeating one off, added on its page, sits in its own group below.
  const form = phone ? page.getByRole('dialog', { name: 'Add a one off' }) : oneOffs.getByRole('form', { name: 'Add a one off' });
  if (phone) await oneOffs.getByRole('button', { name: 'Add one off' }).click();
  await form.getByLabel('Title').fill('Oil the bike chain');
  await form.getByLabel('Repeats').selectOption('recurring');
  await form.getByLabel('Starts').fill('2026-11-04');
  await form.getByRole('button', { name: 'Add one off' }).click();
  const repeating = oneOffs.getByRole('region', { name: 'Repeating' });
  await expect(repeating.getByRole('checkbox', { name: 'Oil the bike chain done' })).toBeVisible();
  await expect(repeating).toContainText('Weekly, next Wed Nov 4');

  // Ticking: the undated one is done today, behind Show completed, and the repeating one moves to next week, both
  // until the day changes.
  await oneOffs.getByRole('checkbox', { name: 'Pay the water bill done' }).click();
  await expect(oneOffs.getByRole('button', { name: 'Show 1 completed in One offs' })).toBeVisible();
  await repeating.getByRole('checkbox', { name: 'Oil the bike chain done' }).click();
  await expect(repeating).toContainText('Done today, next Wed Nov 11');

  // Friday: the dated one is on Today with its tick, and ticking it there counts.
  await jumpTo(page, chicago('2026-11-06', '09:00'));
  await tab(page, phone, 'Today');
  const today = page.getByRole('region', { name: 'One offs today' });
  await today.getByRole('checkbox', { name: 'Return the library books done' }).click();
  await expect(today.getByRole('button', { name: 'Show 1 completed in One offs today' })).toBeVisible();

  await tab(page, phone, 'One offs');
  // Wednesday's ticks have cleared from the list, and today's waits behind Show completed; the repeating one waits for
  // next week.
  await oneOffs.getByRole('button', { name: 'Show 1 completed in One offs' }).click();
  await expect(oneOffs.getByRole('checkbox', { name: 'Pay the water bill done' })).toHaveCount(0);
  await expect(oneOffs.getByRole('checkbox', { name: 'Return the library books done' })).toBeChecked();
  await expect(repeating).toContainText('Weekly, next Wed Nov 11');
  await oneOffs.getByRole('button', { name: 'Finished tasks' }).click();
  const finished = oneOffs.getByRole('region', { name: 'Finished tasks' });
  await expect(finished.getByText('4 finished')).toBeVisible();
  await expect(finished.getByRole('checkbox', { name: 'Pay the water bill done' })).toBeChecked();
  // The item that became a practice is finished too, and links to it, open on the Goals page.
  await finished.getByRole('button', { name: 'Became the practice Stretch every morning' }).click();
  if (phone) await expect(page.getByRole('dialog', { name: 'Edit practice' }).getByLabel('Name')).toHaveValue('Stretch every morning');
  else await expect(pane(page, 'Goals').getByRole('button', { name: /^Stretch every morning/, expanded: true })).toBeVisible();
  expect(errors).toEqual([]);
});
