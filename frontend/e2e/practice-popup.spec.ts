import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { expectNoSideways, expectTapTarget, openSeeded } from './seed';
import type { Seed } from './seed';

// A practice's session and a planning block open one popup everywhere, in the task popup's frame: from Today's
// calendar and list, Week's grid and phone day, the Now card, Done, To schedule, the prompts and Goals. Its block's section
// comes first, then the practice's goal, schedule and notes, then End practice, Cancel and Save.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm
const at = (day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, day, h! + 6, m ?? 0)).toISOString().replace('.000Z', 'Z');
};
const session = (id: string, day: number, from: string, to: string, extra: Record<string, unknown> = {}): Seed => ({
  type: 'time_block',
  id,
  fields: { practice_id: 'pr', start: at(day, from), end: at(day, to), tz: 'America/Chicago', ...extra },
});

const records: Seed[] = [
  { type: 'week_plan', id: 'week:2026-11-02', fields: { week_start: '2026-11-02', finished_at: at(2, '08:00') } },
  { type: 'objective', id: 'g', fields: { title: 'Play music', state: 'active' } },
  { type: 'objective', id: 'g2', fields: { title: 'Keep fit', state: 'active' } },
  { type: 'practice', id: 'pr', fields: { title: 'Piano practice', objective_id: 'g', target_min: 30, per: 'day', state: 'active', preferred_times: [960] } },
  { type: 'practice', id: 'st', fields: { title: 'Stretch', target_min: 15, per: 'day', state: 'active' } },
  { type: 'memo', id: 'n1', fields: { title: 'Hanon exercise 1 first', saved_on: '2026-11-02', home: { type: 'practice', id: 'pr' } } },
  // This morning's, logged; the one under way, started; and one later today.
  session('bd', 2, '09:00', '09:30'),
  { type: 'block_outcome', id: 'outcome:bd', fields: { result: 'done', logged_min: 30, answered_at: at(2, '09:30') } },
  session('bn', 2, '13:45', '14:30', { started_at: at(2, '13:45') }),
  session('bl', 2, '16:00', '16:30'),
  session('bw', 4, '07:00', '07:30'),
  { type: 'task', id: 'planning:week:2026-11-09', fields: { kind: 'planning', title: 'Plan the week of Nov 9', plans: ['week:2026-11-09'] } },
  { type: 'time_block', id: 'bp', fields: { task_id: 'planning:week:2026-11-09', start: at(2, '19:00'), end: at(2, '19:30'), tz: 'America/Chicago' } },
];

async function open(page: Page, list = records) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, list);
  return errors;
}

/** Once the popup has finished sliding in, light then dark. */
async function shoot(page: Page, target: Locator, path: (theme: string) => string) {
  await target.evaluate((e) => Promise.all(e.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))));
  await page.screenshot({ path: path('light') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path('dark') });
  await page.emulateMedia({ colorScheme: 'light' });
}

/** The popup's frame, as from every opener: the block's section or the practice's actions, its fields, then its bar. */
async function expectFrame(popup: Locator, first: 'Time block' | 'Actions', phone: boolean) {
  await expect(popup).toHaveClass(/\btaskpop\b/);
  await expect(popup.getByRole('region', { name: first })).toBeVisible();
  await expect(popup.getByLabel('Goal')).toBeVisible();
  await expect(popup.getByRole('group', { name: 'How often' })).toBeVisible();
  await expect(popup.locator('.taskpopbar').getByRole('button')).toHaveText(['End practice', 'Cancel', 'Save']);
  if (phone) {
    for (const button of await popup.getByRole('region', { name: first }).getByRole('button').all()) await expectTapTarget(button);
    for (const name of ['End practice', 'Cancel', 'Save']) await expectTapTarget(popup.locator('.taskpopbar').getByRole('button', { name }));
  }
}

