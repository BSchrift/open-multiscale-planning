import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { expectTapTarget, openSeeded, touchDrag } from './seed';
import type { Seed } from './seed';

// The missed blocks sheet: a sheet over the lower part of the screen on phone, a small dialog in the middle on desktop.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm in Chicago.
const at = (day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  // Chicago is five hours behind UTC until Nov 1, and six after.
  return new Date(Date.UTC(2026, 9, day, h! + (day < 32 ? 5 : 6), m ?? 0)).toISOString().replace('.000Z', 'Z');
};
const THU = 29; // Thursday, Oct 29.
const MON = 33; // Monday, Nov 2, as a day of October.

const task = (id: string, title: string, fields: Record<string, unknown> = {}): Seed => ({
  type: 'task',
  id,
  fields: { kind: 'project', project_id: 'p', title, ...fields },
});
const block = (id: string, owner: Record<string, string>, day: number, from: string, to: string): Seed => ({
  type: 'time_block',
  id,
  fields: { ...owner, start: at(day, from), end: at(day, to), tz: 'America/Chicago' },
});

// Oldest first: two blocks of the chapter, the email, the water bill, piano practice and the dentist.
const records: Seed[] = [
  { type: 'week_plan', id: 'week:2026-11-02', fields: { week_start: '2026-11-02', finished_at: at(MON, '08:00') } },
  task('t1', 'Draft chapter five', { estimate_min: 180 }),
  task('t2', 'Email the editor', { estimate_min: 60 }),
  task('t3', 'Pay the water bill', { kind: 'one_off' }),
  task('t4', 'Book the dentist', { kind: 'one_off' }),
  { type: 'practice', id: 'pr', fields: { title: 'Piano', target_min: 30, per: 'day', state: 'active' } },
  block('b1', { task_id: 't1' }, THU, '09:00', '10:00'),
  block('b2', { task_id: 't2' }, THU, '10:30', '11:00'),
  block('b3', { task_id: 't3' }, MON, '11:00', '11:30'),
  block('b4', { task_id: 't1' }, MON, '12:00', '12:30'),
  block('pb', { practice_id: 'pr' }, MON, '13:00', '13:30'),
  block('b5', { task_id: 't4' }, MON, '13:30', '13:45'),
];

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  return errors;
}

const sheet = (page: Page, count: number) => page.getByRole('dialog', { name: `${count} missed ${count === 1 ? 'block' : 'blocks'}` });
const focusedRow = (page: Page) => page.evaluate(() => document.activeElement?.closest('[role="group"]')?.getAttribute('aria-label'));
const box = async (locator: Locator) => (await locator.boundingBox())!;

