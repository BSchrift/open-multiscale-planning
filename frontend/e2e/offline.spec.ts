import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded, pane } from './seed';

// The browser build fetches each screen's code from the server the first time it's needed: the dev server here, the
// web host when deployed. Screens load ahead in turn, in the registry's order, once the app has drawn.

async function openApp(page: Page) {
  // Settings loads after Analytics and Done, so once it's asked for, they're loaded or have failed.
  const settingsFetched = page.waitForRequest(/\/src\/ui\/screens\/settings\/index\.tsx/);
  await openSeeded(page);
  await expect(pane(page, 'Today').getByRole('heading', { level: 1 })).toBeVisible();
  await settingsFetched;
  // Then Settings' own files, which Safari would keep as failed for good if the connection dropped as they came.
  await page.waitForLoadState('networkidle');
}

async function open(page: Page, phone: boolean, label: string) {
  if (phone) {
    const back = page.getByRole('button', { name: 'Back to More' });
    if (await back.isVisible()) await back.click();
    else await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: new RegExp(`^${label}`) }).click();
  } else {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: label }).click();
  }
}

test('a screen not opened yet still opens offline, its code fetched once the app had drawn', async ({ page, context }, info) => {
  await openApp(page);
  await context.setOffline(true);
  await open(page, info.project.name === 'phone', 'Analytics');
  await expect(pane(page, 'Analytics').getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
  await page.screenshot({ path: info.outputPath('offline-analytics.png') });
});

test('a screen whose code didn’t arrive opens once back online, or on Try again', async ({ page, context }, info) => {
  const phone = info.project.name === 'phone';
  // As if the connection had dropped as they were due to load.
  const analytics = '**/src/ui/screens/analytics/index.tsx*';
  const done = '**/src/ui/screens/done/index.tsx*';
  await page.route(analytics, (route) => route.abort('internetdisconnected'));
  await page.route(done, (route) => route.abort('internetdisconnected'));
  await openApp(page);

  await context.setOffline(true);
  await open(page, phone, 'Analytics');
  const failed = pane(page, 'Analytics').getByRole('alert');
  await expect(failed).toContainText("Couldn't open this screen");
  await expect(failed).toContainText("It will try again when you're back online.");
  await page.screenshot({ path: info.outputPath('offline-failed.png') });
  await page.unroute(analytics);
  await context.setOffline(false);
  await expect(pane(page, 'Analytics').getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
  await expect(failed).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('online-again.png') });

  await open(page, phone, 'Done');
  await expect(pane(page, 'Done').getByRole('alert')).toContainText("Couldn't open this screen");
  await page.unroute(done);
  const tryAgain = pane(page, 'Done').getByRole('button', { name: 'Try again' });
  if (phone) await expectTapTarget(tryAgain);
  await tryAgain.click();
  await expect(pane(page, 'Done').getByRole('alert')).toHaveCount(0);
  await expect(pane(page, 'Done').getByRole('button', { name: 'Previous day' })).toBeVisible();
});