test("Today: a session opens its popup from the calendar, the list and the Now card, and Save changes its goal with Undo", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const shot = (name: string) => (theme: string) => info.outputPath(`practice-popup-${name}-${info.project.name}-${theme}.png`);
  const errors = await open(page);
  const timeline = page.getByRole('region', { name: "Today's timeline" });
  const popup = page.getByRole('dialog', { name: 'Piano practice' });

  await timeline.getByRole(phone ? 'slider' : 'button', { name: /^Piano practice, 4pm to 4:30pm/ }).click();
  await expectFrame(popup, 'Time block', phone);
  await expect(popup.getByRole('region', { name: 'Time block' }).getByRole('button')).toHaveText(['Start now', 'Mark done', 'Move…', 'Take off calendar', 'Change its set times']);
  await expect(popup.getByRole('heading', { name: 'Piano practice' })).toBeFocused();
  await shoot(page, popup, shot('today-calendar'));
  await popup.getByLabel('Goal').selectOption({ label: 'Keep fit' });
  await popup.getByRole('button', { name: 'Save' }).click();
  await expect(popup).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('Saved Piano practice.');
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await timeline.getByRole(phone ? 'slider' : 'button', { name: /^Piano practice, 4pm to 4:30pm/ }).click();
  await expect(popup.getByLabel('Goal')).toHaveValue('g');
  await popup.getByRole('button', { name: 'Cancel' }).click();

  // The Now card's name opens it with the session under way.
  await page.getByRole('region', { name: 'Current block' }).getByRole('button', { name: 'Piano practice' }).click();
  await expectFrame(popup, 'Time block', phone);
  await expect(popup.getByRole('region', { name: 'Time block' }).getByRole('button')).toHaveText(['Mark done', 'Pause']);
  await shoot(page, popup, shot('now-card'));
  await popup.getByRole('button', { name: 'Cancel' }).click();

  // The list opens the same popup, not details in place.
  await timeline.getByRole('button', { name: 'List' }).click();
  await timeline.getByRole('button', phone ? { name: 'Piano practice, 4pm to 4:30pm, Practice.' } : { name: /^4pm to 4:30pm\s*Piano practice/ }).click();
  await expectFrame(popup, 'Time block', phone);
  await shoot(page, popup, shot('today-list'));
  await popup.getByRole('button', { name: 'Cancel' }).click();
  await timeline.getByRole('button', { name: 'Calendar' }).click();

  // A planning block has the same frame, with its own Start planning and no fields.
  await timeline.getByRole(phone ? 'slider' : 'button', { name: /^Plan the week of Nov 9, 7pm to 7:30pm/ }).click();
  const planning = page.getByRole('dialog', { name: 'Plan the week of Nov 9' });
  await expect(planning.getByRole('region', { name: 'Time block' }).getByRole('button')).toHaveText(['Start planning', 'Move…', 'Remove from calendar']);
  await expect(planning.locator('.taskpopbar').getByRole('button')).toHaveText(['Close']);
  if (phone) await expectTapTarget(planning.locator('.taskpopbar').getByRole('button', { name: 'Close' }));
  await shoot(page, planning, shot('planning'));
  await planning.locator('.taskpopbar').getByRole('button', { name: 'Close' }).click();
  await expect(planning).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("To schedule and Done: a practice's name opens the same popup, with Pause practice where there's no block", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const shot = (name: string) => (theme: string) => info.outputPath(`practice-popup-${name}-${info.project.name}-${theme}.png`);
  const errors = await open(page);
  await page.getByRole('region', { name: 'To schedule' }).getByRole('button', { name: /^Stretch, Practice/ }).click();
  const card = phone ? page.getByRole('dialog', { name: 'Stretch' }) : page.getByRole('group', { name: 'Stretch' });
  await card.getByRole('button', { name: 'Stretch', exact: true }).click();
  const stretch = page.getByRole('dialog', { name: 'Stretch' }).and(page.locator('.taskpop'));
  await expectFrame(stretch, 'Actions', phone);
  await shoot(page, stretch, shot('to-schedule'));
  await stretch.getByRole('button', { name: 'Pause practice' }).click();
  await expect(page.locator('.toast')).toContainText('Paused Stretch.');
  await expect(stretch.getByRole('button', { name: 'Resume practice' })).toBeVisible();
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(stretch.getByRole('button', { name: 'Pause practice' })).toBeVisible();
  await stretch.getByRole('button', { name: 'Cancel' }).click();
  await expect(stretch).toHaveCount(0);
  await card.getByRole('button', { name: 'Close', exact: true }).click();

  const nav = page.getByRole('navigation', { name: 'Main' });
  if (phone) {
    await nav.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: /^Done/ }).click();
  } else {
    await nav.getByRole('button', { name: 'Done' }).click();
  }
  await page.getByRole('region', { name: 'Time worked' }).getByRole('button', { name: 'Piano practice' }).click();
  const popup = page.getByRole('dialog', { name: 'Piano practice' });
  await expectFrame(popup, 'Time block', phone);
  await expect(popup.getByRole('region', { name: 'Time block' }).getByText('Done', { exact: true })).toBeVisible();
  await shoot(page, popup, shot('done'));
  expect(errors).toEqual([]);
});

