// Capture timings in the real desktop app, on two years of records. BENCH=1 runs it, BENCH_RUNS sets the repeats, and
// the numbers print to the console rather than being checked. Build first: npx vite build && node scripts/electron-compile.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { openDb } from '../../src/core/db';
import { seedLarge } from '../../src/core/queries-testing';
import { transact, updateSettings } from '../../src/core/records';
import { systemClock } from '../../src/core/clock';
import { nodeSqliteDriver } from '../../src/platform/node-sqlite';

const ROOT = join(import.meta.dirname, '../..');
const RUNS = Number(process.env.BENCH_RUNS) || 15;

test.skip(!process.env.BENCH, 'BENCH=1 runs the capture benchmark');
test.describe.configure({ timeout: 600_000 });

let dataDir: string;
let app: ElectronApplication | undefined;

async function seeded() {
  dataDir = mkdtempSync(join(tmpdir(), 'multiscale-bench-'));
  writeFileSync(join(dataDir, 'login-item-set'), '');
  const db = await openDb(nodeSqliteDriver(join(dataDir, 'multiscale.sqlite')));
  await seedLarge(db);
  await transact(db, systemClock, (w) => updateSettings(w, { setup_done_at: '2026-01-01T00:00:00Z' }));
  await db.close();
}

const ready = async (page: Page) => {
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.locator(".pane[aria-label='Today'] h1").first()).toBeVisible();
  // Lets startup work settle: the first queries, reminders and statistics.
  await page.waitForTimeout(1500);
};

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  app = await electron.launch({
    args: [ROOT, `--user-data-dir=${dataDir}`, '--use-mock-keychain'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  const page = await app.firstWindow();
  await ready(page);
  return { app, page };
}

type Marks = Record<string, number>;

/**
 * Counts each database call the page makes over IPC, and marks the capture panel's steps, in epoch ms. The calls are
 * counted through ipcMain's own handler map, an Electron internal that a later Electron may rename.
 */
async function instrumentMain(electronApp: ElectronApplication) {
  await electronApp.evaluate(({ app: a, ipcMain }) => {
    const g = globalThis as unknown as { dbCalls: { at: number; sql: string }[]; marks: Record<string, number> };
    const now = () => performance.timeOrigin + performance.now();
    g.dbCalls = [];
    g.marks = {};
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
    for (const channel of ['db:exec', 'db:all', 'db:run']) {
      const original = handlers.get(channel)!;
      handlers.set(channel, (event: unknown, sql: unknown, ...rest: unknown[]) => {
        g.dbCalls.push({ at: now(), sql: String(sql).replace(/\s+/g, ' ').trim().slice(0, 60) });
        return original(event, sql, ...rest);
      });
    }
    const save = handlers.get('capture:save')!;
    handlers.set('capture:save', (...args: unknown[]) => {
      g.marks.received = now();
      return save(...args);
    });
    ipcMain.on('capture:done', () => (g.marks.done = now()));
    const wrap = (w: Electron.BrowserWindow) => {
      for (const name of ['show', 'hide'] as const) {
        const original = w[name].bind(w);
        w[name] = () => {
          g.marks[`${name}Called`] = now();
          original();
        };
        w.on(name as 'show', () => (g.marks[`${name}Event`] = now()));
      }
    };
    a.on('browser-window-created', (_e, w: Electron.BrowserWindow) => wrap(w));
    (globalThis as unknown as { wrapWindow: typeof wrap }).wrapWindow = wrap;
  });
}

const takeCalls = (electronApp: ElectronApplication) =>
  electronApp.evaluate(() => (globalThis as unknown as { dbCalls: { at: number; sql: string }[] }).dbCalls.splice(0));

const takeMarks = (electronApp: ElectronApplication) =>
  electronApp.evaluate(() => {
    const g = globalThis as unknown as { marks: Marks };
    const marks = g.marks;
    g.marks = {};
    return marks;
  });

/** Presses the shortcut, as its callback does, and returns when that was in epoch ms. */
const pressShortcut = (electronApp: ElectronApplication) =>
  electronApp.evaluate(({ app: a }) => {
    const at = performance.timeOrigin + performance.now();
    a.emit('capture-shortcut');
    return at;
  });

function stats(name: string, values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  console.log(
    `${name}: median ${at(0.5).toFixed(1)} ms, p90 ${at(0.9).toFixed(1)}, min ${sorted[0]!.toFixed(1)}, max ${sorted[sorted.length - 1]!.toFixed(1)} (n=${values.length})`,
  );
}

test.beforeEach(seeded);
test.afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

test('shortcut panel: first and later opens, and Enter to hidden', async () => {
  const coldShow: number[] = [];
  const coldShown: number[] = [];
  let running: ElectronApplication | undefined;
  for (let i = 0; i < Math.min(RUNS, 6); i++) {
    if (running) {
      await running.close();
      rmSync(dataDir, { recursive: true, force: true });
      await seeded();
    }
    ({ app: running } = await launch());
    await instrumentMain(running);
    // Wraps a panel made at startup, if there is one.
    await running.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().endsWith('capture.html'));
      if (w) (globalThis as unknown as { wrapWindow(w: Electron.BrowserWindow): void }).wrapWindow(w);
    });
    const pressed = await pressShortcut(running);
    await expect.poll(async () => (await running!.evaluate(() => (globalThis as unknown as { marks: Marks }).marks)).showEvent ?? 0).toBeGreaterThan(0);
    const marks = await takeMarks(running);
    coldShow.push(marks.showCalled! - pressed);
    coldShown.push(marks.showEvent! - pressed);
  }
  const metrics = await running!.evaluate(({ app: a, BrowserWindow }) =>
    a.getAppMetrics().map((m) => {
      const w = BrowserWindow.getAllWindows().find((b) => b.webContents.getOSProcessId() === m.pid);
      return { pid: m.pid, name: `${m.type} ${w ? w.webContents.getURL().split('/').pop() : ''} ${Math.round(m.memory.workingSetSize / 1024)} MB` };
    }),
  );
  // The memory each process holds, as Activity Monitor counts it.
  for (const m of metrics) {
    const footprint = execFileSync('footprint', [String(m.pid)], { encoding: 'utf8' }).match(/Footprint: ([\d.]+ \w+)/)?.[1];
    console.log(`${m.name}, footprint ${footprint}`);
  }
  stats('panel first press after launch, to show()', coldShow);
  stats('panel first press after launch, to shown event', coldShown);

  const capture = running!.windows().find((w) => w.url().endsWith('capture.html'))!;
  const field = capture.getByRole('textbox', { name: 'Capture' });
  await expect(field).toBeFocused();

  const show: number[] = [];
  const shown: number[] = [];
  const phases: number[][] = [];
  const calls: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    await field.fill(`Bench ${i}`);
    await takeCalls(running!);
    await takeMarks(running!);
    const enterAt = capture.evaluate(
      () => new Promise<number>((resolve) => document.addEventListener('keydown', (e) => resolve(performance.timeOrigin + e.timeStamp), { once: true, capture: true })),
    );
    await field.press('Enter');
    const enter = await enterAt;
    await expect.poll(async () => (await running!.evaluate(() => (globalThis as unknown as { marks: Marks }).marks)).hideEvent ?? 0).toBeGreaterThan(0);
    await capture.waitForTimeout(400);
    const m = await takeMarks(running!);
    const made = await takeCalls(running!);
    const begin = made.find((c) => c.sql.startsWith('BEGIN'))!.at;
    const commit = made.find((c) => c.sql.startsWith('COMMIT'))!.at;
    phases.push([m.received! - enter, begin - m.received!, commit - begin, m.done! - commit, m.hideCalled! - enter, m.hideEvent! - enter]);
    calls.push(made.findIndex((c) => c.sql.startsWith('COMMIT')) - made.findIndex((c) => c.sql.startsWith('BEGIN')) + 1);

    const pressed = await pressShortcut(running!);
    await expect.poll(async () => (await running!.evaluate(() => (globalThis as unknown as { marks: Marks }).marks)).showEvent ?? 0).toBeGreaterThan(0);
    const o = await takeMarks(running!);
    show.push(o.showCalled! - pressed);
    shown.push(o.showEvent! - pressed);
    await expect(field).toBeFocused();
  }
  stats('panel later press, to show()', show);
  stats('panel later press, to shown event', shown);
  const names = ['Enter to main', 'main to BEGIN', 'BEGIN to COMMIT', 'COMMIT to done', 'Enter to hide()', 'Enter to hidden event'];
  names.forEach((n, i) => stats(`panel save, ${n}`, phases.map((p) => p[i]!)));
  console.log(`panel db calls in the save transaction: ${calls.join(',')}`);
});

