// Week: on desktop its grid, and on phone the week Today draws over its day, with the strip's days and the day shown,
// placing and editing as Week did on phone before Today drew the week.

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { expectTapTarget, holdMouse, openSeeded, overNowLine, touchDrag } from './seed';
import type { Seed } from './seed';
import { nowCard, openBlock, openStrip, phoneView, todayRead, waitingSheet } from './today';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm in Chicago.
// Chicago is six hours behind UTC in November.
const at = (day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, day, h! + 6, m ?? 0)).toISOString().replace('.000Z', 'Z');
};

const records: Seed[] = [
  { type: 'week_plan', id: 'week:2026-11-02', fields: { week_start: '2026-11-02', finished_at: at(2, '08:00') } },
  { type: 'project', id: 'p', fields: { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-31' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p', title: 'Draft the summary', estimate_min: 120 } },
  { type: 'task', id: 't2', fields: { kind: 'one_off', title: 'Paint the fence', estimate_min: 60 } },
  { type: 'practice', id: 'pr', fields: { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' } },
  { type: 'time_block', id: 'b1', fields: { task_id: 't1', start: at(3, '18:00'), end: at(3, '19:00'), tz: 'America/Chicago' } },
  { type: 'time_block', id: 'b2', fields: { practice_id: 'pr', start: at(4, '07:00'), end: at(4, '07:30'), tz: 'America/Chicago' } },
  { type: 'calendar', id: 'calendar', fields: { connected: true, events: [{ id: 'e1', calendar: 'work', title: 'Quiz night', start: at(3, '18:30'), end: at(3, '19:30') }] } },
];

/** Week on desktop; on phone, Today, which draws the week, once it has read it and nothing more comes in above the day. */
async function openWeek(page: Page, list = records, now = NOW) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: now });
  await openSeeded(page, list);
  if (await page.locator('[data-layout="phone"]').count()) {
    await todayRead(page, true);
    // Today makes the first stretch's planning task by itself, and its row then comes in above the day, moving the day
    // down the page.
    await expect(page.getByRole('region', { name: 'Plan your first stretch' })).toBeVisible();
  } else await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Week' }).click();
  return errors;
}

/** The week shown, by its title: Week's heading on desktop, and on phone the strip on Today, which names itself so. */
const weekTitled = (page: Page, phone: boolean, title: string) =>
  phone ? page.getByRole('region', { name: new RegExp(`^${title}, `) }) : page.getByRole('heading', { name: title });
/** The phone's strip of days, and the title over the day, which names the day shown: Today, Tomorrow or its weekday. */
const strip = (page: Page) => page.getByRole('group', { name: 'Choose a day' });
const dayShown = (page: Page) => page.getByRole('heading', { level: 1 });

test('week arrows reach any week and This week comes back', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await openWeek(page);
  await expect(weekTitled(page, phone, 'This week')).toBeVisible();
  const previous = page.getByRole('button', { name: 'Previous week' });
  if (phone) await expectTapTarget(previous);
  for (let i = 0; i < 3; i++) await previous.click();
  await expect(weekTitled(page, phone, 'Past week')).toBeVisible();
  await expect(page.getByText('Oct 12 to Oct 18')).toBeVisible();
  await expect(page.getByText('Past weeks can be viewed but not changed.')).toBeVisible();
  // On phone, the Today button beside the day's title.
  await (phone ? page.locator('.tdhead').getByRole('button', { name: 'Today' }) : page.getByRole('button', { name: 'This week', exact: true })).click();
  await expect(weekTitled(page, phone, 'This week')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the current time is a line on today only, which moves with the time and lets drops through', async ({ page }, info) => {
  const errors = await openWeek(page);
  const line = page.getByRole('img', { name: 'Current time' });
  await expect(line).toHaveCount(1);
  await expect(line).toHaveCSS('pointer-events', 'none');
  if (info.project.name === 'desktop') {
    // Within Monday's column, and no wider.
    const [drawn, monday] = [(await line.boundingBox())!, (await page.locator('.colbody:visible').first().boundingBox())!];
    expect(drawn.x).toBeGreaterThanOrEqual(monday.x);
    expect(drawn.x + drawn.width).toBeLessThanOrEqual(monday.x + monday.width);
  }
  // On desktop it moves down the column; on phone, to the row that holds the new time.
  const where = () => line.evaluate((e) => `${e.style.top} ${e.parentElement!.dataset.dropFrom ?? ''}`);
  const before = await where();
  await page.clock.fastForward('01:00:00');
  await expect.poll(where).not.toBe(before);
  await page.getByRole('button', { name: 'Previous week' }).click();
  await expect(page.getByText('Oct 26 to Nov 1')).toBeVisible();
  await expect(line).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the current time passes behind the block under way, with only its dot in front', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const under: Seed = { type: 'time_block', id: 'b9', fields: { task_id: 't1', start: at(2, '13:00'), end: at(2, '15:00'), tz: 'America/Chicago', started_at: at(2, '13:00') } };
  // With another block at the same time, so the two are drawn side by side.
  const beside: Seed = { type: 'time_block', id: 'b10', fields: { task_id: 't2', start: at(2, '13:30'), end: at(2, '14:30'), tz: 'America/Chicago', started_at: at(2, '13:30') } };
  const errors = await openWeek(page, [...records, under, beside]);
  const line = page.getByRole('img', { name: 'Current time' });
  await line.scrollIntoViewIfNeeded();
  await expect(line).toHaveCSS('pointer-events', 'none');
  if (phone) {
    // On Today's day the block under way is raised over its lane as a card the width of the day, which the line, and
    // its dot at the day's edge, pass behind.
    const card = (await nowCard(page, true).boundingBox())!;
    expect((await overNowLine(line, card.x + card.width / 2)).at).not.toBe('line');
  } else {
    const b = page.getByRole('button', { name: /^Draft the summary, Mon Nov 2, 1pm to 3pm/ });
    const box = (await b.boundingBox())!;
    expect(await overNowLine(line, box.x + box.width / 2)).toEqual({ at: expect.stringMatching(/^Draft the summary, Mon Nov 2, 1pm to 3pm/), dotOnTop: true });
    const other = (await page.getByRole('button', { name: /^Paint the fence, Mon Nov 2, 1:30pm to 2:30pm/ }).boundingBox())!;
    expect(other.x).toBeGreaterThanOrEqual(box.x + box.width - 1);
    expect((await overNowLine(line, other.x + other.width / 2)).at).toMatch(/^Paint the fence, Mon Nov 2, 1:30pm to 2:30pm/);
  }
  expect(errors).toEqual([]);
});

