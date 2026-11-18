// The journey the deployed web suite takes on desktop: work goes from Capture to this week, onto the calendar by
// suggestion and by drag, back off, and done. The prod Test step takes it against the web app prod still serves, the
// release before, since that publishes only once the checks pass. So each step keeps to what both releases do. The
// cross-version suite (e2e/compat) takes it on the last release's bundle as well as this checkout's, so a step only
// this checkout's web app can take fails there, on CI against main's bundle and on staging against prod's, before
// prod's Test step meets it.

import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/**
 * The time zone the page runs in: the runner's own, unless it's late on Sunday there. The journey asks for a suggested
 * half hour later this week, and suggestions end at the default closed hours from 10pm, so late on Sunday the week has
 * no room left. Then the page runs in Honolulu, 10 hours behind UTC, the runner's zone on CodeBuild, where it's still
 * Sunday morning or early afternoon. A runner so far east that it's late on Sunday in Honolulu too gets Kiritimati, a
 * day ahead of Honolulu, where it's Monday. A zone rather than a page clock, since a zone moves no clock: what the page
 * writes to the shared test user carries the real time.
 */
export function timezoneWithRoom(now = new Date()): string | undefined {
  // From 8pm, since the journey starts some minutes after the page opens, and needs half an hour before 10pm.
  const lateSunday = (timeZone?: string) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
    const part = (type: string) => parts.find((p) => p.type === type)?.value;
    return part('weekday') === 'Sun' && Number(part('hour')) >= 20;
  };
  if (!lateSunday()) return undefined;
  return lateSunday('Pacific/Honolulu') ? 'Pacific/Kiritimati' : 'Pacific/Honolulu';
}

/** The journey, with checks titled `title`, on a page past first-run setup, at the desktop layout. */
export async function workJourney(page: Page, title: string): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Main' });

  // A second check follows it in the Inbox. Process closes itself after its last card, and on a shared test user what
  // else the Inbox holds varies from run to run; with this one after it, Process is still open, on a card, once the
  // first is made a practice.
  for (const item of [title, `${title}, next`]) {
    await nav.getByRole('button', { name: /Capture/ }).click();
    const field = page.getByRole('dialog', { name: 'Capture' }).getByRole('textbox', { name: 'Capture to Inbox' });
    await field.fill(item);
    await field.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Capture' })).toHaveCount(0);
  }

  // Process: a practice made from the card takes the item with it, in one change that one Undo takes back. The release
  // before, which the prod Test step meets, has had the picker since Nov 13, so both take the same steps.
  await nav.getByRole('button', { name: /Inbox/ }).click();
  await page.getByRole('button', { name: `Assign ${title}`, exact: true }).click();
  await page.getByRole('button', { name: 'New practice from this item' }).click();
  await page.getByRole('button', { name: 'Make it a practice' }).click();
  await expect(page.getByText(`${title} is now a practice.`)).toBeVisible();
  await page.getByRole('button', { name: 'Undo and go back' }).click();
  await expect(page.getByText(`Undone: ${title} removed. ${title} is back.`)).toBeVisible();

  // Add to this week picks it for the week, and puts nothing on the calendar.
  await page.getByRole('switch', { name: 'Add to this week' }).click();
  await page.getByRole('combobox', { name: 'Add to a project or One offs' }).fill('One offs');
  await page.keyboard.press('Enter');
  // Enter picks One offs, and Add to adds the item there. The release before, which the prod Test step meets, added it
  // on the pick, so Add to is pressed only while the toast hasn't come. On that release the next card's picker also
  // holds One offs, so both can show at once: wait for either, not exactly one.
  const added = page.getByText(`Added ${title} to One offs and to this week.`);
  const add = page.getByRole('dialog', { name: 'Process Inbox' }).getByRole('button', { name: 'Add to One offs', exact: true });
  await expect(added.or(add).first()).toBeVisible();
  if (!(await added.isVisible())) await add.click();
  await expect(added).toBeVisible();
  // The second check is on the card now, for the cleanup below to delete.
  await page.getByRole('dialog', { name: 'Process Inbox' }).getByRole('button', { name: 'Exit' }).click();

  // Week: it waits in To schedule; a suggestion places it, and Undo brings it back.
  await nav.getByRole('button', { name: 'Week' }).click();
  const lane = page.getByRole('region', { name: 'To schedule' });
  const card = lane.getByRole('button', { name: `${title}, One off, 30m, to schedule` });
  await expect(card).toBeVisible();
  await card.click();
  await page.getByRole('group', { name: title }).getByRole('group', { name: 'Suggested times' }).getByRole('button').first().click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(card).toBeVisible();

  // Dragged by the mouse onto the last day, at 7pm, 13 hours down a 26px-an-hour day from 6am, it's placed there.
  await dragTo(page, card, (c) => ({ x: c.x + 20, y: c.y + 10 }), page.locator('[data-drop-date]').last(), (d) => ({ x: d.x + d.width / 2, y: d.y + 26 * 13 + 2 }));
  await expect(card).toHaveCount(0);
  const placed = page.getByRole('button', { name: new RegExp(`^${title}, .* One off\\.`) });
  await expect(placed).toBeVisible();

  // While editing, dragged back onto To schedule, it comes off the calendar.
  // Skip for now is × on desktop, and is kept on the week's plan for every device.
  if (!(await page.getByRole('button', { name: "Edit this week's plan" }).count())) {
    await page.getByRole('button', { name: /^Skip (for now|planning this week)$/ }).click();
  }
  await page.getByRole('button', { name: "Edit this week's plan" }).click();
  const block = page.getByRole('group', { name: new RegExp(`^${title}, `) });
  await dragTo(page, block, (b) => ({ x: b.x + b.width / 2, y: b.y + 6 }), lane, (l) => ({ x: l.x + l.width / 2, y: l.y + 12 }));
  await expect(block).toHaveCount(0);
  await expect(card).toBeVisible();
  await page.getByRole('button', { name: 'Done editing' }).click();

  // Marked done, it leaves.
  await card.click();
  await page.getByRole('group', { name: title }).getByRole('button', { name: 'Mark done' }).click();
  await expect(card).toHaveCount(0);
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * A mouse drag from a point on one element to a point on another. What waits above the week's days varies with the
 * shared test user's data: a practice left by an earlier run puts a row above every day. So the day's 7pm could be
 * below the window when measured before the drag, where the mouse lets go over nothing. The second element is
 * scrolled into the middle of the window once the drag is under way, and measured after.
 */
async function dragTo(page: Page, from: Locator, grip: (box: Box) => { x: number; y: number }, to: Locator, at: (box: Box) => { x: number; y: number }) {
  await from.scrollIntoViewIfNeeded();
  const start = grip((await from.boundingBox())!);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Pressed and moved past a click's wobble, it lifts. This checkout's web app lifts it once the press has been held,
  // and only then lets it follow. A release from before hold to drag, which the prod Test step can meet, has no hold:
  // it lifts it on the move itself. Either way it's lifted before it moves on, and the drop is read from where it's let
  // go.
  await page.mouse.move(start.x, start.y + 10, { steps: 2 });
  await expect(from).toContainClass('lifted');
  await to.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const end = at((await to.boundingBox())!);
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
}
