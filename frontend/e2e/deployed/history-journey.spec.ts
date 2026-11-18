// The deployed suite's desktop journey on staging's history user, a five-year account of about 34,000 records. On a
// long history each change takes seconds to read back: prod's shared test user, which held tens of thousands of records,
// once took Week's card away only after the toast holding the Undo the journey pressed next had gone (#312). Staging's
// own test user holds next to nothing, since its periods are minutes, so before this nothing met that ahead of prod.
// The history-seed project seeds the account first. scripts/test-deployed.sh runs it on staging, reporting for now.
//
// The account's records carry no expiry, which is what keeps five years of them on staging. A page that reloads fills
// one in for each record it holds and sends them all, and staging would then remove most of the account. So this page
// signs in once and never reloads. What the journey adds are records of its own, and it clears them away again.

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { parse } from 'yaml';
import { loadRetention } from '../../../config/retention';
import { historyFacts, keptHistory } from '../../src/core/history-testing';
import { FIRST_SYNC } from '../history/history';
import { account, go } from '../seed';
import { clearChecks, timezoneWithRoom, workJourney } from './journey';
import { deployed } from './target';

const d = deployed();
const NETWORK = { timeout: 60_000 };

test("the deployed suite's journey, from Capture to the calendar and back, works on the five-year account", async ({ browser }, info) => {
  test.setTimeout(FIRST_SYNC.timeout + 10 * 60_000);
  const t = d.history!;
  const { deleted } = loadRetention(t.env, { read: (path) => readFileSync(path, 'utf8'), parse });
  const { openInbox, records } = historyFacts(keptHistory(deleted, Date.now() + 3_600_000));
  const { viewport, userAgent, deviceScaleFactor, baseURL } = info.project.use;
  const context = await browser.newContext({ viewport, userAgent, deviceScaleFactor, baseURL, timezoneId: timezoneWithRoom() });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Sign in' }).first().click();
  const popup = await opened;
  // The hosted sign-in page has a wide and a narrow form, and shows one.
  await popup.locator('input[name=username]:visible').fill(t.test_user!.username, NETWORK);
  await popup.locator('input[name=password]:visible').fill(t.test_user!.password);
  const started = Date.now();
  await popup.locator('input[name=signInSubmitButton]:visible').click();
  // The first sync pulls the whole account before Settings says Synced, and its settings say setup is done.
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible(FIRST_SYNC);
  await go(page, 'Settings');
  await expect(account(page).getByText('Synced', { exact: true })).toBeVisible(FIRST_SYNC);
  console.log(`history journey: ${records} records synced ${Math.round((Date.now() - started) / 1000)} s after the sign-in was sent`);

  try {
    // What an earlier run left, then the Inbox the history has, which a short count shows wasn't seeded.
    await clearChecks(page);
    await expect(page.getByRole('navigation', { name: 'Main' }).locator('.navcount')).toHaveText(String(openInbox));
    await workJourney(page, `Deployed check ${new Date().toISOString().slice(11, 19)}`);
  } finally {
    // Its checks would change the Inbox count the history-scale test waits for. A failure here leaves the journey's own
    // to be reported, and the next run clears what's left.
    await clearChecks(page).catch((e: Error) => console.log(`history journey: clearing its checks failed too: ${e.message}`));
    await context.close();
  }
  expect(errors).toEqual([]);
});
