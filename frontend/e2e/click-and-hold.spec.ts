// A click or tap on a block opens it, and only a hold lifts it to drag, on Today and Week, with a mouse and a finger. A
// hand that shifts a few pixels while clicking still clicks, whether or not the block can move.

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { expectTapTarget, holdMouse, openSeeded, settled, touchDrag } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm in Chicago.
const at = (day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  // Chicago is six hours behind UTC in November.
  return new Date(Date.UTC(2026, 10, day, h! + 6, m ?? 0)).toISOString().replace('.000Z', 'Z');
};

const records: Seed[] = [
  { type: 'week_plan', id: 'week:2026-11-02', fields: { week_start: '2026-11-02', finished_at: at(2, '08:00') } },
  { type: 'project', id: 'p', fields: { title: 'Annual report', state: 'active', start: '2026-10-01', end: '2026-12-31' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p', title: 'Write the report', estimate_min: 180 } },
  { type: 'task', id: 't2', fields: { kind: 'one_off', title: 'Paint the fence', estimate_min: 60 } },
  { type: 'task', id: 't3', fields: { kind: 'project', project_id: 'p', title: 'Check the figures', estimate_min: 90 } },
  // Still to come, so it moves.
  { type: 'time_block', id: 'b1', fields: { task_id: 't1', start: at(2, '16:00'), end: at(2, '17:00'), tz: 'America/Chicago' } },
  // This morning's, done, and the one under way: neither moves.
  { type: 'time_block', id: 'b2', fields: { task_id: 't2', start: at(2, '09:00'), end: at(2, '10:00'), tz: 'America/Chicago' } },
  { type: 'block_outcome', id: 'outcome:b2', fields: { result: 'done', answered_at: at(2, '10:00') } },
  { type: 'time_block', id: 'b3', fields: { task_id: 't3', start: at(2, '13:30'), end: at(2, '14:30'), tz: 'America/Chicago', started_at: at(2, '13:30') } },
];

async function open(page: Page, extra: Seed[] = []) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, [...records, ...extra]);
  // Every screen's styles, which load after the first and can move what's measured, are in before anything is pressed.
  await settled(page);
  return errors;
}

