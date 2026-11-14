import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { startPlanningThenUndo } from '../seed';
import { addProject, chicago, firstRun, jumpTo, pane, slide, start, tab, TZ } from './journey';

// Five weeks of planning and answering blocks, where Monday evenings never hold and Tuesday evenings always do.
// Analytics then shows what those answers add up to, and stopping Monday evenings moves Schedule's suggestion.

test.use({ timezoneId: TZ, actionTimeout: 15_000 });

const MONDAYS = ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'];
const ORDINALS = ['one', 'two', 'three', 'four', 'five', 'six'];
const nextDay = (day: string) => new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Plans this week from Today: picks, Place the rest at suggested times, Review, Finish. Returns where they went. */
async function planWeek(page: Page, phone: boolean, picks: readonly string[]) {
  await tab(page, phone, 'Today');
  await startPlanningThenUndo(page);
  await page.getByRole('button', { name: 'Continue to picking tasks' }).click();
  const project = page.getByRole('region', { name: 'Finish the first draft' });
  for (const t of picks) await project.getByRole('button', { name: new RegExp(`^Add .*to this week: ${t}$`) }).click();
  const steps = page.getByRole('navigation', { name: 'Planning steps' });
  await steps.getByRole('button', { name: /Schedule/ }).click();
  if (phone) {
    await page.getByRole('button', { name: /^All picked tasks/ }).click();
    await page.getByRole('dialog', { name: 'All picked tasks' }).getByRole('button', { name: 'Place the rest at suggested times' }).click();
  } else {
    await page.getByRole('button', { name: 'Place the rest at suggested times' }).click();
  }
  await steps.getByRole('button', { name: /Review/ }).click();
  await page.getByRole('button', { name: 'Finish plan' }).click();
  await expect(page.getByText('Week planned.')).toBeVisible();
}

/** Answers the block that just ended, which asks on whatever page is showing. */
async function answer(page: Page, title: string, result: 'Task finished' | 'Not done') {
  const prompt = page.getByRole('dialog', { name: 'Block finished' });
  await expect(prompt.getByText(title)).toBeVisible();
  await prompt.getByRole('button', { name: result, exact: true }).click();
  await expect(prompt).toHaveCount(0);
}

test('weeks of answered blocks add up in Analytics, and a pattern changes Schedule', async ({ page }, info) => {
  test.setTimeout(300_000);
  const phone = info.project.name === 'phone';
  const errors = await start(page, chicago(MONDAYS[0]!, '08:00'));
  await firstRun(page, 'Write a novel');
  await page.getByRole('button', { name: /^Skip (for now|planning this week)$/ }).click();
  await tab(page, phone, 'Goals');
  const project = await addProject(page, phone, 'Write a novel', 'Finish the first draft', '2027-03-26');
  await project.getByRole('button', { name: phone ? '+ Task' : 'Add task', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Add task' });
  for (const n of ORDINALS) {
    for (const title of [`Draft chapter ${n}`, `Notes for chapter ${n}`]) {
      await editor.getByLabel('Title').fill(title);
      await slide(editor.getByRole('slider', { name: 'Time estimate' }), 4, '1h');
      await editor.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(editor.getByRole('status')).toHaveText(`Added ${title}.`);
    }
  }
  await editor.getByRole('button', { name: 'Done' }).click();

  for (const [i, monday] of MONDAYS.entries()) {
    const [draft, notes] = [`Draft chapter ${ORDINALS[i]}`, `Notes for chapter ${ORDINALS[i]}`];
    if (i > 0) await jumpTo(page, chicago(monday, '08:00'));
    await planWeek(page, phone, [draft, notes]);

    // The Week tab follows the new week, and shows where the picks went.
    await tab(page, phone, 'Week');
    await expect(pane(page, 'Week').getByRole('heading', { name: 'This week' })).toBeVisible();
    if (phone) {
      // The strip opens on today, Monday.
      await expect(page.getByRole('button', { name: `${draft}, 5pm to 6pm, Project.` })).toBeVisible();
    } else {
      await expect(page.getByRole('button', { name: new RegExp(`^${draft}, Mon .*, 5pm to 6pm, Project\\.`) })).toBeVisible();
      await expect(page.getByRole('button', { name: new RegExp(`^${notes}, Tue .*, 5pm to 6pm, Project\\.`) })).toBeVisible();
    }

    await jumpTo(page, chicago(monday, '18:01'));
    await answer(page, draft, 'Not done');
    await jumpTo(page, chicago(nextDay(monday), '18:01'));
    await answer(page, notes, 'Task finished');
  }

  // Analytics for the fifth week, then the stretch so far.
  await tab(page, phone, 'Analytics');
  const a = pane(page, 'Analytics');
  await expect(a.getByText('Nov 30 to Dec 6')).toBeVisible();
  await expect(a.getByText('1h delivered of 2h planned, with the week still in progress.')).toBeVisible();
  await expect(a.getByRole('img', { name: 'Project tasks: 1 done, 0 partly, 1 not done' })).toBeVisible();
  await a.getByRole('button', { name: 'Previous week' }).click();
  await expect(a.getByText('Nov 23 to Nov 29')).toBeVisible();
  await expect(a.getByText('1h delivered of 2h planned.')).toBeVisible();

  await a.getByRole('button', { name: 'This stretch' }).click();
  await expect(a.getByText('This stretch, Oct 1 to Dec 31')).toBeVisible();
  await expect(a.getByRole('img', { name: 'Project tasks: 5 done, 0 partly, 5 not done' })).toBeVisible();
  await expect(a.getByText('Monday evenings rarely hold: 0 of the last 5 blocks were done.')).toBeVisible();
  await expect(a.getByText('Tuesday evenings hold best: 5 of the last 5 blocks were done.')).toBeVisible();
  await a.getByRole('button', { name: 'Stop suggesting them' }).click();
  await expect(a.getByText('Monday evenings are no longer suggested.')).toBeVisible();

  // The next Monday, Schedule no longer suggests the evening that never held. Before 7am, all of Monday is still ahead.
  await jumpTo(page, chicago('2026-12-07', '06:30'));
  await planWeek(page, phone, ['Draft chapter six']);
  await tab(page, phone, 'Week');
  await expect(pane(page, 'Week').getByRole('heading', { name: 'This week' })).toBeVisible();
  if (phone) {
    // Placed on some day, and not on Monday evening.
    const strip = page.getByRole('group', { name: 'Choose a day' });
    await expect(strip.getByRole('button', { name: /, 14h free$/ })).toHaveCount(1);
    await strip.getByRole('button', { name: /^Mon Dec 7,/ }).click();
    await expect(page.getByRole('heading', { name: 'Mon Dec 7' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Draft chapter six, ([5-9]|1[01])(:\d\d)?pm to/ })).toHaveCount(0);
  } else {
    const placed = page.getByRole('button', { name: /^Draft chapter six, / });
    await expect(placed).toBeVisible();
    // Every earlier week put the first pick on Monday at 5pm.
    await expect(placed).not.toHaveAccessibleName(/^Draft chapter six, Mon Dec 7, ([5-9]|1[01])(:\d\d)?pm/);
  }
  expect(errors).toEqual([]);
});
