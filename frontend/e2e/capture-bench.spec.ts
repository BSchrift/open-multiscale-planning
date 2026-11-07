// Capture timings in the browser build, on two years of records. BENCH=1 runs it, BENCH_RUNS sets the repeats, and
// the numbers print to the console rather than being checked.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Db, Sql } from '../src/core/db';
import { seedLarge } from '../src/core/queries-testing';
import { openSeeded } from './seed';
import type { Seed } from './seed';

const RUNS = Number(process.env.BENCH_RUNS) || 10;

test.skip(!process.env.BENCH, 'BENCH=1 runs the capture benchmark');
test.describe.configure({ timeout: 600_000 });

/** seedLarge's records, as seeds. */
async function largeSeeds(): Promise<Seed[]> {
  const seeds: Seed[] = [];
  const sql = {
    run: async (_s: string, p: { id: string; type: string; data: string }) => void seeds.push({ type: p.type, id: p.id, fields: JSON.parse(p.data) }),
  } as unknown as Sql;
  await seedLarge({ transaction: (fn: (tx: Sql) => Promise<unknown>) => fn(sql) } as unknown as Db);
  return seeds;
}

/** Times capture in the page, each from its trigger event's own timestamp. Once per page load. */
async function instrument(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { bench: Record<string, number[]>; trigger: number };
    const installed = !!w.bench;
    w.bench = { open: [], openFrame: [], key: [], keyFrame: [], saved: [], closed: [] };
    if (installed) return;
    w.trigger = 0;
    let keyAt = 0;
    let enterAt = 0;
    let escAt = 0;
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'Space' && e.metaKey) w.trigger = e.timeStamp;
        else if (e.key === 'Enter') enterAt = e.timeStamp;
        else if (e.key === 'Escape') escAt = e.timeStamp;
        else if (e.key.length === 1) keyAt = e.timeStamp;
      },
      true,
    );
    document.addEventListener('pointerdown', (e) => (w.trigger = e.timeStamp), true);
    document.addEventListener('focusin', (e) => {
      if (!w.trigger || !(e.target as HTMLElement).matches?.('input[aria-label^="Capture to"], input[placeholder="What\'s on your mind?"]')) return;
      const start = w.trigger;
      w.trigger = 0;
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
    // Desktop says Saved in the sheet; phone closes the sheet and says it in a toast.
    new MutationObserver(() => {
      if (enterAt && (document.querySelector('.capstatus')?.textContent?.includes('Saved') || document.querySelector('.toast')?.textContent?.includes('Saved'))) {
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

function stats(name: string, values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  console.log(
    `${name}: median ${at(0.5).toFixed(1)} ms, p90 ${at(0.9).toFixed(1)}, min ${sorted[0]!.toFixed(1)}, max ${sorted[sorted.length - 1]!.toFixed(1)} (n=${values.length})`,
  );
}

const ready = async (page: Page) => {
  await expect(page.locator(".pane[aria-label='Today'] h1").first()).toBeVisible();
  await page.waitForTimeout(1500);
};

test('capture in the browser: first and later opens, typing, and saving', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await openSeeded(page, await largeSeeds());
  // The browser build saves its database a moment after the last write.
  await page.waitForTimeout(2000);
  await page.reload();
  await ready(page);
  const dialog = page.getByRole('dialog', { name: 'Capture' });
  const field = dialog.getByRole('textbox', { name: /Capture to Inbox/ });
  const open = async () => {
    if (phone) await page.getByRole('button', { name: 'Capture a task' }).click();
    else await page.keyboard.press('Shift+Meta+Space');
    await expect(field).toBeFocused();
  };

  const cold: number[] = [];
  const coldFrame: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    if (i > 0) {
      await page.reload();
      await ready(page);
    }
    await instrument(page);
    await open();
    await page.waitForTimeout(100);
    const r = await results(page);
    cold.push(r.open![0]!);
    coldFrame.push(r.openFrame![0]!);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
  stats(`${info.project.name} first open after load, trigger to focused`, cold);
  stats(`${info.project.name} first open after load, trigger to next frame`, coldFrame);

  await instrument(page);
  for (let i = 0; i < RUNS; i++) {
    await open();
    await page.keyboard.type('Buy stamps and envelopes', { delay: 30 });
    await page.waitForTimeout(50);
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(300);
  }
  const r = await results(page);
  stats(`${info.project.name} later open, trigger to focused`, r.open!);
  stats(`${info.project.name} later open, trigger to next frame`, r.openFrame!);
  stats(`${info.project.name} keystroke to handled`, r.key!);
  stats(`${info.project.name} keystroke to next frame`, r.keyFrame!);
  stats(`${info.project.name} Enter to saved`, r.saved!);
});
