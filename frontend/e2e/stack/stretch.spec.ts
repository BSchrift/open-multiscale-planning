import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { go, pane, syncNow } from '../seed';
import { closeDevices, device, signIn } from './devices';

// Stretch planning's progress, through the backend: begun on one device, it resumes on another at the same step, with
// the same steps done, and once one device finishes the plan, neither offers to continue it. On a deployment's shared
// test user, planning may be under way from a run cut short, and the stretch may be planned already; each run starts
// from Goals and finishes the plan again, which leaves that user as it found it.

test.use({ baseURL: `http://localhost:${process.env.STACK_WEB_PORT}` });
test.afterEach(closeDevices);

const steps = (page: Page) => page.getByRole('navigation', { name: 'Planning steps' });
const CTA = /^(Continue planning|Plan (now|the next stretch|your first stretch|without a cadence))$/;

test('planning begun on one device resumes on another at the same step, and a finish on either ends it on both', async ({ browser }) => {
  const run = randomUUID().slice(0, 8);
  const a = await device(browser, `e2e-${run}`);
  const b = await device(browser, `e2e-${run}`);
  await signIn(a.page);
  await signIn(b.page);

  // A goes as far as Projects, continuing from Goals and Practices, and leaves.
  await go(a.page, 'Plan');
  await pane(a.page, 'Plan').getByRole('button', { name: CTA }).click();
  await steps(a.page).getByRole('button', { name: /Goals/ }).click();
  await a.page.getByRole('button', { name: /^(Goals look right|Continue without goals)$/ }).click();
  await a.page.getByRole('button', { name: 'Practices look right' }).click();
  await expect(a.page.getByRole('heading', { name: /^Step \d of \d, Projects\./ })).toBeVisible();
  await a.page.getByRole('button', { name: 'Save and exit' }).click();
  await syncNow(a.page);

  // B, which never opened planning, offers to continue it, and opens where A left it.
  await syncNow(b.page);
  await go(b.page, 'Plan');
  await pane(b.page, 'Plan').getByRole('button', { name: 'Continue planning' }).click();
  await expect(b.page.getByRole('heading', { name: /^Step \d of \d, Projects\./ })).toBeVisible();
  await expect(b.page.locator('.welcome')).toContainText(/Practices.* done\. You were on Projects\./);
  await expect(steps(b.page).getByRole('button', { name: /Practices, done/ })).toBeVisible();

  // B moves on to Finish and finishes; A then has nothing to continue.
  await steps(b.page).getByRole('button', { name: /Finish/ }).click();
  await b.page.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(b.page.getByText(/^Your plan for .* is set\.$/)).toBeVisible();
  for (const d of [b, a]) await syncNow(d.page);
  await go(a.page, 'Plan');
  await expect(pane(a.page, 'Plan').getByRole('button', { name: 'Continue planning' })).toHaveCount(0);
  expect([...a.errors, ...b.errors]).toEqual([]);
});
