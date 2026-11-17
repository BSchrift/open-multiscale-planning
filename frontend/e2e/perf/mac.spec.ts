// The Mac app's performance KPIs (docs/performance.md), on each build PERF_MAC_TARGETS names (name=frontend folder,
// built with vite build and electron-compile): capture in the window and from the global shortcut, the screens, coming
// back to the app, the heap, and cold and warm starts from the launch. On Linux under xvfb in CI, and on macOS weekly.

import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { openDb } from '../../src/core/db';
import { applyRemote } from '../../src/core/records';
import { nodeSqliteDriver } from '../../src/platform/node-sqlite';
import { capture, heapMb, interleave, keep, LAUNCHES, purgeFileCache, Results, ROUND, SAMPLES, scenarioData, SCENARIOS, screens, settled, waitForMeasure, WARMUP } from './harness';
import type { Action } from './harness';

test.describe.configure({ timeout: 3_600_000 });

const ROOT = join(import.meta.dirname, '../..');
const KEYCHAIN = process.platform === 'linux' ? ['-r', join(import.meta.dirname, '../../electron/e2e/linux-keychain.cjs')] : [];
const macTargets = () =>
  (process.env.PERF_MAC_TARGETS ?? `this=${ROOT}`).split(',').filter(Boolean).map((pair) => {
    const [name, dir] = pair.split('=');
    return { name: name!, dir: dir! };
  });

/** A data folder holding the scenario's account, as a sync would have applied it. */
async function dataFolder(scenario: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'multiscale-perf-'));
  writeFileSync(join(dir, 'login-item-set'), '');
  const db = await openDb(nodeSqliteDriver(join(dir, 'multiscale.sqlite')));
  // The data alone: the nightly's conditions are the browser's.
  await applyRemote(db, scenarioData(scenario.split('+')[0]!));
  await db.close();
  return dir;
}

async function launch(dir: string, data: string): Promise<{ app: ElectronApplication; page: Page; launched: number }> {
  const launched = Date.now();
  const app = await electron.launch({ args: [...KEYCHAIN, dir, `--user-data-dir=${data}`, '--use-mock-keychain'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const page = await app.firstWindow();
  return { app, page, launched };
}

/** The panel the global shortcut shows: capture.global, then Escape, which hides it. */
const shortcut = (app: ElectronApplication) => async () => {
    await expect.poll(() => app.windows().some((w) => w.url().endsWith('capture.html'))).toBe(true);
    const panel = app.windows().find((w) => w.url().endsWith('capture.html'))!;
    const before = await panel.evaluate(() => performance.getEntriesByName('capture.global').length);
    await app.evaluate(({ app: a }) => void a.emit('capture-shortcut'));
    await waitForMeasure(panel, 'capture.global', before + 1);
    await panel.keyboard.press('Escape');
};

/** The window coming back to the front, as Electron tells the page (platform/electron.ts): start.resume. */
const resume: Action = async (page) => {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitForMeasure(page, 'start.resume');
  await keep(page);
};

for (const scenario of SCENARIOS) {
  test(`${scenario}: capture, the shortcut, screens, resume, heap and starts`, async () => {
    const data = await dataFolder(scenario);
    const builds = [];
    for (const target of macTargets()) {
      const own = mkdtempSync(join(tmpdir(), 'multiscale-perf-'));
      cpSync(data, own, { recursive: true });
      const { app, page } = await launch(target.dir, own);
      await settled(page);
      builds.push({ target, app, page, own, results: new Results(target.name, 'mac', scenario) });
    }

    await interleave(builds, capture, false);
    await interleave(builds, screens, false);
    await interleave(builds, resume, false);
    await interleaveShortcut(builds);
    for (const { app, page, results } of builds) {
      results.add('mem.heap', [await heapMb(page)]);
      await app.close();
    }

    // Starts, from the launch to Today interactive: the first launch of a pair after the data folder was last opened,
    // which CI's nightly makes cold by purging the OS file cache first (PERF_PURGE), and the next one warm.
    for (let i = 0; i < LAUNCHES; i++) {
      for (const { target, own, results } of i % 2 === 0 ? builds : [...builds].reverse()) {
        for (const kpi of ['start.cold', 'start.warm']) {
          if (kpi === 'start.cold') purgeFileCache();
          const { app, page, launched } = await launch(target.dir, own);
          await page.waitForFunction(() => performance.getEntriesByName('today:interactive', 'mark').length > 0, undefined, { timeout: 120_000, polling: 20 });
          const at = await page.evaluate(() => performance.timeOrigin + performance.getEntriesByName('today:interactive', 'mark')[0]!.startTime);
          results.add(kpi, [at - launched]);
          await app.close();
        }
      }
    }
    for (const { own, results } of builds) {
      results.write();
      rmSync(own, { recursive: true, force: true });
    }
    rmSync(data, { recursive: true, force: true });
  });
}

/** The shortcut's samples, warmed up and taken in turns like the others, from each panel's own page. */
async function interleaveShortcut(builds: { app: ElectronApplication; results: Results }[]) {
  const take = async (app: ElectronApplication, presses: number) => {
    const press = shortcut(app);
    for (let i = 0; i < presses; i++) await press();
    const panel = app.windows().find((w) => w.url().endsWith('capture.html'))!;
    return panel.evaluate(() => {
      const all = performance.getEntriesByName('capture.global').map((m) => m.duration);
      performance.clearMeasures();
      return all;
    });
  };
  for (const { app } of builds) await take(app, WARMUP);
  for (let round = 0; round * ROUND < SAMPLES; round++) {
    for (const { app, results } of round % 2 === 0 ? builds : [...builds].reverse()) results.add('capture.global', await take(app, ROUND));
  }
}
