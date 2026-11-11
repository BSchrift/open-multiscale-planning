import { expect, test } from '@playwright/test';
import { expectTapTarget } from '../seed';
import { chicago, firstRun, jumpTo, pane, start, TZ } from './journey';

// Planning as a task: the prompt to plan a week that started unplanned, then next week's planning task, which the app
// saves with no time three days before the week. Schedule and Delete each have Undo, Now places a block and opens
// planning, Save and exit stops it early, and Finish plan finishes the task.

test.use({ timezoneId: TZ, actionTimeout: 15_000 });

test('the prompt to plan, next week’s planning task, and finishing it', async ({ page }, info) => {
  test.setTimeout(120_000);
  const phone = info.project.name === 'phone';
  const errors = await start(page, chicago('2026-11-02', '07:30')); // Monday morning.
  await firstRun(page, 'Write a novel');

  // The week started unplanned: the prompt says how long planning takes. Skip for now is saved, with Undo.
  await expect(page.getByRole('heading', { name: 'Plan your week' })).toBeVisible();
  await expect(page.getByText("This week isn't planned yet. About 30m.")).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose a time to plan this week' })).toBeVisible();
  const skip = page.getByRole('button', { name: phone ? 'Skip for now' : 'Skip planning this week' });
  await skip.click();
  await expect(page.getByText('Skipped planning this week.')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('heading', { name: 'Plan your week' })).toBeVisible();
  await skip.click();
  await expect(pane(page, 'Today').getByText("This week isn't planned", { exact: true })).toBeVisible();

  // Friday: the app has saved next week's planning task, with no time placed.
  await jumpTo(page, chicago('2026-11-06', '10:00'));
  const row = page.getByRole('region', { name: 'Plan next week' });
  await expect(row).toBeVisible();
  await expect(row.getByText('About 30m', { exact: true })).toBeVisible();
  // It takes the place of the skipped week's banner.
  await expect(pane(page, 'Today').getByText("This week isn't planned", { exact: true })).toHaveCount(0);
  if (phone) {
    for (const name of ['Schedule planning for Friday, Nov 6 at 5pm', 'Choose a time to plan next week', 'Delete planning task: Plan the week of Nov 9']) {
      await expectTapTarget(row.getByRole('button', { name }));
    }
  }

  // One tap schedules it, with Undo.
  await row.getByRole('button', { name: 'Schedule planning for Friday, Nov 6 at 5pm' }).click();
  await expect(page.getByText('Planning scheduled for Fri 5pm.')).toBeVisible();
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(row).toBeVisible();

  // Delete, with Undo.
  await row.getByRole('button', { name: 'Delete planning task: Plan the week of Nov 9' }).click();
  await expect(page.getByText('Planning for the week of Nov 9 deleted.')).toBeVisible();
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(row).toBeVisible();

  // Now places a block from this minute and opens planning. Save and exit stops it, and the row offers Keep going.
  await row.getByRole('button', { name: 'Choose a time to plan next week' }).click();
  const sheet = page.getByRole('dialog', { name: 'When will you plan next week?' });
  await expect(sheet.getByText('About 30m, a first guess.')).toBeVisible();
  if (phone) {
    for (const name of ['Start planning now', 'Choose another time', 'Change length', 'Close']) await expectTapTarget(sheet.getByRole('button', { name }));
  }
  await sheet.getByRole('button', { name: 'Start planning now' }).click();
  await expect(page.getByText(/^Planning until 10:\d\dam\.$/)).toBeVisible();
  await expect(page.getByText('Nov 9 to 15')).toBeVisible();
  await page.getByRole('button', { name: 'Save and exit' }).click();
  const stopped = page.getByRole('region', { name: 'Finish planning next week' });
  await expect(stopped.getByText(/^You stopped on the Inbox step\. About 30m left\.$|^Started, not finished\. About 30m left\.$/)).toBeVisible();

  // Keep going, then Finish plan finishes the task: the row is gone for good.
  await stopped.getByRole('button', { name: 'Keep going' }).click();
  await expect(page.getByText('Nov 9 to 15')).toBeVisible();
  await page.getByRole('navigation', { name: 'Planning steps' }).getByRole('button', { name: /Review$/ }).click();
  // Review offers the next planning time, this session's a week on, in one tap.
  const next = page.getByRole('region', { name: 'Next planning' });
  await expect(next.getByText('Same time as today')).toBeVisible();
  await next.getByRole('button', { name: /^Schedule planning for Friday, Nov 13 at 10/ }).click();
  await expect(next.getByText(/^Scheduled for Fri Nov 13, 10/)).toBeVisible();
  await page.getByRole('button', { name: 'Finish plan' }).click();
  await expect(page.getByText('Week planned.')).toBeVisible();
  await expect(pane(page, 'Today').getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(stopped).toHaveCount(0);

  // Monday: the week was planned on Friday, so nothing asks.
  await jumpTo(page, chicago('2026-11-09', '08:00'));
  await expect(pane(page, 'Today').getByText('Monday, Nov 9')).toBeVisible();
  await expect(pane(page, 'Today').getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Plan your week' })).toHaveCount(0);
  expect(errors).toEqual([]);
});
