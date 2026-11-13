import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { expectTapTarget, openSeeded, pane } from './seed';
import type { Seed } from './seed';

// When will you plan this week, opened from Week's Choose a time: the sheet shows whole, over the tab bar and the +
// button, and Choose another time places the planning block on the calendar, beside what's busy, by hand.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm in Chicago, this week not yet planned.
// Chicago is six hours behind UTC in November.
const at = (day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, day, h! + 6, m ?? 0)).toISOString().replace('.000Z', 'Z');
};

const records: Seed[] = [
  { type: 'project', id: 'p', fields: { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-31' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p', title: 'Draft the summary', estimate_min: 120 } },
  { type: 'time_block', id: 'b1', fields: { task_id: 't1', start: at(3, '18:00'), end: at(3, '19:00'), tz: 'America/Chicago' } },
  { type: 'calendar', id: 'calendar', fields: { connected: true, events: [{ id: 'e1', calendar: 'work', title: 'Quiz night', start: at(4, '18:30'), end: at(4, '20:00') }] } },
];

/** Whether the middle of a control is the control, not something drawn over it. */
const onTop = (target: Locator) =>
  target.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!hit && e.contains(hit);
  });

async function openSheet(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Week' }).click();
  await page.getByRole('button', { name: 'Choose a time to plan this week' }).click();
  return { errors, sheet: page.getByRole('dialog', { name: 'When will you plan this week?' }) };
}

test('the sheet shows whole, over the tab bar and the + button', async ({ page }, info) => {
  const { errors, sheet } = await openSheet(page);
  await expect(sheet).toBeVisible();
  // Every control in it can be reached, none under anything else.
  for (const button of await sheet.getByRole('button').all()) {
    await button.scrollIntoViewIfNeeded();
    expect(await onTop(button), (await button.textContent()) ?? '').toBe(true);
    if (info.project.name === 'phone') await expectTapTarget(button);
  }
  await expect(sheet.getByLabel('Day', { exact: true })).toHaveCount(0);
  if (info.project.name === 'phone') {
    // The tab bar and + sit under the sheet's backdrop.
    expect(await onTop(page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Today' }))).toBe(false);
    expect(await onTop(page.getByRole('button', { name: 'Capture a task' }))).toBe(false);
    // The narrowest iPhones in use are 375pt wide, and short.
    await page.setViewportSize({ width: 375, height: 667 });
    await sheet.getByRole('button', { name: 'Close' }).scrollIntoViewIfNeeded();
    expect(await onTop(sheet.getByRole('button', { name: 'Close' }))).toBe(true);
    const box = (await sheet.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await sheet.evaluate((e) => e.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath('planning-sheet.png') });
  expect(errors).toEqual([]);
});

/** 'Tue Nov 3, 6:15pm to 6:45pm' read off the block, as the toast says it: 'Tue 6:15pm'. */
const said = (when: string) => {
  const [, day, time] = /(Mon|Tue|Wed|Thu|Fri|Sat|Sun) Nov \d+, (\S+) to /.exec(when)!;
  return `${day} ${time}`;
};

test('Choose another time: the block waits on the calendar to drag beside what is busy, and Place here schedules it', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const { errors, sheet } = await openSheet(page);
  await sheet.getByRole('button', { name: 'Choose another time' }).click();
  await expect(sheet).toHaveCount(0);
  let when: string;
  if (phone) {
    await expect(page.getByText('Placing Plan the week of Nov 2, 30m')).toBeVisible();
    const handle = page.getByRole('slider', { name: /^Time for Plan the week of Nov 2/ });
    await expect(handle).toBeFocused();
    // Wednesday, beside Quiz night, then a quarter hour later by key.
    await page.getByRole('group', { name: 'Choose a day' }).getByRole('button').nth(2).click();
    await expect(page.getByRole('heading', { name: 'Wed Nov 4' })).toBeVisible();
    await expect(pane(page, 'Week').getByText('Quiz night')).toBeVisible();
    await handle.focus();
    const before = (await handle.getAttribute('aria-valuetext'))!;
    await page.keyboard.press('ArrowDown');
    await expect(handle).not.toHaveAttribute('aria-valuetext', before);
    when = (await handle.getAttribute('aria-valuetext'))!;
    await page.screenshot({ path: info.outputPath('planning-place-phone.png') });
    await expectTapTarget(page.getByRole('button', { name: 'Place here' }));
  } else {
    const block = page.getByRole('group', { name: /^Plan the week of Nov 2, .*Enter places it\.$/ });
    await expect(block).toBeFocused();
    const was = (await block.getAttribute('aria-label'))!;
    // A day later and an hour later: one column right, and 40px down at 40px an hour.
    const box = (await block.boundingBox())!;
    const column = (await page.locator('.colbody').first().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + column.width / 2, box.y + 30, { steps: 4 });
    await page.mouse.move(box.x + box.width / 2 + column.width + 2, box.y + 48, { steps: 4 });
    await page.mouse.up();
    await expect(block).not.toHaveAttribute('aria-label', was);
    when = (await block.getAttribute('aria-label'))!;
    await expect(pane(page, 'Week').getByText('Quiz night')).toBeVisible();
    await block.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('planning-place-desktop.png') });
  }
  await page.getByRole('button', { name: 'Place here' }).click();
  await expect(page.getByText(`Planning scheduled for ${said(when)}.`)).toBeVisible();
  await expect(page.getByRole('region', { name: `Planning is set for ${said(when)}.` })).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(pane(page, 'Week').getByText("This week isn't planned yet. About 30m.")).toBeVisible();
  expect(errors).toEqual([]);
});
