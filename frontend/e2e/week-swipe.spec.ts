// Swiping Week's day on phone from day to day, as Apple Maps pages between places: the day follows the finger, and
// letting go settles on the day momentum points to, at most one day either side of the one the swipe began on. In
// Chromium the finger is real: CDP's Input.dispatchTouchEvent sends touches the page sees as a person's, at the times
// given, so a swipe's speed is exact and a vertical drag scrolls the page as the phone would. Playwright's WebKit can't
// move a finger, so there the same pointer events are sent to the page, at the same times. The iPhone Simulator test
// swipes the app itself.

import { expect, test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';
import { openSeeded, settled } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

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

/** A point the finger passes, `t` ms after it went down. */
type Point = { x: number; y: number; t: number };

/**
 * One finger, put down, moved and lifted: real touches in Chromium; in WebKit, the touch pointer events they make. Each
 * is sent at `t` ms after the finger went down, as its event's time says, or now when `t` is left out.
 */
function finger(page: Page) {
  const chromium = page.context().browser()?.browserType().name() === 'chromium';
  let cdp: CDPSession | null = null;
  let base = 0;
  let last = { x: 0, y: 0 };
  return async (type: 'down' | 'move' | 'up', p: { x: number; y: number } | null, t?: number) => {
    const to = p ?? last;
    last = to;
    if (chromium) {
      if (type === 'down') [cdp, base] = [await page.context().newCDPSession(page), Date.now() / 1000];
      const kind = ({ down: 'touchStart', move: 'touchMove', up: 'touchEnd' } as const)[type];
      await cdp!.send('Input.dispatchTouchEvent', { type: kind, touchPoints: type === 'up' ? [] : [{ x: to.x, y: to.y, id: 1 }], ...(t === undefined ? {} : { timestamp: base + t / 1000 }) });
      return;
    }
    // The page keeps the time the finger went down, which the events' times count from.
    await page.evaluate(
      ({ type, x, y, t }) => {
        const kind = { down: 'pointerdown', move: 'pointermove', up: 'pointerup' }[type]!;
        const held = window as unknown as { fingerDown: number };
        if (type === 'down') held.fingerDown = performance.now();
        const e = new PointerEvent(kind, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: type === 'up' ? 0 : 1, clientX: x, clientY: y });
        if (t !== null) Object.defineProperty(e, 'timeStamp', { value: held.fingerDown + t });
        (type === 'down' ? document.elementFromPoint(x, y)! : window).dispatchEvent(e);
      },
      { type, x: to.x, y: to.y, t: t ?? null },
    );
  };
}

/** A finger put down at the first point, moved through the rest at their times, and lifted `upAt` ms after it went down. */
async function swipe(page: Page, points: readonly Point[], upAt: number) {
  const send = finger(page);
  for (const [i, p] of points.entries()) await send(i ? 'move' : 'down', p, p.t);
  await send('up', null, upAt);
}

/** From `from`, `steps` moves of (dx, dy) each, `every` ms apart. */
const path = (from: { x: number; y: number }, steps: number, dx: number, dy: number, every: number): Point[] =>
  Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + dx * i, y: from.y + dy * i, t: every * i }));

const day = (page: Page) => page.locator('.wkdaycard');
const heading = (page: Page) => page.locator('h3.wkday');
const strip = (page: Page) => page.getByRole('group', { name: 'Choose a day' });

/** A point on the part of the day that shows, `y` px down it: below the sticky week top and clear of the tab bar. */
const onDay = (page: Page, y = 40) =>
  day(page).evaluate((el, y) => {
    const box = el.getBoundingClientRect();
    const top = Math.max(box.top, document.querySelector('.weektop')!.getBoundingClientRect().bottom);
    return { x: box.left + box.width * 0.8, y: Math.min(top + y, innerHeight - 160) };
  }, y);

/** The swipe has let go and its spring has settled. */
const still = (page: Page) => expect(day(page)).not.toHaveAttribute('data-swiping');

/** The minute at the top of what shows of the day, under the sticky week top, read from its rows as drops read them. */
const timeAtTop = (page: Page) =>
  page.evaluate(() => {
    const top = document.querySelector('.weektop')!.getBoundingClientRect().bottom;
    const rows = [...document.querySelectorAll<HTMLElement>('.wkdaycard .dppane:not(.dpside) [data-drop-from]')];
    const row = rows.find((r) => top < r.getBoundingClientRect().bottom)!;
    const box = row.getBoundingClientRect();
    const [from, to] = [Number(row.dataset.dropFrom), Number(row.dataset.dropTo)];
    return from + Math.max(0, Math.min(1, (top - box.top) / box.height)) * (to - from);
  });

