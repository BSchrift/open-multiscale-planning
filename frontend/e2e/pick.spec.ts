// Pick tasks, this stretch first, at desktop and phone size: every way a task could go unseen, walked on the proposal's
// sample week, and the toggle that shows what's outside this stretch in place.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NOW, SAMPLE } from './pick-sample';
import { expectTapTarget, openSeeded } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

async function openPick(page: Page, records: readonly Seed[] = SAMPLE, now = NOW) {
  await page.clock.install({ time: now });
  await openSeeded(page, records);
  await page.getByRole('button', { name: 'Start planning' }).first().click();
  await page.getByRole('button', { name: 'Continue to picking tasks' }).click();
  await expect(page.getByRole('heading', { name: /^Pick tasks/ })).toBeVisible();
}

const project = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const row = (page: Page, title: string) => page.locator('li', { has: page.getByRole('button', { name: `Edit task ${title}`, exact: true }) });

test('walks every way a task could go unseen, and the toggle shows the rest in place', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await openPick(page);

  // 1. Work that needs you from outside this stretch shows, with the reason, first by date.
  const photo = project(page, 'Sort the photo albums');
  await expect(page.locator('.plist > section').first()).toHaveAttribute('aria-label', 'Sort the photo albums');
  await expect(photo.getByRole('heading', { level: 3 })).toHaveText(phone ? 'Sort the photo albumsOverdue, last stretch, overdue from the last stretch, outside this stretch' : 'Sort the photo albumsOverdue, from last stretch, overdue from the last stretch, outside this stretch');
  await expect(photo.getByRole('button', { name: 'Add 1h 30m to this week: Scan the last box, Sort the photo albums, outside this stretch' })).toBeVisible();

  // 4. Behind pace outside this stretch: shown with the reason, its tasks folded and counted, no estimate too (10).
  const guitar = project(page, 'Learn the guitar');
  await expect(guitar.getByRole('heading', { level: 3 })).toContainText('Behind pace');
  await expect(guitar.getByRole('button', { name: 'Show 3 tasks in Learn the guitar, outside this stretch: Learn three songs, by Jan 31, 1h 30m, 1 with no estimate' })).toBeVisible();

  // 9. New since the stretch was planned: shown whole, tagged.
  const garden = project(page, 'Plan the garden');
  await expect(garden.getByRole('heading', { level: 3 })).toContainText(phone ? 'New' : 'New since you planned this stretch');
  await expect(row(page, 'Choose the beds')).toBeVisible();

  // 10. No estimate says so on the row.
  await expect(row(page, 'Make the charts')).toContainText('No estimate');

  // 8. A project is a heading, never a button, so it can't be closed.
  await expect(page.locator('.plist h3 button')).toHaveCount(0);

  // 5. A task that needs a new time asks on its row; on phone Answer opens the three choices in place.
  const measure = page.locator('li[data-task="k3"]');
  if (phone) {
    const answer = measure.getByRole('button', { name: 'Answer: Measure the walls, needs a new time' });
    await expectTapTarget(answer);
    await answer.click();
    await expect(answer).toHaveAttribute('aria-expanded', 'true');
  }
  await expect(measure.getByRole('button', { name: 'Keep Measure the walls in the plan' })).toBeVisible();

  // 6. A fold names its milestone, date and count; opened, it stays as Hide and focus moves to the task it showed.
  const kitchen = project(page, 'Kitchen renovation');
  const fold = kitchen.getByRole('button', { name: 'Show 1 task in Kitchen renovation, outside this stretch: Book the fitters, due Jan 15, 30m' });
  await expect(fold).toHaveText(/Show Book the fitters, due Jan 15 · 1 task, 30m/);
  if (phone) await expectTapTarget(fold);
  await fold.click();
  await expect(row(page, 'Ask neighbours for fitter recommendations')).toBeFocused();
  const hide = kitchen.getByRole('button', { name: 'Hide 1 task in Kitchen renovation' });
  await expect(hide).toHaveAttribute('aria-expanded', 'true');
  if (phone) await expectTapTarget(hide);
  await hide.click();
  await expect(kitchen.getByRole('button', { name: /^Show 1 task in Kitchen renovation/ })).toBeFocused();

  // A milestone with a task in the week shows whole; the shed's other one folds.
  const shed = project(page, 'Build the garden shed');
  await expect(shed.getByRole('heading', { level: 3 })).toContainText('In this week');
  await expect(row(page, 'Order the timber')).toBeVisible();
  await expect(shed.getByRole('button', { name: /^Show 2 tasks in Build the garden shed, outside this stretch: Raise the walls, due Mar 20, 1h 30m$/ })).toBeVisible();

  // 11. One offs always show, and what's still in the Inbox is counted, with a way back.
  const oneOffs = project(page, 'One offs');
  await expect(oneOffs.getByRole('heading', { level: 4 })).toHaveText(['This week', 'Later or no date']);
  await expect(oneOffs).toContainText('2 still in your Inbox. Sort them to pick them here.');

  // 12. One number before Continue, and Show lists them by reason.
  const name = 'Continue to scheduling, 6 need you';
  await expect(page.getByRole('button', { name })).toBeVisible();
  if (phone) await expect(page.locator('.needstrip')).toHaveText('6 need you · 2 to answer, 1 new time, 3 dueShow');
  else await expect(page.locator('.needyou')).toHaveText('6 need you: 2 questions to answer, 1 task that needs a new time, 3 due or overdue not in the week. Show the 6');
  await page.screenshot({ path: info.outputPath(`pick-stretch-${info.project.name}.png`) });
  const show = page.getByRole('button', { name: phone ? 'Show the 6 that need you: 2 to answer, 1 needs a new time, 3 due or overdue.' : 'Show the 6 that need you' });
  if (phone) await expectTapTarget(show);
  await show.click();
  const dialog = page.getByRole('dialog', { name: 'Need you (6)' });
  await expect(dialog.getByRole('heading', { level: 3 })).toHaveText(['To answer (2)', 'Needs a new time (1)', 'Due or overdue, not in the week (3)']);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);

  // The toggle: nothing of the cookbook needs you, so it's hidden whole until the lede shows it, in place.
  await expect(project(page, 'Write a cookbook')).toHaveCount(0);
  const lede = page.locator('.plede').getByRole('button', { name: 'Show 10 more tasks outside this stretch' });
  await expect(lede).toHaveAttribute('aria-expanded', 'false');
  await lede.click();
  await expect(page.locator('.plede').getByRole('button', { name: 'Hide 10 tasks outside this stretch' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-outside]')).toHaveText('Showing 10 more tasks, in date order: 1 in Kitchen renovation, 3 in Learn the guitar, 2 in Build the garden shed, 4 in Write a cookbook.');
  await expect(project(page, 'Write a cookbook')).toBeVisible();
  await expect(project(page, 'Learn Spanish')).toContainText("Can't be planned while paused.");
  await page.getByRole('button', { name: 'Go to Write a cookbook' }).click();
  await expect(row(page, 'List the recipes')).toBeFocused();
  await page.screenshot({ path: info.outputPath(`pick-stretch-open-${info.project.name}.png`) });

  if (phone) {
    // 7. Past the fold: the real heading sticks as its tasks scroll under it, and the strip stays at any scroll.
    const scroll = page.locator('.pkscroll');
    await scroll.evaluate((el) => el.scrollBy(0, 900));
    const stuck = await scroll.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return !!document.elementFromPoint(r.left + 40, r.top + 8)?.closest('.pph');
    });
    expect(stuck).toBe(true);
    await expect(page.locator('.needstrip')).toBeInViewport();
  }
});

