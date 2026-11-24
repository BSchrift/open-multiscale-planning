import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { belongsTo, expectTapTarget, openSeeded, pane } from './seed';
import type { Seed } from './seed';

// The task popup is the same wherever a task opens: from a list it can Start now, Mark done and Schedule…, and set its
// dates; from a block on a calendar the block's own section takes the actions' place. Each action saves at once with
// Undo; dates save with the rest of the popup.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm

const records: Seed[] = [
  { type: 'objective', id: 'g1', fields: { title: 'Write the quarterly report', state: 'active' } },
  { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: 'Report', state: 'active', start: '2026-10-01', end: '2026-12-15' } },
  { type: 'milestone', id: 'm1', fields: { project_id: 'p1', title: 'Drafts', due: '2026-11-20' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Draft the summary', estimate_min: 120 } },
  { type: 'task', id: 'o1', fields: { kind: 'one_off', title: 'Return the drill', estimate_min: 30, schedule: { type: 'once', from: '2026-11-07' }, next_due: '2026-11-07' } },
  { type: 'task', id: 'i1', fields: { kind: 'inbox', title: 'Call the bank' } },
  { type: 'week_plan', id: 'week:2026-11-02', fields: { week_start: '2026-11-02', finished_at: '2026-11-02T14:00:00Z' } },
  { type: 'time_block', id: 'b1', fields: { task_id: 't1', start: '2026-11-02T22:00:00Z', end: '2026-11-02T23:00:00Z', tz: 'America/Chicago' } },
];

const popupOf = (page: Page, title: string) => page.locator(`.sheet.taskpop[aria-label="${title}"]`);
const toast = (page: Page) => page.locator('.toast');

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  return errors;
}

async function openOneOffs(page: Page, phone: boolean) {
  const nav = page.getByRole('navigation', { name: 'Main' });
  if (phone) {
    await nav.getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: /^One offs/ }).click();
  } else {
    await nav.getByRole('button', { name: 'One offs' }).click();
  }
  await expect(pane(page, 'One offs').getByRole('heading', { name: 'One offs', level: 1 })).toBeVisible();
}

/** Once the popup, or a menu over it, has finished sliding in, light then dark. */
async function shoot(page: Page, target: Locator, path: (theme: string) => string) {
  await target.evaluate((e) => Promise.all(e.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))));
  await page.screenshot({ path: path('light') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path('dark') });
  await page.emulateMedia({ colorScheme: 'light' });
}

