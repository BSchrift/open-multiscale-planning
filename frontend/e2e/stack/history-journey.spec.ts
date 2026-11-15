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
import { workJourney } from '../deployed/journey';
import { account } from '../seed';
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
  await expect(d.page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Inbox/ })).toContainText(String(historyFacts(changes).openInbox));

  // Prod's runner took more than 5 seconds to read a change back on its shared test user. A CI runner or a Mac takes about
  // one on this account, so the page runs six times slower from here, where Week's read-back takes 5 to 6 seconds, past
  // the toast's: the journey before #312 fails here as it did on prod, waiting for Undo.
  await (await d.context.newCDPSession(d.page)).send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await workJourney(d.page, `Deployed check ${new Date().toISOString().slice(11, 19)}`);
  expect(d.errors).toEqual([]);
});
