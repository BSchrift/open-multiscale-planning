// What the performance specs share: their settings, the data each scenario loads, the actions that make each KPI's
// measure, and the interleaving that takes samples from every build in turn, so whatever the runner's speed, each gets
// it. Results go to one JSON file per build, platform and scenario, which scripts/perf-report.ts reads.
//   PERF_SAMPLES   samples per KPI per build, after the warm-up (100)
//   PERF_WARMUP    actions done first and thrown away (20)
//   PERF_LAUNCHES  launches for the start KPIs, cold and warm each (5; 0 skips them)
//   PERF_CPU       how much the phone rows slow the CPU (4)
//   PERF_SCENARIOS which data: empty, one-year, five-year (one-year), each with a condition after a + (web.spec.ts)
//   PERF_PURGE     1 empties the OS file cache before each cold start (needs sudo)
//   PERF_TARGETS   the builds, name=url,... as scripts/test-perf.sh serves them
//   PERF_OUT       where the results go (test-results/perf/raw)

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { parse } from 'yaml';
import type { Platform } from '../../../config/perf';
import { loadRetention } from '../../../config/retention';
import { emptyAccount, historyChanges, keptHistory } from '../../src/core/history-testing';
import type { RecordChange } from '../../src/core/types';
import { openWithHistory, readRecord } from '../seed';

const num = (name: string, fallback: number) => (process.env[name] ? Number(process.env[name]) : fallback);
export const SAMPLES = num('PERF_SAMPLES', 100);
export const WARMUP = num('PERF_WARMUP', 20);
export const LAUNCHES = num('PERF_LAUNCHES', 5);
export const CPU = num('PERF_CPU', 4);
export const SCENARIOS = (process.env.PERF_SCENARIOS ?? 'one-year').split(',');
export const OUT = process.env.PERF_OUT ?? join(import.meta.dirname, '../../test-results/perf/raw');
/** Samples taken from one build before the next build's turn. */
export const ROUND = 10;

export interface Target {
  name: string;
  url: string;
}
export const targets = (): Target[] =>
  (process.env.PERF_TARGETS ?? '').split(',').filter(Boolean).map((pair) => {
    const [name, url] = pair.split('=');
    return { name: name!, url: url! };
  });

/** The scenario's account, ending now, as history-testing.ts makes them. */
export function scenarioData(scenario: string): RecordChange[] {
  const now = Date.now();
  if (scenario === 'empty') return emptyAccount(now);
  if (scenario === 'one-year') return historyChanges({ weeks: 52, now });
  if (scenario === 'five-year') return historyChanges({ weeks: 260, now });
  throw new Error(`No data for the scenario ${scenario}: use empty, one-year or five-year.`);
}

/**
 * Opens the app on the account as its first launch leaves it. The records carry no expiry, as those from before retention
 * don't, so that launch works out each one's and then removes what has expired (core/expiry.ts): over half of five
 * years, with Today empty until it's done, which takes minutes on the slowed phone. A device does that once, so no KPI
 * times it: this launches once more and waits for a record that launch removes to be gone.
 */
export async function openLaunched(page: Page, changes: readonly RecordChange[]): Promise<void> {
  await openWithHistory(page, changes);
  // The runner's builds are local's (scripts/test-perf.sh), whose deleted period says what that launch removes.
  const { deleted } = loadRetention('local', { read: (path) => readFileSync(path, 'utf8'), parse });
  const kept = new Set(keptHistory(deleted, Date.now(), [...changes]));
  const gone = changes.find((change) => !kept.has(change));
  if (!gone) return;
  await page.reload();
  await expect.poll(() => readRecord(page, gone.type, gone.id), { timeout: 120_000 }).toBeUndefined();
}

/** Samples by KPI, for one build, platform and scenario. */
export class Results {
  readonly samples = new Map<string, number[]>();
  constructor(readonly target: string, readonly platform: Platform, readonly scenario: string) {}
  add(kpi: string, values: readonly number[]) {
    this.samples.set(kpi, [...(this.samples.get(kpi) ?? []), ...values]);
  }
  write() {
    mkdirSync(OUT, { recursive: true });
    const body = { target: this.target, platform: this.platform, scenario: this.scenario, samples: Object.fromEntries(this.samples) };
    writeFileSync(join(OUT, `${this.target}--${this.platform}--${this.scenario}.json`), JSON.stringify(body));
  }
}

/** Every measure the page holds, by name, and clears them. */
export const takeMeasures = (page: Page) =>
  page.evaluate(() => {
    const all: Record<string, number[]> = {};
    for (const m of performance.getEntriesByType('measure')) (all[m.name] ??= []).push(m.duration);
    performance.clearMeasures();
    return all;
  });

/** Waits until the page holds at least count measures of the name: 15 seconds at most, so a lost one fails the action. */
export const waitForMeasure = (page: Page, name: string, count = 1) =>
  page.waitForFunction(([n, c]) => performance.getEntriesByName(n as string, 'measure').length >= (c as number), [name, count] as const, { polling: 20, timeout: 15_000 });

/** The phone rows' slower CPU, as Lighthouse slows it for phones. Chromium only. */
export async function slowCpu(page: Page, rate: number) {
  if (rate <= 1) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
}

