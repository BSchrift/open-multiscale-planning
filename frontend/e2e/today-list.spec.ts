// The phone's day as a list (option C): Today's List view, chosen from the title's menu, and the day by itself at the
// accessibility text sizes, where a row grows with its words and a calendar's fixed hours can't. Desktop's list is
// unchanged, so these run on phone.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded } from './seed';
import type { Seed } from './seed';
import { phoneView } from './today';

test.use({ timezoneId: 'America/Chicago' });
test.beforeEach(({}, info) => test.skip(info.project.name !== 'phone', "Today's phone layout"));

// Monday, Nov 2, 2026 in Chicago, six hours behind UTC.
const at = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, 2, h! + 6, m ?? 0)).toISOString().replace('.000Z', 'Z');
};
const planned: Seed = { type: 'week_plan', id: 'week:2026-11-02', fields: { week_start: '2026-11-02', finished_at: at('08:00') } };
const project: Seed = { type: 'project', id: 'p', fields: { title: 'The book', state: 'active', start: '2026-10-01', end: '2026-12-31' } };
const task = (id: string, title: string, extra: Record<string, unknown> = {}): Seed => ({ type: 'task', id, fields: { kind: 'project', project_id: 'p', title, estimate_min: 300, ...extra } });
const block = (id: string, taskId: string, from: string, to: string, extra: Record<string, unknown> = {}): Seed => ({
  type: 'time_block',
  id,
  fields: { task_id: taskId, start: at(from), end: at(to), tz: 'America/Chicago', ...extra },
});
const day: Seed[] = [
  planned,
  project,
  task('t1', 'Write chapter two'),
  task('t2', 'Renew passport', { kind: 'one_off', project_id: null, estimate_min: 30 }),
  task('t3', 'Fix onboarding bugs in the sign-up flow before the launch on Friday'),
  block('b1', 't1', '13:30', '15:00', { started_at: at('13:30') }),
  block('b2', 't2', '15:30', '16:00'),
  block('b3', 't3', '16:30', '18:00'),
  { type: 'calendar', id: 'calendar', fields: { connected: true, events: [{ id: 'e1', calendar: 'work', title: '1:1 with Sam', start: at('16:00'), end: at('16:30') }] } },
];

async function open(page: Page, time: string, records: Seed[]) {
  await page.clock.install({ time: new Date(at(time)) });
  await openSeeded(page, records);
  await expect(page.getByRole('region', { name: "Today's timeline" })).toBeVisible();
}
const list = (page: Page) => page.locator('.tdlist');
const rows = (page: Page) => list(page).locator(':scope > .tlrow');
/** Nothing on the page is wider than the screen. */
const fitsAcross = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.tdlist *')].every((el) => el.getBoundingClientRect().right <= innerWidth + 0.5));

test('the List view is the day by time, with free time to fill; a tap grows a block and a second opens it', async ({ page }) => {
  await open(page, '14:10', day);
  await phoneView(page, 'Show as a list');
  await expect(rows(page)).toHaveText([
    /^1:30pm\s*Write chapter two\s*50 min left$/,
    /^3pm\s*Free until 3:30pm, 30 min$/,
    /^3:30pm\s*Renew passport\s*30 min$/,
    /^4pm\s*1:1 with Sam\s*Busy, 30 min$/,
    /^4:30pm\s*Fix onboarding bugs in the sign-up flow before the launch on Friday\s*1h 30m$/,
    /^6pm\s*Free until 10pm, 4h$/,
  ]);
  // A long name wraps rather than being cut short.
  const bugs = page.getByRole('button', { name: /^Fix onboarding bugs/ });
  expect((await bugs.boundingBox())!.height).toBeGreaterThan(60);
  for (const name of [/^Renew passport, 3:30pm to 4pm/, /^Free, 3pm to 3:30pm/]) await expectTapTarget(page.getByRole('button', { name }));
  expect(await fitsAcross(page)).toBe(true);

  // Selected by Today, the block in progress stays in its row; a tap grows it into its card, across the row.
  const now = page.getByRole('button', { name: /^Write chapter two, 1:30pm to 3pm/ });
  await now.click();
  const card = list(page).locator('.cev.raised');
  await expect(card).not.toHaveClass(/inlane/);
  for (const name of ['Mark done now', 'Stop for now']) await expectTapTarget(card.getByRole('button', { name }));
  // Another tap selects another, with Move and Details, and a second opens its popup.
  const passport = page.getByRole('button', { name: /^Renew passport, 3:30pm to 4pm/ });
  await passport.click();
  await expect(passport).toHaveAccessibleName(/Selected\.$/);
  await expect(card.getByRole('button', { name: 'Move' })).toBeVisible();
  await card.locator('.rctitle').click();
  await expect(page.getByRole('dialog', { name: 'Renew passport' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Renew passport' }).getByRole('button', { name: 'Cancel' }).click();

  // Free time adds a task there.
  await page.getByRole('button', { name: 'Free, 3pm to 3:30pm. Add a task then' }).click();
  await expect(page.getByRole('dialog', { name: 'Capture' }).getByText('Today, 3pm to 3:30pm')).toBeVisible();
});

test('in the morning a Now row says the time free, and the next block shows Start early on itself', async ({ page }) => {
  await open(page, '15:10', day.filter((r) => r.id !== 'b1'));
  await phoneView(page, 'Show as a list');
  await expect(rows(page).first()).toHaveText(/^Now\s*3:10pm, free until 3:30pm$/);
  const early = list(page).locator('.cev.raised.inlane').getByRole('button', { name: 'Start early' });
  await early.click();
  await expect(list(page).locator('.cev.raised.inlane')).toContainText(/min left$/);
});

test('at the accessibility text sizes the day is a list by itself, each time above its row, and nothing runs off the screen', async ({ page }) => {
  await open(page, '14:10', day);
  // The first accessibility size, 28pt body text, as the iPhone app's text follows the phone's setting; read as the app
  // comes back from Settings, where it's changed.
  await page.addStyleTag({ content: "[data-layout='phone'] { --pt: calc(28px / 17) !important; }" });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(list(page)).toHaveClass(/\bbig\b/);
  const row = rows(page).filter({ hasText: 'Renew passport' });
  const time = (await row.locator('.tltime').boundingBox())!;
  const face = (await row.locator('.tlcard').boundingBox())!;
  expect(time.y + time.height).toBeLessThanOrEqual(face.y + 0.5);
  expect(await fitsAcross(page)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('today-list-large.png'), fullPage: true });
  // The calendar is still a choice from the menu.
  await phoneView(page, 'Show as a calendar');
  await expect(list(page)).toHaveCount(0);
  await expect(page.locator('.tdpager .day')).toBeVisible();
});
