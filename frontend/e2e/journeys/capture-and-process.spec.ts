import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addMilestones, addProject, chicago, firstRun, jumpTo, openProject, pane, start, tab, TZ } from './journey';

// Capture from anywhere, sort the Inbox to a milestone, a dated one off, an undated one off and the bin, then live
// with the One offs page across days: ticking, Today's one offs, Finished tasks and the Repeating group.

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
  await capture(page, phone, 'An old idea to let go', !phone);

  await tab(page, phone, 'Inbox');
  const inbox = pane(page, 'Inbox');
  await expect(inbox.locator('.inboxrow, .morerow')).toHaveText([/Buy a proofing basket/, /Return the library books/, /Pay the water bill/, /An old idea to let go/]);
  await inbox.getByRole('button', { name: 'Process 4 items' }).click();
  const card = page.getByRole('dialog', { name: 'Process Inbox' });

  // To the project, then onto its milestone from the line under the card.
  await expect(card.getByRole('heading', { name: 'Buy a proofing basket' })).toBeVisible();
  await card.getByRole('button', { name: 'Bake a sourdough loaf' }).click();
  await expect(card.getByRole('status')).toHaveText('Sent to Bake a sourdough loaf.');
  await card.getByRole('combobox', { name: 'Milestone for Buy a proofing basket' }).selectOption({ label: 'A starter that rises' });

  // To One offs, dated Friday.
  await expect(card.getByRole('heading', { name: 'Return the library books' })).toBeVisible();
  await card.getByRole('button', { name: 'One offs' }).click();
  await card.getByRole('button', { name: 'Add date for Return the library books' }).click();
  await card.getByLabel('Date', { exact: true }).fill('2026-11-06');
  await card.getByRole('button', { name: 'Set date' }).click();
  await expect(card.getByRole('button', { name: 'Change date for Return the library books' })).toBeVisible();

  // To One offs with no date.
  await expect(card.getByRole('heading', { name: 'Pay the water bill' })).toBeVisible();
  await card.getByRole('button', { name: 'One offs' }).click();

  // And the bin, after asking.
  await expect(card.getByRole('heading', { name: 'An old idea to let go' })).toBeVisible();
  await card.getByRole('button', { name: 'Delete/done' }).click();
  await card.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(card.getByRole('heading', { name: 'Inbox clear' })).toBeVisible();
  await expect(card).toContainText('3 sorted, 1 deleted.');
  await card.getByRole('button', { name: 'Done' }).click();
  await expect(inbox.getByText(/^Inbox is empty\./)).toBeVisible();

  // Each landed where it was sent.
  await openProject(page, phone, 'Learn to bake bread', 'Bake a sourdough loaf');
  await expect(page.getByRole('group', { name: 'Milestone: A starter that rises' }).getByRole('button', { name: /^Edit task Buy a proofing basket/ })).toBeVisible();

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
  await expect(finished.getByText('3 finished')).toBeVisible();
  await expect(finished.getByRole('checkbox', { name: 'Pay the water bill done' })).toBeChecked();
  expect(errors).toEqual([]);
});
