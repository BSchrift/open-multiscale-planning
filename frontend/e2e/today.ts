// Today's screens differ by layout: desktop keeps its Now card, its sections and its prompts, and the phone puts the
// day's calendar first, the block under way or selected raised on it as a card (src/ui/screens/today/Phone.tsx). These
// reach the same thing in each, so a spec reads the same on both.

import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

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
  if (!(await block.getAttribute('aria-label'))?.endsWith('Selected.')) await block.tap();
  await expect(block).toHaveAccessibleName(/Selected\.$/);
  await nowCard(page, true).locator('.rctitle').tap();
}

/** Picks from the phone's Today menu, which holds the day's zoom and its list. */
export async function phoneView(page: Page, choice: 'Zoom in' | 'Zoom out' | 'Show as a list' | 'Show as a calendar'): Promise<void> {
  await page.getByRole('button', { name: "Today's view" }).click();
  await page.getByRole('menuitem', { name: choice }).click();
}

/** The sheet behind the phone's row of what's waiting for a time: Needs a new time, To schedule and missed blocks. */
export async function waitingSheet(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /waiting for a time|missed blocks? to check in on|^Connect Google Calendar$/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Waiting for a time' });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Closes the waiting sheet once it's back from a card's sheet, which it's drawn again after, so a key isn't lost. */
export async function closeWaiting(page: Page): Promise<void> {
  const sheet = page.getByRole('dialog', { name: 'Waiting for a time' });
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
}

/** A block that ended unanswered asks on itself on phone: a tap selects it, raised with its answers. */
export async function askOnBlock(page: Page, name: RegExp): Promise<Locator> {
  const block = page.getByRole('region', { name: "Today's timeline" }).getByRole('button', { name });
  const card = nowCard(page, true);
  // By its top, which shows above a raised card drawn over the rest of it, as a block beside the one under way is.
  if (!(await block.getAttribute('aria-label'))?.endsWith('Selected.')) await block.click({ position: { x: 12, y: 4 } });
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