test('on desktop, a small dialog in the middle, answered row by row, in Select mode and from the keyboard', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop layout');
  const errors = await open(page);
  const dialog = sheet(page, 6);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('group')).toHaveText([/^Draft chapter five/, /^Email the editor/, /^Pay the water bill/, /^Draft chapter five/, /^Piano/, /^Book the dentist/]);
  await expect(page.getByRole('button', { name: /None of them/ })).toHaveCount(0);

  // 440px wide, centred once it has faded in, no taller than 70% of the window.
  await dialog.evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
  const viewport = page.viewportSize()!;
  const frame = await box(dialog);
  expect(Math.round(frame.width)).toBe(440);
  expect(Math.abs(frame.x + frame.width / 2 - viewport.width / 2)).toBeLessThan(2);
  expect(Math.abs(frame.y + frame.height / 2 - viewport.height / 2)).toBeLessThan(2);
  expect(frame.height).toBeLessThanOrEqual(viewport.height * 0.7 + 1);

  // Focus starts on the first row and stays inside.
  await expect.poll(() => focusedRow(page)).toBe('Draft chapter five');
  for (let i = 0; i < 25; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  await dialog.getByRole('group').first().focus();

  // The key behind the ⓘ, by key and by click.
  await page.keyboard.press('i');
  await expect(dialog.getByRole('group', { name: 'Key' })).toContainText('Partly, some is left');
  await expect(dialog.getByRole('group', { name: 'Key' })).toContainText('For a practice: Did it, Some and Skipped.');
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('group', { name: 'Key' })).toHaveCount(0);
  await expect(dialog).toBeVisible();

  // 1 finishes the focused row; the chapter's later block goes with it, and Undo brings both back.
  await dialog.getByRole('group').first().focus();
  await page.keyboard.press('1');
  await expect(page.getByText('Draft chapter five: finished, and 1 later block.')).toBeVisible();
  await expect(sheet(page, 4)).toBeVisible();
  await expect.poll(() => focusedRow(page)).toBe('Email the editor');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(sheet(page, 6)).toBeVisible();

  // 2 asks how much is left inside the dialog; Back changes nothing.
  await dialog.getByRole('group').first().focus();
  await page.keyboard.press('2');
  await expect(dialog.getByRole('heading', { name: 'How much is left?' })).toBeVisible();
  await expect(dialog.getByText('2h left')).toBeVisible();
  await dialog.getByRole('button', { name: 'More time left: Draft chapter five' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Draft chapter five: partly, 2h 30m left.')).toBeVisible();
  await expect(sheet(page, 5)).toBeVisible();

  // S, Space, arrows and A in Select mode, then 3 answers every ticked row, with one Undo.
  const five = sheet(page, 5);
  await five.getByRole('group').first().focus();
  await page.keyboard.press('s');
  await expect(five.getByRole('status')).toHaveText('0 selected');
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(five.getByRole('status')).toHaveText('2 selected');
  await page.keyboard.press('3');
  await expect(page.getByText('Answered 2 blocks.')).toBeVisible();
  await expect(sheet(page, 3)).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(sheet(page, 5)).toBeVisible();

  // Esc is Later; the Review row brings it back, and Select all then Not done answers the lot.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Review' }).click();
  await five.getByRole('button', { name: 'Select', exact: true }).click();
  await five.getByRole('button', { name: 'Select all' }).click();
  await expect(five.getByText('For a practice, Finished counts as Did it.')).toBeVisible();
  await five.getByRole('button', { name: 'Not done', exact: true }).click();
  await expect(page.getByText('Answered 5 blocks.')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('on phone, a sheet from the bottom: tap a row, Partly for a selection, and a swipe down is Later', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'phone layout');
  const errors = await open(page);
  const dialog = sheet(page, 6);
  await expect(dialog).toBeVisible();

  // Along the bottom once it has slid up, as tall as its rows up to about 60% of the screen.
  await dialog.evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
  const viewport = page.viewportSize()!;
  const frame = await box(dialog);
  expect(Math.round(frame.y + frame.height)).toBe(viewport.height);
  expect(frame.height).toBeLessThanOrEqual(viewport.height * 0.6 + 1);
  for (const name of ['Finished: Draft chapter five', 'Partly: Draft chapter five', 'Not done: Draft chapter five', 'What the icons mean', 'Select']) {
    await expectTapTarget(dialog.getByRole('button', { name, exact: true }).first());
  }

  await dialog.getByRole('button', { name: 'Not done: Email the editor' }).click();
  await expect(page.getByText("Email the editor: not done. It's in Needs a new time.")).toBeVisible();
  const five = sheet(page, 5);
  await expect(five.getByRole('group')).toHaveCount(5);

  await five.getByRole('button', { name: 'Select', exact: true }).click();
  await five.getByRole('checkbox', { name: 'Pay the water bill' }).check();
  await five.getByRole('checkbox', { name: 'Piano' }).check();
  await expect(five.getByRole('status')).toHaveText('2 selected');
  await five.getByRole('button', { name: 'Partly', exact: true }).click();
  await expect(five.getByText('15m done')).toBeVisible();
  await five.getByRole('button', { name: 'Less time done: Piano' }).click();
  await expectTapTarget(five.getByRole('button', { name: 'More time done: Piano' }));
  await five.getByRole('button', { name: 'Save 2 answers' }).click();
  await expect(page.getByText('Answered 2 blocks.')).toBeVisible();
  await expect(sheet(page, 3)).toBeVisible();

  // A swipe down from its top puts it away, and Review brings it back.
  const three = sheet(page, 3);
  const top = await box(three);
  await touchDrag(page, three.locator('.missgrab'), { x: top.x + top.width / 2, y: top.y + 200 }, 0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /^Check in on 3 missed blocks/ }).click();
  await expect(three).toBeVisible();
  expect(errors).toEqual([]);
});

test('turns off the slide with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await expect(sheet(page, 6)).toHaveCSS('animation-name', 'none');
});

test('screenshots of each state, for comparing with the design', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) });
  if (info.project.name === 'phone') {
    await open(page);
    const dialog = sheet(page, 6);
    await dialog.getByRole('button', { name: 'What the icons mean' }).click();
    await shot('phone-1-rows-key');
    await dialog.getByRole('button', { name: 'Select', exact: true }).click();
    await dialog.getByRole('checkbox', { name: 'Email the editor' }).check();
    await dialog.getByRole('checkbox', { name: 'Piano' }).check();
    await shot('phone-2-select');
    await dialog.getByRole('button', { name: 'Partly', exact: true }).click();
    await shot('phone-3-partly');
    return;
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const dialog = sheet(page, 6);
  await expect(dialog).toBeVisible();
  await shot('desktop-1440x900-rows');
  await page.setViewportSize({ width: 1024, height: 640 });
  await dialog.getByRole('button', { name: 'Select', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Email the editor' }).check();
  await dialog.getByRole('checkbox', { name: 'Pay the water bill' }).check();
  await shot('desktop-1024x640-select');
  // The list scrolls inside a dialog held to 70% of the window.
  expect((await box(dialog)).height).toBeLessThanOrEqual(640 * 0.7 + 1);
  expect(await dialog.locator('.misslist').evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  await page.setViewportSize({ width: 700, height: 800 });
  await dialog.getByRole('button', { name: 'Partly', exact: true }).click();
  await expect(Math.round((await box(dialog)).width)).toBe(440);
  await shot('desktop-700x800-partly');
});