/**
 * Empties the OS file cache before a cold start, with PERF_PURGE=1 as the nightly sets it on runners that allow sudo:
 * purge on macOS, which covers the iPhone Simulator too, and drop_caches on Linux.
 */
export function purgeFileCache() {
  if (process.env.PERF_PURGE !== '1') return;
  execSync(process.platform === 'darwin' ? 'sudo purge' : 'sync && echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null');
}

/** The page's JavaScript heap in MB, as Chromium counts it (JSHeapUsedSize). */
export async function heapMb(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const { metrics } = await cdp.send('Performance.getMetrics');
  return (metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0) / 1048576;
}

/** Waits for Today drawn with its data, then lets startup's first reads and statistics settle. */
export async function settled(page: Page) {
  await page.waitForFunction(() => performance.getEntriesByName('today:interactive', 'mark').length > 0, undefined, { timeout: 120_000 });
  await page.waitForTimeout(1500);
  await takeMeasures(page);
}

/** One round of actions, each making its KPIs' measures. */
export type Action = (page: Page, phone: boolean) => Promise<void>;

/** Opens capture, types a word, and saves it: capture.open, capture.key for each letter, and capture.save. */
export const capture: Action = async (page, phone) => {
  const dialog = page.getByRole('dialog', { name: 'Capture' });
  if (phone) await page.getByRole('button', { name: 'Capture a task' }).click();
  else await page.keyboard.press('Shift+Meta+Space');
  await expect(dialog.getByRole('textbox', { name: /Capture to Inbox/ })).toBeFocused();
  await waitForMeasure(page, 'capture.open');
  // About as fast as a quick typist, so each key has its own frame.
  await page.keyboard.type('Buy', { delay: 40 });
  await waitForMeasure(page, 'capture.key', 3);
  await page.keyboard.press('Enter');
  await waitForMeasure(page, 'capture.save');
  if (!phone) await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await keep(page);
};

/** Today, Week, Done and Analytics in turn, each a nav measure; on phone, Done and Analytics are under More. */
export const screens: Action = async (page, phone) => {
  const main = page.getByRole('navigation', { name: 'Main' });
  const tab = (name: string): Locator => main.getByRole('button', { name: new RegExp(`^${name}`) });
  for (const screen of ['Week', 'Done', 'Analytics', 'Today']) {
    const name = `nav.${screen.toLowerCase()}`;
    if (phone && (screen === 'Done' || screen === 'Analytics')) {
      await tab('More').click();
      const back = page.getByRole('button', { name: 'Back to More' });
      if (await back.isVisible()) await back.click();
      await page.locator(".pane[aria-label='More']:visible").getByRole('button', { name: new RegExp(`^${screen}`) }).click();
    } else {
      await tab(screen).click();
    }
    await waitForMeasure(page, name);
    await keep(page);
  }
};

// Each action ends by moving its measures out of the page into here, where the round collects them, so the page's list
// stays short and the next wait counts only new ones.
const pending = new WeakMap<Page, Record<string, number[]>>();
export async function keep(page: Page) {
  const taken = await takeMeasures(page);
  const into = pending.get(page) ?? {};
  for (const [name, values] of Object.entries(taken)) (into[name] ??= []).push(...values);
  pending.set(page, into);
}
/** What the actions on a page kept since the last call. */
export function collect(page: Page): Record<string, number[]> {
  const taken = pending.get(page) ?? {};
  pending.delete(page);
  return taken;
}

/**
 * An action, tried again up to twice when it fails: Today opens some questions by itself, such as how a block that
 * ended went, and one opening over capture closes it. Whatever is open is closed with Escape, and the measures the
 * failed try left in the page thrown away.
 */
async function attempt(action: Action, page: Page, phone: boolean) {
  for (let tries = 1; ; tries++) {
    try {
      return await action(page, phone);
    } catch (err) {
      if (tries === 3) throw err;
      console.log(`${action.name} failed, trying again: ${String(err).split('\n')[0]}`);
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape');
      await takeMeasures(page);
    }
  }
}

/**
 * Warms each build up, then takes SAMPLES rounds' worth from them in turn, ROUND actions at a time, in alternating order
 * (ABBAAB...), so neither always goes first.
 */
export async function interleave(builds: { page: Page; results: Results }[], action: Action, phone: boolean) {
  const began = Date.now();
  const rounds = Math.ceil(SAMPLES / ROUND);
  for (const { page } of builds) {
    for (let i = 0; i < WARMUP; i++) await attempt(action, page, phone);
    collect(page);
  }
  for (let round = 0; round * ROUND < SAMPLES; round++) {
    const order = round % 2 === 0 ? builds : [...builds].reverse();
    for (const { page, results } of order) {
      for (let i = 0; i < ROUND; i++) await attempt(action, page, phone);
      for (const [name, values] of Object.entries(collect(page))) results.add(name, values);
    }
    // The pace, so a run that's slow or stuck shows where.
    if ((round + 1) % 5 === 0 || round + 1 === rounds) console.log(`${action.name}: round ${round + 1} of ${rounds} after ${Math.round((Date.now() - began) / 1000)} s`);
  }
}
