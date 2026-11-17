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

test('an Inbox item’s block shows it isn’t sorted yet, on Today and on Week: a dashed edge, the inbox icon and the word Inbox', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const item: Seed = { type: 'task', id: 'i1', fields: { kind: 'inbox', title: 'Book dentist' } };
  const errors = await open(page, [planned, item, block('bi', { task_id: 'i1' }, '17:45', '18:45')]);
  await settled(page);
  const drawn = page.getByRole(phone ? 'slider' : 'button', { name: 'Book dentist, 5:45pm to 6:45pm, Inbox.' });
  await drawn.scrollIntoViewIfNeeded();
  await expect(drawn).toHaveClass(/\bk-inbox\b/);
  await expect(drawn.locator('svg[data-icon="inbox"]')).toBeVisible();
  expect(await drawn.evaluate((el) => getComputedStyle(el).borderLeftStyle)).toBe('dashed');

  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Week' }).click();
  const week = page.getByRole('button', { name: phone ? 'Book dentist, 5:45pm to 6:45pm, Inbox.' : 'Book dentist, Mon Nov 2, 5:45pm to 6:45pm, Inbox.' });
  await week.scrollIntoViewIfNeeded();
  await expect(week).toHaveClass(/\bk-inbox\b/);
  await expect(week.locator('svg[data-icon="inbox"]')).toBeVisible();
  if (phone) await expect(week).toContainText('Inbox, 1h');
  await week.click();
  await expect(page.getByRole('dialog', { name: 'Book dentist' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a block held on phone lifts with one light tap from the device; a mouse drag on desktop taps nothing', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  // A phone browser that can vibrate, as on Android, noting each one. WebKit has no vibrate of its own.
  await page.addInitScript(() => {
    const taps: unknown[] = [];
    Object.defineProperty(navigator, 'vibrate', { value: (pattern: unknown) => taps.push(pattern) > 0, configurable: true });
    Object.assign(window, { taps });
  });
  const errors = await open(page, [planned, report, block('b1', { task_id: 't1' }, '16:00', '17:00')]);
  await settled(page);
  const b = page.getByRole(phone ? 'slider' : 'button', { name: /^Write the report, 4pm to 5pm/ });
  await b.scrollIntoViewIfNeeded();
  const box = (await b.boundingBox())!;
  // The first zoom draws 30px an hour, so 15px down is half an hour later.
  if (phone) await touchDrag(page, b, { x: box.x + box.width / 2, y: box.y + box.height / 2 + 15 });
  else {
    await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2 + 15, { steps: 4 });
    await page.mouse.up();
  }
  await expect(page.getByText('Write the report is now 4:30pm to 5:30pm.')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { taps: unknown[] }).taps)).toEqual(phone ? [10] : []);
  expect(errors).toEqual([]);
});


/**
 * Puts a pointer down on the day at a time: a finger on phone, a mouse on desktop. The day is measured in the same moment,
 * since what loads above it can still move it down the page. Returns where it pressed.
 */
async function pressOnDay(page: Page, time: string, phone: boolean) {
  await page.locator('.day').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const [h, m] = time.split(':').map(Number);
  return page.evaluate(
    ({ minutes, pointerType }) => {
      // From 7am, 30px an hour at the first zoom.
      const box = document.querySelector('.day')!.getBoundingClientRect();
      const at = { x: box.x + box.width * 0.6, y: box.y + ((minutes - 420) / 60) * 30 };
      const init = { bubbles: true, cancelable: true, pointerId: 7, pointerType, isPrimary: true, button: 0, buttons: 1, clientX: at.x, clientY: at.y };
      document.elementFromPoint(at.x, at.y)!.dispatchEvent(new PointerEvent('pointerdown', init));
      return at;
    },
    { minutes: h! * 60 + (m ?? 0), pointerType: phone ? 'touch' : 'mouse' },
  );
}

async function letGo(page: Page, at: { x: number; y: number }, phone: boolean) {
  await page.evaluate(
    ({ x, y, pointerType }) => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, pointerType, isPrimary: true, button: 0, clientX: x, clientY: y })),
    { ...at, pointerType: phone ? 'touch' : 'mouse' },
  );
}

/** Counts each ring as it's drawn, since it's gone again in moments. */
const countRings = (page: Page) =>
  page.evaluate(() => {
    const seen = window as unknown as { rings: number };
    seen.rings = 0;
    new MutationObserver((changes) => {
      for (const c of changes) for (const n of c.addedNodes) if (n instanceof Element && n.classList.contains('holdring')) seen.rings++;
    }).observe(document.body, { childList: true, subtree: true });
  });
const rings = (page: Page) => page.evaluate(() => (window as unknown as { rings: number }).rings);

test('a press held on empty time drafts an hour there with a ring, and Capture opens on it; Save puts it on the calendar as an Inbox item, with Undo', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, report, block('b1', { task_id: 't1' }, '16:00', '17:00')]);
  await settled(page);
  await countRings(page);
  const at = await pressOnDay(page, '17:50', phone);
  const draft = page.locator('.cev.holddraft');
  await expect(draft).toBeVisible();
  await expect(draft).toContainText('New task');
  await expect(draft).toHaveAttribute('title', '5:45pm to 6:45pm');
  await expect(draft).toHaveClass(/\bs-placing\b/);
  await expect.poll(() => rings(page)).toBe(1);
  await page.screenshot({ path: info.outputPath('hold-draft.png') });
  await letGo(page, at, phone);

  const capture = page.getByRole('dialog', { name: 'Capture' });
  await expect(capture.getByText('Today, 5:45pm to 6:45pm')).toBeVisible();
  const field = capture.getByRole('textbox', { name: 'Capture to Inbox' });
  await expect(field).toBeFocused();
  await page.keyboard.type('Book dentist');
  await expect(draft).toContainText('Book dentist');
  // The draft stays in view beside Capture on desktop, and above its sheet on phone.
  const sheet = (await capture.boundingBox())!;
  const drawn = (await draft.boundingBox())!;
  const apart = drawn.x + drawn.width <= sheet.x || sheet.x + sheet.width <= drawn.x || drawn.y + drawn.height <= sheet.y || sheet.y + sheet.height <= drawn.y;
  expect(apart, 'Capture covers the draft').toBe(true);
  if (phone) expect(drawn.y + drawn.height).toBeLessThanOrEqual(sheet.y);
  await page.screenshot({ path: info.outputPath('hold-capture.png') });
  await page.keyboard.press('Enter');

  await expect(page.locator('.toast')).toContainText('Saved to Inbox, 5:45pm to 6:45pm');
  await expect(draft).toHaveCount(0);
  const saved = page.getByRole(phone ? 'slider' : 'button', { name: 'Book dentist, 5:45pm to 6:45pm, Inbox.' });
  await expect(saved).toHaveClass(/\bk-inbox\b/);
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(saved).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a press held on time gone by drafts nothing, and a toast says why; a quick press drafts nothing either', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, report, block('b1', { task_id: 't1' }, '16:00', '17:00')]);
  await settled(page);
  const past = await pressOnDay(page, '13:00', phone);
  await page.waitForTimeout(600);
  await letGo(page, past, phone);
  await expect(page.locator('.toast')).toContainText('That time has gone by. Hold on a later time.');
  await expect(page.locator('.cev.holddraft')).toHaveCount(0);

  const later = await pressOnDay(page, '18:00', phone);
  await letGo(page, later, phone);
  await page.waitForTimeout(600);
  await expect(page.locator('.cev.holddraft')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Capture' })).toHaveCount(0);
  expect(errors).toEqual([]);
});
