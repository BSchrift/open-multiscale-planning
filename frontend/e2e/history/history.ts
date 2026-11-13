// What the history-scale specs share: the account they sign in to, how they read the time and record their numbers,
// and the in-page timing of Today and Week. scripts/test-history.sh runs them.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { parse } from 'yaml';
import { loadRetention } from '../../../config/retention';
import { createAuth } from '../../src/core/auth';
import { systemClock } from '../../src/core/clock';
import { keptHistory } from '../../src/core/history-testing';
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

/**
 * The history as this environment's server keeps it, by its retention: what the seed sends and the specs count. An hour
 * ahead, so nothing counted goes while the seed and the specs run.
 */
export function keptChanges() {
  const { deleted } = loadRetention(historyTarget().env, { read: (path) => readFileSync(path, 'utf8'), parse });
  return keptHistory(deleted, Date.now() + 3_600_000);
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

/**
 * Pick's estimate slider dragged with the mouse across ten steps, as in weekly planning, then put back with its Undo:
 * the slowest step, from its input event until the frame after it. Saving each step made this lag behind the mouse.
 */
export async function timeEstimateDrag(page: Page): Promise<number> {
  await page.evaluate(() => {
    const steps: number[] = [];
    Object.assign(window, { estimateSteps: steps });
    document.addEventListener(
      'input',
      (event) => {
        if ((event.target as HTMLInputElement).type !== 'range') return;
        const at = event.timeStamp;
        requestAnimationFrame(() => setTimeout(() => steps.push(performance.now() - at)));
      },
      true,
    );
  });
  // From Week, which offers this week's planning, or next week's once this one is planned.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Week', exact: true }).click();
  await page.locator(".pane[aria-label='Week']:visible").getByRole('button', { name: /^(Start planning|Plan next week)$/ }).click(NETWORK);
  await page.getByRole('button', { name: 'Continue to picking tasks' }).click(NETWORK);
  // The first project on Pick's timeline, then the first task's estimate in it.
  await page.getByRole('button', { name: /^(?!One offs, ).+, .+ planned$/ }).first().click(NETWORK);
  await page.getByRole('button', { name: /^Estimate for .+: / }).first().click(NETWORK);
  const slider = page.getByRole('dialog', { name: /^Estimate for / }).getByRole('slider');
  const box = (await slider.boundingBox())!;
  const max = Number(await slider.getAttribute('max'));
  // The thumb's centre at each step, inset by half the thumb.
  const at = (step: number) => [box.x + 8 + ((box.width - 16) * step) / max, box.y + box.height / 2] as const;
  await page.mouse.move(...at(0));
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) await page.mouse.move(...at(step), { steps: 3 });
  await page.mouse.up();
  await page.getByRole('button', { name: 'Undo', exact: true }).click(NETWORK);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0, NETWORK);
  const steps = await page.evaluate(() => (window as unknown as { estimateSteps: number[] }).estimateSteps);
  const slowest = Math.round(Math.max(...steps) * 10) / 10;
  console.log(`estimate drag: ${steps.length} steps, the slowest ${slowest} ms`);
  return slowest;
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
  return page.evaluate((s) => (globalThis as unknown as HistoryPage).multiscaleHistory[s](), surface);
}

export interface HistoryTimes {
  today_query_ms: number;
  week_query_ms: number;
  records: number;
}

export interface HistoryPage {
  multiscaleHistory: {
    web(): Promise<HistoryTimes>;
    electron(): Promise<HistoryTimes>;
  };
}
