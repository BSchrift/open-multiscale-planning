// Today's timeline beyond moving a block, which today.spec.ts has: Calendar or List, the calendar's zoom, and changing
// a block's length, both one still to come and the one under way.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded, touchDrag } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm in Chicago.
const at = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  // Chicago is six hours behind UTC in November.
  return new Date(Date.UTC(2026, 10, 2, h! + 6, m ?? 0)).toISOString().replace('.000Z', 'Z');
};

const planned: Seed = { type: 'week_plan', id: 'week:2026-11-02', fields: { week_start: '2026-11-02', finished_at: at('08:00') } };
const project: Seed = { type: 'project', id: 'p', fields: { title: 'Annual report', state: 'active', start: '2026-10-01', end: '2026-12-31' } };
const report: Seed = { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p', title: 'Write the report', estimate_min: 180 } };
const fence: Seed = { type: 'task', id: 't2', fields: { kind: 'one_off', title: 'Paint the fence', estimate_min: 90 } };
const piano: Seed = { type: 'practice', id: 'pr', fields: { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' } };
const block = (id: string, work: Record<string, unknown>, from: string, to: string, extra: Record<string, unknown> = {}): Seed => ({
  type: 'time_block',
  id,
  fields: { ...work, start: at(from), end: at(to), tz: 'America/Chicago', ...extra },
});

// The clock runs on from 2pm, as in today.spec.ts's drag tests.
async function open(page: Page, records: Seed[]) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  return errors;
}

/** To schedule, above the day, changes height once it has read the week, so blocks are measured after that. */
const settled = (page: Page) => expect(page.getByRole('region', { name: 'To schedule' }).getByText('Everything this week is on the calendar.')).toBeVisible();

test('the timeline switches to a list of the day in order, which opens a practice in place, and the choice lasts after a reload', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const calendar: Seed = {
    type: 'calendar',
    id: 'calendar',
    fields: { connected: true, events: [{ id: 'e1', calendar: 'g1', title: 'Quiz night', start: at('19:00'), end: at('20:00') }] },
  };
  const done: Seed = { type: 'block_outcome', id: 'outcome:b1', fields: { result: 'done', answered_at: at('10:00') } };
  const errors = await open(page, [
    planned,
    project,
    report,
    fence,
    piano,
    calendar,
    block('b1', { task_id: 't1' }, '09:00', '10:00'),
    done,
    block('b2', { task_id: 't2' }, '16:00', '17:30'),
    block('b3', { practice_id: 'pr' }, '18:00', '18:30'),
  ]);
  const timeline = page.getByRole('region', { name: "Today's timeline" });
  const views = timeline.getByRole('group', { name: 'Timeline view' });
  const [calendarView, listView] = [views.getByRole('button', { name: 'Calendar' }), views.getByRole('button', { name: 'List' })];
  await expect(calendarView).toHaveAttribute('aria-pressed', 'true');
  if (phone) {
    await expectTapTarget(calendarView);
    await expectTapTarget(listView);
  }
  await listView.click();
  await expect(listView).toHaveAttribute('aria-pressed', 'true');
  await expect(calendarView).toHaveAttribute('aria-pressed', 'false');
  await expect(timeline.getByRole('group', { name: 'Calendar zoom' })).toHaveCount(0);

  // Each block and event in order of time; phone says a block's time, title and kind, desktop its range and project.
  const rows = timeline.locator('.tllist > *');
  if (phone) {
    await expect(rows).toHaveText([/^9am\s*Write the report\s*Project, Done$/, /^4pm\s*Paint the fence\s*One off$/, /^6pm\s*Piano practice\s*Practice$/, /^7pm\s*Quiz night$/]);
    await expectTapTarget(timeline.getByRole('button', { name: 'Paint the fence, 4pm to 5:30pm, One off.' }));
  } else {
    await expect(rows).toHaveText([/^9am to 10am\s*Write the report\s*Annual report/, /^4pm to 5:30pm\s*Paint the fence\s*One off/, /^6pm to 6:30pm\s*Piano practice\s*Practice/, /^7pm to 8pm\s*Quiz night$/]);
  }
  await page.screenshot({ path: info.outputPath(`today-list-${info.project.name}.png`) });

  // A practice's session opens its details: in place on desktop, over the page on phone.
  if (phone) {
    await timeline.getByRole('button', { name: 'Piano practice, 6pm to 6:30pm, Practice.' }).click();
    const sheet = page.getByRole('dialog', { name: 'Piano practice' });
    await expect(sheet.getByText('6pm to 6:30pm')).toBeVisible();
    await expect(sheet.getByText(/^Practice:/)).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toHaveCount(0);
  } else {
    const row = timeline.getByRole('button', { name: /^6pm to 6:30pm\s*Piano practice/ });
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(timeline.getByText(/^Practice:/)).toBeVisible();
  }

  // The choice is kept on this device.
  await page.reload();
  await expect(page.getByRole('region', { name: "Today's timeline" }).getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: "Today's timeline" }).locator('.tllist > *')).toHaveCount(4);
  await page.getByRole('region', { name: "Today's timeline" }).getByRole('button', { name: 'Calendar' }).click();
  await expect(page.getByRole('region', { name: "Today's timeline" }).getByRole('group', { name: 'Calendar zoom' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('zoom draws the calendar taller a step at a time and back, each button stopping at its end', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, fence, block('b2', { task_id: 't2' }, '16:00', '17:00')]);
  await settled(page);
  const zoom = page.getByRole('group', { name: 'Calendar zoom' });
  const [zoomIn, zoomOut] = [zoom.getByRole('button', { name: 'Zoom in' }), zoom.getByRole('button', { name: 'Zoom out' })];
  if (phone) {
    await expectTapTarget(zoomIn);
    await expectTapTarget(zoomOut);
  }
  const hour = page.getByRole(phone ? 'slider' : 'button', { name: /^Paint the fence, 4pm to 5pm/ });
  // An hour's block is an hour of the calendar, less a pixel of gap: 30, 48, 72 and 96 pixels an hour.
  const height = async () => Math.round((await hour.boundingBox())!.height);
  await expect(zoomOut).toBeDisabled();
  expect(await height()).toBe(29);
  for (const px of [48, 72, 96]) {
    await zoomIn.click();
    await expect.poll(height).toBe(px - 1);
  }
  await expect(zoomIn).toBeDisabled();
  await page.screenshot({ path: info.outputPath(`today-zoomed-${info.project.name}.png`) });
  for (const px of [72, 48, 30]) {
    await zoomOut.click();
    await expect.poll(height).toBe(px - 1);
  }
  await expect(zoomOut).toBeDisabled();
  await expect(zoomIn).toBeEnabled();
  expect(errors).toEqual([]);
});

test('a block still to come changes its length from its bottom edge, held first on phone, and Undo takes it back', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, report, block('b1', { task_id: 't1' }, '16:00', '17:00')]);
  await settled(page);
  const b = page.getByRole(phone ? 'slider' : 'button', { name: /^Write the report, 4pm to 5pm/ });
  await b.scrollIntoViewIfNeeded();
  // The first zoom draws 30px an hour, so 15px down is half an hour longer.
  if (phone) {
    const grip = b.locator('.rz');
    const box = (await grip.boundingBox())!;
    await touchDrag(page, grip, { x: box.x + box.width / 2, y: box.y + box.height / 2 + 15 });
  } else {
    const edge = (await b.locator('.evh').boundingBox())!;
    const x = edge.x + edge.width / 2;
    await page.mouse.move(x, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, edge.y + edge.height / 2 + 8, { steps: 3 });
    await page.mouse.move(x, edge.y + edge.height / 2 + 15, { steps: 3 });
    await page.mouse.up();
  }
  await expect(page.getByText('Write the report is now 4pm to 5:30pm.')).toBeVisible();
  await expect(page.getByRole(phone ? 'slider' : 'button', { name: /^Write the report, 4pm to 5:30pm/ })).toBeVisible();
  // Changing its length is not a click: nothing opens.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole(phone ? 'slider' : 'button', { name: /^Write the report, 4pm to 5pm/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('on desktop, Shift and the arrow keys change a block’s length a quarter hour at a time, never under 15 minutes, with one Undo', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'Phone has no arrow keys; VoiceOver moves a block as a slider');
  const errors = await open(page, [planned, report, block('b1', { task_id: 't1' }, '16:00', '16:45')]);
  await settled(page);
  const b = page.getByRole('button', { name: /^Write the report, 4pm to 4:45pm/ });
  await b.focus();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.getByText('Write the report is now 4pm to 5pm.')).toBeVisible();
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowUp');
  await expect(page.getByText('Write the report is now 4pm to 4:15pm.')).toBeVisible();
  const short = page.getByRole('button', { name: /^Write the report, 4pm to 4:15pm/ });
  await expect(short).toBeFocused();
  // Steps in a row are one change, so Undo goes back to before the first.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: /^Write the report, 4pm to 4:45pm/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the block under way keeps its start and changes only its end, from its edge or, on desktop, Shift and the arrow keys', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, fence, block('b0', { task_id: 't2' }, '13:30', '15:00', { started_at: at('13:30') })]);
  await settled(page);
  // Under way, it's a button on phone too, since it no longer moves.
  const b = page.getByRole('button', { name: /^Paint the fence, 1:30pm to 3pm, One off\. Now\./ });
  await b.scrollIntoViewIfNeeded();
  if (phone) {
    const grip = b.locator('.rz');
    const box = (await grip.boundingBox())!;
    await touchDrag(page, grip, { x: box.x + box.width / 2, y: box.y + box.height / 2 + 15 });
  } else {
    // Pressed in the middle, it doesn't move.
    const mid = (await b.boundingBox())!;
    await page.mouse.move(mid.x + mid.width / 3, mid.y + mid.height / 2);
    await page.mouse.down();
    await page.mouse.move(mid.x + mid.width / 3, mid.y + mid.height / 2 + 30, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByText(/^Paint the fence is now/)).toHaveCount(0);
    const edge = (await b.locator('.evh').boundingBox())!;
    const x = edge.x + edge.width / 2;
    await page.mouse.move(x, edge.y + edge.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, edge.y + edge.height / 2 + 8, { steps: 3 });
    await page.mouse.move(x, edge.y + edge.height / 2 + 15, { steps: 3 });
    await page.mouse.up();
  }
  await expect(page.getByText('Paint the fence is now 1:30pm to 3:30pm.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Current block' }).getByText('Now, 1:30pm to 3:30pm')).toBeVisible();
  if (!phone) {
    const longer = page.getByRole('button', { name: /^Paint the fence, 1:30pm to 3:30pm/ });
    await longer.focus();
    // Plain arrows would move a block still to come; this one stays where it started.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+ArrowUp');
    await expect(page.getByText('Paint the fence is now 1:30pm to 3:15pm.')).toBeVisible();
  }
  expect(errors).toEqual([]);
});
