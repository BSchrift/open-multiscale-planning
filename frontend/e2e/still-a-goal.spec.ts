import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded } from './seed';
import type { Seed } from './seed';

// A goal with nothing active, and nothing under it changed for a stretch, asks "Still a goal?": not now (asking again
// next stretch), archive it, or add work. Archived goals can be restored or deleted.

test.use({ timezoneId: 'America/Chicago' });

// Seeded in the summer, so by November nothing under the goals has changed for more than the three months a stretch
// lasts with no cadence set.
const SEEDED = new Date('2026-07-01T17:00:00Z');
const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm

const records: Seed[] = [
  { type: 'objective', id: 'g1', fields: { title: 'Learn Spanish', state: 'active' } },
  { type: 'objective', id: 'g2', fields: { title: 'Run a 10k', state: 'active' } },
  { type: 'practice', id: 'pr1', fields: { objective_id: 'g2', title: 'Easy run', target_min: 30, per: 'day', state: 'active' } },
];

async function openGoals(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: SEEDED });
  await openSeeded(page, records);
  // A jump too long for fastForward, which stops short of about 25 days.
  await page.clock.setSystemTime(NOW);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Goals' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Goals' })).toBeVisible();
  return errors;
}

const goal = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name}`) });

test('Yes, not now quiets the question until the next stretch, with Undo, and then it asks again', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await openGoals(page);
  await expect(goal(page, 'Learn Spanish')).toContainText('Nothing active. Still a goal?');
  // A goal with work under it isn't asked, however long it has been quiet.
  await expect(goal(page, 'Run a 10k')).not.toContainText('Still a goal');

  await goal(page, 'Learn Spanish').click();
  const notNow = page.getByRole('button', { name: 'Yes, not now' });
  if (phone) {
    await expectTapTarget(notNow);
    await expectTapTarget(page.getByRole('button', { name: 'No, archive it' }));
  }
  await page.screenshot({ path: info.outputPath(`still-a-goal-${info.project.name}.png`) });
  await notNow.click();
  await expect(page.getByText('Learn Spanish: not now.')).toBeVisible();
  await expect(goal(page, 'Learn Spanish')).toContainText('Not now. Asking again Jan 1.');
  await expect(notNow).toHaveCount(0);
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(notNow).toBeVisible();

  await notNow.click();
  await expect(goal(page, 'Learn Spanish')).toContainText('Not now. Asking again Jan 1.');
  // The next stretch starts on Jan 1, and the app opened then asks again.
  await page.clock.setSystemTime(new Date('2027-01-01T18:00:00Z'));
  await page.reload();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Goals' }).click();
  await expect(goal(page, 'Learn Spanish')).toContainText('Nothing active. Still a goal?');
  expect(errors).toEqual([]);
});

test('No, archive it moves the goal to Archived, where Restore brings it back with Undo, and Delete asks first', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await openGoals(page);
  await goal(page, 'Learn Spanish').click();
  await page.getByRole('button', { name: 'No, archive it' }).click();
  await expect(page.getByText('Archived Learn Spanish.')).toBeVisible();
  await expect(goal(page, 'Learn Spanish')).toHaveCount(0);
  const archived = page.getByRole('button', { name: 'Archived (1)' });
  // Focus follows the goal to Archived; WebKit doesn't focus a tapped button, so only desktop has focus to follow.
  if (!phone) await expect(archived).toBeFocused();
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(goal(page, 'Learn Spanish')).toBeVisible();
  await expect(archived).toHaveCount(0);

  // Back as it was, still open.
  await expect(goal(page, 'Learn Spanish')).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'No, archive it' }).click();
  await archived.click();
  const restore = page.getByRole('button', { name: 'Restore Learn Spanish' });
  if (phone) {
    await expectTapTarget(restore);
    await expectTapTarget(page.getByRole('button', { name: 'Delete Learn Spanish' }));
  }
  await restore.click();
  const undo = page.locator('.toast').getByRole('button', { name: 'Undo' });
  await expect(page.getByText('Learn Spanish restored.')).toBeVisible();
  await expect(undo).toBeFocused();
  await expect(goal(page, 'Learn Spanish')).toBeVisible();
  await undo.click();
  await expect(goal(page, 'Learn Spanish')).toHaveCount(0);

  // Deleting an archived goal asks first.
  await page.getByRole('button', { name: 'Delete Learn Spanish' }).click();
  const ask = page.getByRole('dialog', { name: 'Delete Learn Spanish?' });
  await ask.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(page.getByText('Deleted Learn Spanish.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Archived/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('adding work answers the question: a project under the goal and it stops asking', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await openGoals(page);
  await goal(page, 'Learn Spanish').click();
  await expect(page.getByRole('button', { name: 'Yes, not now' })).toBeVisible();
  await page.getByRole('button', { name: phone ? '+ Project' : 'Add project' }).first().click();
  const form = page.getByRole('form', { name: 'Add project' });
  await form.getByLabel('Name').fill('Finish the beginner course');
  await form.getByLabel('Ends').fill('2027-01-29');
  await form.getByRole('button', { name: 'Add project' }).click();
  await expect(page.getByText('Project added, Nov 2 to Jan 29.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yes, not now' })).toHaveCount(0);
  // Closed, it no longer reads as having nothing active: desktop counts what it has, and phone shows only its title.
  await goal(page, 'Learn Spanish').click();
  await expect(goal(page, 'Learn Spanish')).not.toContainText('Nothing active');
  if (!phone) await expect(goal(page, 'Learn Spanish')).toContainText('1 project');
  expect(errors).toEqual([]);
});
