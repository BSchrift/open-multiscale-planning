// Today on phone: the day's calendar first. The block in progress is raised out of its lane as a card; a tap selects
// another block, which grows into the card as the one before settles back, and a second tap opens it. A block that
// ended asks on itself, what's waiting for a time is one row and one sheet, what's due is chips, the prompt to plan is
// a row, and the hours before the day opens fold into one row. Desktop's Today is unchanged, so these run on phone.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded, touchDrag } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });
test.beforeEach(({}, info) => test.skip(info.project.name !== 'phone', "Today's phone layout"));

// Monday, Nov 2, 2026 in Chicago, six hours behind UTC.
const at = (time: string, day = 2) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, day, h! + 6, m ?? 0)).toISOString().replace('.000Z', 'Z');
};
const planned: Seed = { type: 'week_plan', id: 'week:2026-11-02', fields: { week_start: '2026-11-02', finished_at: at('08:00') } };
const settings: Seed = { type: 'settings', id: 'settings', fields: { setup_done_at: '2026-01-01T00:00:00.000Z', plan_cadence: null } };
const project: Seed = { type: 'project', id: 'p', fields: { title: 'The book', state: 'active', start: '2026-10-01', end: '2026-12-31' } };
const task = (id: string, title: string, extra: Record<string, unknown> = {}): Seed => ({ type: 'task', id, fields: { kind: 'project', project_id: 'p', title, estimate_min: 300, ...extra } });
const block = (id: string, taskId: string, from: string, to: string, extra: Record<string, unknown> = {}): Seed => ({
  type: 'time_block',
  id,
  fields: { task_id: taskId, start: at(from), end: at(to), tz: 'America/Chicago', ...extra },
});
const day: Seed[] = [
  settings,
  planned,
  project,
  task('t1', 'Write chapter two'),
  task('t2', 'Renew passport', { kind: 'one_off', project_id: null, estimate_min: 30 }),
  task('t3', 'Fix onboarding bugs'),
  block('b1', 't1', '13:30', '15:00', { started_at: at('13:30') }),
  block('b2', 't2', '15:30', '16:00'),
  block('b3', 't3', '16:30', '18:00'),
];

async function open(page: Page, time: string, records: Seed[]) {
  await page.clock.install({ time: new Date(at(time)) });
  await openSeeded(page, records);
  await expect(page.getByRole('region', { name: "Today's timeline" })).toBeVisible();
}
const card = (page: Page) => page.locator('.cev.raised:not(.settling)');
/** Every animation on the page that ends has ended. */
const settled = (page: Page) => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));

test('the block in progress stays within its own times and right of the hour labels, raised and a little wider, until a tap selects it', async ({ page }) => {
  await open(page, '14:10', day);
  const now = card(page);
  await expect(now).toContainText('Write chapter two');
  await expect(now).toContainText('50 min left');
  // Not tapped: exactly its block's times, its left edge clear of the hour labels and ticks, a little wider to the right.
  const lane = (await page.getByRole('button', { name: /^Write chapter two, 1:30pm to 3pm/ }).boundingBox())!;
  const gutter = (await page.locator('.day').boundingBox())!;
  let raised = (await now.boundingBox())!;
  expect(Math.abs(raised.y - lane.y)).toBeLessThan(1);
  expect(Math.abs(raised.y + raised.height - (lane.y + lane.height))).toBeLessThan(1);
  expect(raised.x).toBeGreaterThanOrEqual(gutter.x);
  expect(raised.x + raised.width).toBeGreaterThan(lane.x + lane.width);
  // Its actions wait for the tap.
  await expect(now.getByRole('button', { name: 'Mark done now' })).toHaveCount(0);

  // Tapped, it's selected: it grows past its times and over the gutter, with its actions, each a whole tap target.
  await now.click();
  await settled(page);
  raised = (await card(page).boundingBox())!;
  expect(raised.y).toBeLessThan(lane.y);
  expect(raised.y + raised.height).toBeGreaterThan(lane.y + lane.height);
  expect(raised.x).toBeLessThan(gutter.x);
  for (const name of ['Mark done now', 'Stop for now']) await expectTapTarget(card(page).getByRole('button', { name }));
  await expectTapTarget(card(page).getByRole('button', { name: /^Pause, / }));
  // The day opens an hour before it, with the morning folded into one row.
  await expect(page.getByRole('button', { name: /^Earlier, 7am to 12pm/, expanded: false })).toBeVisible();
});

