// The week's strip on the phone's Today: tapping a day shows it under its name, a swipe moves day to day, and the strip
// folds into a 44pt slim bar as the day scrolls, settling to whichever end is nearer once the scroll rests. Playwright's
// WebKit can't move a real finger, so a swipe here is the touch pointer events one makes; the iPhone test swipes and
// scrolls the app itself.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openSeeded } from './seed';
import type { Seed } from './seed';
import { todayRead } from './today';

test.use({ timezoneId: 'America/Chicago' });
test.beforeEach(({}, info) => test.skip(info.project.name !== 'phone', "the strip is the phone's"));

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm in Chicago.
const at = (day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, day, h! + 6, m ?? 0)).toISOString().replace('.000Z', 'Z');
};
const records: Seed[] = [
  { type: 'week_plan', id: 'week:2026-11-02', fields: { week_start: '2026-11-02', finished_at: at(2, '08:00') } },
  { type: 'task', id: 't1', fields: { kind: 'one_off', title: 'Paint the fence', estimate_min: 60 } },
  { type: 'task', id: 't2', fields: { kind: 'one_off', title: 'Draft the summary', estimate_min: 60 } },
  { type: 'task', id: 't3', fields: { kind: 'one_off', title: 'Sand the deck', estimate_min: 60 } },
  { type: 'time_block', id: 'b1', fields: { task_id: 't1', start: at(2, '16:00'), end: at(2, '17:00'), tz: 'America/Chicago' } },
  { type: 'time_block', id: 'b2', fields: { task_id: 't2', start: at(3, '18:00'), end: at(3, '19:00'), tz: 'America/Chicago' } },
  { type: 'time_block', id: 'b3', fields: { task_id: 't3', start: at(9, '10:00'), end: at(9, '11:00'), tz: 'America/Chicago' } },
];

async function open(page: Page) {
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await todayRead(page, true);
}

const strip = (page: Page) => page.getByRole('group', { name: 'Choose a day' });
const slim = (page: Page) => page.getByRole('button', { name: 'Today, Monday 2. Show the week' });
const heading = (page: Page) => page.getByRole('heading', { level: 1 });

/** Where the day row docks: the bottom of the week row, in the page's scroll. */
const dock = (page: Page) =>
  page.evaluate(() => {
    const pane = document.querySelector('.pane')!;
    return document.querySelector('.sfweek')!.getBoundingClientRect().bottom - pane.getBoundingClientRect().top + pane.scrollTop;
  });
const scrollTo = (page: Page, top: number) => page.evaluate((top) => document.querySelector('.pane')!.scrollTo(0, top), top);
const scrollTop = (page: Page) => page.evaluate(() => document.querySelector('.pane')!.scrollTop);
/** How tall the day row's band is drawn: 100pt open, 56pt folded. */
const band = (page: Page) => page.evaluate(() => document.querySelector('.sfbg')!.getBoundingClientRect().height);

/** A touch swipe across the day: the pointer events a finger makes, `ms` apart, as WebKit can't move one. */
async function swipe(page: Page, from: { x: number; y: number }, dx: number, steps = 6, ms = 16) {
  await page.evaluate(
    async ({ from, dx, steps, ms }) => {
      const send = (type: string, x: number, t: number, target: EventTarget) => {
        const e = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: from.y });
        Object.defineProperty(e, 'timeStamp', { value: t });
        target.dispatchEvent(e);
      };
      const t0 = performance.now();
      send('pointerdown', from.x, t0, document.elementFromPoint(from.x, from.y)!);
      for (let i = 1; i <= steps; i++) send('pointermove', from.x + (dx * i) / steps, t0 + ms * i, window);
      send('pointerup', from.x + dx, t0 + ms * steps, window);
    },
    { from, dx, steps, ms },
  );
}

