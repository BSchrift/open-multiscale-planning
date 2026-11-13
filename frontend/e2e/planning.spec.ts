import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm, with this week not yet planned.

const records: Seed[] = [
  { type: 'project', id: 'report', fields: { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-15', weekly_aim: 240 } },
  { type: 'milestone', id: 'm1', fields: { project_id: 'report', title: 'Gather notes', due: '2026-10-18' } },
  { type: 'milestone', id: 'm2', fields: { project_id: 'report', title: 'Draft chapters', due: '2026-11-09' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'report', milestone_id: 'm1', title: 'Collect the sources', estimate_min: 120 } },
  { type: 'task', id: 't2', fields: { kind: 'project', project_id: 'report', milestone_id: 'm2', title: 'Write chapter one', estimate_min: 240 } },
  { type: 'project', id: 'bread', fields: { title: 'Learn to bake bread', state: 'active', start: '2026-10-15', end: '2027-02-28', weekly_aim: 120 } },
  { type: 'milestone', id: 'm3', fields: { project_id: 'bread', title: 'Shape the first loaf', due: '2026-12-01' } },
  { type: 'task', id: 'b1', fields: { kind: 'project', project_id: 'bread', milestone_id: 'm3', title: 'Bake a test loaf', estimate_min: 180 } },
  { type: 'task', id: 'o1', fields: { kind: 'one_off', title: 'Paint the fence', estimate_min: 90, schedule: { type: 'once', from: '2026-11-04' } } },
  { type: 'task', id: 'i1', fields: { kind: 'inbox', title: 'Rake the leaves' } },
];

const steps = (page: Page) => page.getByRole('navigation', { name: 'Planning steps' });

async function startPlanning(page: Page) {
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await page.getByRole('button', { name: 'Start planning' }).first().click();
  await expect(steps(page)).toBeVisible();
}

test('plans a week: Inbox, pick with the capacity ring, then finish at Review', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await startPlanning(page);

  // Inbox
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Process 1 item' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue to picking tasks' }).click();

  // Pick: a task's title opens its popup, and a rename shows at once, with focus back on the title.
  if (!phone) await page.getByRole('button', { name: /^Write the report,/ }).click();
  await page.getByRole('button', { name: /^Edit task Write chapter one/ }).click();
  const editor = page.getByRole('dialog', { name: 'Write chapter one' });
  await editor.getByRole('button', { name: 'Rename Write chapter one' }).click();
  await editor.getByRole('textbox', { name: 'Name' }).fill('Write the first chapter');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toHaveCount(0);
  const renamed = page.getByRole('button', { name: /^Edit task Write the first chapter/ });
  await expect(renamed).toBeFocused();
  if (phone) expect((await renamed.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // Its estimate opens a slider, and Mark done finishes it in place, struck through, until Undo.
  const est = page.getByRole('button', { name: /^Estimate for Write the first chapter:/ });
  if (phone) await expectTapTarget(est);
  await est.click();
  const pop = page.getByRole('dialog', { name: 'Estimate for Write the first chapter' });
  const slider = pop.getByRole('slider', { name: 'Estimate' });
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', '5h');
  // Back where it was, so the suggestions below stay as they are, and Save has nothing to write.
  await page.keyboard.press('ArrowLeft');
  if (phone) await expectTapTarget(pop.getByRole('button', { name: 'Save' }));
  await pop.getByRole('button', { name: 'Save' }).click();
  await expect(pop).toHaveCount(0);
  const done = page.getByRole('button', { name: 'Mark Write the first chapter done' });
  if (phone) await expectTapTarget(done);
  await done.click();
  const undo = page.getByRole('button', { name: 'Undo finishing Write the first chapter' });
  await expect(undo).toBeVisible();
  await page.screenshot({ path: info.outputPath(`pick-done-${info.project.name}.png`) });
  await undo.click();
  await expect(page.getByRole('button', { name: 'Mark Write the first chapter done' })).toBeVisible();

  if (phone) {
    // The board opens on the first project, with its tasks in a half-height sheet.
    const sheet = page.getByRole('region', { name: 'Tasks in Write the report' });
    await expect(sheet).toBeVisible();
    await expect(page.getByRole('button', { name: /^Write the report, Overdue/ })).toContainText('★2');
    const add = sheet.getByRole('button', { name: 'Add Collect the sources' });
    const box = await add.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await add.click();
    await expect(page.locator('.donut .dlabel')).toHaveText('+2h');
    await expect(sheet.getByRole('button', { name: 'Remove Collect the sources' })).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: info.outputPath('pick-phone.png') });

    await page.getByRole('button', { name: 'Next project' }).click();
    const bread = page.getByRole('region', { name: 'Tasks in Learn to bake bread' });
    await expect(bread.getByText('★ 2h of 3h')).toBeVisible();
    await bread.getByRole('button', { name: 'Add Bake a test loaf' }).click();

    await page.getByRole('button', { name: /^Planned for Nov 2 to 8, 3 tasks/ }).click();
    const planned = page.getByRole('dialog', { name: 'Planned for Nov 2 to 8' });
    await expect(planned.getByText('Paint the fence', { exact: true })).toBeVisible();
    await planned.getByRole('button', { name: 'Close' }).click();
    await expect(planned).toHaveCount(0);

    await steps(page).getByRole('button', { name: 'Review' }).click();
  } else {
    await page.getByRole('button', { name: 'Add Collect the sources to the plan' }).click();
    const planned = page.getByRole('complementary', { name: 'Time this week' });
    await expect(planned.getByText('Collect the sources', { exact: true })).toBeVisible();
    await expect(planned.getByText('Paint the fence', { exact: true })).toBeVisible();
    await expect(planned.locator('.donut')).toBeVisible();
    await page.getByRole('img', { name: 'Weekly aim 4h, 2h planned, 2h short' }).waitFor();
    await page.screenshot({ path: info.outputPath('pick-desktop.png') });

    await planned.getByRole('button', { name: 'Add suggested (6h)' }).click();
    await expect(planned.getByText('Bake a test loaf', { exact: true })).toBeVisible();

    await steps(page).getByRole('button', { name: '4. Review' }).click();
  }

  // Review: nothing is placed yet, so the aims aren't reached, and finishing is still allowed.
  await expect(page.getByRole('heading', { name: '2 aims not reached' })).toBeVisible();
  await expect(page.getByText(/of what you picked isn't scheduled/)).toBeVisible();
  await page.screenshot({ path: info.outputPath(`review-${info.project.name}.png`) });
  await page.getByRole('button', { name: 'Finish plan' }).click();
  await expect(steps(page)).toHaveCount(0);
  await expect(page.getByText('Week planned.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('week arrows have no limit, with This week to come back, and the step is kept', async ({ page }) => {
  await startPlanning(page);
  const next = page.getByRole('button', { name: 'Next week' });
  for (let i = 0; i < 6; i++) await next.click();
  await expect(page.getByText('Dec 14 to 20')).toBeVisible();
  await page.getByRole('button', { name: 'This week' }).click();
  await expect(page.getByText('Nov 2 to 8')).toBeVisible();
  await expect(page.getByRole('button', { name: 'This week' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Continue to picking tasks' }).click();
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await expect(steps(page)).toHaveCount(0);
  await page.getByRole('button', { name: /Start planning|Continue planning/ }).first().click();
  await expect(steps(page).locator('[aria-current="step"]')).toHaveText(/Pick/);
});