test('desktop: drag a block to another day and time, then remove it with Undo', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'The grid is the desktop layout');
  const errors = await openWeek(page);
  await expect(page.getByRole('button', { name: /^Draft the summary, Tue Nov 3, 6pm to 7pm, Project\. Conflicts with Quiz night\./ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('week-desktop.png') });

  await page.getByRole('button', { name: "Edit this week's plan" }).click();
  await expect(page.getByRole('heading', { name: 'Editing this week' })).toBeVisible();
  // A half-hour block keeps its edge to drag, no more than a quarter of it, so most of it still moves the block.
  const piano = page.getByRole('group', { name: /^Piano practice/ });
  const [pianoBox, pianoEdge] = [(await piano.boundingBox())!, (await piano.locator('.evh').boundingBox())!];
  expect(pianoEdge.height).toBeLessThanOrEqual(pianoBox.height / 4);
  const block = page.getByRole('group', { name: /^Draft the summary/ });
  const box = (await block.boundingBox())!;
  const column = (await page.locator('.colbody').first().boundingBox())!;
  // One column right and 40px down: a day later and an hour later, at 40px an hour.
  await holdMouse(page, { x: box.x + box.width / 2, y: box.y + 8 });
  await page.mouse.move(box.x + box.width / 2 + column.width / 2, box.y + 30, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 + column.width + 2, box.y + 48, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole('group', { name: /^Draft the summary, Wed Nov 4, 7pm to 8pm, Project\./ })).toBeVisible();

  // The bottom edge makes it longer.
  const moved = page.getByRole('group', { name: /^Draft the summary/ });
  const edge = (await moved.locator('.evh').boundingBox())!;
  await holdMouse(page, { x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 });
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 20, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole('group', { name: /^Draft the summary, Wed Nov 4, 7pm to 8:30pm, Project\./ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('week-desktop-edit.png') });

  await moved.hover();
  await page.getByRole('button', { name: 'Remove Draft the summary' }).click();
  await expect(page.getByText('Removed Draft the summary')).toBeVisible();
  await expect(page.getByRole('group', { name: /^Draft the summary/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('group', { name: /^Draft the summary, Wed Nov 4/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a task's block opens the task's popup, with the block's own section at its top, and Remove from calendar offers Undo", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await openWeek(page);
  if (phone) await strip(page).getByRole('button', { name: /^Tue Nov 3/ }).tap();
  // On phone a block still to come is a slider. A tap selects it, raised as a card whose Details opens it, and which
  // focus goes back to.
  const block = page.getByRole(phone ? 'slider' : 'button', { name: /^Draft the summary, (Tue Nov 3, )?6pm to 7pm/ });
  await expect(block).toHaveAttribute('aria-haspopup', 'dialog');
  const details = nowCard(page, true).getByRole('button', { name: 'Details' });
  if (phone) await block.tap();
  const open = () => (phone ? details.tap() : block.click());
  await open();
  const popup = page.getByRole('dialog', { name: 'Draft the summary' });
  await expect(popup.getByRole('heading', { name: 'Draft the summary' })).toBeFocused();
  await expect(popup.getByRole('button', { name: 'Delete task' })).toBeVisible();
  const section = popup.getByRole('region', { name: 'Time block' });
  await expect(section.getByText('Tue Nov 3, 6pm to 7pm')).toBeVisible();
  await expect(section.getByText('Write the report')).toBeVisible();
  // A centred dialog on desktop, a sheet along the bottom on phone, once it has finished sliding in.
  await popup.evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished)));
  const box = (await popup.boundingBox())!;
  const view = page.viewportSize()!;
  if (phone) expect(Math.round(box.y + box.height)).toBe(view.height);
  else expect(Math.abs(box.x + box.width / 2 - view.width / 2)).toBeLessThan(2);
  // Today's popup on phone changes the block's time from Move…; its length is the day's to change, from the block's
  // edge, and while editing the week, from the popup's Length (week-blocks.spec.ts).
  if (phone) for (const name of ['Move…', 'Remove from calendar']) await expectTapTarget(section.getByRole('button', { name, exact: true }));
  await page.screenshot({ path: info.outputPath(`week-popup-${info.project.name}.png`) });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: info.outputPath(`week-popup-${info.project.name}-dark.png`) });
  await page.emulateMedia({ colorScheme: 'light' });
  // Esc closes it, and focus goes back to what opened it.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(phone ? details : block).toBeFocused();

  await open();
  await section.getByRole('button', { name: 'Remove from calendar' }).click();
  // Today's popup, on phone, says where the block's task waits now.
  await expect(page.getByText(phone ? /^Took Draft the summary off the calendar\./ : 'Removed Draft the summary')).toBeVisible();
  // The block's section goes with it; the task stays open.
  await expect(section).toHaveCount(0);
  await expect(popup.getByRole('button', { name: 'Delete task' })).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(section).toBeVisible();
  expect(errors).toEqual([]);
});