test("Goals: a practice's row opens the same popup, with Pause practice and no block", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const shot = (name: string) => (theme: string) => info.outputPath(`practice-popup-${name}-${info.project.name}-${theme}.png`);
  const errors = await open(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Goals' }).click();
  await page.getByRole('button', { name: /^Play music/ }).click();
  const row = page.getByRole('button', { name: /^Piano practice/ });
  await expect(row).toHaveAttribute('aria-haspopup', 'dialog');
  await row.click();
  const popup = page.getByRole('dialog', { name: 'Piano practice' });
  await expectFrame(popup, 'Actions', phone);
  await expect(popup.getByRole('region', { name: 'Actions' }).getByRole('button')).toHaveText(['Pause practice']);
  await shoot(page, popup, shot('goals'));
  await popup.getByRole('button', { name: 'Cancel' }).click();
  await expect(popup).toHaveCount(0);
  await expect(row).toBeFocused();
  expect(errors).toEqual([]);
});

test("Week: a session opens the same popup from the grid, while editing too, and from the phone's day with its length", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const shot = (name: string) => (theme: string) => info.outputPath(`practice-popup-${name}-${info.project.name}-${theme}.png`);
  const errors = await open(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Week' }).click();
  const popup = page.getByRole('dialog', { name: 'Piano practice' });
  if (phone) {
    await page.getByRole('group', { name: 'Choose a day' }).getByRole('button').nth(2).click();
    await page.getByRole('button', { name: /^Piano practice, 7am to 7:30am/ }).click();
    await expectFrame(popup, 'Time block', phone);
    await expectTapTarget(popup.getByRole('region', { name: 'Time block' }).getByRole('slider', { name: 'Length' }));
    await shoot(page, popup, shot('week'));
  } else {
    await page.getByRole('button', { name: /^Piano practice, Wed Nov 4, 7am to 7:30am/ }).click();
    await expectFrame(popup, 'Time block', phone);
    await shoot(page, popup, shot('week'));
    await popup.getByRole('button', { name: 'Cancel' }).click();
    // While editing, where a click on a practice did nothing before.
    await page.getByRole('button', { name: "Edit this week's plan" }).click();
    await page.getByRole('group', { name: /^Piano practice, Wed Nov 4/ }).click();
    await expectFrame(popup, 'Time block', phone);
    await shoot(page, popup, shot('week-editing'));
  }
  expect(errors).toEqual([]);
});

test("the prompt that logs a session: its name opens the popup, whose section answers in a practice's words", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const shot = (name: string) => (theme: string) => info.outputPath(`practice-popup-${name}-${info.project.name}-${theme}.png`);
  const errors = await open(page, [...records.filter((r) => r.id !== 'bn' && r.id !== 'bd' && r.id !== 'outcome:bd'), session('bg', 2, '13:00', '13:30')]);
  const prompt = page.getByRole('dialog', { name: 'Block finished' });
  await prompt.getByRole('button', { name: 'Piano practice' }).click();
  const popup = page.getByRole('dialog', { name: 'Piano practice' });
  await expectFrame(popup, 'Time block', phone);
  const asks = popup.getByRole('group', { name: 'How did it go?' });
  await expect(asks.getByRole('button')).toHaveText(['Did it', 'Some', 'Skipped']);
  await shoot(page, popup, shot('prompt'));
  await asks.getByRole('button', { name: 'Did it' }).click();
  await expect(page.locator('.toast')).toContainText('Piano practice: did it.');
  await expect(popup.getByRole('group', { name: 'How did it go?' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("phone: a session's popup and a planning block's never scroll sideways", async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'The sheet is a phone matter');
  const errors = await open(page);
  const timeline = page.getByRole('region', { name: "Today's timeline" });
  await timeline.getByRole('slider', { name: /^Piano practice, 4pm to 4:30pm/ }).click();
  let popup = page.getByRole('dialog', { name: 'Piano practice' });
  await expectNoSideways(popup);
  await popup.getByRole('button', { name: 'Cancel' }).click();
  await expect(popup).toHaveCount(0);
  await timeline.getByRole('slider', { name: /^Plan the week of Nov 9, 7pm to 7:30pm/ }).click();
  popup = page.getByRole('dialog', { name: 'Plan the week of Nov 9' });
  await expectNoSideways(popup);
  expect(errors).toEqual([]);
});
