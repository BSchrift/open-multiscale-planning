// A block on Week once it's placed: its details on desktop, its length on both layouts, Remove on phone, and a past
// week, which can be read but not changed. week.spec.ts has moving blocks, To schedule and the week arrows.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded, pane } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm in Chicago.
const chicago = (month: number, day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  // Chicago is six hours behind UTC in November, and five in October, before the clocks change on November 1.
  return new Date(Date.UTC(2026, month - 1, day, h! + (month === 11 ? 6 : 5), m ?? 0)).toISOString().replace('.000Z', 'Z');
};
const at = (day: number, time: string) => chicago(11, day, time);

const records: Seed[] = [
  { type: 'week_plan', id: 'week:2026-11-02', fields: { week_start: '2026-11-02', finished_at: at(2, '08:00') } },
  { type: 'project', id: 'p', fields: { title: 'Annual report', state: 'active', start: '2026-10-01', end: '2026-12-31' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p', title: 'Draft the summary', estimate_min: 120 } },
  { type: 'task', id: 't2', fields: { kind: 'one_off', title: 'Paint the fence', estimate_min: 60 } },
  { type: 'practice', id: 'pr', fields: { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' } },
  { type: 'time_block', id: 'b1', fields: { task_id: 't1', start: at(3, '18:00'), end: at(3, '19:00'), tz: 'America/Chicago' } },
  { type: 'time_block', id: 'b2', fields: { practice_id: 'pr', start: at(4, '07:00'), end: at(4, '07:30'), tz: 'America/Chicago' } },
  // This morning's, done.
  { type: 'time_block', id: 'b3', fields: { task_id: 't2', start: at(2, '09:00'), end: at(2, '10:00'), tz: 'America/Chicago' } },
  { type: 'block_outcome', id: 'outcome:b3', fields: { result: 'done', answered_at: at(2, '10:00') } },
];

async function openWeek(page: Page, list = records) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, list);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Week' }).click();
  return errors;
}

test("desktop: a block clicked on the grid shows its details beside the week, whose name opens the task, and Close gives focus back", async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'The grid is the desktop layout');
  const errors = await openWeek(page);
  const summary = page.getByRole('button', { name: 'Draft the summary, Tue Nov 3, 6pm to 7pm, Project.' });
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await summary.click();
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  const detail = page.getByRole('region', { name: 'Draft the summary' });
  await expect(detail.getByText('6pm to 7pm')).toBeVisible();
  await expect(detail).toContainText('Project: Annual report');
  await page.screenshot({ path: info.outputPath('week-block-detail.png') });
  await detail.getByRole('button', { name: 'Close' }).click();
  await expect(detail).toHaveCount(0);
  await expect(summary).toBeFocused();
  await expect(summary).toHaveAttribute('aria-expanded', 'false');

  // A second click on the block closes it too; one block's details at a time.
  await summary.click();
  await expect(detail).toBeVisible();
  const piano = page.getByRole('button', { name: 'Piano practice, Wed Nov 4, 7am to 7:30am, Practice.' });
  await piano.click();
  await expect(detail).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Piano practice' })).toContainText('Practice:');
  await piano.click();
  await expect(page.getByRole('region', { name: 'Piano practice' })).toHaveCount(0);

  // A block that's been answered says how it went.
  await page.getByRole('button', { name: 'Paint the fence, Mon Nov 2, 9am to 10am, One off. Done.' }).click();
  const fence = page.getByRole('region', { name: 'Paint the fence' });
  await expect(fence.getByText('Done', { exact: true })).toBeVisible();
  await expect(fence).toContainText('One off: No date');

  // A task's name opens the task.
  await page.getByRole('button', { name: 'Draft the summary, Tue Nov 3, 6pm to 7pm, Project.' }).click();
  await detail.getByRole('button', { name: 'Draft the summary' }).click();
  await expect(page.getByRole('dialog', { name: 'Draft the summary' }).getByRole('button', { name: 'Delete task' })).toBeVisible();
  expect(errors).toEqual([]);
});

