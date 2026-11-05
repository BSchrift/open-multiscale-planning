import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded } from './seed';
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

test('desktop: drag a block to another day and time, then remove it with Undo', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'The grid is the desktop layout');
  const errors = await openWeek(page);
  await expect(page.getByRole('button', { name: /^Draft the summary, Tue Nov 3, 6pm to 7pm, Project\. Conflicts with Quiz night\./ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('week-desktop.png') });

  await page.getByRole('button', { name: "Edit this week's plan" }).click();
  await expect(page.getByRole('heading', { name: 'Editing this week' })).toBeVisible();
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
  const thursday = strip.getByRole('button', { name: /^Thu.*no slot for this task$/ });
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
