// The journey the deployed web suite takes on desktop: work goes from Capture to this week, onto the calendar by
// suggestion and by drag, back off, and done. The prod Test step takes it against the web app prod still serves, the
// release before, since that publishes only once the checks pass. So each step keeps to what both releases do. The
// cross-version suite (e2e/compat) takes it on the last release's bundle as well as this checkout's, so a step only
// this checkout's web app can take fails there, on CI against main's bundle and on staging against prod's, before
// prod's Test step meets it. What neither can show is how slowly prod's shared test user's history reads a change
// back: CI starts empty and staging deletes its records within minutes. So no step waits for a screen to catch up while
// something that goes by itself, such as a toast, holds the control it presses next.

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

/**
 * Puts away, before each action, the questions a block asks by itself on every tab while it's left unanswered: Block
 * finished, the missed blocks sheet and Have you started?. On a shared test user, a block a failed run left on the
 * calendar asks once it has ended, and on desktop its question sits in the corner over the page: on prod, on 18
 * November, over the block on the last day that the journey pressed to drag. Esc puts each away for the session, as
 * Answer later and Later do, and answers nothing.
 */
export async function putPromptsAway(page: Page): Promise<void> {
  await page.addLocatorHandler(page.getByRole('dialog', { name: /^(Block finished|\d+ missed blocks?|Have you started\?)$/ }), (prompt) => prompt.press('Escape'));
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
  // The toast with Undo shows once the change is saved, and goes after 5 seconds. Week takes the card away only once it
  // has read the change back, which on prod's shared test user's history can take longer than that (see the expect
  // timeout in playwright.config.ts), so waiting for the card first can leave no Undo to press. As soon as Undo shows,
  // the mouse rests on it and it takes focus, either of which holds the toast, as for a person reaching for it by mouse
  // or by keyboard, until the card has gone. Both, since the mouse alone let it go now and then in the slowed-down run
  // of this step on this checkout's web app, though no other toast came and nothing moved the mouse.
  const undo = page.getByRole('button', { name: 'Undo' });
  await undo.hover();
  await undo.focus();
  await expect(card).toHaveCount(0);
  await undo.click();
  await expect(card).toBeVisible();

  // Dragged by the mouse onto the last day, at 7pm, 13 hours down a 26px-an-hour day from 6am, it's placed there.
  await dragTo(page, card, () => ({ x: 20, y: 10 }), page.locator('[data-drop-date]').last(), (d) => ({ x: d.x + d.width / 2, y: d.y + 26 * 13 + 2 }));
  await expect(card).toHaveCount(0);
  const placed = page.getByRole('button', { name: new RegExp(`^${title}, .* One off\\.`) });
  await expect(placed).toBeVisible();

  // While editing, dragged back onto To schedule, it comes off the calendar.
  await editWeek(page);
  const block = page.getByRole('group', { name: new RegExp(`^${title}, `) });
  // Pressed near its left end: its × to take it off sits at the top right, and takes a press for itself. Beside another
  // block at the same time, it's half as wide, and its middle is under the ×.
  await dragTo(page, block, () => ({ x: 8, y: 6 }), lane, (l) => ({ x: l.x + l.width / 2, y: l.y + 12 }));
  await expect(block).toHaveCount(0);
  await expect(card).toBeVisible();
  await page.getByRole('button', { name: 'Done editing' }).click();

  // Marked done, it leaves.
  await card.click();
  await page.getByRole('group', { name: title }).getByRole('button', { name: 'Mark done' }).click();
  await expect(card).toHaveCount(0);
}

/** Week's editing, from this week: Skip for now first, while the week still asks to be planned. */
async function editWeek(page: Page): Promise<void> {
  const edit = page.getByRole('button', { name: "Edit this week's plan" });
  // Skip for now is × on desktop, and is kept on the week's plan for every device.
  const skip = page.getByRole('button', { name: /^Skip (for now|planning this week)$/ });
  // Week draws one or the other once it has loaded. Counted before then, it has neither, and waiting on Skip for now
  // waits for good on a week that doesn't ask: every staging run from 19 November did, as staging's Week drew late.
  await expect(edit.or(skip).first()).toBeVisible();
  if (!(await edit.count())) await skip.click();
  await edit.click();
}

