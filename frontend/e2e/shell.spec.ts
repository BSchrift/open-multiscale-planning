import { expect, test } from '@playwright/test';
// By pane rather than by content, so this keeps working whatever each screen goes on to render.
import { pane } from './seed';

test('starts at setup on an empty database, then shows the shell', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(pane(page, 'Today')).toBeVisible();

  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav).toBeVisible();
  if (info.project.name === 'phone') {
    await expect(nav.getByRole('button')).toHaveText(['Today', 'Week', 'Inbox', 'Goals', 'More']);
    await nav.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(pane(page, 'Settings')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to More' })).toBeVisible();
  } else {
    await expect(nav.locator('.nav button')).toHaveText(['Today', 'Inbox', 'Week', 'Plan', 'Goals', 'One offs', 'Analytics', 'Done', 'Settings']);
    await nav.getByRole('button', { name: 'Goals' }).click();
    await expect(pane(page, 'Goals')).toBeVisible();
  }

  const capture = info.project.name === 'phone' ? page.getByRole('button', { name: 'Capture a task' }) : nav.getByRole('button', { name: /Capture/ });
  await capture.click();
  await expect(page.getByRole('dialog', { name: 'Capture' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.screenshot({ path: info.outputPath('shell.png') });
  // Without OPFS, as in phone's WebKit here, the browser build saves 200ms after the last change, and a reload sooner
  // loses it (a shortcut in platform/web.ts).
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toHaveCount(0);
  await expect(nav).toBeVisible();
  expect(errors).toEqual([]);
});
