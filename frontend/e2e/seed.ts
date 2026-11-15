// Seeds records into the browser build before a test looks at a screen. Only dev builds expose the hook. Also the
// steps the browser and Electron specs share.

import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { formatDate } from '../src/core/dates';
import { FILE, STORE } from '../src/platform/web-file';

export interface Seed {
  type: string;
  id?: string;
  fields: Record<string, unknown>;
}

/** Waits for the app to open its data, then writes the records in one transaction. */
export async function seed(page: Page, records: readonly Seed[]): Promise<void> {
  await page.waitForFunction(() => 'multiscaleSeed' in window);
  await page.evaluate((r) => (window as unknown as { multiscaleSeed(r: readonly Seed[]): Promise<void> }).multiscaleSeed(r), records);
}

/** A record as this device has it, for fields no screen shows. */
export async function readRecord(page: Page, type: string, id: string): Promise<Record<string, unknown> | undefined> {
  await page.waitForFunction(() => 'multiscaleRecord' in window);
  return page.evaluate(([t, i]) => (window as unknown as { multiscaleRecord(type: string, id: string): Promise<Record<string, unknown> | undefined> }).multiscaleRecord(t!, i!), [type, id]);
}

/** Opens the app past first-run setup, with the given records already in place. */
export async function openSeeded(page: Page, records: readonly Seed[] = []): Promise<void> {
  await page.goto('/');
  await seed(page, [{ type: 'settings', id: 'settings', fields: { setup_done_at: '2026-01-01T00:00:00.000Z' } }, ...records]);
}

/**
 * Waits until the database file the browser build keeps in IndexedDB has this text in it, so a reload keeps it. Without
 * OPFS, as in phone's WebKit here, the browser build saves the whole file there 200ms after the last change, and a
 * reload sooner loses it (a shortcut in platform/web.ts); with OPFS, a copy follows as soon.
 */
export async function saved(page: Page, text: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ store, file, text }) =>
          new Promise<boolean>((resolve, reject) => {
            // The database web-file.ts opens. Never made here: one without its store would break the app's.
            const open = indexedDB.open('multiscale-dev');
            open.onupgradeneeded = () => open.transaction!.abort();
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const read = open.result.transaction(store).objectStore(store).get(file);
              read.onerror = () => reject(read.error);
              read.onsuccess = () => resolve(new TextDecoder().decode(read.result as Uint8Array | undefined).includes(text));
              open.result.close();
            };
          }),
        { store: STORE, file: FILE, text },
      ),
    )
    .toBe(true);
}

/** Checks a control is at least 44pt each way, the smallest a finger can hit reliably. */
export async function expectTapTarget(target: Locator): Promise<void> {
  // A control that isn't there fails here, by name, rather than as a timeout in the wait below, which reads like an
  // animation that never ends.
  await expect(target).toBeVisible();
  // Measured once it and what it sits in have finished moving in, such as a sheet sliding up: partway, the browser
  // reads a moved box's corners to the nearest float, so a 44px box can read 43.99997px. An endless animation, such as
  // a spinner's, never finishes, so it isn't waited for.
  await target.evaluate((e) =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect instanceof KeyframeEffect && a.effect.getComputedTiming().endTime !== Infinity && a.effect.target?.contains(e))
        .map((a) => a.finished.catch(() => {})),
    ),
  );
  const box = await target.boundingBox();
  const what = await target.evaluate((e) => e.outerHTML.slice(0, 80));
  expect(box?.height, what).toBeGreaterThanOrEqual(44);
  expect(box?.width, what).toBeGreaterThanOrEqual(44);
}

/** A main area's page. */
export const pane = (page: Page, label: string) => page.locator(`.pane[aria-label='${label}']:visible`);
export const account = (page: Page) => pane(page, 'Settings').getByRole('region', { name: 'Account' });