test("desktop: what waits above the week shares rows across days, so the strip is as tall as its busiest day", async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'The grid is the desktop layout');
  // A session every day still to place, as the owner's Gym is, and a one off for Thursday. Piano practice waits on
  // every day but Wednesday, which has its session.
  const errors = await openWeek(page, [
    ...records,
    { type: 'practice', id: 'gym', fields: { title: 'Gym', target_min: 60, per: 'day', days: [0, 1, 2, 3, 4, 5, 6], state: 'active' } },
    { type: 'task', id: 't3', fields: { kind: 'one_off', title: 'Do some cleaning', estimate_min: 30, schedule: { type: 'once', from: '2026-11-05' } } },
  ]);
  const lane = page.locator('.collane');
  const tops = (title: RegExp) => lane.locator('.oochip', { hasText: title }).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
  await expect(lane.locator('.oochip', { hasText: /^Gym$/ })).toHaveCount(7);
  // Each practice keeps one row across the week, and the one off goes under them on its day.
  const [gym, piano, cleaning] = [await tops(/^Gym$/), await tops(/^Piano practice$/), await tops(/^Do some cleaning$/)];
  expect(new Set(gym).size).toBe(1);
  expect(new Set(piano).size).toBe(1);
  expect(piano[0]).toBeGreaterThan(gym[0]!);
  expect(cleaning[0]).toBeGreaterThan(piano[0]!);
  // Three rows, for Thursday's three, rather than one for each of the 14 items.
  const heights = await lane.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(Math.max(...heights)).toBe(3 * 28 + 4);
  await page.screenshot({ path: info.outputPath('week-lane-rows.png') });
  expect(errors).toEqual([]);
});

test('desktop: add a task at its suggested time', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'The grid is the desktop layout');
  const errors = await openWeek(page);
  await page.getByRole('button', { name: "Edit this week's plan" }).click();
  await page.getByRole('button', { name: /^Paint the fence/ }).click();
  await expect(page.getByRole('group', { name: /^Paint the fence, .*Enter places it\.$/ })).toBeVisible();
  const suggestion = page.getByRole('button', { name: /^Use suggested time, / }).first();
  const label = (await suggestion.getAttribute('aria-label'))!.replace('Use suggested time, ', '');
  await suggestion.click();
  await expect(page.getByText(new RegExp(`^${label.split(', ')[0]}, `))).toBeVisible();
  await page.getByRole('button', { name: 'Place here' }).click();
  await expect(page.getByText(`Placed Paint the fence, ${label}`)).toBeVisible();
  await page.getByRole('button', { name: 'Done editing' }).click();
  await expect(page.getByRole('button', { name: new RegExp(`^Paint the fence, ${label.split(', ')[0]}`) })).toBeVisible();
  expect(errors).toEqual([]);
});

