// Pinching the day on the phone's Today draws its hours taller or shorter, as Apple Calendar does, around the time under
// the fingers, and the height stays on the device. Chromium only: CDP's Input.dispatchTouchEvent sends two real touches,
// which the page sees as a person's fingers, and Playwright's WebKit has no way to put down a second finger. The iPhone
// Simulator test pinches the app itself.

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { openSeeded, settled } from './seed';
import type { Seed } from './seed';
import { phoneView, todayRead } from './today';

test.use({ timezoneId: 'America/Chicago', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm in Chicago.
const at = (time: string, day = 2) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, day, h! + 6, m ?? 0)).toISOString().replace('.000Z', 'Z');
};
const records: Seed[] = [
  { type: 'week_plan', id: 'week:2026-11-02', fields: { week_start: '2026-11-02', finished_at: at('08:00') } },
  { type: 'task', id: 't1', fields: { kind: 'one_off', title: 'Paint the fence', estimate_min: 60 } },
  { type: 'time_block', id: 'b1', fields: { task_id: 't1', start: at('16:00'), end: at('17:00'), tz: 'America/Chicago' } },
  // Tuesday's, whose day is drawn whole, from 7am, where today's opens at 1pm with the hours before folded into a row.
  { type: 'task', id: 't2', fields: { kind: 'one_off', title: 'Draft the summary', estimate_min: 60 } },
  { type: 'time_block', id: 'b2', fields: { task_id: 't2', start: at('10:00', 3), end: at('11:00', 3), tz: 'America/Chicago' } },
];

/** Two fingers put down `from` apart, one above the other around a point, spread or pinched to `to` apart, and lifted. */
async function pinch(page: Page, around: { x: number; y: number }, from: number, to: number) {
  const cdp = await page.context().newCDPSession(page);
  const fingers = (gap: number) => [
    { x: around.x, y: around.y - gap / 2, id: 1 },
    { x: around.x, y: around.y + gap / 2, id: 2 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(from) });
  for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(from + ((to - from) * i) / 10) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** One finger put down, moved `dy` and lifted, quickly, as a swipe. */
async function swipe(page: Page, from: { x: number; y: number }, dy: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, id: 1 }] });
  for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x, y: from.y + (dy * i) / 10, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const middle = async (el: Locator) => {
  const box = (await el.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, height: box.height };
};

/** Today, read, with nothing still to come in above the day. */
async function openToday(page: Page) {
  await todayRead(page, true);
  // Today makes the first stretch's planning task by itself, and its row then comes in above the day, moving the day
  // down the page. Until then, a point measured on the day can land elsewhere.
  await expect(page.getByRole('region', { name: 'Plan your first stretch' })).toBeVisible();
}

/** Today with its 4pm block in the middle of the screen. */
async function openBlock(page: Page) {
  await openToday(page);
  const block = page.getByRole('slider', { name: /^Paint the fence, 4pm to 5pm/ });
  await block.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  return block;
}

test.beforeEach(async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'Two fingers need CDP, which only Chromium has');
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  // Every screen's styles, which load after the first and can move the day, are in before anything is measured.
  await settled(page);
});

test('pinching out draws the day taller around the time under the fingers, up to three times, one finger still scrolls it, and it stays after a reload', async ({ page }, info) => {
  const block = await openBlock(page);
  const before = await middle(block);
  // An hour is 72pt, less a pixel between blocks.
  expect(before.height).toBeCloseTo(71, 0);
  await pinch(page, before, 60, 300);
  // Five times the spread stops at three times the height, and the block stays under the fingers.
  await expect.poll(async () => (await middle(block)).height).toBeCloseTo(3 * 72 - 1, 0);
  const after = await middle(block);
  expect(Math.abs(after.y - before.y)).toBeLessThan(12);
  await page.screenshot({ path: info.outputPath('today-pinched-out.png') });
  // One finger swiped up over the evening's free time scrolls the day as before.
  await swipe(page, { x: after.x, y: after.y + after.height + 40 }, -200);
  await expect.poll(async () => (await middle(block)).y).toBeLessThan(after.y - 100);

  await page.reload();
  const again = await openBlock(page);
  await expect.poll(async () => (await middle(again)).height).toBeCloseTo(3 * 72 - 1, 0);
  // Editing the week draws the same hours: 17 of them, three times 72pt each.
  await phoneView(page, "Edit this week's plan");
  await expect.poll(async () => (await page.locator('.day.dragday').boundingBox())!.height).toBeCloseTo(17 * 216, 0);
});

test('pinching in stops where the whole day fits on screen, with every block still a full tap target', async ({ page }, info) => {
  await openToday(page);
  // Tuesday, drawn whole.
  await page.getByRole('group', { name: 'Choose a day' }).getByRole('button', { name: /^Tue Nov 3/ }).tap();
  const block = page.getByRole('slider', { name: /^Draft the summary, 10am to 11am/ });
  const day = page.locator('.tdpager .day');
  await day.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  // The room for the day: from under the strip's day row, folded to its slim bar, to the tab bar.
  const room = await page.evaluate(() => document.querySelector('.tabs')!.getBoundingClientRect().top - document.querySelector('.sffold')!.getBoundingClientRect().top - 56);
  await pinch(page, await middle(day), 300, 20);
  // The hours shrink until the drawn day fits that room, and no further. Drawn in whole points an hour, 15 of them from
  // 7am to 10pm, it falls short of the room by less than a point an hour.
  await expect.poll(async () => (await day.boundingBox())!.height).toBeLessThanOrEqual(room + 1);
  expect((await day.boundingBox())!.height).toBeGreaterThan(room - 15);
  expect((await middle(block)).height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath('today-pinched-in.png') });
});
