// Planning a stretch is where a goal's backlog is tidied: its block on the Goals step, and Keep or Delete for what's
// gone untouched, at desktop and phone sizes.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded, readRecord, seed } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

// Monday Nov 2, 2026, 2pm. Calendar quarters: planning is for Jan 1 to Mar 31.
const NOW = new Date('2026-11-02T20:00:00Z');
const SHOTS = process.env.E2E_SHOTS;

const records: Seed[] = [
  { type: 'settings', id: 'settings', fields: { plan_stretch: { last_planned: '2026-10-01' } } },
  { type: 'objective', id: 'g1', fields: { title: 'Learn to bake bread', state: 'active' } },
  { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: 'Rye bread', state: 'active', start: '2026-10-01', end: '2027-06-30' } },
  { type: 'project', id: 'backlog:g1', fields: { objective_id: 'g1', title: 'Learn to bake bread, Backlog', state: 'active', start: '2026-10-01', end: '2027-03-31' } },
];
const untouched: Seed = { type: 'task', id: 'k1', fields: { kind: 'project', project_id: 'backlog:g1', milestone_id: null, title: 'Ask Sam for his focaccia recipe', estimate_min: 20, order: 1 } };
const fresh: Seed = { type: 'task', id: 'k2', fields: { kind: 'project', project_id: 'backlog:g1', milestone_id: null, title: 'Watch a shaping video', estimate_min: 60, order: 2 } };

async function openGoalsStep(page: Page, phone: boolean) {
  // The first task arrives in April and isn't touched again, so it's untouched by November.
  await page.clock.install({ time: new Date('2026-04-02T17:00:00Z') });
  await openSeeded(page, [...records.slice(0, 4), untouched]);
  await page.clock.setSystemTime(NOW);
  await seed(page, [fresh]);
  const nav = page.getByRole('navigation', { name: 'Main' });
  if (phone) {
    await nav.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: /^Plan/ }).click();
  } else {
    await nav.getByRole('button', { name: 'Plan' }).click();
  }
  await page.getByRole('button', { name: 'Plan now' }).click();
  await expect(page.getByRole('heading', { name: /Goals\. Are these still your goals\?/ })).toBeFocused();
}

test("the Goals step shows each goal's backlog as a block, whose preview offers Keep and Delete and a way to Goals", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await openGoalsStep(page, phone);
  const card = page.getByRole('region', { name: 'Learn to bake bread' });
  const block = card.getByRole('button', { name: 'Open the backlog for Learn to bake bread' });
  await expect(block).toContainText('2 tasks, 1h 20m, 1 untouched since Apr 2');
  if (phone) await expectTapTarget(block);
  await block.click();
  const sheet = page.getByRole('dialog', { name: 'The backlog for Learn to bake bread' });
  const group = sheet.getByRole('group', { name: 'Untouched since Apr 2' });
  await expect(group.getByText('Ask Sam for his focaccia recipe')).toBeVisible();
  await expect(sheet.getByText('Watch a shaping video')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/stretch-backlog-${info.project.name}.png` });
  const keep = group.getByRole('button', { name: 'Keep Ask Sam for his focaccia recipe' });
  if (phone) for (const target of [keep, group.getByRole('button', { name: 'Delete Ask Sam for his focaccia recipe' })]) await expectTapTarget(target);
  await keep.click();
  await expect(group).toHaveCount(0);
  await expect.poll(async () => (await readRecord(page, 'task', 'k1'))?.kept_at).toBeTruthy();
  // The step's own Undo waits behind the preview, for once it's closed.
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(block).toBeFocused();
  await page.getByRole('button', { name: 'Undo: Kept Ask Sam for his focaccia recipe.' }).click();
  // Keep only restarts the task's clock, as the spec says, so its Undo clears kept_at and the task stays touched.
  await expect.poll(async () => (await readRecord(page, 'task', 'k1'))?.kept_at ?? null).toBeNull();
});
