// Goal backlogs: a goal's tasks that aren't part of a project, on Goals, at desktop and phone sizes.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded, readRecord, touchDrag } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm
const SHOTS = process.env.E2E_SHOTS;

const records: Seed[] = [
  { type: 'objective', id: 'g1', fields: { title: 'Learn to bake bread', state: 'active' } },
  { type: 'objective', id: 'g2', fields: { title: 'Run a 10k', state: 'active' } },
  { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: 'Rye bread', state: 'active', start: '2026-10-01', end: '2026-12-15' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p1', title: 'Feed the starter', estimate_min: 30 } },
  { type: 'project', id: 'backlog:g1', fields: { objective_id: 'g1', title: 'Learn to bake bread, Backlog', state: 'active', start: '2026-10-01', end: '2027-03-31' } },
  { type: 'task', id: 'b1', fields: { kind: 'project', project_id: 'backlog:g1', milestone_id: null, title: 'Ask Sam for his focaccia recipe', estimate_min: 20, order: 1 } },
  { type: 'task', id: 'b2', fields: { kind: 'project', project_id: 'backlog:g1', milestone_id: null, title: 'Watch a shaping video', estimate_min: 60, order: 2 } },
];

async function openBacklog(page: Page, phone: boolean) {
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Goals' }).click();
  await page.getByRole('button', { name: /^Learn to bake bread/ }).click();
  const row = page.getByRole('button', { name: 'Backlog, 2 tasks, 1h 20m' });
  if (phone) await expectTapTarget(row);
  await row.click();
  if (phone) await expect(page.getByRole('heading', { level: 1, name: 'Learn to bake bread Backlog' })).toBeFocused();
  else await expect(row).toHaveAttribute('aria-expanded', 'true');
}

const ticks = (page: Page) => page.getByRole('group', { name: 'Tasks in the backlog for Learn to bake bread' }).getByRole('checkbox');

test('a goal backlog on Goals: add a task, tick one done and drag one to a new place, each undone', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openBacklog(page, phone);
  await expect(page.getByText("Tasks for this goal that aren't part of a project.")).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/goals-backlog-${info.project.name}.png` });

  // Add task: no milestone, Add closes, with Undo.
  const add = page.getByRole('button', { name: 'Add task to the backlog for Learn to bake bread' });
  if (phone) await expectTapTarget(add);
  await add.click();
  const editor = page.getByRole('dialog', { name: 'Add task to the backlog for Learn to bake bread' });
  await expect(editor.getByRole('combobox', { name: 'Milestone' })).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/goals-backlog-add-${info.project.name}.png` });
  await editor.getByRole('textbox', { name: 'Title' }).fill('Order rye flour');
  await editor.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Added Order rye flour to the backlog for Learn to bake bread.')).toBeVisible();
  await expect(editor).toHaveCount(0);
  await expect(ticks(page).last()).toHaveAccessibleName('Order rye flour done');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(ticks(page)).toHaveCount(2);

  // Tick one done, with Undo.
  // Clicked, not checked: the row leaves as it's ticked, so a check would find the next one.
  await page.getByRole('checkbox', { name: 'Ask Sam for his focaccia recipe done' }).click();
  await expect(page.getByText('Completed Ask Sam for his focaccia recipe.')).toBeVisible();
  await expect(ticks(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(ticks(page)).toHaveCount(2);

  // Drag the second above the first: by its handle on desktop, by holding the row on phone.
  const first = page.getByRole('button', { name: /^Edit task Ask Sam/ });
  const second = page.getByRole('button', { name: /^Edit task Watch a shaping video/ });
  const target = (await first.boundingBox())!;
  if (phone) {
    await touchDrag(page, second, { x: target.x + target.width / 2, y: target.y + target.height / 2 });
  } else {
    const handle = (await page.getByRole('button', { name: 'Reorder Watch a shaping video, 2 of 2' }).boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(50);
    for (let i = 1; i <= 4; i++) await page.mouse.move(handle.x, handle.y + ((target.y + target.height / 2 - handle.y) * i) / 4);
    await page.mouse.up();
  }
  await expect(page.getByText('Moved Watch a shaping video to 1 of 2.')).toBeVisible();
  await expect(ticks(page).first()).toHaveAccessibleName('Watch a shaping video done');
  expect(Number((await readRecord(page, 'task', 'b2'))?.order)).toBeLessThan(1);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(ticks(page).first()).toHaveAccessibleName('Ask Sam for his focaccia recipe done');

  if (phone) {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expectTapTarget(ticks(page).first().locator('xpath=ancestor::label'));
      await expectTapTarget(page.getByRole('button', { name: 'Reorder Ask Sam for his focaccia recipe, 1 of 2' }));
      await expectTapTarget(add);
    }
  }
  expect(errors).toEqual([]);
});

test('a goal backlog moves with the keyboard alone', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'Keyboard reordering is a desktop path; phone uses the hold.');
  await openBacklog(page, false);
  const handle = page.getByRole('button', { name: 'Reorder Watch a shaping video, 2 of 2' });
  await handle.focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByText('Moved Watch a shaping video to 1 of 2.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reorder Watch a shaping video, 1 of 2' })).toBeFocused();
});