/** How far the page under the day has scrolled: the app's own scrolling pane on phone. */
const scrolled = (page: Page) =>
  day(page).evaluate((el) => {
    let s = el.parentElement;
    while (s && !/auto|scroll/.test(getComputedStyle(s).overflowY)) s = s.parentElement;
    return (s ?? document.scrollingElement!).scrollTop;
  });

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  // Every screen's styles, which load after the first and can move the day, are in before anything is measured.
  await settled(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Week' }).click();
  await expect(heading(page)).toHaveText('Mon Nov 2');
});
test.afterEach(() => expect(errors).toEqual([]));

test('a quick short flick moves one day, and the strip follows', async ({ page }) => {
  // 60px in 32ms: far short of halfway, but 1875 pt/s, well past the flick speed.
  await swipe(page, path(await onDay(page), 4, -15, 0, 8), 34);
  await expect(heading(page)).toHaveText('Tue Nov 3');
  await expect(strip(page).getByRole('button', { name: /^Tue Nov 3/ })).toHaveAttribute('aria-pressed', 'true');
  await still(page);
  await expect(page.getByRole('button', { name: /^Draft the summary, 6pm to 7pm/ })).toBeVisible();

  // And back the other way.
  await swipe(page, path(await onDay(page), 4, 15, 0, 8), 34);
  await expect(heading(page)).toHaveText('Mon Nov 2');
  await still(page);
});

test('a slow small drag springs back to the day it started on', async ({ page }) => {
  // 80px over 800ms, then held still before letting go: slow, and nowhere near halfway.
  await swipe(page, path(await onDay(page), 16, -5, 0, 50), 900);
  await still(page);
  await expect(heading(page)).toHaveText('Mon Nov 2');
  await expect(page.getByRole('button', { name: /^Paint the fence, 4pm to 5pm/ })).toBeVisible();
});

