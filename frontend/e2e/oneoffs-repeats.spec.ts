import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { expectTapTarget, oneOffRow, openSeeded, pane } from './seed';
import type { Seed } from './seed';

// One offs beyond those oneoffs.spec.ts adds: a date range, monthly, a set time after it was last done and a flexible
// window, each moved on by its own rule when ticked; dates changed in place; and Delete from Change repeat.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm.

const records: Seed[] = [
  { type: 'task', id: 'day', fields: { kind: 'one_off', title: 'Return the drill', schedule: { type: 'once', from: '2026-11-07' }, next_due: '2026-11-07' } },
  {
    type: 'task',
    id: 'weekly',
    fields: { kind: 'one_off', title: 'Feed the fish', schedule: { type: 'recurring', every: 1, unit: 'week', anchor: '2026-11-02' }, next_due: '2026-11-09' },
  },
];

async function openOneOffs(page: Page, phone: boolean) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  const nav = page.getByRole('navigation', { name: 'Main' });
  if (phone) {
    await nav.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: /^One offs/ }).click();
  } else {
    await nav.getByRole('button', { name: 'One offs' }).click();
  }
  await expect(pane(page, 'One offs').getByRole('heading', { name: 'One offs', level: 1 })).toBeVisible();
  return errors;
}

/** The add form: on the page on desktop, in a sheet on phone. */
async function addForm(page: Page, phone: boolean): Promise<Locator> {
  if (!phone) return pane(page, 'One offs').getByRole('form', { name: 'Add a one off' });
  await pane(page, 'One offs').getByRole('button', { name: 'Add one off' }).click();
  return page.getByRole('dialog', { name: 'Add a one off' });
}

const line = (page: Page, title: string) => oneOffRow(page, title).locator('.small').first();

test('adds one offs over a date range, monthly, a set time after last done and within a window, and a tick moves each by its own rule', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await openOneOffs(page, phone);

  let form = await addForm(page, phone);
  await form.getByLabel('Title').fill('Paint the shed');
  await form.getByLabel('Date (optional)').fill('2026-11-10');
  const end = form.getByRole('button', { name: '+ End date' });
  if (phone) await expectTapTarget(end);
  await end.click();
  await form.getByLabel('End date').fill('2026-11-13');
  await form.getByRole('button', { name: 'Add one off' }).click();
  await expect(line(page, 'Paint the shed')).toHaveText('Nov 10 to Nov 13, 30m');

  form = await addForm(page, phone);
  await form.getByLabel('Title').fill('Pay the rent');
  await form.getByLabel('Repeats').selectOption('recurring');
  await form.getByLabel('How often').selectOption('Monthly');
  await expect(form.getByRole('group', { name: 'On' })).toHaveCount(0);
  await form.getByLabel('Starts').fill('2026-11-15');
  await form.getByRole('button', { name: 'Add one off' }).click();
  await expect(line(page, 'Pay the rent')).toHaveText('Monthly on the 15th, next Nov 15, 30m');

  form = await addForm(page, phone);
  await form.getByLabel('Title').fill('Get a haircut');
  await form.getByLabel('Repeats').selectOption('float');
  const weeks = form.getByRole('slider', { name: 'After you last did it' });
  await weeks.fill('6');
  await expect(weeks).toHaveAttribute('aria-valuetext', '6 weeks');
  await form.getByRole('button', { name: 'Add one off' }).click();
  await expect(line(page, 'Get a haircut')).toHaveText('6 weeks after last done, next after first done, 30m');

  form = await addForm(page, phone);
  await form.getByLabel('Title').fill('Change the furnace filter');
  await form.getByLabel('Repeats').selectOption('window');
  // Each end of the window keeps the other in step: the shortest above the longest pulls the longest up with it, and the
  // longest below the shortest pulls it down.
  const least = form.getByRole('slider', { name: 'Every, at least' });
  const most = form.getByRole('slider', { name: 'At most' });
  await least.fill('5');
  await expect(most).toHaveAttribute('aria-valuetext', '5 months');
  await most.fill('1');
  await expect(least).toHaveAttribute('aria-valuetext', '1 month');
  await least.fill('2');
  await most.fill('4');
  await page.screenshot({ path: info.outputPath(`oneoff-window-${info.project.name}.png`) });
  await form.getByRole('button', { name: 'Add one off' }).click();
  await expect(line(page, 'Change the furnace filter')).toHaveText(/^Every 2 to 4 months, next between /);

  // Ticked today, each repeating one stays a row on its next date; unticking puts it back.
  for (const [title, ticked] of [
    ['Pay the rent', 'Done today, next Dec 15'],
    ['Get a haircut', 'Done today, next about Dec 14'],
    ['Change the furnace filter', 'Done today, next between Jan 2 and Mar 2'],
  ] as const) {
    const was = await line(page, title).textContent();
    await oneOffRow(page, title).getByRole('checkbox', { name: `${title} done` }).click();
    await expect(line(page, title)).toHaveText(ticked);
    await oneOffRow(page, title).getByRole('checkbox', { name: `${title} done` }).click();
    await expect(line(page, title)).toHaveText(was!);
  }
  expect(errors).toEqual([]);
});

