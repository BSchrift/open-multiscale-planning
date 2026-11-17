// The browser's performance KPIs (docs/performance.md), on the runner's build of each target: capture, the screens, the
// heap after them, and cold and warm starts with the bytes a first load fetches. Run by scripts/test-perf.sh. A scenario
// is its data, and the nightly's conditions after a +: one-year+offline with the browser offline once loaded, and
// one-year+cpu6x with the phone's CPU 6 times slower, for low-end phones.

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Platform } from '../../../config/perf';
import { capture, CPU, heapMb, interleave, LAUNCHES, openLaunched, purgeFileCache, Results, scenarioData, SCENARIOS, screens, settled, slowCpu, targets } from './harness';

test.describe.configure({ timeout: 3_600_000 });

/** Lighthouse's slow 4G, for the phone's cold start: 150 ms round trips, 1.6 Mbps down and 750 kbps up. */
const SLOW_4G = { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 };

for (const scenario of SCENARIOS) {
  test(`${scenario}: capture, screens, heap and starts`, async ({ browser, playwright }, info) => {
    const platform = info.project.name as Platform;
    const phone = platform === 'web-phone';
    const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, launchOptions } = info.project.use;
    const device = { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
    const [dataName, condition] = scenario.split('+');
    const data = scenarioData(dataName!);
    const cpu = condition === 'cpu6x' ? 6 : CPU;
    const builds = await Promise.all(
      targets().map(async (target) => {
        const context = await browser.newContext({ ...device, baseURL: target.url });
        const page = await context.newPage();
        await openLaunched(page, data);
        // Slowed only now: the seed and its first launch are setup, not timed.
        if (phone) await slowCpu(page, cpu);
        await page.reload();
        await settled(page);
        if (condition === 'offline') await context.setOffline(true);
        return { target, page, results: new Results(target.name, platform, scenario) };
      }),
    );

    await interleave(builds, capture, phone);
    await interleave(builds, screens, phone);
    for (const { page, results } of builds) {
      results.add('mem.heap', [await heapMb(page)]);
      await page.context().close();
    }

    // Starts: a profile per build that holds the data as its first launch left it, copied without its HTTP cache for
    // each cold launch, then reloaded warm. Launches take turns between the builds, as the actions do.
    const launch = (dir: string, url: string) => playwright.chromium.launchPersistentContext(dir, { ...device, baseURL: url, args: launchOptions?.args ?? [] });
    const profiles = new Map<string, string>();
    for (const { target } of LAUNCHES > 0 ? builds : []) {
      const profile = mkdtempSync(join(tmpdir(), 'multiscale-perf-'));
      const setup = await launch(profile, target.url);
      await openLaunched(setup.pages()[0] ?? (await setup.newPage()), data);
      await setup.close();
      profiles.set(target.name, profile);
    }
    for (let i = 0; i < LAUNCHES; i++) {
      for (const { target, results } of i % 2 === 0 ? builds : [...builds].reverse()) {
        const copy = mkdtempSync(join(tmpdir(), 'multiscale-perf-'));
        cpSync(profiles.get(target.name)!, copy, { recursive: true });
        for (const cache of ['Default/Cache', 'Default/Code Cache', 'Default/GPUCache']) rmSync(join(copy, cache), { recursive: true, force: true });
        purgeFileCache();
        const context = await launch(copy, target.url);
        const page = context.pages()[0] ?? (await context.newPage());
        if (phone) await slowCpu(page, cpu);
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        if (phone) await cdp.send('Network.emulateNetworkConditions', SLOW_4G);
        let bytes = 0;
        cdp.on('Network.loadingFinished', (e) => (bytes += e.encodedDataLength));
        await page.goto('/');
        results.add('start.cold', [await interactiveAt(page)]);
        if (!phone) results.add('web.firstload', [Math.round(bytes / 1024)]);
        await page.reload();
        results.add('start.warm', [await interactiveAt(page)]);
        await context.close();
        rmSync(copy, { recursive: true, force: true });
      }
    }
    for (const profile of profiles.values()) rmSync(profile, { recursive: true, force: true });
    for (const { results } of builds) results.write();
  });
}

/** When Today was first drawn with its data, from navigation start. */
async function interactiveAt(page: Page): Promise<number> {
  await page.waitForFunction(() => performance.getEntriesByName('today:interactive', 'mark').length > 0, undefined, { timeout: 120_000, polling: 20 });
  return page.evaluate(() => performance.getEntriesByName('today:interactive', 'mark')[0]!.startTime);
}
