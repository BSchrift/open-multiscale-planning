import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { go, pane, syncNow } from '../seed';
import { closeDevices, device, signIn } from './devices';
import { target } from './target';

// Planning as a task, through the backend: two devices starting the same week's planning before they sync make one
// task with a block from each, and Skip for now on one holds on the other.

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

  // Each starts this week's planning before seeing the other's: each makes the task, with a block from now.
  const start = async (d: typeof a) => {
    await go(d.page, 'Today', 'Plan your week');
    await d.page.getByRole('button', { name: 'Start planning' }).click();
    await expect(d.page.getByText(/^Planning until .*\.$/)).toBeVisible();
  };
  await start(a);
  await syncNow(a.page);
  await start(b);
  for (const d of [b, a]) await syncNow(d.page);
  await go(a.page, 'Week', /./);
  await expect(pane(a.page, 'Week').getByRole('button', { name: /^Plan the week of / })).toHaveCount(2);

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
  await expect(pane(a.page, 'Today').getByText("This week isn't planned", { exact: true })).toBeVisible();
  await expect(a.page.getByRole('heading', { name: 'Plan your week' })).toHaveCount(0);
  expect([...a.errors, ...b.errors]).toEqual([]);
});
