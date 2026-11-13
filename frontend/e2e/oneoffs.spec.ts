import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded, pane } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm.

const records: Seed[] = [
  { type: 'task', id: 'undated', fields: { kind: 'one_off', title: 'Tidy the shed', schedule: { type: 'once' } } },
  { type: 'task', id: 'day', fields: { kind: 'one_off', title: 'Return the drill', schedule: { type: 'once', from: '2026-11-07' }, next_due: '2026-11-07', estimate_min: 30 } },
  { type: 'task', id: 'range', fields: { kind: 'one_off', title: 'Mend the gate', schedule: { type: 'once', from: '2026-11-03', to: '2026-11-06' }, next_due: '2026-11-03' } },
  {
    type: 'task',
    id: 'weekly',
    fields: { kind: 'one_off', title: 'Feed the fish', schedule: { type: 'recurring', every: 1, unit: 'week', anchor: '2026-11-02' }, next_due: '2026-11-09' },
  },
];

async function openOneOffs(page: Page, phone: boolean) {
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  const nav = page.getByRole('navigation', { name: 'Main' });
  if (phone) {
    await nav.getByRole('button', { name: 'More' }).click();
    const row = page.getByRole('button', { name: /^One offs/ });
    await expect(row).toContainText('4 to do');
    await row.click();
  } else {
    await nav.getByRole('button', { name: 'One offs' }).click();
  }
  await expect(pane(page, 'One offs').getByRole('heading', { name: 'One offs', level: 1 })).toBeVisible();
}

const boxes = (page: Page) => pane(page, 'One offs').getByRole('checkbox');

test('lists, ticks until the day changes, and shows what was finished', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await openOneOffs(page, phone);
  await expect(boxes(page)).toHaveCount(4);
  const names = await boxes(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(names).toEqual(['Mend the gate done', 'Return the drill done', 'Tidy the shed done', 'Feed the fish done']);
  await expect(pane(page, 'One offs').getByRole('region', { name: 'Repeating' })).toContainText('Weekly, next Mon Nov 9');

  if (phone) {
    for (const box of await boxes(page).all()) {
      const target = await box.locator('xpath=..').boundingBox();
      expect(target!.width).toBeGreaterThanOrEqual(44);
      expect(target!.height).toBeGreaterThanOrEqual(44);
    }
  }

  // Done today, it waits behind Show completed, focus moving to the next one.
  const drill = pane(page, 'One offs').getByRole('checkbox', { name: 'Return the drill done' });
  await drill.click();
  await expect(page.getByText('Completed Return the drill.')).toBeVisible();
  await expect(drill).toHaveCount(0);
  await expect(pane(page, 'One offs').getByRole('checkbox', { name: 'Tidy the shed done' })).toBeFocused();
  const show = pane(page, 'One offs').getByRole('button', { name: 'Show 1 completed in One offs' });
  if (phone) await expectTapTarget(show);
  await show.click();
  await expect(drill).toBeChecked();
  await expect(pane(page, 'One offs').getByText('Done today', { exact: true })).toBeVisible();
  const plants = pane(page, 'One offs').getByRole('checkbox', { name: 'Feed the fish done' });
  await plants.click();
  await expect(pane(page, 'One offs').getByText('Done today, next Mon Nov 16')).toBeVisible();
  await plants.click();
  await expect(pane(page, 'One offs').getByText('Weekly, next Mon Nov 9')).toBeVisible();

  await pane(page, 'One offs').getByRole('button', { name: 'Finished tasks' }).click();
  const finished = pane(page, 'One offs').getByRole('region', { name: 'Finished tasks' });
  await expect(finished.getByText('1 finished')).toBeVisible();
  await expect(finished.getByRole('heading', { name: 'November' })).toBeVisible();
  await expect(finished.getByText('Done Nov 2')).toBeVisible();

  await page.clock.fastForward('24:00:00');
  // Only its entry under Finished tasks is left.
  await expect(pane(page, 'One offs').getByRole('checkbox', { name: 'Return the drill done' })).toHaveCount(1);
  await expect(finished.getByRole('checkbox', { name: 'Return the drill done' })).toBeChecked();
  await expect(boxes(page)).toHaveCount(4);
  await page.screenshot({ path: info.outputPath('oneoffs.png'), fullPage: true });
});