test('a day tapped on the strip shows under its name, a swipe goes on to the next, and Today comes back', async ({ page }) => {
  await open(page);
  await expect(heading(page)).toHaveText('Today');
  await strip(page).getByRole('button', { name: /^Tue Nov 3/ }).tap();
  await expect(heading(page)).toHaveText('Tomorrow');
  await expect(page.getByRole('slider', { name: /^Draft the summary, 6pm to 7pm/ })).toBeVisible();

  // A quick swipe left, across the day: Wednesday, with nothing on it.
  const box = (await page.locator('.tdpager').boundingBox())!;
  await swipe(page, { x: box.x + box.width * 0.85, y: box.y + 120 }, -box.width * 0.6);
  await expect(heading(page)).toHaveText('Wednesday');
  // Read straight from the strip, which the day kept at its time of day may have folded away.
  await expect(page.locator('.sfdays [aria-pressed="true"]')).toHaveAttribute('aria-label', /^Wed Nov 4/);

  // Next week's arrow, and the Today button back.
  await page.getByRole('button', { name: 'Next week' }).tap();
  await expect(heading(page)).toHaveText('Monday');
  await expect(page.getByRole('slider', { name: /^Sand the deck, 10am to 11am/ })).toBeVisible();
  await expect(page.locator('.sfdays [aria-pressed="true"]')).toHaveAttribute('aria-label', /^Mon Nov 9/);
  await page.locator('.tdhead').getByRole('button', { name: 'Today' }).tap();
  await expect(heading(page)).toHaveText('Today');
  await expect(page.getByRole('slider', { name: /^Paint the fence, 4pm to 5pm/ })).toBeVisible();
});

test('the strip folds into the slim bar over 72pt of scroll, settles to the nearer end, and the bar opens it again', async ({ page }) => {
  await open(page);
  const d = await dock(page);
  expect(await band(page)).toBeCloseTo(100, 0);
  await expect(slim(page)).toHaveCount(0);

  // Folded all the way: the slim bar is the one control, the seven days hidden from taps and screen readers.
  await scrollTo(page, d + 90);
  await expect.poll(() => band(page)).toBeCloseTo(56, 0);
  await expect(slim(page)).toBeVisible();
  await expect(slim(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(strip(page)).toHaveCount(0);

  // Let go a third of the way: back open. Two thirds: folded.
  await scrollTo(page, d + 24);
  await expect.poll(() => scrollTop(page)).toBeCloseTo(d, 0);
  await expect(strip(page)).toBeVisible();
  await scrollTo(page, d + 48);
  await expect.poll(() => scrollTop(page)).toBeCloseTo(d + 72, 0);
  await expect(slim(page)).toBeVisible();

  // The slim bar opens the days over the day without scrolling it, and focus goes to the day shown. A tap at the
  // bar itself, as a finger lands, since Playwright's own tap first scrolls it clear of the page's padding.
  const bar = (await slim(page).boundingBox())!;
  await page.touchscreen.tap(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await expect(strip(page).getByRole('button', { name: /^Mon Nov 2/ })).toBeFocused();
  expect(await scrollTop(page)).toBeCloseTo(d + 72, 0);
  await expect.poll(() => band(page)).toBeCloseTo(100, 0);
  // Scrolled on, it folds again.
  await scrollTo(page, d + 160);
  await expect(slim(page)).toBeVisible();
});

test('with reduced motion the strip switches to the slim bar at once, and never settles', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const d = await dock(page);
  await scrollTo(page, d + 30);
  await expect(strip(page)).toBeVisible();
  await scrollTo(page, d + 50);
  await expect(slim(page)).toBeVisible();
  await expect.poll(() => band(page)).toBeCloseTo(56, 0);
  // Nothing springs the scroll: it stays where it was let go.
  await scrollTo(page, d + 30);
  await expect(strip(page)).toBeVisible();
  // Well past the time a settle waits for the scroll to rest.
  await page.clock.runFor(1000);
  expect(await scrollTop(page)).toBeCloseTo(d + 30, 0);
});

test("Plan's This week card edits the week on Today, and the tab bar has no Week", async ({ page }) => {
  await open(page);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('button', { name: 'Week' })).toHaveCount(0);
  await nav.getByRole('button', { name: 'Plan' }).tap();
  const thisWeek = page.getByRole('region', { name: 'This week' });
  await expect(thisWeek.getByText('2h planned,', { exact: false })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Next week' })).toBeVisible();
  await thisWeek.getByRole('button', { name: "Edit this week's plan" }).tap();
  await expect(page.getByRole('button', { name: 'Done editing' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Done editing' }).tap();
  await expect(heading(page)).toHaveText('Today');
});