test('a long drag, flicked on at the end, moves exactly one day, drawing the next day beside it on the way', async ({ page }) => {
  // Over 650px left, well past one day, the last of it fast.
  const points = path(await onDay(page), 26, -25, 0, 16);
  const send = finger(page);
  for (const [i, p] of points.slice(0, 14).entries()) await send(i ? 'move' : 'down', p, p.t);
  // Past halfway, with the finger still down: the next day is drawn beside this one, and the strip already says it.
  await expect(day(page).locator('.dpside[data-day="2026-11-03"]')).toContainText('Draft the summary');
  await expect(strip(page).getByRole('button', { name: /^Tue Nov 3/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(heading(page)).toHaveText('Mon Nov 2');
  for (const p of points.slice(14)) await send('move', p, p.t);
  // Far past one day, the day after next is never drawn, and the page never scrolls sideways.
  await expect(day(page).locator('.dppane')).toHaveCount(3);
  await expect(day(page).locator('.dppane[data-day="2026-11-04"]')).toHaveCount(0);
  expect(await page.evaluate(() => [...document.querySelectorAll('*')].filter((el) => el.scrollLeft > 0).length + scrollX)).toBe(0);
  await send('up', null, points.at(-1)!.t + 2);
  await still(page);
  await expect(heading(page)).toHaveText('Tue Nov 3');
  await expect(page.getByRole('button', { name: /^Draft the summary, 6pm to 7pm/ })).toBeVisible();
});

test('a vertical drag scrolls the day and keeps it', async ({ page }, info) => {
  const before = await scrolled(page);
  await swipe(page, path(await onDay(page, 200), 10, 2, -25, 16), 300);
  await still(page);
  await expect(heading(page)).toHaveText('Mon Nov 2');
  // A real finger scrolls the page as the phone would; WebKit's pointer events here can't scroll it.
  if (info.project.name === 'desktop') await expect.poll(() => scrolled(page)).toBeGreaterThan(before + 100);
});

test('a held block dragged sideways moves, and a hold on empty time drafts there, with no swipe either time', async ({ page }) => {
  // Real time here, so the app's hold runs as it would.
  const send = finger(page);
  const block = page.getByRole('button', { name: /^Paint the fence, 4pm to 5pm/ });
  await block.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = (await block.boundingBox())!;
  const from = { x: box.x + box.width * 0.7, y: box.y + box.height / 2 };
  // Held until it lifts, then dragged left and two rows down, onto the free time after it, much as a swipe would go.
  await send('down', from);
  await expect(page.locator('.tlblock.lifted')).toBeVisible();
  for (let i = 1; i <= 6; i++) await send('move', { x: from.x - 30 * i, y: from.y + 20 * i });
  await send('up', null);
  await expect(page.getByText(/^Moved Paint the fence to Mon Nov 2, /)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Paint the fence, 4pm to 5pm/ })).toHaveCount(0);
  await still(page);
  await expect(heading(page)).toHaveText('Mon Nov 2');

  // Held on the free time after it until a draft appears, then dragged sideways: Capture opens on the draft.
  const free = page.locator('.dppane:not(.dpside) .tlfree').last();
  await free.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const fb = (await free.boundingBox())!;
  const start = { x: fb.x + fb.width * 0.7, y: fb.y + 20 };
  await send('down', start);
  await expect(page.locator('.holddraft')).toBeVisible();
  for (let i = 1; i <= 6; i++) await send('move', { x: start.x - 30 * i, y: start.y });
  await send('up', null);
  await expect(page.getByRole('dialog', { name: 'Capture' })).toBeVisible();
  await expect(heading(page)).toHaveText('Mon Nov 2');
});

test("swiped past Sunday, the day carries on into next week's Monday, as the week arrows do", async ({ page }) => {
  await strip(page).getByRole('button', { name: /^Sun Nov 8/ }).click();
  await expect(heading(page)).toHaveText('Sun Nov 8');
  await swipe(page, path(await onDay(page), 4, -15, 0, 8), 34);
  await expect(page.getByRole('heading', { name: 'Next week' })).toBeVisible();
  await expect(heading(page)).toHaveText('Mon Nov 9');
  await expect(strip(page).getByRole('button', { name: /^Mon Nov 9/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^Sand the deck, 10am to 11am/ })).toBeVisible();

  // And back into this week's Sunday.
  await still(page);
  await swipe(page, path(await onDay(page), 4, 15, 0, 8), 34);
  await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible();
  await expect(heading(page)).toHaveText('Sun Nov 8');
});

test('the time of day at the top of the day stays put from day to day', async ({ page }) => {
  // Monday's 4pm block at the top of what shows, under the week's sticky top. Monday's morning has gone by, so its rows
  // are drawn short; Tuesday's aren't, so the same scroll would show another time there.
  const block = page.getByRole('button', { name: /^Paint the fence, 4pm to 5pm/ });
  await block.evaluate((el) => {
    const top = document.querySelector('.weektop')!.getBoundingClientRect().bottom;
    let s = el.parentElement;
    while (s && !/auto|scroll/.test(getComputedStyle(s).overflowY)) s = s.parentElement;
    (s ?? document.scrollingElement!).scrollTop += el.getBoundingClientRect().top - top + 10;
  });
  const before = await timeAtTop(page);
  expect(before).toBeGreaterThan(16 * 60);
  expect(before).toBeLessThan(17 * 60);
  await swipe(page, path(await onDay(page, 200), 4, -15, 0, 8), 34);
  await expect(heading(page)).toHaveText('Tue Nov 3');
  await still(page);
  expect(Math.abs((await timeAtTop(page)) - before)).toBeLessThan(5);
});

test('with reduced motion, the day changes as the finger lifts, with no spring', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const points = path(await onDay(page), 4, -15, 0, 8);
  const send = finger(page);
  for (const [i, p] of points.entries()) await send(i ? 'move' : 'down', p, p.t);
  // Every place the day is drawn at from here on: with no spring, none between where the finger left it and the next day.
  await day(page).locator('.dptrack').evaluate((track) => {
    const seen: string[] = [];
    new MutationObserver(() => seen.push((track as HTMLElement).style.transform)).observe(track, { attributes: true, attributeFilter: ['style'] });
    (window as unknown as { seen: string[] }).seen = seen;
  });
  await send('up', null, 34);
  await expect(heading(page)).toHaveText('Tue Nov 3');
  await still(page);
  expect(await page.evaluate(() => (window as unknown as { seen: string[] }).seen.filter(Boolean))).toEqual([]);
});