test("changes a one off's date in place to a range and clears it, each with Undo, and Esc keeps a date not yet set", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await openOneOffs(page, phone);
  const p = pane(page, 'One offs');
  const change = p.getByRole('button', { name: 'Change date for Return the drill' });
  if (phone) await expectTapTarget(change);
  await change.click();
  const dates = p.getByRole('form', { name: 'Dates for Return the drill' });
  await expect(dates.getByLabel('Date', { exact: true })).toHaveValue('2026-11-07');
  await dates.getByLabel('Date', { exact: true }).fill('2026-11-09');
  await page.keyboard.press('Escape');
  await expect(dates.getByRole('alert')).toHaveText("This date isn't set yet. Set it, or Cancel to drop it.");
  await expect(dates.getByRole('button', { name: 'Set date' })).toBeFocused();
  await dates.getByRole('button', { name: '+ End date' }).click();
  await dates.getByLabel('End date').fill('2026-11-11');
  await dates.getByRole('button', { name: 'Set date' }).click();
  await expect(page.getByText('Return the drill, Nov 9 to Nov 11.')).toBeVisible();
  await expect(line(page, 'Return the drill')).toHaveText('Nov 9 to Nov 11');
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(line(page, 'Return the drill')).toHaveText('Nov 7');

  await change.click();
  const clear = dates.getByRole('button', { name: phone ? 'Clear' : 'Clear date' });
  if (phone) await expectTapTarget(clear);
  await clear.click();
  await expect(page.getByText('Return the drill, no date.')).toBeVisible();
  await expect(line(page, 'Return the drill')).toHaveText('No date');
  await expect(p.getByRole('button', { name: 'Add date for Return the drill' })).toBeVisible();
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(line(page, 'Return the drill')).toHaveText('Nov 7');
  expect(errors).toEqual([]);
});

test('the add form says what it is missing, and Change repeat deletes a one off with Undo', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await openOneOffs(page, phone);
  const form = await addForm(page, phone);
  await form.getByRole('button', { name: 'Add one off' }).click();
  await expect(form.getByRole('alert')).toHaveText('Give it a title.');
  await form.getByLabel('Title').fill('Paint the shed');
  await form.getByRole('button', { name: '+ End date' }).click();
  await form.getByLabel('End date').fill('2026-11-13');
  await form.getByRole('button', { name: 'Add one off' }).click();
  await expect(form.getByRole('alert')).toHaveText('Pick a date.');
  if (phone) await form.getByRole('button', { name: 'Cancel' }).click();

  const p = pane(page, 'One offs');
  await p.getByRole('button', { name: 'Change repeat for Feed the fish' }).click();
  const editor = p.getByRole('form', { name: 'Change Feed the fish' });
  const del = editor.getByRole('button', { name: 'Delete' });
  if (phone) await expectTapTarget(del);
  await del.click();
  await expect(page.getByText('Deleted Feed the fish')).toBeVisible();
  await expect(oneOffRow(page, 'Feed the fish')).toHaveCount(0);
  const undo = page.locator('.toast').getByRole('button', { name: 'Undo' });
  // The row went with it, so focus waits on Undo.
  await expect(undo).toBeFocused();
  await undo.click();
  await expect(line(page, 'Feed the fish')).toHaveText('Weekly, next Mon Nov 9');
  expect(errors).toEqual([]);
});
