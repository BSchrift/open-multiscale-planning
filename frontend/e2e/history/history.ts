// What the history-scale specs share: the account they sign in to, how they read the time and record their numbers,
// and the in-page timing of Today and Week. scripts/test-history.sh runs them.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import type { Page } from '@playwright/test';
import { createAuth } from '../../src/core/auth';
import { systemClock } from '../../src/core/clock';
import { createHttpSend } from '../../src/core/sync';
import { memoryTokens } from '../../src/platform/memory';

export interface HistoryTarget {
  env: string;
  api_url: string;
  client_id: string;
  region?: string;
  /** A deployment's history user. Locally the stack's own user, whom its sign-in lets straight in. */
  test_user?: { username: string; password: string };
}

/** As scripts/test-target.mjs prints it with MULTISCALE_TEST_USER=history, for the local stack or a deployment. */
export function historyTarget(): HistoryTarget {
  let target: Partial<HistoryTarget> = {};
  try {
    target = JSON.parse(process.env.MULTISCALE_TARGET ?? '');
  } catch {
    // Reported below.
  }
  if (!target.env || !target.api_url || !target.client_id || (target.env !== 'local' && !target.test_user?.password)) {
    throw new Error('MULTISCALE_TARGET has no history user. Run make test-history.');
  }
  return target as HistoryTarget;
}

/** A deployment's sign-in page and network take longer than the local stack's. */
export const NETWORK = { timeout: 60_000 };
/** However long a first sync of the whole history takes, which is what these specs measure. */
export const FIRST_SYNC = { timeout: 25 * 60_000 };

/** The sync API signed in as the history user, the way a device calls it. */
export async function historySend(t: HistoryTarget) {
  if (t.test_user) {
    // A deployment's test client allows password sign-in, as the Go suite and XCUITest use it.
    const res = await fetch(`https://cognito-idp.${t.region}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
      body: JSON.stringify({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: t.client_id, AuthParameters: { USERNAME: t.test_user.username, PASSWORD: t.test_user.password } }),
    });
    const token = ((await res.json()) as { AuthenticationResult?: { AccessToken?: string } }).AuthenticationResult?.AccessToken;
    if (!token) throw new Error(`Cognito refused the history user (${res.status})`);
    return createHttpSend({ apiUrl: t.api_url, auth: { accessToken: async () => token, expire: async () => undefined }, fetch: (url, init) => fetch(url, init) });
  }
  // The local sign-in, followed by hand: with no username it signs in the stack's own user, as an app's does.
  let opened = '';
  const auth = createAuth({
    authUrl: `${t.api_url}/cognito`,
    clientId: t.client_id,
    redirectUri: 'multiscale-local://auth/callback',
    clock: systemClock,
    tokens: memoryTokens(),
    openExternal: async (url) => void (opened = url),
    fetch: (url, init) => fetch(url, init),
  });
  await auth.signIn();
  const res = await fetch(opened, { redirect: 'manual' });
  if (!(await auth.handleRedirect(res.headers.get('location') ?? ''))) throw new Error('The local sign-in gave no code');
  return createHttpSend({ apiUrl: t.api_url, auth, fetch: (url, init) => fetch(url, init) });
}

const RESULTS = process.env.HISTORY_RESULTS || join(import.meta.dirname, '../../test-results/history');

/** Adds a surface's numbers to its file, which scripts/history-report.ts reads, or the seeded history's facts. */
export function record(surface: 'web' | 'mac' | 'facts', numbers: Record<string, number>) {
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `${surface}.json`);
  let kept: Record<string, number> = {};
  try {
    kept = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // The first number for this surface.
  }
  writeFileSync(file, JSON.stringify({ ...kept, ...numbers }, null, 2));
  console.log(`${surface}: ${JSON.stringify(numbers)}`);
}

/**
 * Resolves once the app shows Today with the history's Inbox count in the nav, which arrives with its latest records, at
 * the page's own time of that frame, so the number isn't rounded up to how often a test polls.
 */
export async function usableAt(page: Page, openInbox: number): Promise<number> {
  const handle = await page.waitForFunction(
    (count) => {
      const nav = document.querySelector('nav[aria-label="Main"]');
      const badge = nav?.querySelector('.navcount, .tbadge');
      const today = document.querySelector(".pane[aria-label='Today']");
      return badge?.textContent === String(count) && today?.checkVisibility() ? Date.now() : false;
    },
    openInbox,
    { polling: 'raf', ...FIRST_SYNC },
  );
  return (await handle.jsonValue()) as number;
}

/** Each query's median of five runs in the app's page, through the app's own database driver. */
export async function timeQueries(page: Page, surface: 'web' | 'electron'): Promise<HistoryTimes> {
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, 'page.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    loader: { '.css': 'empty' },
    logLevel: 'warning',
  });
  // Evaluated rather than added as a script, which a page's content security policy could refuse.
  await page.evaluate(bundle.outputFiles[0]!.text);
  if (surface === 'electron') return page.evaluate(() => (globalThis as unknown as HistoryPage).multiscaleHistory.electron());
  // The web app's sql.js, opened on what it saved: the page keeps its own copy out of reach.
  const wasm = readFileSync(join(import.meta.dirname, '../../node_modules/sql.js/dist/sql-wasm.wasm')).toString('base64');
  return page.evaluate((w) => (globalThis as unknown as HistoryPage).multiscaleHistory.web(w), wasm);
}

export interface HistoryTimes {
  today_query_ms: number;
  week_query_ms: number;
  records: number;
}

export interface HistoryPage {
  multiscaleHistory: {
    web(wasmBase64: string): Promise<HistoryTimes>;
    electron(): Promise<HistoryTimes>;
  };
}