test('adds one offs of each kind, and dates one in place', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await openOneOffs(page, phone);

  const openForm = async () => {
    if (!phone) return pane(page, 'One offs').getByRole('form', { name: 'Add a one off' });
    await pane(page, 'One offs').getByRole('button', { name: 'Add one off' }).click();
    const sheet = page.getByRole('dialog', { name: 'Add a one off' });
    await expect(sheet.getByLabel('Title')).toBeFocused();
    return sheet;
  };

  let form = await openForm();
  await form.getByLabel('Title').fill('Wash the car');
  await form.getByLabel('Repeats').selectOption('seasonal');
  await form.getByRole('button', { name: 'April' }).click();
  await form.getByRole('button', { name: 'October' }).click();
  await form.getByRole('button', { name: 'Add one off' }).click();
  await expect(pane(page, 'One offs').getByText('In April and October, next in April, 30m')).toBeVisible();

  form = await openForm();
  await form.getByLabel('Title').fill('Test the doorbell');
  await form.getByLabel('Repeats').selectOption('rule');
  await form.getByLabel('Which').selectOption('Last');
  await form.getByLabel('Day').selectOption('Weekday');
  await form.getByLabel('Of each').selectOption('Quarter');
  if (phone) await expectTapTarget(form.getByLabel('Of each'));
  await form.getByRole('button', { name: 'Add one off' }).click();
  await expect(pane(page, 'One offs').getByText(/on the last weekday, next Dec 31/)).toBeVisible();
  if (phone) await expect(page.getByRole('dialog')).toHaveCount(0);

  await pane(page, 'One offs').getByRole('button', { name: 'Add date for Tidy the shed' }).click();
  await pane(page, 'One offs').getByLabel('Date', { exact: true }).fill('2026-11-04');
  await pane(page, 'One offs').getByRole('button', { name: 'Set date' }).click();
  await expect(pane(page, 'One offs').getByText('Nov 4', { exact: true })).toBeVisible();
  const names = await boxes(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(names.slice(0, 3)).toEqual(['Mend the gate done', 'Tidy the shed done', 'Return the drill done']);
});

test('repeats weekly on chosen days, and changing it keeps them', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await openOneOffs(page, phone);
  if (phone) await pane(page, 'One offs').getByRole('button', { name: 'Add one off' }).click();
  let form = phone ? page.getByRole('dialog', { name: 'Add a one off' }) : pane(page, 'One offs').getByRole('form', { name: 'Add a one off' });
  await form.getByLabel('Title').fill('Put the bins out');
  await form.getByLabel('Repeats').selectOption('recurring');
  const on = form.getByRole('group', { name: 'On' });
  await on.getByRole('button', { name: 'Weekdays' }).click();
  for (const day of ['Tuesday', 'Wednesday', 'Friday']) await on.getByRole('checkbox', { name: day }).click();
  await expect(on.getByRole('checkbox', { checked: true })).toHaveCount(2);
  if (phone) {
    for (const target of [...(await on.locator('.daychip').all()), on.getByRole('button', { name: 'Weekends' })]) await expectTapTarget(target);
  }
  await form.screenshot({ path: info.outputPath(`oneoff-days-${info.project.name}.png`) });
  if (phone) {
    // Below 332pt the chips wrap four and three, still 44pt each, rather than squeeze.
    await page.setViewportSize({ width: 320, height: 844 });
    const [mon, fri] = [await on.getByText('Mon', { exact: true }).boundingBox(), await on.getByText('Fri', { exact: true }).boundingBox()];
    expect(fri!.y).toBeGreaterThan(mon!.y);
    for (const chip of await on.locator('.daychip').all()) await expectTapTarget(chip);
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await form.getByRole('button', { name: 'Add one off' }).click();
  await expect(pane(page, 'One offs').getByText(/^Weekly on Mon and Thu/)).toBeVisible();

  // Changed, it keeps its days, and Mon to Fri reads as every weekday.
  await pane(page, 'One offs').getByRole('button', { name: 'Change repeat for Put the bins out' }).click();
  form = page.getByRole('form', { name: 'Change Put the bins out' });
  const kept = form.getByRole('group', { name: 'On' });
  await expect(kept.getByRole('checkbox', { name: 'Monday' })).toBeChecked();
  await expect(kept.getByRole('checkbox', { name: 'Thursday' })).toBeChecked();
  await expect(kept.getByRole('checkbox', { name: 'Tuesday' })).not.toBeChecked();
  await kept.getByRole('button', { name: 'Weekdays' }).click();
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(pane(page, 'One offs').getByText(/^Every weekday/)).toBeVisible();
});

test('phone: a tall sheet rises above the keyboard without its top going off the screen', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'The keyboard is a phone matter');
  await openOneOffs(page, true);
  await pane(page, 'One offs').getByRole('button', { name: 'Add one off' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a one off' });
  // The twelve months make the sheet taller than the room a keyboard leaves.
  await sheet.getByLabel('Repeats').selectOption('seasonal');
  const height = page.viewportSize()!.height;
  // As in the Capture sheet's test: what app/keyboard.ts would set for a 336pt keyboard.
  await page.evaluate(() => document.documentElement.style.setProperty('--keyboard', '336px'));
  await expect.poll(async () => Math.round((await sheet.boundingBox())!.y + (await sheet.boundingBox())!.height)).toBe(height - 336);
  expect((await sheet.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  await expect(sheet.getByLabel('Title')).toBeInViewport();
  await page.screenshot({ path: info.outputPath('tall-sheet-keyboard.png') });
});