/**
 * Takes away the checks a journey leaves, which a run that fails part way leaves for the next: Inbox items are
 * deleted, a check on the calendar from now on is taken off it, and a one off still waiting in this week's To schedule
 * is marked done. A check left on the calendar changes what the next run meets: on prod, on 19 November, one left at
 * 7pm on the last day, the time the journey drags to, was drawn beside the journey's own block, and the journey's press
 * landed on that block's ×; this checkout's web app asks before putting a second block there at all. A check that has
 * already ended stays, as Week can't take it off, and putPromptsAway puts its question away.
 */
export async function clearLeftChecks(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.getByRole('button', { name: /Inbox/ }).click();
  for (let left = page.getByRole('button', { name: /^Assign (Deployed|Staging|Compat) check / }); await left.count(); ) {
    const name = (await left.first().getAttribute('aria-label'))!.replace(/^Assign /, '');
    await left.first().click();
    // Delete was "Delete/done" before, which a deployment may still be serving. Process can open with its delete question
    // already showing, so answer it if it's there.
    const del = page.getByRole('button', { name: /^Delete(\/done)?$/ });
    const yes = page.getByRole('button', { name: 'Yes, delete' });
    // The sync just before can take the item away as the click lands (prod's Test saw the Inbox empty, no Process open),
    // so an item that's gone needs nothing more.
    const asking = () => del.or(yes).first().isVisible();
    const gone = async () => !(await page.getByRole('button', { name: `Assign ${name}`, exact: true }).count());
    await expect.poll(async () => (await asking()) || (await gone()), { timeout: 15_000 }).toBe(true);
    if (!(await asking())) continue;
    if (await del.isVisible()) await del.click();
    await yes.click();
    // The last one closes this release's Process by itself.
    const process = page.getByRole('dialog', { name: 'Process Inbox' });
    await expect(process.getByRole('heading', { name, exact: true })).toHaveCount(0);
    if (await process.count()) await process.getByRole('button', { name: 'Exit' }).click();
  }
  await nav.getByRole('button', { name: 'Week' }).click();
  // Its × takes a block off the calendar while editing, and puts a one off picked for the week back in To schedule.
  await editWeek(page);
  for (let left = page.getByRole('button', { name: /^Remove (Deployed|Staging|Compat) check / }); await left.count(); ) {
    const name = (await left.first().getAttribute('aria-label'))!;
    // Pressed by keyboard, as a person using one would. Checks left at the same time are drawn side by side, and each
    // one's × sits under the next block, which takes a click: prod's Test failed so on 20 November.
    await left.first().press('Enter');
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Done editing' }).click();
  const lane = page.getByRole('region', { name: 'To schedule' });
  for (let left = lane.getByRole('button', { name: /^(Deployed|Staging|Compat) check [^,]*, One off, .*, to schedule$/ }); await left.count(); ) {
    const name = (await left.first().getAttribute('aria-label'))!;
    await left.first().click();
    await page.getByRole('group', { name: name.replace(/, One off, .*$/, '') }).getByRole('button', { name: 'Mark done' }).click();
    await expect(lane.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * A mouse drag from a point on one element to a point on another. What waits above the week's days varies with the
 * shared test user's data: a practice left by an earlier run puts a row above every day. So the day's 7pm could be
 * below the window when measured before the drag, where the mouse lets go over nothing. The second element is
 * scrolled into the middle of the window once the drag is under way, and measured after. The press is at `grip`, a point
 * on the first element, which the mouse goes to as it would for a click: once nothing covers that point and the
 * element has stopped moving, since Week can still be laying out a change it has just read back.
 */
async function dragTo(page: Page, from: Locator, grip: (box: Box) => { x: number; y: number }, to: Locator, at: (box: Box) => { x: number; y: number }) {
  const position = grip((await from.boundingBox())!);
  await from.hover({ position });
  const box = (await from.boundingBox())!;
  const start = { x: box.x + position.x, y: box.y + position.y };
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
