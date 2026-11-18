// The sync KPIs (docs/performance.md) between two browsers of one user, through the local stack behind Toxiproxy, on
// the network PERF_NETWORK names (good, slow-3g or flaky), which scripts/test-perf.sh sets up, or against staging as its
// test user (staging), from the release pipeline's nightly: sync.send and sync.push
// on the device that captures, sync.pull on the other. With a good network it also times capture and the screens while
// a third device's 5,000 records come down, against the same device idle, and has both devices edit at once for a
// minute and checks they end up equal. Nightly only, with PERF_SYNC=1.

import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { pane } from '../seed';
import { device as stackDevice, signIn } from '../stack/devices';
import { percentile } from '../../scripts/perf-stats';
import { capture, collect, keep, Results, screens, waitForMeasure } from './harness';
import type { Action } from './harness';

test.describe.configure({ timeout: 3_600_000 });

const NETWORK = process.env.PERF_NETWORK ?? 'good';
const PULLS = Number(process.env.PERF_SYNC_SAMPLES ?? 30);
const api = process.env.LOCAL_API_URL!;
const url = () => process.env.PERF_TARGETS!.split(',').find((pair) => pair.startsWith('this='))!.slice('this='.length);
const wait = { timeout: 120_000 };

/**
 * The network between the browsers and the stack, by Toxiproxy's API (scripts/test-perf.sh made the proxy): a slow 3G
 * of about 2 s round trips and 400 kbps, or a flaky one with 5% of connections reset, up to a second of jitter and a
 * 10-second outage every 2 minutes. Shaped once the devices are signed in, so only the timed part is slowed.
 */
