import { expect, test } from '@playwright/test';
import { openSeeded } from './seed';

test('one tab at a time: a second says so, and opens once the first is closed', async ({ page, context }) => {
  await openSeeded(page);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByText('Multiscale is open in another tab.')).toBeVisible();
  await page.close();
  await second.reload();
  await expect(second.getByRole('navigation', { name: 'Main' })).toBeVisible();
});
