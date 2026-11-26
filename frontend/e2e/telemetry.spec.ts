import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { signIn, standInApi } from './api';
import type { SentEvent } from './api';
import { openSeeded, saved } from './seed';

const NOW = new Date('2026-11-04T15:00:00Z');

/** Moves the page's clock on a minute at a time until done: telemetry sends a batch only once the one before it has gone. */
const minutesUntil = (page: Page, done: () => boolean) =>
  expect
    .poll(async () => {
      if (!done()) await page.clock.runFor('01:00');
      return done();
    })
    .toBe(true);

const total = (events: SentEvent[], key: string) => events.reduce((sum, event) => sum + Number(event.attributes[key]), 0);

// Battery monitoring's signal from every platform: each minute, how many syncs the app made and what they carried.
test('signed in, it reports each minute the syncs it made and their bytes', async ({ page, context, baseURL }) => {
  const api = await standInApi(context, baseURL!);
  await page.clock.install({ time: NOW });
  await openSeeded(page);
  // Its screen loaded, as a module of its own, so the reload cancels none.
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  // Saved before the reload, which otherwise can come before phone WebKit's save and open a first-run app. Before the
  // sign-in, too, since that can take a few seconds on OPFS, and a page signed in that long syncs before the reload.
  await saved(page, 'setup_done_at');
  await signIn(page);
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect.poll(() => api.syncs).toBe(1);
  const reported = () => api.events.filter((event) => event.name === 'app.sync.count');
  // The minutes' counts add up to the syncs whose answers reached the app, once the last one's batch has gone: never more, never fewer.
  await minutesUntil(page, () => total(reported(), 'sync.count') === api.syncs);
  // Each request and reply, as JSON.
  expect(total(reported(), 'sync.bytes')).toBeGreaterThan(40);
  // An idle minute reports none.
  await minutesUntil(page, () => reported().some((event) => event.attributes['sync.count'] === 0));
});
