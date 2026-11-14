import { expect, test } from '@playwright/test';
import { tab } from '../journeys/journey';
import { expectSaved } from '../offline';
import { openSeeded, pane } from '../seed';

// Proposed behaviour, left out of the suite until the owner decides on it (playwright.config.ts ignores e2e/proposed):
// the web app reloaded, or opened from a bookmark, with no connection should open with its data, as the Mac and iPhone
// apps do. It can't yet. The browser fetches the page and its code from the server on every load, and nothing keeps a
// copy: there's no service worker, so the reload itself fails, with net::ERR_INTERNET_DISCONNECTED in Chromium and "an
// internal error" in WebKit.
// A service worker that precaches the built bundle would close it, so this would then run against the built bundle
// (vite build, then vite preview) rather than the dev server, whose modules aren't what a service worker would keep.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm in Chicago.

test('the web app reloaded offline opens with its data', async ({ page, context }, info) => {
  const phone = info.project.name === 'phone';
  await page.clock.install({ time: NOW });
  await openSeeded(page, [{ type: 'task', id: 'i1', fields: { kind: 'inbox', title: 'Call the bank' } }]);
  await expectSaved(page, 'task', 'i1', { title: 'Call the bank' });

  await context.setOffline(true);
  await page.reload();
  await tab(page, phone, 'Inbox');
  await expect(pane(page, 'Inbox').locator('.inboxrow')).toHaveText([/Call the bank/]);
});
