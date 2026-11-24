import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { parse } from 'yaml';
import { loadRetention } from '../../../config/retention';
import { createAuth } from '../../src/core/auth';
import { systemClock } from '../../src/core/clock';
import { historyFacts, keptHistory, seedHistory } from '../../src/core/history-testing';
import { createHttpSend } from '../../src/core/sync';
import { memoryTokens } from '../../src/platform/memory';
import { clearLeftChecks, workJourney } from '../deployed/journey';
import { account, syncNow } from '../seed';
import { closeDevices, device, startSignIn } from './devices';
import { target } from './target';

// The deployed web suite's journey on the history-scale test's five-year account, about 33,000 records. A long history
// makes a change take a second or more to read back, where a new user's takes milliseconds: on prod's shared test user, Week took
// a card away only after the toast holding the Undo the journey pressed next had gone (#312). CI's users start empty
// and staging keeps records for minutes, so nothing before prod met it. Each staging run takes the journey on its history
// user too (the web app suite's history project); this is the same on the local stack, so a PR meets it first.

const t = target();
test.use({ baseURL: `http://localhost:${process.env.STACK_WEB_PORT}` });
test.afterEach(closeDevices);

/** The sync API as `username`, through the local sign-in, as an app calls it. */
async function sendAs(api: string, username: string) {
  let opened = '';
  const auth = createAuth({
    authUrl: `${api}/cognito`,
    clientId: 'local-client',
    redirectUri: 'multiscale-local://auth/callback',
    clock: systemClock,
    tokens: memoryTokens(),
    openExternal: async (url) => void (opened = url),
    fetch: (url, init) => fetch(url, init),
  });
  await auth.signIn();
  const res = await fetch(`${opened}&username=${encodeURIComponent(username)}`, { redirect: 'manual' });
  if (!(await auth.handleRedirect(res.headers.get('location') ?? ''))) throw new Error('The local sign-in gave no code');
  return createHttpSend({ apiUrl: api, auth, fetch: (url, init) => fetch(url, init) });
}

test("the deployed suite's journey, from Capture to the calendar and back, works on a five-year account", async ({ browser }) => {
  test.skip(!t.localApi, 'needs: a user of its own to seed, which only the local stack makes; staging has its history user');
  test.setTimeout(10 * 60_000);
  const user = `e2e-history-${randomUUID().slice(0, 8)}`;
  const { deleted } = loadRetention(process.env.RETENTION || t.env, { read: (path) => readFileSync(path, 'utf8'), parse });
  const changes = keptHistory(deleted, Date.now() + 3_600_000);
  await seedHistory(await sendAs(t.localApi!, user), { changes, unitsPerSecond: Infinity });

  const d = await device(browser, user, { viewport: { width: 1360, height: 1000 } });
  await startSignIn(d.page);
  // The first sync pulls the whole account before Settings says Synced; the Inbox count is the history's.
  await expect(account(d.page).getByText('Synced', { exact: true })).toBeVisible({ timeout: 5 * 60_000 });
  const inbox = d.page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Inbox/ });
  await expect(inbox).toContainText(String(historyFacts(changes).openInbox));

  // Prod's runner took more than 5 seconds to read a change back on its shared test user. A CI runner or a Mac takes about
  // one on this account, so the page runs six times slower from here, where Week's read-back takes 5 to 6 seconds, past
  // the toast's: the journey before #312 fails here as it did on prod, waiting for Undo.
  const cdp = await d.context.newCDPSession(d.page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await workJourney(d.page, `Deployed check ${new Date().toISOString().slice(11, 19)}`);

  // Then the clean-up the deployed suite runs after it, at full speed as staging runs it, which deletes the second check
  // the journey leaves in the Inbox. On staging's history user it left Process open over the page on 11 of the first 14
  // runs, on the Inbox's first item with nothing done in it, and the next test's first press never landed. CI's runner
  // hasn't shown that, here or slowed down: its database worker reads the delete back sooner, and the page's slowing
  // never reaches the worker. So this checks what the clean-up leaves: no Process, and the history's Inbox, nothing of
  // it deleted. Process can draw some seconds after a press, so it's looked for again after a sync.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await clearLeftChecks(d.page);
  await syncNow(d.page);
  await expect(d.page.getByRole('dialog', { name: 'Process Inbox' })).toHaveCount(0);
  await expect(inbox).toHaveAccessibleName(`Inbox ${historyFacts(changes).openInbox}`);
  expect(d.errors).toEqual([]);
});