test('a tap selects a block, which grows as the one before settles back; a second tap opens it, and empty time hands the selection back', async ({ page }) => {
  await open(page, '14:10', day);
  // Slowed from 200ms, so the middle of the change holds still long enough to check.
  await page.addStyleTag({ content: ':root { --dur-medium: 3000ms !important; }' });
  const passport = page.getByRole('slider', { name: /^Renew passport, 3:30pm to 4pm/ });
  await passport.click();
  // Mid-way, both cards are on the screen: one growing, one settling.
  await expect(page.locator('.cev.raised.settling')).toHaveCount(1);
  await expect(card(page)).toHaveCount(1);
  await settled(page);
  await expect(page.locator('.cev.raised.settling')).toHaveCount(0);
  await expect(card(page)).toContainText('3:30pm to 4pm, One off');
  await expect(passport).toHaveAccessibleName(/Selected\.$/);
  await expectTapTarget(card(page).getByRole('button', { name: 'Move' }));
  await card(page).getByRole('button', { name: 'Move' }).click();
  await expect(page.getByRole('menu', { name: 'Move Renew passport' })).toBeVisible();
  await page.keyboard.press('Escape');
  // The card covers the block, so a tap on it is the second tap.
  await card(page).locator('.rctitle').click();
  await expect(page.getByRole('dialog', { name: 'Renew passport' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Renew passport' }).getByRole('button', { name: 'Cancel' }).click();
  await page.locator('.day').click({ position: { x: 150, y: 10 } });
  await settled(page);
  await expect(card(page)).toContainText('Write chapter two');
});

test('with reduced motion the selection changes at once', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, '14:10', day);
  await page.getByRole('slider', { name: /^Renew passport/ }).click();
  expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length)).toBe(0);
  await expect(page.locator('.cev.raised.settling')).toHaveCount(0);
  await expect(card(page)).toContainText('Renew passport');
});

test('a block that just ended asks on itself, with no sheet opening by itself, and Done answers it', async ({ page }) => {
  await open(page, '15:04', day);
  await expect(card(page)).toContainText('Ended at 3pm');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  for (const name of ['Done', 'Partly', 'Not done']) await expectTapTarget(card(page).getByRole('button', { name, exact: true }));
  await card(page).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Write chapter two, 1:30pm to 3pm, Project\. Done\./ })).toBeVisible();
});

test('in the morning the next block is selected when it starts within the hour, so Start early shows', async ({ page }) => {
  await open(page, '15:10', [...day.filter((r) => r.id !== 'b1')]);
  await expect(card(page)).toContainText('Next in 20 min, 3:30pm to 4pm');
  await card(page).getByRole('button', { name: 'Start early' }).click();
  // Started, it's the block in progress, drawn within its own times until a tap shows its actions.
  await expect(card(page)).toContainText('Renew passport');
  await expect(card(page)).toHaveClass(/inlane/);
  await card(page).click();
  await expect(card(page).getByRole('button', { name: 'Mark done now' })).toBeVisible();
});

test('the hours before the day opens fold into a row that says what it holds, and open on a tap', async ({ page }) => {
  await open(page, '14:10', [...day, task('t0', 'Write chapter one'), block('b0', 't0', '09:00', '10:30')]);
  const earlier = page.getByRole('button', { name: 'Earlier, 7am to 12pm, 1 block, 1 to answer' });
  await expectTapTarget(earlier);
  await expect(page.getByRole('slider', { name: /^Write chapter one/ })).toHaveCount(0);
  await earlier.click();
  await expect(earlier).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: /^Write chapter one, 9am to 10:30am/ })).toBeVisible();
  // Tapping Today again goes back to where the day opens, folded.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Today' }).click();
  await expect(earlier).toHaveAttribute('aria-expanded', 'false');
});

test("what's waiting for a time is one row and one sheet; a card held there lifts out, and the sheet steps aside for the day", async ({ page }) => {
  await open(page, '14:10', [
    ...day,
    task('t4', 'Read the Q4 report', { estimate_min: 60 }),
    { type: 'week_pick', id: 'pick:2026-11-02:t4', fields: { week_start: '2026-11-02', task_id: 't4', minutes: 60 } },
  ]);
  await page.getByRole('button', { name: '1 to schedule' }).click();
  const sheet = page.getByRole('dialog', { name: 'To schedule' });
  const report = sheet.getByRole('button', { name: /^Read the Q4 report, Project/ });
  await expect(report).toBeVisible();
  // Held and dragged over the day at 7pm, where nothing is.
  const hour = page.locator('.dayhr', { hasText: /^7pm$/ });
  await hour.scrollIntoViewIfNeeded();
  const seven = await hour.boundingBox();
  await touchDrag(page, report, { x: 200, y: seven!.y + seven!.height / 2 + 4 });
  await expect(page.getByRole('slider', { name: /^Read the Q4 report, 7pm to 8pm/ })).toBeVisible();
  await expect(sheet).toHaveCount(0);
});