test("desktop: while editing, a block's bottom edge snaps its length to the quarter hour, and Shift and the arrow keys step it, never under 15 minutes", async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'The grid is the desktop layout');
  const errors = await openWeek(page);
  await page.getByRole('button', { name: "Edit this week's plan" }).click();
  await expect(page.getByRole('heading', { name: 'Editing this week' })).toBeVisible();
  const summary = page.getByRole('group', { name: /^Draft the summary, Tue Nov 3, 6pm to 7pm/ });
  // An hour's height, so the drag is about 20 minutes whatever the grid's scale.
  const hour = (await summary.boundingBox())!.height;
  const edge = (await summary.locator('.evh').boundingBox())!;
  const x = edge.x + edge.width / 2;
  await page.mouse.move(x, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, edge.y + edge.height / 2 + hour / 6, { steps: 3 });
  await page.mouse.move(x, edge.y + edge.height / 2 + (hour * 20) / 60, { steps: 3 });
  await page.mouse.up();
  await expect(page.getByRole('group', { name: /^Draft the summary, Tue Nov 3, 6pm to 7:15pm/ })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Last change' })).toContainText('Draft the summary, Tue Nov 3, 6pm to 7:15pm');

  await page.getByRole('group', { name: /^Draft the summary, Tue Nov 3, 6pm to 7:15pm/ }).focus();
  for (const end of ['7:30pm', '7:15pm', '7pm', '6:45pm', '6:30pm', '6:15pm']) {
    await page.keyboard.press(end === '7:30pm' ? 'Shift+ArrowDown' : 'Shift+ArrowUp');
    await expect(page.getByRole('group', { name: new RegExp(`^Draft the summary, Tue Nov 3, 6pm to ${end}`) })).toBeFocused();
  }
  // At 15 minutes it stops.
  await page.keyboard.press('Shift+ArrowUp');
  await expect(page.getByRole('group', { name: /^Draft the summary, Tue Nov 3, 6pm to 6:15pm/ })).toBeFocused();
  await page.getByRole('button', { name: 'Done editing' }).click();
  await expect(page.getByRole('button', { name: /^Draft the summary, Tue Nov 3, 6pm to 6:15pm, Project\./ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("phone: a block's sheet changes its length on a slider, and Remove takes it off with Undo", async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'The strip is the phone layout');
  const errors = await openWeek(page);
  await page.getByRole('group', { name: 'Choose a day' }).getByRole('button').nth(1).click();
  await expect(page.getByRole('heading', { name: 'Tue Nov 3' })).toBeVisible();
  await page.getByRole('button', { name: /^Draft the summary, 6pm to 7pm, Project\./ }).click();
  const sheet = page.getByRole('dialog', { name: 'Draft the summary' });
  const length = sheet.getByRole('slider', { name: 'Length' });
  await expect(length).toHaveAttribute('aria-valuetext', '1h');
  for (const name of ['Move', 'Remove', 'Close']) await expectTapTarget(sheet.getByRole('button', { name, exact: true }));
  await expectTapTarget(length);
  await length.focus();
  await page.keyboard.press('ArrowRight');
  await expect(length).toHaveAttribute('aria-valuetext', '1h 15m');
  await expect(sheet.getByText('Tue Nov 3, 6pm to 7:15pm')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(sheet.getByText('Tue Nov 3, 6pm to 6:45pm')).toBeVisible();
  await page.screenshot({ path: info.outputPath('week-phone-length.png') });

  await sheet.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByText('Removed Draft the summary')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Draft the summary, / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeFocused();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: /^Draft the summary, 6pm to 6:45pm, Project\./ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a past week can be read but not changed: its blocks don't move or edit, opening only on desktop, and it links to that week's analytics", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const last: Seed[] = [
    { type: 'time_block', id: 'b9', fields: { task_id: 't1', start: chicago(10, 27, '10:00'), end: chicago(10, 27, '11:00'), tz: 'America/Chicago' } },
    { type: 'block_outcome', id: 'outcome:b9', fields: { result: 'done', answered_at: chicago(10, 27, '11:00') } },
  ];
  const errors = await openWeek(page, [...records, ...last]);
  await page.getByRole('button', { name: 'Previous week' }).click();
  await expect(page.getByRole('heading', { name: 'Past week' })).toBeVisible();
  await expect(page.getByText('Past weeks can be viewed but not changed.')).toBeVisible();
  await expect(page.getByRole('button', { name: "Edit this week's plan" })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'To schedule' })).toHaveCount(0);

  if (phone) {
    await page.getByRole('group', { name: 'Choose a day' }).getByRole('button').nth(1).click();
    await expect(page.getByRole('heading', { name: 'Tue Oct 27' })).toBeVisible();
    // Shown in its row, but not a button: on phone a past block has nothing to open, move or change.
    const row = page.locator('.tlrow', { hasText: 'Draft the summary' });
    await expect(row).toContainText('10amDraft the summaryProject, 1h');
    await expect(row.getByRole('button')).toHaveCount(0);
  } else {
    // A button to open, not a block to drag: the arrow keys leave it where it was.
    const b = page.getByRole('button', { name: 'Draft the summary, Tue Oct 27, 10am to 11am, Project. Done.' });
    await expect(page.getByRole('group', { name: /^Draft the summary/ })).toHaveCount(0);
    await b.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await expect(b).toBeVisible();
    await b.click();
    await expect(page.getByRole('region', { name: 'Draft the summary' }).getByText('Done', { exact: true })).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath(`week-past-${info.project.name}.png`) });

  const analytics = page.getByRole('button', { name: phone ? "See that week's analytics" : "See this week's analytics" });
  if (phone) await expectTapTarget(analytics);
  await analytics.click();
  const a = pane(page, 'Analytics');
  await expect(a.getByText('Oct 26 to Nov 1')).toBeVisible();
  await expect(a.getByText('Past week')).toBeVisible();
  expect(errors).toEqual([]);
});
