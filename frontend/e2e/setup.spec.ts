import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, pane } from './seed';

// First-run setup beyond the straight path settings.spec.ts and shell.spec.ts take. Signed out, it has three steps;
// the Google Calendar step comes only once signed in, so it's the stack layer's. Setup doesn't ask how often to plan:
// the first stretch planning does.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm.

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  return errors;
}

test('first run counts its steps and Back returns to each, and Capture puts the first thought in the Inbox rather than making a goal', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page);
  const counter = page.getByText(/^Step \d of \d$/);
  await expect(counter).toHaveText('Step 1 of 3');
  if (phone) for (const name of ['Sign in', 'Skip']) await expectTapTarget(page.getByRole('button', { name }));
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.getByRole('heading', { name: 'Unavailable hours' })).toBeFocused();
  await expect(counter).toHaveText('Step 2 of 3');
  if (phone) for (const name of ['Back', 'Next']) await expectTapTarget(page.getByRole('button', { name }));
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeFocused();
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(counter).toHaveText('Step 3 of 3');
  const field = page.getByRole('textbox', { name: 'A goal or a thought' });
  await expect(field).toBeFocused();
  const goal = page.getByRole('button', { name: 'Add goal' });
  const capture = page.getByRole('button', { name: 'Capture' });
  // Nothing to add until something's typed.
  await expect(goal).toBeDisabled();
  await expect(capture).toBeDisabled();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Unavailable hours' })).toBeFocused();
  await page.getByRole('button', { name: 'Next' }).click();
  await field.fill('Book the boiler service');
  if (phone) for (const target of [goal, capture, page.getByRole('button', { name: 'Back' }), page.getByRole('button', { name: 'Skip' })]) await expectTapTarget(target);
  await capture.click();

  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav).toBeVisible();
  await nav.getByRole('button', { name: phone ? 'Inbox, 1 to sort' : 'Inbox' }).click();
  await expect(pane(page, 'Inbox').locator('.inboxrow, .morerow')).toHaveText([/Book the boiler service/]);
  await nav.getByRole('button', { name: /^Goals/ }).click();
  await expect(pane(page, 'Goals').getByText('Book the boiler service')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('first run picks up at the step it was on after a reload', async ({ page }) => {
  const errors = await open(page);
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.getByRole('heading', { name: 'Unavailable hours' })).toBeFocused();
  // Signing in leaves for the browser, and the app may be closed meanwhile, so the step is kept.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Unavailable hours' })).toBeVisible();
  await expect(page.getByText('Step 2 of 3')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  expect(errors).toEqual([]);
});