test("phone: Today's strip of days, a block's sheet, and Move to another day", async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'The strip is the phone layout');
  const errors = await openWeek(page);
  const days = strip(page);
  await expect(days.getByRole('button')).toHaveCount(7);
  await expectTapTarget(days.getByRole('button').first());
  // The narrowest iPhones in use are 375pt wide.
  await page.setViewportSize({ width: 375, height: 667 });
  await expectTapTarget(days.getByRole('button').first());
  await page.setViewportSize({ width: 390, height: 844 });
  await days.getByRole('button').nth(1).tap();
  await expect(dayShown(page)).toHaveText('Tomorrow');
  const row = page.getByRole('slider', { name: 'Draft the summary, 6pm to 7pm, Project. Conflicts with Quiz night.' });
  await expectTapTarget(row);
  await page.screenshot({ path: info.outputPath('week-phone.png') });

  await openBlock(page, row, true);
  const sheet = page.getByRole('dialog', { name: 'Draft the summary' });
  await expect(sheet.getByText('Tue Nov 3, 6pm to 7pm')).toBeVisible();
  await expectTapTarget(sheet.getByRole('button', { name: 'Move…', exact: true }));
  await sheet.getByRole('button', { name: 'Move…', exact: true }).click();
  await page.getByRole('menu', { name: 'Move to' }).getByRole('menuitem', { name: 'Choose a time…' }).click();
  await expect(page.getByText('Moving Draft the summary, 1h, from Tue 6pm')).toBeVisible();
  const handle = page.getByRole('slider', { name: /^Time for Draft the summary/ });
  await handle.focus();
  await page.keyboard.press('ArrowDown');
  await expect(handle).toHaveAttribute('aria-valuetext', 'Tue Nov 3, 6:15pm to 7:15pm');
  // The strip carries it to Saturday, opened from its slim bar if placing scrolled the day.
  await (await openStrip(page)).getByRole('button').nth(5).tap();
  await page.screenshot({ path: info.outputPath('week-phone-move.png') });
  const moveHere = page.getByRole('button', { name: 'Move here' });
  await expectTapTarget(moveHere);
  await moveHere.click();
  await expect(page.getByText('Moved Draft the summary to Sat Nov 7, 6:15pm')).toBeVisible();
  await expect(dayShown(page)).toHaveText('Saturday');
  await expect(page.getByRole('slider', { name: /^Draft the summary, 6:15pm to 7:15pm/ })).toBeVisible();
  expect(errors).toEqual([]);
});

// The legend that stood over Week's strip on phone has gone with Week, so the strip's colours are checked against each
// other rather than a legend.
test("phone: each day in Today's strip draws its free, planned and busy time, each in a colour of its own", async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'The strip is the phone layout');
  // A week like the one reported: Tuesday the 24th at 1pm, Monday's work done, and most days ahead free but for an
  // hour or two of calendar events.
  const event = (id: string, day: number, start: string, end: string) => ({ id, calendar: 'work', title: `Meeting ${id}`, start: at(day, start), end: at(day, end) });
  const week: Seed[] = [
    { type: 'week_plan', id: 'week:2026-11-23', fields: { week_start: '2026-11-23', finished_at: at(23, '08:00') } },
    records[1]!,
    records[2]!,
    { type: 'time_block', id: 'b9', fields: { task_id: 't1', start: at(23, '09:00'), end: at(23, '10:00'), tz: 'America/Chicago' } },
    { type: 'block_outcome', id: 'outcome:b9', fields: { result: 'done', answered_at: at(23, '10:00') } },
    {
      type: 'calendar',
      id: 'calendar',
      fields: {
        connected: true,
        events: [
          event('e1', 24, '08:00', '09:00'),
          event('e2', 24, '15:00', '16:00'),
          event('e3', 25, '08:00', '09:00'),
          event('e4', 25, '09:00', '10:00'),
          event('e5', 26, '12:00', '13:00'),
          event('e6', 27, '09:00', '10:00'),
          event('e7', 27, '14:00', '15:30'),
          event('e8', 28, '11:00', '12:00'),
        ],
      },
    },
  ];
  const errors = await openWeek(page, week, new Date('2026-11-24T19:00:00Z'));
  const days = strip(page);
  const wed = days.getByRole('button', { name: 'Wed Nov 25, 13h free' });
  await expect(wed).toBeVisible();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: info.outputPath(`week-day-bars-${scheme}.png`) });
  }

  const fill = (target: Locator) => target.evaluate((e) => getComputedStyle(e).backgroundColor);
  const none = 'rgba(0, 0, 0, 0)';
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // Wednesday is free from 7am to 10pm but for 8am to 10am: both show, free as a light track, not in busy's grey.
    const free = await fill(wed.locator('.sl.free').first());
    const busy = await fill(wed.locator('.sl.busy').first());
    expect(free).not.toBe(none);
    expect(free).not.toBe(busy);
    expect(await wed.locator('.sl.free').count()).toBe(26);
    expect(await wed.locator('.sl.busy').count()).toBe(4);
    // Before 7am is sleep, drawn as nothing.
    expect(await fill(wed.locator('.sl').first())).toBe(none);
    // Monday's done block is drawn as planned, in a colour of its own.
    const planned = await fill(days.getByRole('button').first().locator('.sl.planned').first());
    expect(planned).not.toBe(none);
    expect(planned).not.toBe(free);
    expect(planned).not.toBe(busy);
    // Today's morning has gone by: drawn as nothing, as sleep is, but for its 8am event, still busy.
    const today = days.getByRole('button').nth(1);
    expect(await fill(today.locator('.sl').nth(2))).toBe(none);
    expect(await fill(today.locator('.sl').nth(4))).toBe(busy);
    expect(await fill(today.locator('.sl').nth(20))).toBe(free);
  }
  expect(errors).toEqual([]);
});