test('walk case 2: with the next stretch planned early, both plans count, and only work in neither folds', async ({ page }) => {
  const seed: Seed[] = [
    { type: 'settings', id: 'settings', fields: { plan_stretch: { last_planned: '2027-01-01' } } },
    { type: 'project', id: 'kitchen', fields: { title: 'Kitchen renovation', state: 'active', start: '2026-09-01', end: '2027-06-30' } },
    { type: 'milestone', id: 'tops', fields: { project_id: 'kitchen', title: 'Fit the worktops', due: '2026-12-20' } },
    { type: 'milestone', id: 'fitters', fields: { project_id: 'kitchen', title: 'Book the fitters', due: '2027-01-15' } },
    { type: 'milestone', id: 'apps', fields: { project_id: 'kitchen', title: 'Order the appliances', due: '2027-04-10' } },
    { type: 'task', id: 'k0', fields: { kind: 'project', project_id: 'kitchen', title: 'Strip the old units', estimate_min: 900, done_at: '2026-10-01T15:00:00Z' } },
    { type: 'task', id: 'k1', fields: { kind: 'project', project_id: 'kitchen', milestone_id: 'tops', title: 'Choose the worktop', estimate_min: 60 } },
    { type: 'task', id: 'k2', fields: { kind: 'project', project_id: 'kitchen', milestone_id: 'fitters', title: 'Ask neighbours for fitter recommendations', estimate_min: 30 } },
    { type: 'task', id: 'k3', fields: { kind: 'project', project_id: 'kitchen', milestone_id: 'apps', title: 'Pick the fridge', estimate_min: 120 } },
  ];
  await openPick(page, seed, new Date('2026-12-07T20:00:00Z'));
  const kitchen = project(page, 'Kitchen renovation');
  await expect(row(page, 'Choose the worktop')).toBeVisible();
  await expect(row(page, 'Ask neighbours for fitter recommendations')).toBeVisible();
  await expect(row(page, 'Pick the fridge')).toHaveCount(0);
  await expect(kitchen.getByRole('button', { name: 'Show 1 task in Kitchen renovation, outside this stretch: Order the appliances, due Apr 10, 2h' })).toBeVisible();
});