test("what's due is a chip above the day, opening its tick, Find a time and Change date", async ({ page }) => {
  await open(page, '14:10', [...day, { type: 'task', id: 'o1', fields: { kind: 'one_off', title: 'Pay electricity bill', estimate_min: 15, schedule: { type: 'once', from: '2026-11-02' } } }]);
  const chip = page.getByRole('group', { name: 'Due today' }).getByRole('button', { name: 'Pay electricity bill, one off due today' });
  await expectTapTarget(chip);
  await chip.click();
  const sheet = page.getByRole('dialog', { name: 'Pay electricity bill' });
  await expect(sheet.getByRole('button', { name: 'Find a time for Pay electricity bill' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: /^Change date/ })).toBeVisible();
});

test("an unplanned week's prompt is the strip's footer over today's calendar; its sheet's Skip is the saved skip", async ({ page }) => {
  await open(page, '09:40', [settings, project, task('t1', 'Write chapter two')]);
  await expect(page.getByText('Not planned yet')).toBeVisible();
  await page.getByRole('button', { name: 'Plan this week' }).click();
  const sheet = page.getByRole('dialog', { name: 'Plan this week' });
  await expect(sheet.getByText("This week isn't planned yet")).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Start planning' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Skip planning this week' }).click();
  await expect(page.getByText('Skipped planning this week.')).toBeVisible();
  await expect(sheet).toHaveCount(0);
  // Nothing on the day: the free time you're in offers Start something.
  await page.getByRole('button', { name: 'Start something' }).click();
  await expect(page.getByRole('dialog', { name: 'Start something' }).getByRole('button', { name: 'Start Write chapter two' })).toBeVisible();
});

test("the header's menu zooms the day and shows it as a list", async ({ page }) => {
  await open(page, '14:10', day);
  const passport = page.getByRole('slider', { name: /^Renew passport/ });
  const before = (await passport.boundingBox())!.height;
  await page.getByRole('button', { name: 'View and week' }).click();
  await page.getByRole('menuitem', { name: 'Zoom in' }).click();
  await expect.poll(async () => (await passport.boundingBox())!.height).toBeGreaterThan(before);
  await page.getByRole('button', { name: 'View and week' }).click();
  await page.getByRole('menuitem', { name: 'Show as a list' }).click();
  await expect(page.getByRole('button', { name: /^Renew passport, 3:30pm to 4pm/ })).toHaveClass(/tlbtn/);
});

test('a block held and dragged to the bottom of the screen scrolls the day on, and keeps to the finger', async ({ page }) => {
  await open(page, '14:10', day);
  const bugs = page.getByRole('slider', { name: /^Fix onboarding bugs, 4:30pm to 6pm/ });
  // Low on the screen, so a short way down reaches the edge, and the day's end is still far off.
  await bugs.evaluate((el) => el.scrollIntoView({ block: 'end' }));
  const box = (await bugs.boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + 10 };
  // Near the bottom, above the tab bar, where a held block scrolls the day.
  const to = { x: from.x, y: page.viewportSize()!.height - 110 };
  const pane = page.locator('.pane[aria-label="Today"]');
  const top = await pane.evaluate((el) => el.scrollTop);
  const fire = (type: string, at: { x: number; y: number }, onBlock = false) =>
    (onBlock ? bugs : page.locator('body')).evaluate(
      (el, { type, x, y, onBlock }) => {
        const init = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y };
        (onBlock ? el : window).dispatchEvent(new PointerEvent(type, init));
      },
      { type, x: at.x, y: at.y, onBlock },
    );
  await fire('pointerdown', from, true);
  await expect(bugs).toHaveClass(/\blifted\b/);
  await fire('pointermove', { x: from.x, y: from.y + 20 });
  await fire('pointermove', to);
  // Held there, the day scrolls on by itself, at least an hour.
  await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(top + 72);
  await fire('pointerup', to);
  const said = page.getByText(/^Fix onboarding bugs is now /);
  await expect(said).toBeVisible();
  const [, h, m, half] = /is now (\d+):?(\d\d)?(am|pm)/.exec((await said.textContent())!)!;
  const start = ((Number(h) % 12) + (half === 'pm' ? 12 : 0)) * 60 + Number(m ?? 0);
  // Later than the finger's drop alone would put it, by the hour and more the day scrolled under it.
  expect(start).toBeGreaterThan(16 * 60 + 30 + (to.y - from.y) / 1.2 + 45);
});
