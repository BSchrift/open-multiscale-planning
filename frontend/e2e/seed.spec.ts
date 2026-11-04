import { expect, test } from '@playwright/test';
import { openSeeded } from './seed';

test('seeded records reach the screens without a reload', async ({ page }) => {
  await openSeeded(page, [{ type: 'task', fields: { kind: 'inbox', title: 'Paint the fence' } }]);
  await expect(page.getByRole('heading', { name: 'Welcome' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByText('1', { exact: true })).toBeVisible();
});
