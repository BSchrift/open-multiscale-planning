import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { go, pane, syncNow } from '../seed';
import { closeDevices, device, signIn } from './devices';
import { target } from './target';

// Planning as a task, through the backend: two devices starting the same week's planning make one task, and Skip for
// now on one holds on the other.

const t = target();
test.use({ baseURL: `http://localhost:${process.env.STACK_WEB_PORT}` });
test.afterEach(closeDevices);

test('two devices starting planning make one task, and a skip on one holds on the other', async ({ browser }) => {
  // A week's planning task and plan have fixed ids, so on a deployment's shared test user the first run of a week would
  // leave its skip for every later one.
  test.skip(!t.localApi, 'needs: a fresh user each run');
  const run = randomUUID().slice(0, 8);
  const a = await device(browser, `e2e-${run}`);
  const b = await device(browser, `e2e-${run}`);
  await signIn(a.page);
  await signIn(b.page);

  // Each starts this week's planning: each makes the task with a block from now, unless it has already synced the
  // other's block, which it never doubles. Either way it's one task.
  const start = async (d: typeof a) => {
    // Once it has the other's block under way, Today shows that rather than the prompt.
    await go(d.page, 'Today', /^(Today|Plan your week)$/);
    await pane(d.page, 'Today').getByRole('button', { name: /^(Start planning|Keep going)$/ }).first().click();
    await expect(d.page.getByRole('navigation', { name: 'Planning steps' })).toBeVisible();
  };
  await start(a);
  await expect(a.page.getByText(/^Planning until .*\.$/)).toBeVisible();
  await syncNow(a.page);
  await start(b);
  for (const d of [b, a]) await syncNow(d.page);
  await go(a.page, 'Week', /./);
  await expect(pane(a.page, 'Week').getByRole('button', { name: /^Plan the week of / }).first()).toBeVisible();

  // Save and exit stops both; then the week asks again.
  await go(a.page, 'Today');
  await pane(a.page, 'Today').getByRole('button', { name: 'Keep going' }).click();
  await a.page.getByRole('button', { name: 'Save and exit' }).click();
  for (const d of [a, b]) await syncNow(d.page);

  // Skipped on one, the other stops asking.
  await go(b.page, 'Today', 'Plan your week');
  await b.page.getByRole('button', { name: 'Skip planning this week' }).click();
  await expect(b.page.getByText('Skipped planning this week.')).toBeVisible();
  for (const d of [b, a]) await syncNow(d.page);
  await go(a.page, 'Today');
  // From three days before next week, next week's planning row takes the place of this week's line.
  const today = pane(a.page, 'Today');
  await expect(today.getByText("This week isn't planned", { exact: true }).or(today.getByRole('region', { name: 'Plan next week' }))).toBeVisible();
  await expect(a.page.getByRole('heading', { name: 'Plan your week' })).toHaveCount(0);
  expect([...a.errors, ...b.errors]).toEqual([]);
});