test("phone: a block held on Today's day, then dragged later in the evening, moves to the time it's let go at, with Undo", async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', "Today's day is the phone layout");
  const errors = await openWeek(page, [...records, { type: 'time_block', id: 'b5', fields: { task_id: 't2', start: at(2, '16:00'), end: at(2, '17:00'), tz: 'America/Chicago' } }]);
  const block = page.getByRole('slider', { name: /^Paint the fence, 4pm to 5pm/ });
  await block.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  // Let go two hours and a half lower, over the free evening after it, on the day drawn 72pt an hour.
  const box = (await block.boundingBox())!;
  await touchDrag(page, block, { x: box.x + box.width / 2, y: box.y + box.height / 2 + 72 * 2.5 });
  await expect(page.getByText(/^Paint the fence is now (6|7|8)/)).toBeVisible();
  await expect(page.getByRole('slider', { name: /^Paint the fence, 4pm to 5pm/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('slider', { name: /^Paint the fence, 4pm to 5pm/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('phone: a day with no slot stays readable', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'The strip is the phone layout');
  // Thursday is busy from 7am to 10pm, so the one hour block has no slot there.
  const awayDay: Seed = {
    type: 'calendar',
    id: 'calendar',
    fields: { connected: true, events: [{ id: 'e2', calendar: 'work', title: 'Away day', start: at(5, '07:00'), end: at(5, '22:00') }] },
  };
  const errors = await openWeek(page, records.map((r) => (r.type === 'calendar' ? awayDay : r)));
  await strip(page).getByRole('button').nth(1).tap();
  // The block's card, raised on the day by a tap, has Move, whose Choose a time… starts placing it.
  const block = page.getByRole('slider', { name: /^Draft the summary, 6pm to 7pm/ });
  await block.tap();
  await expect(block).toHaveAccessibleName(/Selected\.$/);
  await nowCard(page, true).getByRole('button', { name: 'Move' }).tap();
  await page.getByRole('menuitem', { name: 'Choose a time…' }).click();
  await expect(page.getByText('Moving Draft the summary, 1h, from Tue 6pm')).toBeVisible();
  const thursday = (await openStrip(page)).getByRole('button', { name: /^Thu.*no slot for this task/ });
  await expect(thursday).toContainText('No slot');
  const contrast = await thursday.locator('.wfree').evaluate((el) => {
    const rgb = (c: string) => c.match(/[\d.]+/g)!.map(Number);
    const lum = ([r, g, b]: number[]) => {
      const lin = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
    };
    let opacity = 1;
    for (let e: Element | null = el; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
    // Today's strip paints the card behind its days on an element of its own, not on one that holds them.
    let back: Element = el;
    while (back.parentElement && !back.classList.contains('sffold') && rgb(getComputedStyle(back).backgroundColor)[3] === 0) back = back.parentElement;
    if (back.classList.contains('sffold')) back = back.querySelector('.sfcard')!;
    const bg = rgb(getComputedStyle(back).backgroundColor);
    const fg = rgb(getComputedStyle(el).color).slice(0, 3).map((v, i) => v * opacity + bg[i]! * (1 - opacity));
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return (hi! + 0.05) / (lo! + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  expect(errors).toEqual([]);
});

// As the owner had it: an hour's practice at 5:30pm on Friday, and planning from 5:30pm to 6:45pm.
const together: Seed[] = [
  ...records,
  { type: 'practice', id: 'meals', fields: { title: 'Plan meals for the week', target_min: 60, per: 'week', state: 'active' } },
  { type: 'time_block', id: 'bm', fields: { practice_id: 'meals', start: at(6, '17:30'), end: at(6, '18:30'), tz: 'America/Chicago' } },
  { type: 'task', id: 'planning:week:2026-11-09', fields: { kind: 'planning', title: 'Plan the week of Nov 9', plans: ['week:2026-11-09'], estimate_min: 75 } },
  { type: 'time_block', id: 'bp', fields: { task_id: 'planning:week:2026-11-09', start: at(6, '17:30'), end: at(6, '18:45'), tz: 'America/Chicago' } },
];

test("phone: blocks at the same time sit side by side on Today's day, and each opens its popup", async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', "Today's day is the phone layout");
  const errors = await openWeek(page, together);
  await strip(page).getByRole('button').nth(4).tap();
  await expect(dayShown(page)).toHaveText('Friday');
  const plan = page.getByRole('slider', { name: 'Plan the week of Nov 9, 5:30pm to 6:45pm, Planning. Overlaps Plan meals for the week.' });
  const meals = page.getByRole('slider', { name: 'Plan meals for the week, 5:30pm to 6:30pm, Practice. Overlaps Plan the week of Nov 9.' });
  const sideBySide = async () => {
    const [left, right] = [(await plan.boundingBox())!, (await meals.boundingBox())!];
    expect(left.y).toBeCloseTo(right.y, 0);
    expect(left.x + left.width).toBeLessThanOrEqual(right.x);
    expect(left.width).toBeCloseTo(right.width, 0);
    await expectTapTarget(plan);
    await expectTapTarget(meals);
  };
  await sideBySide();
  await plan.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: info.outputPath('week-phone-together.png') });
  // The narrowest phones still fit both.
  await page.setViewportSize({ width: 320, height: 640 });
  await sideBySide();
  await page.screenshot({ path: info.outputPath('week-phone-together-320.png') });

  await openBlock(page, meals, true);
  const popup = page.getByRole('dialog', { name: 'Plan meals for the week' });
  await expect(popup.getByText('Fri Nov 6, 5:30pm to 6:30pm')).toBeVisible();
  await popup.getByRole('button', { name: 'Cancel' }).click();
  // Meals stays raised as a card over the block beside it, until a tap on empty time, at 9pm, hands the selection back.
  const empty = await page.locator('.tdpager .day').evaluate((day: HTMLElement) => {
    const [from, to] = [Number(day.dataset.dropFrom), Number(day.dataset.dropTo)];
    const point = () => {
      const box = day.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + ((21 * 60 - from) / (to - from)) * box.height };
    };
    document.querySelector('.pane')!.scrollBy(0, point().y - innerHeight / 2);
    return point();
  });
  await page.touchscreen.tap(empty.x, empty.y);
  await expect(meals).not.toHaveAccessibleName(/Selected\.$/);
  await openBlock(page, plan, true);
  await expect(page.getByRole('dialog', { name: 'Plan the week of Nov 9' }).getByText('Fri Nov 6, 5:30pm to 6:45pm')).toBeVisible();
  expect(errors).toEqual([]);
});

test("phone: blocks at the same time past what Today's day has room for go behind +N more, which lists them all", async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', "Today's day is the phone layout");
  const errors = await openWeek(page, [
    ...together,
    { type: 'time_block', id: 'bc', fields: { task_id: 't2', start: at(6, '18:00'), end: at(6, '18:30'), tz: 'America/Chicago' } },
    { type: 'time_block', id: 'bd', fields: { task_id: 't1', start: at(6, '18:00'), end: at(6, '18:30'), tz: 'America/Chicago' } },
  ]);
  await strip(page).getByRole('button').nth(4).tap();
  // A 390pt phone's day has room for three readable columns, so four at once draw two and +2 more.
  await expect(page.getByRole('slider', { name: /^Plan the week of Nov 9, 5:30pm/ })).toBeVisible();
  await expect(page.getByRole('slider', { name: /^Plan meals for the week, 5:30pm/ })).toBeVisible();
  await expect(page.getByRole('slider', { name: /^Paint the fence, 6pm/ })).toHaveCount(0);
  const more = page.getByRole('button', { name: /^\+2 more: / });
  await expectTapTarget(more);
  await more.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('week-phone-more.png') });
  await more.click();
  const list = page.getByRole('dialog', { name: 'Blocks from 5:30pm to 6:45pm' });
  for (const name of [/^Plan the week of Nov 9, 5:30pm/, /^Plan meals for the week, 5:30pm/, /^Draft the summary, 6pm/]) await expect(list.getByRole('button', { name })).toBeVisible();
  const fence = list.getByRole('button', { name: /^Paint the fence, 6pm to 6:30pm, One off\./ });
  await expectTapTarget(fence);
  await fence.click();
  await expect(page.getByRole('dialog', { name: 'Paint the fence' }).getByText('Fri Nov 6, 6pm to 6:30pm')).toBeVisible();
  expect(errors).toEqual([]);
});

test("phone: Edit this week's plan from Today's menu, and add a task from the drawer", async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'The drawer is the phone layout');
  const errors = await openWeek(page);
  await phoneView(page, "Edit this week's plan");
  await expect(weekTitled(page, true, 'Editing this week')).toBeVisible();
  await page.getByRole('button', { name: 'Add a task' }).click();
  const drawer = page.getByRole('dialog', { name: 'Add to this week' });
  await drawer.getByRole('button', { name: /^Paint the fence/ }).click();
  const offer = drawer.getByRole('button', { name: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) Nov \d+, / }).first();
  await expectTapTarget(offer);
  await page.screenshot({ path: info.outputPath('week-phone-drawer.png') });
  await offer.click();
  await expect(page.getByText(/^Placed Paint the fence, /)).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('slider', { name: /^Paint the fence\./ })).toBeVisible();
  await page.getByRole('button', { name: 'Done editing' }).click();
  await expect(weekTitled(page, true, 'This week')).toBeVisible();
  expect(errors).toEqual([]);
});

