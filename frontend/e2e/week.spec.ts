import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded, touchDrag } from './seed';
import type { Seed } from './seed';

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

async function openWeek(page: Page, list = records) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, list);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Week' }).click();
  return errors;
}

test('week arrows reach any week and This week comes back', async ({ page }, info) => {
  const errors = await openWeek(page);
  await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible();
  const previous = page.getByRole('button', { name: 'Previous week' });
  if (info.project.name === 'phone') await expectTapTarget(previous);
  for (let i = 0; i < 3; i++) await previous.click();
  await expect(page.getByRole('heading', { name: 'Past week' })).toBeVisible();
  await expect(page.getByText('Oct 12 to Oct 18')).toBeVisible();
  await expect(page.getByText('Past weeks can be viewed but not changed.')).toBeVisible();
  await page.getByRole('button', { name: 'This week', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible();
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
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + column.width / 2, box.y + 30, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 + column.width + 2, box.y + 48, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole('group', { name: /^Draft the summary, Wed Nov 4, 7pm to 8pm, Project\./ })).toBeVisible();

  // The bottom edge makes it longer.
  const moved = page.getByRole('group', { name: /^Draft the summary/ });
  const edge = (await moved.locator('.evh').boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
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

test('phone: the day strip, a block sheet, and Move to another day', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'The strip is the phone layout');
  const errors = await openWeek(page);
  const strip = page.getByRole('group', { name: 'Choose a day' });
  await expect(strip.getByRole('button')).toHaveCount(7);
  await expectTapTarget(strip.getByRole('button').first());
  // The narrowest iPhones in use are 375pt wide.
  await page.setViewportSize({ width: 375, height: 667 });
  await expectTapTarget(strip.getByRole('button').first());
  await page.setViewportSize({ width: 390, height: 844 });
  await strip.getByRole('button').nth(1).click();
  await expect(page.getByRole('heading', { name: 'Tue Nov 3' })).toBeVisible();
  const row = page.getByRole('button', { name: 'Draft the summary, 6pm to 7pm, Project. Conflicts with Quiz night.' });
  await expectTapTarget(row);
  await page.screenshot({ path: info.outputPath('week-phone.png') });

  await row.click();
  const sheet = page.getByRole('dialog', { name: 'Draft the summary' });
  await expect(sheet.getByText('Tue Nov 3, 6pm to 7pm')).toBeVisible();
  await expectTapTarget(sheet.getByRole('slider', { name: 'Length' }));
  await sheet.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByText('Moving Draft the summary, 1h, from Tue 6pm')).toBeVisible();
  const handle = page.getByRole('slider', { name: /^Time for Draft the summary/ });
  await handle.focus();
  await page.keyboard.press('ArrowDown');
  await expect(handle).toHaveAttribute('aria-valuetext', 'Tue Nov 3, 6:15pm to 7:15pm');
  await strip.getByRole('button').nth(5).click();
  await page.screenshot({ path: info.outputPath('week-phone-move.png') });
  const moveHere = page.getByRole('button', { name: 'Move here' });
  await expectTapTarget(moveHere);
  await moveHere.click();
  await expect(page.getByText('Moved Draft the summary to Sat Nov 7, 6:15pm')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sat Nov 7' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Draft the summary, 6:15pm to 7:15pm/ })).toBeVisible();
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
  const strip = page.getByRole('group', { name: 'Choose a day' });
  await strip.getByRole('button').nth(1).click();
  await page.getByRole('button', { name: /^Draft the summary, 6pm to 7pm/ }).click();
  await page.getByRole('dialog', { name: 'Draft the summary' }).getByRole('button', { name: 'Move', exact: true }).click();
  const thursday = strip.getByRole('button', { name: /^Thu.*no slot for this task/ });
  await expect(thursday).toContainText('No slot');
  const contrast = await thursday.locator('.wfree').evaluate((el) => {
    const rgb = (c: string) => c.match(/[\d.]+/g)!.map(Number);
    const lum = ([r, g, b]: number[]) => {
      const lin = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
    };
    let opacity = 1;
    for (let e: Element | null = el; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
    let back: Element = el;
    while (back.parentElement && rgb(getComputedStyle(back).backgroundColor)[3] === 0) back = back.parentElement;
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

test('phone: blocks at the same time sit side by side with their time once, and each opens its sheet', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', "The day's rows are the phone layout");
  const errors = await openWeek(page, together);
  await page.getByRole('group', { name: 'Choose a day' }).getByRole('button').nth(4).click();
  await expect(page.getByRole('heading', { name: 'Fri Nov 6' })).toBeVisible();
  const plan = page.getByRole('button', { name: 'Plan the week of Nov 9, 5:30pm to 6:45pm, Planning. Overlaps Plan meals for the week.' });
  const meals = page.getByRole('button', { name: 'Plan meals for the week, 5:30pm to 6:30pm, Practice. Overlaps Plan the week of Nov 9.' });
  const sideBySide = async () => {
    const [left, right] = [(await plan.boundingBox())!, (await meals.boundingBox())!];
    expect(left.y).toBeCloseTo(right.y, 0);
    expect(left.x + left.width).toBeLessThanOrEqual(right.x);
    expect(left.width).toBeCloseTo(right.width, 0);
    await expectTapTarget(plan);
    await expectTapTarget(meals);
  };
  await sideBySide();
  await expect(page.locator('.wkdaycard .tltime').filter({ hasText: /^5:30pm$/ })).toHaveCount(1);
  await expect(page.getByText('Free, 7pm to 10pm')).toBeVisible();
  await plan.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('week-phone-together.png') });
  // The narrowest phones still fit both.
  await page.setViewportSize({ width: 320, height: 640 });
  await sideBySide();
  await page.screenshot({ path: info.outputPath('week-phone-together-320.png') });

  await meals.click();
  const sheet = page.getByRole('dialog', { name: 'Plan meals for the week' });
  await expect(sheet.getByText('Fri Nov 6, 5:30pm to 6:30pm')).toBeVisible();
  await sheet.getByRole('button', { name: 'Close' }).click();
  await plan.click();
  await expect(page.getByRole('dialog', { name: 'Plan the week of Nov 9' }).getByText('Fri Nov 6, 5:30pm to 6:45pm')).toBeVisible();
  expect(errors).toEqual([]);
});

test('phone: a third block at the same time goes behind +1 more, which lists all three', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', "The day's rows are the phone layout");
  const errors = await openWeek(page, [...together, { type: 'time_block', id: 'bc', fields: { task_id: 't2', start: at(6, '18:00'), end: at(6, '18:30'), tz: 'America/Chicago' } }]);
  await page.getByRole('group', { name: 'Choose a day' }).getByRole('button').nth(4).click();
  // A 390pt phone's row has room for two readable columns.
  await expect(page.getByRole('button', { name: /^Plan the week of Nov 9, 5:30pm/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Plan meals for the week, 5:30pm/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Paint the fence, 6pm/ })).toHaveCount(0);
  const more = page.getByRole('button', { name: '+1 more: Paint the fence' });
  await expectTapTarget(more);
  await more.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('week-phone-more.png') });
  await more.click();
  const list = page.getByRole('dialog', { name: 'Blocks from 5:30pm to 6:45pm' });
  const fence = list.getByRole('button', { name: /^Paint the fence, 6pm to 6:30pm, One off\./ });
  await expectTapTarget(fence);
  await fence.click();
  await expect(page.getByRole('dialog', { name: 'Paint the fence' }).getByText('Fri Nov 6, 6pm to 6:30pm')).toBeVisible();
  expect(errors).toEqual([]);
});

test("phone: Edit this week's plan and add a task from the drawer", async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'The drawer is the phone layout');
  const errors = await openWeek(page);
  await page.getByRole('button', { name: "Edit this week's plan" }).click();
  await expect(page.getByRole('heading', { name: 'Editing this week' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('to schedule: picked work waits above the week, a suggestion places it, Undo brings it back, and it drags both ways', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const pick = { type: 'week_pick', id: 'pick:2026-11-02:t1', fields: { week_start: '2026-11-02', task_id: 't1', minutes: 180 } } as const;
  const errors = await openWeek(page, [...records, pick]);
  const lane = page.getByRole('region', { name: 'To schedule' });
  // Piano practice counts a session for each day still without one.
  await expect(lane.getByText('7 · 5h')).toBeVisible();
  const card = lane.getByRole('button', { name: 'Draft the summary, Project, 2h of 3h left, to schedule' });
  if (phone) await expectTapTarget(card);
  await page.screenshot({ path: info.outputPath(`to-schedule-${info.project.name}.png`) });

  await card.click();
  const panel = phone ? page.getByRole('dialog', { name: 'Draft the summary' }) : page.getByRole('group', { name: 'Draft the summary' });
  const first = panel.getByRole('group', { name: 'Suggested times' }).getByRole('button').first();
  await expect(first).toHaveAccessibleName(/^1 · \w{3} \d/);
  await first.click();
  await expect(card).toHaveCount(0);
  await expect(lane.getByText('6 · 3h')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(card).toBeVisible();

  if (!phone) {
    // Dragged by the mouse onto Thursday, 26px an hour from 6am: 8am.
    const thu = (await page.locator('[data-drop-date="2026-11-05"]').boundingBox())!;
    const from = (await card.boundingBox())!;
    await page.mouse.move(from.x + 20, from.y + 10);
    await page.mouse.down();
    await page.mouse.move(thu.x + thu.width / 2, thu.y + 26 * 2 + 1, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByRole('button', { name: /^Draft the summary, Thu Nov 5, 8am to 10am, Project\./ })).toBeVisible();
    await expect(card).toHaveCount(0);

    // And while editing, dragged back up onto To schedule it comes off the calendar.
    await page.getByRole('button', { name: "Edit this week's plan" }).click();
    const placed = page.getByRole('group', { name: /^Draft the summary, Thu Nov 5/ });
    const box = (await placed.boundingBox())!;
    const target = (await lane.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + 10, { steps: 8 });
    await page.mouse.up();
    await expect(placed).toHaveCount(0);
    await expect(lane.getByRole('button', { name: 'Draft the summary, Project, 2h of 3h left, to schedule' })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('phone: a card held, then dragged down onto the day, is placed where it is let go', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'Holding first is for touch');
  const errors = await openWeek(page);
  const lane = page.getByRole('region', { name: 'To schedule' });
  // Today, Monday, has its session waiting.
  const card = lane.getByRole('button', { name: 'Piano practice, Practice, 30 minutes on Monday, to schedule' });
  await expect(card).toBeVisible();
  // A swipe that moves before the hold leaves it be.
  await touchDrag(page, card, { x: 20, y: 700 }, 50);
  await expect(card).toBeVisible();

  // Held near the bottom, the day scrolls up under the card; moved back up off the edge, it's let go in the evening.
  await lane.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  const height = page.viewportSize()!.height;
  const evening = page.locator('.tlrow', { hasText: /^\d+(am|pm)Free, / }).last();
  // Let go over the middle of the evening that shows between the sticky day strip and the tray.
  const overEvening = async () => {
    const [b, top] = [(await evening.boundingBox())!, (await page.locator('.weektop').boundingBox())!];
    const from = Math.max(b.y, top.y + top.height);
    return { x: b.x + b.width / 2, y: (from + Math.min(b.y + b.height, height - 170)) / 2 };
  };
  await touchDrag(page, card, { x: 200, y: height - 110 }, 500, 1000, overEvening);
  await expect(card).toHaveCount(0);
  const placed = await page.getByRole('button', { name: /^Piano practice, \d/ }).getAttribute('aria-label');
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
  if (phone) await page.getByRole('group', { name: 'Choose a day' }).getByRole('button', { name: /^Fri Nov 6, .*1 to schedule$/ }).click();
  await expect(page.getByRole('button', { name: friday })).toBeVisible();
  await page.screenshot({ path: info.outputPath(`week-practice-${info.project.name}.png`), fullPage: !phone });
  await page.getByRole('button', { name: friday }).click();
  const panel = phone ? page.getByRole('dialog', { name: 'Morning run' }) : page.getByRole('group', { name: 'Morning run' });
  await expect(panel.getByText('Practice, 30m on Friday, usually 9:30am')).toBeVisible();
  await panel.getByRole('button', { name: '1 · Fri 9:30am to 10am' }).click();
  await expect(page.getByText('Placed Morning run, Fri Nov 6, 9:30am')).toBeVisible();
  await expect(page.getByRole('button', { name: friday })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: friday })).toBeVisible();
  if (phone) return expect(errors).toEqual([]);

  // Tuesday's at 7am, then moved to 8:30, kept for Tuesdays only.
  await page.getByRole('button', { name: 'Morning run, Practice, 30 minutes on Tuesday around 7 AM, to schedule' }).click();
  await page.getByRole('group', { name: 'Morning run' }).getByRole('button', { name: '1 · Tue 7am to 7:30am' }).click();
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