test('from a list: Start now, Mark done and Schedule… save at once with Undo, and dates save with the popup', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const shot = (name: string) => (theme: string) => info.outputPath(`task-popup-${name}-${info.project.name}-${theme}.png`);
  const errors = await open(page);
  await openOneOffs(page, phone);
  const row = pane(page, 'One offs').getByRole('button', { name: 'Return the drill', exact: true });
  await row.click();
  const popup = popupOf(page, 'Return the drill');
  const actions = popup.getByRole('region', { name: 'Actions' });
  for (const name of ['Start now', 'Mark done', 'Schedule…']) {
    const action = actions.getByRole('button', { name, exact: true });
    await expect(action).toBeVisible();
    if (phone) await expectTapTarget(action);
  }
  await shoot(page, popup, shot('list'));

  // A date range, with the rules One offs uses, saved with the rest of the popup and its Undo.
  await expect(popup.getByLabel('Repeats')).toHaveValue('once');
  await popup.getByLabel('Date (optional)').fill('2026-11-04');
  await popup.getByRole('button', { name: '+ End date' }).click();
  await popup.getByLabel('End date').fill('2026-11-06');
  await shoot(page, popup, shot('dates'));
  await popup.getByRole('button', { name: 'Save' }).click();
  await expect(popup).toHaveCount(0);
  await expect(toast(page).getByText('Saved Return the drill.')).toBeVisible();
  await expect(pane(page, 'One offs').getByText(/^Nov 4 to Nov 6/)).toBeVisible();

  // Mark done stays in the popup, as a block's does, with Undo putting the task back.
  await row.click();
  await actions.getByRole('button', { name: 'Mark done' }).click();
  await expect(toast(page).getByText('Return the drill done')).toBeVisible();
  await expect(actions).toHaveCount(0);
  await shoot(page, toast(page), shot('marked-done'));
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(actions.getByRole('button', { name: 'Mark done' })).toBeVisible();

  // Start now puts it on the clock from now; counting, it needs no other start.
  await actions.getByRole('button', { name: 'Start now' }).click();
  await expect(toast(page).getByText('Started Return the drill.')).toBeVisible();
  await expect(actions.getByRole('button', { name: 'Start now' })).toHaveCount(0);
  await shoot(page, toast(page), shot('started'));
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(actions.getByRole('button', { name: 'Start now' })).toBeVisible();

  // Schedule… offers To schedule's times for it this week, none before its date, then Choose a time….
  await actions.getByRole('button', { name: 'Schedule…' }).click();
  const menu = page.getByRole('menu', { name: 'Schedule' });
  await expect(menu.getByRole('menuitem', { name: 'Choose a time…' })).toBeVisible();
  const first = menu.getByRole('menuitem').first();
  if (phone) await expectTapTarget(first);
  await shoot(page, menu, shot('schedule'));
  const when = (await first.textContent())!;
  await first.click();
  await expect(toast(page).getByText(/^Placed Return the drill, /)).toBeVisible();
  await shoot(page, toast(page), shot('placed'));
  expect(when).toMatch(/^Wed Nov 4|^Thu Nov 5|^Fri Nov 6/);
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(toast(page)).toHaveCount(0);

  // Choose a time… opens Week to place it by hand.
  await actions.getByRole('button', { name: 'Schedule…' }).click();
  await menu.getByRole('menuitem', { name: 'Choose a time…' }).click();
  await expect(popup).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Editing this week' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('from Inbox: only Mark done, and dates once Belongs to gives it a home', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page);
  // Inbox carries its count.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Inbox/ }).click();
  await pane(page, 'Inbox').getByRole('button', { name: 'Call the bank', exact: true }).click();
  const popup = popupOf(page, 'Call the bank');
  const actions = popup.getByRole('region', { name: 'Actions' });
  await expect(actions.getByRole('button')).toHaveText(['Mark done']);
  await expect(popup.getByText('Inbox items have no date. To give it one, choose One offs or a project under Belongs to.')).toBeVisible();
  await shoot(page, popup, (theme) => info.outputPath(`task-popup-inbox-${info.project.name}-${theme}.png`));
  await belongsTo(page, popup, 'One offs');
  await popup.getByLabel('Date (optional)').fill('2026-11-05');
  await popup.getByRole('button', { name: 'Save' }).click();
  await expect(toast(page).getByText('Moved Call the bank to One offs.')).toBeVisible();
  await expect(pane(page, 'Inbox').getByRole('button', { name: 'Call the bank', exact: true })).toHaveCount(0);
  if (phone) await expect(popup).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("from a block on Today: the block's section takes the actions' place, and Mark done there finishes the task with Undo", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page);
  // On phone a block still to come is a slider.
  const block = page.getByRole(phone ? 'slider' : 'button', { name: /^Draft the summary, 4pm to 5pm/ });
  await block.scrollIntoViewIfNeeded();
  await (phone ? block.tap() : block.click());
  const popup = popupOf(page, 'Draft the summary');
  const section = popup.getByRole('region', { name: 'Time block' });
  await expect(section.getByRole('button')).toHaveText(['Start now', 'Mark done', 'Move…', 'Remove from calendar']);
  await expect(popup.getByRole('region', { name: 'Actions' })).toHaveCount(0);
  // The same fields below it as from a list, a project's task with a date and no repeat.
  await expect(popup.getByLabel('Date (optional)')).toBeVisible();
  await expect(popup.getByLabel('Repeats')).toHaveCount(0);
  await shoot(page, popup, (theme) => info.outputPath(`task-popup-block-${info.project.name}-${theme}.png`));
  const done = section.getByRole('button', { name: 'Mark done' });
  if (phone) await expectTapTarget(done);
  await done.click();
  await expect(toast(page).getByText('Marked Draft the summary done. Its 4pm block came off the calendar, so that time is free.')).toBeVisible();
  await expect(block).toHaveCount(0);
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(block).toBeVisible();
  expect(errors).toEqual([]);
});