/** Opens a desktop tab and waits for its heading. */
export async function go(page: Page, label: string, heading: string | RegExp = label) {
  // Inbox carries its count.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^${label}( \\d+)?$`) }).click();
  await expect(pane(page, label).getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}

/**
 * Presses Sync now and waits for it to finish, allowing for a deployment's slower network. A sync already under way
 * finishes first, so a caller that may meet one passes a timeout for it.
 */
export async function syncNow(page: Page, timeout = 30_000) {
  await go(page, 'Settings');
  await account(page).getByRole('button', { name: 'Sync now' }).click();
  await expect(account(page).getByRole('button', { name: 'Sync now', disabled: true })).toHaveCount(0, { timeout });
}

/**
 * Start planning, then its toast's Undo, which keeps this week's times free: Start puts planning on the clock from now.
 * Undo waits until planning has drawn, since on phone the toast moves down then, and a press on Undo while it moves is
 * let go beside it, which leaves the toast and the planning block in place.
 */
export async function startPlanningThenUndo(page: Page) {
  await page.getByRole('button', { name: 'Start planning' }).first().click();
  await expect(page.getByRole('navigation', { name: 'Planning steps' })).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText(/^Planning until /)).toHaveCount(0);
}

/** A one off's row. */
export const oneOffRow = (page: Page, title: string) =>
  pane(page, 'One offs').locator('.maintrow').filter({ has: page.getByRole('checkbox', { name: `${title} done` }) });

export async function setDate(page: Page, title: string, date: string) {
  await go(page, 'One offs');
  await pane(page, 'One offs').getByRole('button', { name: `Add date for ${title}` }).click();
  await pane(page, 'One offs').getByLabel('Date', { exact: true }).fill(date);
  await pane(page, 'One offs').getByRole('button', { name: 'Set date' }).click();
  // The row's line starts with the date, then its estimate if it has one.
  await expect(oneOffRow(page, title).getByText(new RegExp(`^${formatDate(date)}(,|$)`))).toBeVisible();
}

/**
 * What's drawn on top at a point on the current-time line, and whether its dot is on top at its centre. The line and dot
 * let pointers through, so for a moment they're made to take them, and the hit test then finds whatever paints highest.
 */
export async function overNowLine(line: Locator, x: number): Promise<{ at: string; dotOnTop: boolean }> {
  return line.evaluate((el, x) => {
    const dot = el.querySelector('i')!;
    el.style.pointerEvents = dot.style.pointerEvents = 'auto';
    const r = el.getBoundingClientRect();
    const d = dot.getBoundingClientRect();
    const hit = document.elementFromPoint(x, r.top + r.height / 2);
    const onDot = document.elementFromPoint(d.left + d.width / 2, d.top + d.height / 2);
    el.style.pointerEvents = dot.style.pointerEvents = '';
    return { at: hit === el ? 'line' : (hit?.closest('[aria-label]')?.getAttribute('aria-label') ?? hit?.className ?? ''), dotOnTop: onDot === dot };
  }, x);
}

/**
 * A finger held on an element, then dragged to a point and let go, as touch pointer events: Playwright's touchscreen
 * only taps. The hold is real time, so the app's hold-to-drag timer runs as it would.
 */
export async function touchDrag(page: Page, target: Locator, to: { x: number; y: number }, holdMs = 500, dwellMs = 0, letGo: { x: number; y: number } | Locator | (() => Promise<{ x: number; y: number }>) = to): Promise<void> {
  const box = (await target.boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const fire = (type: string, at: { x: number; y: number }, onTarget = false) =>
    (onTarget ? target : page.locator('body')).evaluate(
      (el, { type, x, y, onTarget }) => {
        const init = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y };
        (onTarget ? el : window).dispatchEvent(new PointerEvent(type, init));
      },
      { type, x: at.x, y: at.y, onTarget },
    );
  await fire('pointerdown', from, true);
  await page.waitForTimeout(holdMs);
  for (let i = 1; i <= 4; i++) await fire('pointermove', { x: from.x + ((to.x - from.x) * i) / 4, y: from.y + ((to.y - from.y) * i) / 4 });
  // Held still there, as a finger waits at the edge for the page to scroll.
  if (dwellMs) await page.waitForTimeout(dwellMs);
  // Let go over an element: the middle of the part of it on screen, once the page has stopped scrolling.
  let end = letGo as { x: number; y: number };
  if (typeof letGo === 'function') end = await letGo();
  else if ('boundingBox' in letGo) {
    const b = (await letGo.boundingBox())!;
    const bottom = Math.min(b.y + b.height, page.viewportSize()!.height - 160);
    end = { x: b.x + b.width / 2, y: (Math.max(b.y, 0) + bottom) / 2 };
  }
  if (end !== to) await fire('pointermove', end);
  await fire('pointerup', end);
}