/** Times the overlay in the page: trigger to focused field and frame, typing, and Enter to saved. */
async function instrumentPage(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { bench: Record<string, number[]>; benchTrigger: number };
    const installed = !!w.bench;
    w.bench = { open: [], openFrame: [], key: [], keyFrame: [], saved: [], closed: [] };
    if (installed) return;
    let keyAt = 0;
    let enterAt = 0;
    let escAt = 0;
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'Space' && e.metaKey) w.benchTrigger = e.timeStamp;
        else if (e.key === 'Enter') enterAt = e.timeStamp;
        else if (e.key === 'Escape') escAt = e.timeStamp;
        else if (e.key.length === 1) keyAt = e.timeStamp;
      },
      true,
    );
    document.addEventListener('pointerdown', (e) => (w.benchTrigger = e.timeStamp), true);
    document.addEventListener('focusin', (e) => {
      if (!w.benchTrigger || !(e.target as HTMLElement).matches?.('input[aria-label^="Capture to"]')) return;
      const start = w.benchTrigger;
      w.benchTrigger = 0;
      w.bench.open!.push(performance.now() - start);
      requestAnimationFrame(() => setTimeout(() => w.bench.openFrame!.push(performance.now() - start)));
    });
    window.addEventListener('input', () => {
      if (!keyAt) return;
      const start = keyAt;
      keyAt = 0;
      w.bench.key!.push(performance.now() - start);
      requestAnimationFrame(() => setTimeout(() => w.bench.keyFrame!.push(performance.now() - start)));
    });
    new MutationObserver(() => {
      if (enterAt && document.querySelector('.capstatus')?.textContent?.includes('Saved')) {
        w.bench.saved!.push(performance.now() - enterAt);
        enterAt = 0;
      }
      if (escAt && !document.querySelector('[role=dialog][aria-label=Capture]')) {
        w.bench.closed!.push(performance.now() - escAt);
        escAt = 0;
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

const results = (page: Page) => page.evaluate(() => (window as unknown as { bench: Record<string, number[]> }).bench);

test('in-app overlay: first and later opens, typing, and Enter to saved', async () => {
  const { app: running, page } = await launch();
  await instrumentMain(running);
  const dialog = page.getByRole('dialog', { name: 'Capture' });
  const field = dialog.getByRole('textbox', { name: 'Capture to Inbox' });

  const cold: number[] = [];
  const coldFrame: number[] = [];
  for (let i = 0; i < Math.min(RUNS, 8); i++) {
    if (i > 0) {
      await page.reload();
      await ready(page);
    }
    await instrumentPage(page);
    await page.keyboard.press('Shift+Meta+Space');
    await expect(field).toBeFocused();
    await page.waitForTimeout(100);
    const r = await results(page);
    cold.push(r.open![0]!);
    coldFrame.push(r.openFrame![0]!);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
  stats('overlay first open after load, trigger to focused', cold);
  stats('overlay first open after load, trigger to next frame', coldFrame);

  await page.waitForTimeout(300);
  await instrumentPage(page);
  const inSave: number[] = [];
  const txTime: number[] = [];
  const after: number[] = [];
  const settle: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    await page.keyboard.press('Shift+Meta+Space');
    await expect(field).toBeFocused();
    await page.keyboard.type('Buy stamps and envelopes', { delay: 30 });
    await page.waitForTimeout(100);
    await takeCalls(running);
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('status')).toContainText('Saved');
    await expect(dialog).toHaveCount(0);
    const made = await takeCalls(running);
    const begin = made.findIndex((c) => c.sql.startsWith('BEGIN'));
    const commit = made.findIndex((c) => c.sql.startsWith('COMMIT'));
    inSave.push(commit - begin + 1);
    txTime.push(made[commit]!.at - made[begin]!.at);
    after.push(made.length - commit - 1);
    settle.push(made[made.length - 1]!.at - made[commit]!.at);
  }
  const r = await results(page);
  stats('overlay later open, trigger to focused', r.open!);
  stats('overlay later open, trigger to next frame', r.openFrame!);
  stats('keystroke to handled', r.key!);
  stats('keystroke to next frame', r.keyFrame!);
  stats('Enter to Saved shown', r.saved!);
  console.log(`db calls in the save transaction: ${inSave.join(',')}`);
  stats('save transaction, first call to COMMIT', txTime);
  console.log(`db calls after it, refreshing screens: ${after.join(',')}`);
  stats('COMMIT to the last refresh call', settle);
});

test('in-app overlay: later opens with every tab visited', async () => {
  const { page } = await launch();
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const name of ['Inbox', 'Week', 'Plan', 'Goals', 'One offs', 'Analytics', 'Settings', 'Today']) {
    await nav.getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) }).click();
    await page.waitForTimeout(700);
  }
  const dialog = page.getByRole('dialog', { name: 'Capture' });
  const field = dialog.getByRole('textbox', { name: 'Capture to Inbox' });
  // Once untimed, so a first open that has to load Capture doesn't count.
  await page.keyboard.press('Shift+Meta+Space');
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');
  await instrumentPage(page);
  for (let i = 0; i < RUNS; i++) {
    await page.keyboard.press('Shift+Meta+Space');
    await expect(field).toBeFocused();
    await page.waitForTimeout(100);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(100);
  }
  const r = await results(page);
  stats('every tab visited, open, trigger to focused', r.open!);
  stats('every tab visited, open, trigger to next frame', r.openFrame!);
  stats('every tab visited, Esc to closed', r.closed!);
});
