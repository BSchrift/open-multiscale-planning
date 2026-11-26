// Today's screens differ by layout: desktop keeps its Now card, its sections and its prompts, and the phone puts the
// day's calendar first, the block under way or selected raised on it as a card (src/ui/screens/today/Phone.tsx). These
// reach the same thing in each, so a spec reads the same on both.

import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/** Whether the app drew the phone's layout, read once its shell is drawn, which can be a moment after the seed. */
export async function isPhone(page: Page): Promise<boolean> {
  return (await page.locator('[data-layout]').first().getAttribute('data-layout')) === 'phone';
}

/**
 * Today has read the week, so nothing above the day moves after: To schedule's line on desktop, and on phone, Today no
 * longer busy. Without `phone`, the layout drawn says which.
 */
export async function todayRead(page: Page, phone?: boolean): Promise<void> {
  await expect(page.getByRole('region', { name: "Today's timeline" })).toBeVisible();
  if (phone ?? (await page.locator('[data-layout="phone"]').count()) > 0) await expect(page.locator('.tdphone')).toHaveAttribute('aria-busy', 'false');
  else await expect(page.getByRole('region', { name: 'To schedule' }).getByText(/^(Everything this week is on the calendar\.|Nothing waiting for today\.|\d+ · )/)).toBeVisible();
}

/** The block under way, or the next: desktop's Now card, or on phone the block raised on the day. */
export function nowCard(page: Page, phone: boolean): Locator {
  return phone ? page.locator('.cev.raised:not(.settling)') : page.getByRole('region', { name: 'Current block' });
}

/**
 * On phone, the block in progress keeps to its own times, one line, until a tap selects it and shows its actions: this
 * taps it, if it isn't already. Desktop's Current block card always has them.
 */
export async function showNow(page: Page, phone: boolean): Promise<Locator> {
  const now = nowCard(page, phone);
  if (!phone) return now;
  await expect(now).toBeVisible();
  if (await now.evaluate((el) => el.classList.contains('inlane'))) {
    await now.click();
    await expect(page.locator('.cev.raised.inlane')).toHaveCount(0);
  }
  return now;
}

/**
 * Opens a block from the day: a click on desktop; on phone the first tap selects it, raising it as a card over it, and a
 * second, on the card, opens it.
 */
export async function openBlock(page: Page, block: Locator, phone: boolean): Promise<void> {
  if (!phone) return block.click();
  if (!(await block.getAttribute('aria-label'))?.endsWith('Selected.')) {
    // Selected by Today rather than a tap, it's drawn in its lane over its block, so the tap that grows it lands there.
    const over = page.locator(`.cev.raised.inlane[data-raised="${await block.getAttribute('data-block')}"]`);
    await ((await over.count()) > 0 ? over.locator('.blktitle') : block).tap();
  }
  await expect(block).toHaveAccessibleName(/Selected\.$/);
  await nowCard(page, true).locator('.rctitle').tap();
}

/**
 * Picks from the phone's Today menu, which holds the day's zoom and its list, and the week's own actions that Week's
 * page had on phone before Today drew the week.
 */
export async function phoneView(
  page: Page,
  choice: 'Zoom in' | 'Zoom out' | 'Show as a list' | 'Show as a calendar' | "Edit this week's plan" | "Reset this week's plan" | "See this week's analytics" | "See that week's analytics",
): Promise<void> {
  await page.getByRole('button', { name: 'View and week' }).click();
  await page.getByRole('menuitem', { name: choice }).click();
}

/**
 * The strip's seven days, opened from its slim bar when the day has scrolled them away. The bar is tapped where it's
 * drawn, as a finger lands, since Playwright's own tap first scrolls the bar, stuck over the day, clear of the page's
 * padding. Opened, focus goes to the day shown once the days are in, which is waited for, so it doesn't take focus from
 * what's pressed next.
 */
export async function openStrip(page: Page): Promise<Locator> {
  const days = page.getByRole('group', { name: 'Choose a day' });
  // A day just chosen keeps its time of day, which can scroll the page and fold the strip, and a half fold then springs
  // to an end: so the page is let rest first, for longer than the spring waits before it starts (140ms). A scroll, such
  // as focus going to a block, reaches the strip only at the browser's next rendering update, which a test's clock
  // doesn't drive, since it fakes animation frames: so each frame also waits for one, which a resize observer's first
  // call comes after. Without it the strip can still be open over a day already scrolled, and fold under the tap.
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const pane = document.querySelector('.pane')!;
        const drawn = () =>
          new Promise<void>((after) => {
            const seen = new ResizeObserver(() => {
              seen.disconnect();
              after();
            });
            seen.observe(document.documentElement);
          });
        let [last, still] = [-1, 0];
        const tick = async () => {
          await drawn();
          still = pane.scrollTop === last ? still + 1 : 0;
          last = pane.scrollTop;
          if (still >= 15) done();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  if (!(await days.isVisible())) {
    const bar = (await page.getByRole('button', { name: /\. Show the week$/ }).boundingBox())!;
    await page.touchscreen.tap(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await expect(days.locator('[aria-pressed="true"]')).toBeFocused();
  }
  await expect(days).toBeVisible();
  return days;
}

/** The sheet behind the strip footer's count of what's waiting for a time: Needs a new time, the week's cards and missed blocks. */
export async function waitingSheet(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /\d+ to schedule|missed blocks? to check in on|^Connect Google Calendar$/ }).click();
  const sheet = page.getByRole('dialog', { name: 'To schedule' });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Closes the waiting sheet once it's back from a card's sheet, which it's drawn again after, so a key isn't lost. */
export async function closeWaiting(page: Page): Promise<void> {
  const sheet = page.getByRole('dialog', { name: 'To schedule' });
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
}

/**
 * A block that ended unanswered asks on itself on phone: a tap selects it, raised with its answers. Selected by Today
 * rather than a tap, it keeps to its own times with one button, How did it go?, which grows it to them.
 */
export async function askOnBlock(page: Page, name: RegExp): Promise<Locator> {
  const block = page.getByRole('region', { name: "Today's timeline" }).getByRole('button', { name });
  const card = nowCard(page, true);
  // Drawn with its block, so it's there once the block is.
  await expect(block).toBeVisible();
  const ask = card.getByRole('button', { name: 'How did it go?' });
  if ((await ask.count()) > 0) await ask.click();
  // By its top, which shows above a raised card drawn over the rest of it, as a block beside the one under way is.
  else if (!(await block.getAttribute('aria-label'))?.endsWith('Selected.')) await block.click({ position: { x: 12, y: 4 } });
  await expect(block).toHaveAccessibleName(/Selected\.$/);
  await expect(card).toContainText('How did it go?');
  return card;
}

/**
 * Puts off the question a block that ended unanswered asks: desktop's prompt has Answer later. On phone the block asks
 * on itself, raised on the day, so there's nothing to put off, only Today to wait for.
 */
export async function answerLater(page: Page): Promise<void> {
  await expect(page.locator('[data-layout]')).toHaveCount(1);
  if ((await page.locator('[data-layout="phone"]').count()) > 0) return todayRead(page, true);
  await page.getByRole('dialog', { name: 'Block finished' }).getByRole('button', { name: 'Answer later' }).click();
}