/** A finger held on a block, then let go without moving. */
async function holdInPlace(page: Page, block: Locator) {
  await block.scrollIntoViewIfNeeded();
  const box = (await block.boundingBox())!;
  await touchDrag(page, block, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
}

/** A click whose mouse shifts 5px, then 8px, before it's let go, as a hand does pressing a trackpad. */
async function wobblyClick(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const [x, y] = [box.x + box.width / 3, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 3, y + 4);
  await page.mouse.move(x + 5, y + 6);
  await page.mouse.up();
}

/** Opens a task's block, checks its popup came up, and closes it. */
async function opens(page: Page, title: string, press: () => Promise<void>) {
  await press();
  const popup = page.getByRole('dialog', { name: title });
  await expect(popup.getByRole('region', { name: 'Time block' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
}

test('Today: a click that wobbles opens any block, one that moves included, and only a hold drags it', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page);
  await expect(page.getByRole('region', { name: 'To schedule' }).getByText('Everything this week is on the calendar.')).toBeVisible();
  const day = page.getByRole('region', { name: "Today's timeline" });
  // On phone a block that moves is a slider, as on Week.
  const report = day.getByRole(phone ? 'slider' : 'button', { name: /^Write the report, 4pm to 5pm/ });
  const blocks: [string, Locator][] = [
    ['Write the report', report],
    ['Paint the fence', day.getByRole('button', { name: /^Paint the fence, 9am to 10am/ })],
    ['Check the figures', day.getByRole('button', { name: /^Check the figures, 1:30pm to 2:30pm/ })],
  ];
  for (const [title, block] of blocks) await opens(page, title, () => (phone ? block.tap() : wobblyClick(page, block)));
  // None of those clicks moved anything.
  await expect(page.getByText(/ is now /)).toHaveCount(0);

  // Held, then dragged 15px, which is half an hour at the first zoom.
  await report.scrollIntoViewIfNeeded();
  const box = (await report.boundingBox())!;
  const from = { x: box.x + box.width / 3, y: box.y + box.height / 2 };
  if (phone) await touchDrag(page, report, { x: from.x, y: from.y + 15 });
  else {
    await holdMouse(page, from);
    await page.mouse.move(from.x, from.y + 8, { steps: 2 });
    await page.mouse.move(from.x, from.y + 15, { steps: 2 });
    await page.mouse.up();
  }
  await expect(page.getByText('Write the report is now 4:30pm to 5:30pm.')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Week, desktop: while editing, a click that wobbles opens a block or a card, and only a hold drags them', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'The grid is the desktop layout');
  const errors = await open(page, [
    { type: 'task', id: 't4', fields: { kind: 'project', project_id: 'p', title: 'Book the printer', estimate_min: 60 } },
    { type: 'week_pick', id: 'pick:2026-11-02:t4', fields: { week_start: '2026-11-02', task_id: 't4', minutes: 60 } },
  ]);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Week' }).click();
  // Not editing, a block is a button.
  await opens(page, 'Write the report', () => wobblyClick(page, page.getByRole('button', { name: /^Write the report, Mon Nov 2, 4pm to 5pm/ })));

  await page.getByRole('button', { name: "Edit this week's plan" }).click();
  const report = page.getByRole('group', { name: /^Write the report, Mon Nov 2, 4pm to 5pm/ });
  await opens(page, 'Write the report', () => wobblyClick(page, report));
  await expect(page.getByRole('group', { name: /^Write the report, Mon Nov 2, 4pm to 5pm/ })).toBeVisible();

  // Held, then dragged an hour down: editing draws 40px an hour.
  const box = (await report.boundingBox())!;
  const from = { x: box.x + box.width / 3, y: box.y + box.height / 2 };
  await holdMouse(page, from);
  await page.mouse.move(from.x, from.y + 20, { steps: 2 });
  await page.mouse.move(from.x, from.y + 40, { steps: 2 });
  await page.mouse.up();
  await expect(page.getByRole('group', { name: /^Write the report, Mon Nov 2, 5pm to 6pm/ })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // A card waiting in To schedule opens its suggested times the same way.
  const card = page.getByRole('region', { name: 'To schedule' }).getByRole('button', { name: /^Book the printer, / });
  await wobblyClick(page, card);
  await expect(page.getByRole('group', { name: 'Book the printer' }).getByRole('group', { name: 'Suggested times' })).toBeVisible();
  expect(errors).toEqual([]);
});

test("Week, phone: while editing, a tap opens a block, a swipe across it doesn't move it, and a hold drags it", async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'The draggable day is the phone layout');
  const errors = await open(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Week' }).click();
  await page.getByRole('button', { name: "Edit this week's plan" }).click();
  const report = page.getByRole('slider', { name: /^Write the report\./ });
  await expect(report).toHaveAttribute('aria-valuetext', 'Mon Nov 2, 4pm to 5pm');
  await opens(page, 'Write the report', () => report.tap());

  // The day draws 48px an hour. A finger that moves before the hold is scrolling, so the block stays.
  await report.scrollIntoViewIfNeeded();
  const box = (await report.boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await touchDrag(page, report, { x: from.x, y: from.y + 48 }, 50);
  await expect(report).toHaveAttribute('aria-valuetext', 'Mon Nov 2, 4pm to 5pm');
  await touchDrag(page, report, { x: from.x, y: from.y + 48 });
  await expect(page.getByRole('slider', { name: /^Write the report\./ })).toHaveAttribute('aria-valuetext', 'Mon Nov 2, 5pm to 6pm');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Today: a block's quick menu opens on a right-click or Shift-F10 on desktop, and on phone a hold let go in place", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}-${info.project.name}.png`) });
  const errors = await open(page);
  await expect(page.getByRole('region', { name: 'To schedule' }).getByText('Everything this week is on the calendar.')).toBeVisible();
  const day = page.getByRole('region', { name: "Today's timeline" });
  const report = day.getByRole(phone ? 'slider' : 'button', { name: /^Write the report, 4pm to 5pm/ });
  const figures = day.getByRole('button', { name: /^Check the figures, 1:30pm to 2:30pm/ });
  const menu = (name: string) => page.getByRole('menu', { name });

  if (phone) {
    await holdInPlace(page, report);
    await expect(menu('Write the report').getByRole('menuitem')).toHaveText(['Done', 'Start now', 'Move to', 'Open', 'Remove from calendar', 'Delete task…']);
    // Nothing moved, and the popup stayed shut.
    await expect(page.getByText(/ is now /)).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    for (const item of await menu('Write the report').getByRole('menuitem').all()) await expectTapTarget(item);
    await shot('today-menu');
    await menu('Write the report').getByRole('menuitem', { name: 'Move to' }).tap();
    await expect(menu('Move to').getByRole('menuitem')).toHaveText(['Back', 'Next free time, 5pm', 'Tomorrow, 4pm', 'Back to To schedule', 'Choose a time…']);
    await shot('today-menu-move');
    await menu('Move to').getByRole('menuitem', { name: 'Back', exact: true }).tap();
    await menu('Write the report').getByRole('menuitem', { name: 'Done' }).tap();
  } else {
    await report.scrollIntoViewIfNeeded();
    await report.click({ button: 'right' });
    await expect(menu('Write the report').getByRole('menuitem')).toHaveText(['Done', 'Start now', 'Move to', 'Open', 'Remove from calendar', 'Delete task…']);
    await expect(menu('Write the report').getByRole('menuitem', { name: 'Done' })).toBeFocused();
    await shot('today-menu');
    await menu('Write the report').getByRole('menuitem', { name: 'Move to' }).hover();
    await expect(menu('Move to').getByRole('menuitem')).toHaveText(['Next free time, 5pm', 'Tomorrow, 4pm', 'Back to To schedule', 'Choose a time…']);
    await shot('today-menu-move');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot('today-menu-move-dark');
    await page.emulateMedia({ colorScheme: 'light' });
    // Esc closes the submenu, then the menu, and focus is back on the block.
    await page.keyboard.press('Escape');
    await expect(menu('Move to')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(report).toBeFocused();
    // From the keys: the menu opens on the focused block, and Enter chooses Done, the first item.
    await page.keyboard.press('Shift+F10');
    await expect(menu('Write the report').getByRole('menuitem', { name: 'Done' })).toBeFocused();
    await page.keyboard.press('Enter');
  }
  await expect(page.getByText('Marked Write the report done. Its 4pm block came off the calendar, so that time is free.')).toBeVisible();
  await expect(report).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(report).toBeVisible();

  // The block under way, which doesn't move, has one too: Pause pauses it, as on the Now card.
  if (phone) await holdInPlace(page, figures);
  else await figures.click({ button: 'right' });
  await expect(menu('Check the figures').getByRole('menuitem')).toHaveText(['Done', 'Pause', 'Open', 'Delete task…']);
  await (phone ? menu('Check the figures').getByRole('menuitem', { name: 'Pause' }).tap() : menu('Check the figures').getByRole('menuitem', { name: 'Pause' }).click());
  await expect(page.getByText('Paused Check the figures')).toBeVisible();
  await expect(page.getByRole('menu')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Today: Move… in a block's popup offers its quick menu's new times, and the next free time moves it with Undo", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}-${info.project.name}.png`) });
  const dark = async (name: string) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(`${name}-dark`);
    await page.emulateMedia({ colorScheme: 'light' });
  };
  const errors = await open(page);
  const day = page.getByRole('region', { name: "Today's timeline" });
  const report = day.getByRole(phone ? 'slider' : 'button', { name: /^Write the report, 4pm to 5pm/ });
  await report.scrollIntoViewIfNeeded();
  await (phone ? report.tap() : report.click());
  const section = page.getByRole('dialog', { name: 'Write the report' }).getByRole('region', { name: 'Time block' });
  const buttons = section.getByRole('button');
  await expect(buttons).toHaveText(['Start now', 'Done', 'Move…', 'Remove from calendar']);
  // Every one fits inside the section, wrapping onto a second line if it must, and on phone each is a full tap target.
  const box = (await section.boundingBox())!;
  for (const b of await buttons.all()) {
    const r = (await b.boundingBox())!;
    expect(r.x).toBeGreaterThanOrEqual(box.x);
    expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width);
    if (phone) await expectTapTarget(b);
  }
  await shot('popup-move');
  await dark('popup-move');

  const move = section.getByRole('button', { name: 'Move…' });
  await (phone ? move.tap() : move.click());
  const menu = page.getByRole('menu', { name: 'Move to' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Next free time, 5pm', 'Tomorrow, 4pm', 'Back to To schedule', 'Choose a time…']);
  await expect(menu.getByRole('menuitem', { name: 'Next free time, 5pm' })).toBeFocused();
  if (phone) for (const item of await menu.getByRole('menuitem').all()) await expectTapTarget(item);
  await shot('popup-move-menu');
  await dark('popup-move-menu');

  const next = menu.getByRole('menuitem', { name: 'Next free time, 5pm' });
  await (phone ? next.tap() : next.click());
  await expect(page.getByText('Moved Write the report to 5pm.')).toBeVisible();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(section.getByText('Mon Nov 2, 5pm to 6pm')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(section.getByText('Mon Nov 2, 4pm to 5pm')).toBeVisible();
  expect(errors).toEqual([]);
});

test("Today: Move to, Tomorrow asks first when tomorrow has a block at that time, which Today doesn't draw", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [{ type: 'time_block', id: 'b4', fields: { task_id: 't2', start: at(3, '16:30'), end: at(3, '17:30'), tz: 'America/Chicago' } }]);
  const report = page.getByRole('region', { name: "Today's timeline" }).getByRole(phone ? 'slider' : 'button', { name: /^Write the report, 4pm to 5pm/ });
  const press = (target: Locator) => (phone ? target.tap() : target.click());
  if (phone) await holdInPlace(page, report);
  else {
    await report.scrollIntoViewIfNeeded();
    await report.click({ button: 'right' });
  }
  await press(page.getByRole('menu', { name: 'Write the report' }).getByRole('menuitem', { name: 'Move to' }));
  await press(page.getByRole('menu', { name: 'Move to' }).getByRole('menuitem', { name: 'Tomorrow, 4pm' }));
  const ask = page.getByRole('dialog', { name: 'Schedule both at the same time?' });
  await expect(ask).toContainText('Write the report overlaps Paint the fence.');
  await expect(ask.getByRole('button', { name: 'Keep both' })).toBeFocused();
  await expect(page.getByText(/^Moved /)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`today-tomorrow-ask-${info.project.name}.png`) });
  await press(ask.getByRole('button', { name: 'Replace' }));
  await expect(page.getByText('Moved Write the report to tomorrow, 4pm. Took Paint the fence off the calendar.')).toBeVisible();
  await expect(report).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(report).toBeVisible();
  expect(errors).toEqual([]);
});

test("Today: Move… in a block's popup, Tomorrow asks first when tomorrow has a block at that time, above the popup", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [{ type: 'time_block', id: 'b4', fields: { task_id: 't2', start: at(3, '16:30'), end: at(3, '17:30'), tz: 'America/Chicago' } }]);
  const report = page.getByRole('region', { name: "Today's timeline" }).getByRole(phone ? 'slider' : 'button', { name: /^Write the report, 4pm to 5pm/ });
  const press = (target: Locator) => (phone ? target.tap() : target.click());
  await report.scrollIntoViewIfNeeded();
  await press(report);
  const section = page.getByRole('dialog', { name: 'Write the report' }).getByRole('region', { name: 'Time block' });
  await press(section.getByRole('button', { name: 'Move…' }));
  await press(page.getByRole('menu', { name: 'Move to' }).getByRole('menuitem', { name: 'Tomorrow, 4pm' }));
  const ask = page.getByRole('dialog', { name: 'Schedule both at the same time?' });
  await expect(ask).toContainText('Write the report overlaps Paint the fence.');
  await expect(ask.getByRole('button', { name: 'Keep both' })).toBeFocused();
  await expect(page.getByText(/^Moved /)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`popup-tomorrow-ask-${info.project.name}.png`) });
  await press(ask.getByRole('button', { name: 'Replace' }));
  await expect(page.getByText('Moved Write the report to tomorrow, 4pm. Took Paint the fence off the calendar.')).toBeVisible();
  await expect(report).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(report).toBeVisible();
  expect(errors).toEqual([]);
});