async function shape(network: string): Promise<() => Promise<void>> {
  // A good network is the proxy as it is, and staging's is the real one.
  if (network === 'good' || network === 'staging') return async () => undefined;
  const toxi = process.env.PERF_TOXIPROXY!;
  const post = (path: string, body: unknown) => fetch(`${toxi}${path}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => expect(r.ok, path).toBe(true));
  const toxics: { name: string; type: string; stream?: string; toxicity?: number; attributes: Record<string, number> }[] =
    network === 'slow-3g'
      ? [
          { name: 'down', type: 'latency', stream: 'downstream', attributes: { latency: 1000 } },
          { name: 'up', type: 'latency', stream: 'upstream', attributes: { latency: 1000 } },
          { name: 'downrate', type: 'bandwidth', stream: 'downstream', attributes: { rate: 50 } },
          { name: 'uprate', type: 'bandwidth', stream: 'upstream', attributes: { rate: 50 } },
        ]
      : network === 'flaky'
        ? [
            { name: 'resets', type: 'reset_peer', toxicity: 0.05, attributes: { timeout: 0 } },
            { name: 'jitter', type: 'latency', stream: 'downstream', attributes: { latency: 0, jitter: 1000 } },
          ]
        : [];
  for (const toxic of toxics) await post('/proxies/api/toxics', toxic);
  const outages =
    network === 'flaky'
      ? setInterval(() => {
          void post('/proxies/api', { enabled: false });
          setTimeout(() => void post('/proxies/api', { enabled: true }), 10_000);
        }, 120_000)
      : undefined;
  return async () => {
    clearInterval(outages);
    await post('/proxies/api', { enabled: true });
    for (const toxic of toxics) await fetch(`${toxi}/proxies/api/toxics/${toxic.name}`, { method: 'DELETE' });
  };
}

/** A device of the user, past setup and signed in, with its first sync done. Each test has a user of its own. */
async function device(browser: Browser, user: string, seed: { type: string; fields: Record<string, unknown> }[] = []): Promise<Page> {
  if (NETWORK === 'staging') {
    // The deployment's test user, through its hosted sign-in page, as the stack specs sign in.
    const { page } = await stackDevice(browser, user, { baseURL: url(), viewport: { width: 1360, height: 1000 } });
    await signIn(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Today/ }).click();
    await keep(page);
    return page;
  }
  const context = await browser.newContext({ baseURL: url(), viewport: { width: 1360, height: 1000 } });
  // The local sign-in lets anyone in, as the username in the query.
  await context.route((u) => u.href.startsWith(`${api}/cognito/oauth2/authorize?`), (route) => route.continue({ url: `${route.request().url()}&username=${user}` }));
  const page = await context.newPage();
  await page.goto('/');
  await page.waitForFunction(() => 'multiscaleSeed' in window);
  await page.evaluate((records) => (window as unknown as { multiscaleSeed(r: unknown[]): Promise<void> }).multiscaleSeed(records), [{ type: 'settings', id: 'settings', fields: { setup_done_at: '2026-01-01T00:00:00.000Z' } }, ...seed]);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Settings/ }).click();
  const popup = page.waitForEvent('popup');
  await pane(page, 'Settings').getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(async () => (await popup).isClosed(), wait).toBe(true);
  await expect(pane(page, 'Settings').getByText('Synced', { exact: true })).toBeVisible(wait);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Today/ }).click();
  await keep(page);
  return page;
}

/** Sync now, from Settings, then back to Today; with finish, waits for the sync to end, as its button says. */
async function syncNow(page: Page, finish = true) {
  const main = page.getByRole('navigation', { name: 'Main' });
  const settings = pane(page, 'Settings');
  await main.getByRole('button', { name: /^Settings/ }).click();
  await settings.getByRole('button', { name: 'Sync now' }).click();
  if (finish) await expect(settings.getByRole('button', { name: 'Sync now', disabled: true })).toHaveCount(0, wait);
  await main.getByRole('button', { name: /^Today/ }).click();
}
const newUser = () => `perf-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

const collectSync = async (page: Page, results: Results) => {
  const taken = await page.evaluate(() => {
    const all: Record<string, number[]> = {};
    for (const m of performance.getEntriesByType('measure')) (all[m.name] ??= []).push(m.duration);
    performance.clearMeasures();
    return all;
  });
  for (const [name, values] of Object.entries(taken)) if (name.startsWith('sync.')) results.add(name, values);
};

test(`sync on a ${NETWORK} network: a push, its wait, and the other device's pull`, async ({ browser }) => {
  const results = new Results('this', 'web-desktop', NETWORK);
  const user = newUser();
  const [phone, desk] = [await device(browser, user), await device(browser, user)];
  const unshape = await shape(NETWORK);
  for (let i = 0; i < PULLS; i++) {
    const dialog = phone.getByRole('dialog', { name: 'Capture' });
    await phone.keyboard.press('Shift+Meta+Space');
    await dialog.getByRole('textbox', { name: /Capture to Inbox/ }).fill(`Pushed ${i}`);
    await phone.keyboard.press('Enter');
    await phone.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // The push goes 2 seconds after the last edit; a flaky network may need tries.
    await waitForMeasure(phone, 'sync.push').catch(() => undefined);
    await collectSync(phone, results);
    // The pull ends once a screen draws what it brought.
    await syncNow(desk);
    await waitForMeasure(desk, 'sync.pull');
    await collectSync(desk, results);
  }
  await unshape();
  results.write();
});

test.describe('on a good network', () => {
  test.skip(NETWORK !== 'good', 'Busy and two-device runs use the good network');

  const p95 = (values: number[] | undefined) => (values?.length ? percentile(values, 0.95) : 0);

  test('capture and the screens while 5,000 records come down, against the same device idle', async ({ browser }) => {
    const results = new Results('this', 'web-desktop', 'background-sync');
    const idle = new Results('this', 'web-desktop', 'background-idle');
    const user = newUser();
    const desk = await device(browser, user);
    // The longest main-thread task, which should stay under 200 ms.
    await desk.evaluate(() => {
      const w = window as unknown as { longest: number };
      w.longest = 0;
      new PerformanceObserver((list) => list.getEntries().forEach((e) => (w.longest = Math.max(w.longest, e.duration)))).observe({ type: 'longtask', buffered: false });
    });
    const run = async (into: Results, rounds: number) => {
      for (let i = 0; i < rounds; i++) {
        for (const action of [capture, screens] as Action[]) await action(desk, false);
      }
      for (const [name, values] of Object.entries(collect(desk))) into.add(name, values);
    };
    await run(idle, 10);
    // A third device with 5,000 tasks of its own signs in and pushes them; the desk pulls them while timed.
    const many = Array.from({ length: 5000 }, (_, i) => ({ type: 'task', fields: { kind: 'inbox', title: `Brought ${i}` } }));
    await device(browser, user, many);
    await desk.evaluate(() => ((window as unknown as { longest: number }).longest = 0));
    // The pull starts, and the actions run while it applies.
    await syncNow(desk, false);
    await run(results, 10);
    const longest = await desk.evaluate(() => (window as unknown as { longest: number }).longest);
    results.write();
    idle.write();
    for (const kpi of ['capture.open', 'capture.save', 'nav.today']) {
      const [b, i] = [p95(results.samples.get(kpi)), p95(idle.samples.get(kpi))];
      console.log(`${kpi}: p95 ${b.toFixed(1)} ms while syncing, ${i.toFixed(1)} ms idle${b > i * 1.5 ? ', over 1.5 times, report only' : ''}`);
    }
    console.log(`Longest main-thread task while syncing: ${longest.toFixed(0)} ms${longest > 200 ? ', over 200 ms, report only' : ''}`);
  });

  test('two devices editing at once for a minute end up equal', async ({ browser }) => {
    const results = new Results('this', 'web-desktop', 'two-devices');
    const user = newUser();
    const pages = [await device(browser, user), await device(browser, user)];
    const until = Date.now() + 60_000;
    for (let i = 0; Date.now() < until; i++) {
      await Promise.all(
        pages.map(async (page, d) => {
          const dialog = page.getByRole('dialog', { name: 'Capture' });
          await page.keyboard.press('Shift+Meta+Space');
          await dialog.getByRole('textbox', { name: /Capture to Inbox/ }).fill(`Device ${d} edit ${i}`);
          await page.keyboard.press('Enter');
          await page.keyboard.press('Escape');
          await expect(dialog).toHaveCount(0);
        }),
      );
      await pages[0]!.waitForTimeout(1000);
    }
    // Each pushes what's left, then each pulls the other's.
    for (const page of [...pages, ...pages]) await syncNow(page);
    for (const page of pages) await collectSync(page, results);
    results.write();
    // Inbox's count in the navigation, which every capture adds to: the same on both, and all of them.
    const inbox = (page: Page) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Inbox/ }).textContent();
    await expect.poll(async () => (await Promise.all(pages.map(inbox))).join(' and ')).toMatch(/^(Inbox\d+) and \1$/);
  });
});