test('walk case 3: a milestone added here is tagged to this stretch, reads "by Dec 31" and never folds', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await openPick(page);
  const report = project(page, 'Write the quarterly report');
  if (phone) {
    // The bottom bar's + adds to the project under the sticky name, the first one here.
    await page.getByRole('button', { name: 'Add a task, one off, milestone or project' }).click();
    await page.getByRole('button', { name: 'Milestone in Sort the photo albums' }).click();
  } else await report.getByRole('button', { name: 'Add milestone to Write the quarterly report' }).click();
  const form = page.getByRole('form', { name: /^New milestone in / });
  await form.getByRole('textbox', { name: 'Milestone name' }).fill('Print and bind');
  await form.getByRole('button', { name: 'Add' }).click();
  const tasks = page.getByRole('form', { name: /^New task in / });
  await tasks.getByRole('textbox', { name: 'Title' }).fill('Get a print quote');
  await tasks.getByRole('checkbox', { name: 'This week' }).uncheck();
  await tasks.getByRole('button', { name: 'Add' }).click();
  await tasks.getByRole('button', { name: 'Close' }).click();
  // By the stretch's end, or the project's when that's sooner.
  await expect(page.getByRole('heading', { name: phone ? 'Milestone: Print and bind, by Dec 31' : 'Milestone: Print and bind, by Dec 15' })).toBeVisible();
  await expect(row(page, 'Get a print quote')).toBeVisible();
});

test('until this stretch is planned, every project shows and one line says why', async ({ page }) => {
  await openPick(page, [...SAMPLE, { type: 'settings', id: 'settings', fields: { plan_stretch: {} } }]);
  await expect(page.getByText("Oct 1 to Dec 31 isn't planned yet, so every project shows.")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Plan this stretch' })).toBeVisible();
  await expect(project(page, 'Write a cookbook')).toBeVisible();
  await expect(row(page, 'Ask neighbours for fitter recommendations')).toBeVisible();
  await expect(page.getByRole('button', { name: /outside this stretch$/ })).toHaveCount(0);
});