test('to schedule: picked work waits above the week, a suggestion places it, Undo brings it back, and it drags both ways', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const pick = { type: 'week_pick', id: 'pick:2026-11-02:t1', fields: { week_start: '2026-11-02', task_id: 't1', minutes: 180 } } as const;
  const errors = await openWeek(page, [...records, pick]);
  // Above the week on desktop, and on phone in the sheet behind the strip's count of what's waiting for a time.
  const lane = phone ? await waitingSheet(page) : page.getByRole('region', { name: 'To schedule' });
  // Piano practice counts a session for each day still without one: on desktop the week's, and on phone those of the
  // day shown, today, and the days before it.
  await expect(lane.getByText(phone ? '2 · 2h 30m' : '7 · 5h')).toBeVisible();
  const card = lane.getByRole('button', { name: 'Draft the summary, Project, 2h of 3h left, to schedule' });
  if (phone) await expectTapTarget(card);
  await page.screenshot({ path: info.outputPath(`to-schedule-${info.project.name}.png`) });

  await card.click();
  const panel = phone ? page.getByRole('dialog', { name: 'Draft the summary' }) : page.getByRole('group', { name: 'Draft the summary' });
  const first = panel.getByRole('group', { name: 'Suggested times' }).getByRole('button').first();
  await expect(first).toHaveAccessibleName(/^\w{3} \d/);
  await first.click();
  await expect(card).toHaveCount(0);
  await expect(lane.getByText(phone ? '1 · 30m' : '6 · 3h')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(card).toBeVisible();

  if (!phone) {
    // Dragged by the mouse onto Thursday, 26px an hour from 6am: 8am.
    const thu = (await page.locator('[data-drop-date="2026-11-05"]').boundingBox())!;
    const from = (await card.boundingBox())!;
    await holdMouse(page, { x: from.x + 20, y: from.y + 10 });
    await page.mouse.move(thu.x + thu.width / 2, thu.y + 26 * 2 + 1, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByRole('button', { name: /^Draft the summary, Thu Nov 5, 8am to 10am, Project\./ })).toBeVisible();
    await expect(card).toHaveCount(0);

    // And while editing, dragged back up onto To schedule it comes off the calendar.
    await page.getByRole('button', { name: "Edit this week's plan" }).click();
    const placed = page.getByRole('group', { name: /^Draft the summary, Thu Nov 5/ });
    const box = (await placed.boundingBox())!;
    const target = (await lane.boundingBox())!;
    await holdMouse(page, { x: box.x + box.width / 2, y: box.y + 8 });
    await page.mouse.move(target.x + target.width / 2, target.y + 10, { steps: 8 });
    await page.mouse.up();
    await expect(placed).toHaveCount(0);
    await expect(lane.getByRole('button', { name: 'Draft the summary, Project, 2h of 3h left, to schedule' })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("desktop: a toast that takes another's place under the resting mouse is held by it too, until the mouse goes", async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'A mouse rests on the toast on desktop');
  const picks = [
    { type: 'week_pick', id: 'pick:2026-11-02:t1', fields: { week_start: '2026-11-02', task_id: 't1', minutes: 180 } },
    { type: 'week_pick', id: 'pick:2026-11-02:t2', fields: { week_start: '2026-11-02', task_id: 't2', minutes: 60 } },
  ] as const;
  const errors = await openWeek(page, [...records, ...picks]);
  const lane = page.getByRole('region', { name: 'To schedule' });
  await lane.getByRole('button', { name: /^Draft the summary, / }).click();
  await page.getByRole('group', { name: 'Draft the summary' }).getByRole('group', { name: 'Suggested times' }).getByRole('button').first().click();
  const toast = page.locator('.toast');
  await expect(toast).toContainText('Placed Draft the summary');
  await toast.getByRole('button', { name: 'Undo' }).hover();

  // Another change, from the keyboard, so the mouse stays where it is: its toast takes the first one's place under it.
  await lane.getByRole('button', { name: /^Paint the fence, / }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('group', { name: 'Paint the fence' }).getByRole('button', { name: 'Take out of this week' }).focus();
  await page.keyboard.press('Enter');
  await expect(toast).toContainText('Took Paint the fence out of this week');
  await expect.poll(() => toast.evaluate((el) => el.matches(':hover'))).toBe(true);
  // Past the 5 seconds a toast with Undo shows for.
  await page.clock.runFor(6000);
  await expect(toast).toContainText('Took Paint the fence out of this week');

  await page.mouse.move(10, 10);
  await page.clock.runFor(6000);
  await expect(toast).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("phone: a card held in Today's sheet of what's waiting, then dragged down onto the day, is placed where it is let go", async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'Holding first is for touch');
  const errors = await openWeek(page);
  // Today, Monday, has its session waiting, in the sheet behind the strip's count of what's waiting for a time.
  const card = (await waitingSheet(page)).getByRole('button', { name: 'Piano practice, Practice, 30 minutes on Monday, to schedule' });
  await expect(card).toBeVisible();
  // A swipe that moves before the hold leaves it be.
  await touchDrag(page, card, { x: 20, y: 700 }, 50);
  await expect(card).toBeVisible();

  // Held near the bottom, the sheet steps aside and the day scrolls up under the card; moved back up off the edge, it's
  // let go in the evening.
  const height = page.viewportSize()!.height;
  // Let go over the middle of the evening that shows between the strip's day row, stuck over the day, and the tab bar.
  const overEvening = () =>
    page.evaluate((height) => {
      const day = document.querySelector<HTMLElement>('.tdpager .day')!;
      const [from, to] = [Number(day.dataset.dropFrom), Number(day.dataset.dropTo)];
      const box = day.getBoundingClientRect();
      const y = (minute: number) => box.y + ((minute - from) / (to - from)) * box.height;
      const top = Math.max(y(17 * 60), document.querySelector('.sfbg')!.getBoundingClientRect().bottom);
      return { x: box.x + box.width / 2, y: (top + Math.min(y(to), height - 170)) / 2 };
    }, height);
  await touchDrag(page, card, { x: 200, y: height - 110 }, 500, 1000, overEvening);
  await expect(card).toHaveCount(0);
  const placed = await page.getByRole('slider', { name: /^Piano practice, \d/ }).getAttribute('aria-label');
  const [, h, m, ap] = /^Piano practice, (\d+)(?::(\d+))?(am|pm)/.exec(placed!)!;
  const minutes = ((Number(h) % 12) + (ap === 'pm' ? 12 : 0)) * 60 + Number(m ?? 0);
  expect(minutes).toBeGreaterThanOrEqual(17 * 60);
  expect(errors).toEqual([]);
});

test("a set-day practice waits above its own days: Friday's 9:30 places it, Undo takes it back, and a new time can be kept for Tuesdays", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const run: Seed = {
    type: 'practice',
    id: 'run',
    fields: { title: 'Morning run', target_min: 30, per: 'day', days: [0, 1, 4], preferred_times: [420], day_times: [null, null, null, null, 570, null, null], state: 'active' },
  };
  const errors = await openWeek(page, [...records.filter((r) => r.id !== 'pr' && r.id !== 'b2'), run]);
  const friday = 'Morning run, Practice, 30 minutes on Friday around 9:30 AM, to schedule';
  // On phone, Friday on the strip, whose sheet of what's waiting holds Friday's session.
  if (phone) await strip(page).getByRole('button', { name: /^Fri Nov 6/ }).tap();
  const lane = phone ? await waitingSheet(page) : page;
  await expect(lane.getByRole('button', { name: friday })).toBeVisible();
  await page.screenshot({ path: info.outputPath(`week-practice-${info.project.name}.png`), fullPage: !phone });
  await lane.getByRole('button', { name: friday }).click();
  const panel = phone ? page.getByRole('dialog', { name: 'Morning run' }) : page.getByRole('group', { name: 'Morning run' });
  await expect(panel.getByText('Practice, 30m on Friday, usually 9:30am')).toBeVisible();
  await panel.getByRole('button', { name: 'Fri 9:30am to 10am' }).click();
  await expect(page.getByText('Placed Morning run, Fri Nov 6, 9:30am')).toBeVisible();
  await expect(lane.getByRole('button', { name: friday })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  // On phone the sheet of what's waiting is still open, drawn again once the card's own sheet closed.
  await expect(lane.getByRole('button', { name: friday })).toBeVisible();
  if (phone) return expect(errors).toEqual([]);

  // Tuesday's at 7am, then moved to 8:30, kept for Tuesdays only.
  await page.getByRole('button', { name: 'Morning run, Practice, 30 minutes on Tuesday around 7 AM, to schedule' }).click();
  await page.getByRole('group', { name: 'Morning run' }).getByRole('button', { name: 'Tue 7am to 7:30am' }).click();
  await page.getByRole('button', { name: "Edit this week's plan" }).click();
  await page.getByRole('group', { name: /^Morning run, Tue Nov 3, 7am/ }).focus();
  // Each press is saved before the next, and the ask is announced without taking focus from the session.
  for (const time of ['7:15', '7:30', '7:45', '8', '8:15', '8:30']) {
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('group', { name: new RegExp(`^Morning run, Tue Nov 3, ${time}am`) })).toBeFocused();
  }
  const ask = page.getByRole('group', { name: 'Use 8:30am in future weeks too?' });
  await expect(ask).toHaveAccessibleDescription('Morning run moved to Tue 8:30am.');
  await expect(ask.getByText("The last one replaces Friday's 9:30am.")).toBeVisible();
  await ask.getByRole('button', { name: 'Yes, on Tuesdays' }).click();
  await expect(page.getByText('Morning run is now 8:30am on Tuesdays.')).toBeVisible();
  expect(errors).toEqual([]);
});
