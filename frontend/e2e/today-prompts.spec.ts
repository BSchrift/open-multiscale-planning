// The Now card's other answers and the questions a block asks as it happens: Do next block instead, Start early, Mark
// done now with nothing after, "Have you started?" and the end-of-block prompt's Not done, Answer later and Still
// going. today.spec.ts has Start, the ring, Mark done now with a block after, and Partly.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm in Chicago.
const at = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  // Chicago is six hours behind UTC in November.
  return new Date(Date.UTC(2026, 10, 2, h! + 6, m ?? 0)).toISOString().replace('.000Z', 'Z');
};

const planned: Seed = { type: 'week_plan', id: 'week:2026-11-02', fields: { week_start: '2026-11-02', finished_at: at('08:00') } };
const report: Seed = { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p', title: 'Write the report', estimate_min: 180 } };
const fence: Seed = { type: 'task', id: 't2', fields: { kind: 'one_off', title: 'Paint the fence', estimate_min: 60 } };
// Week's To schedule lists a project's work only while the project runs.
const project: Seed = { type: 'project', id: 'p', fields: { title: 'Annual report', state: 'active', start: '2026-10-01', end: '2026-12-31' } };
const block = (id: string, task: string, from: string, to: string, extra: Record<string, unknown> = {}): Seed => ({
  type: 'time_block',
  id,
  fields: { task_id: task, start: at(from), end: at(to), tz: 'America/Chicago', ...extra },
});

/**
 * Opens Today at Monday 2pm, then holds the clock there, so countdowns and "minutes ago" read the same on every run.
 * Held only once the records are in, as today.spec.ts does: on desktop the database doesn't finish opening while the
 * clock is held.
 */
async function open(page: Page, records: Seed[]) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await page.clock.setFixedTime(NOW);
  return errors;
}

const role = (phone: boolean) => (phone ? 'slider' : 'button');

test('Do next block instead trades the work of the block now and the next, which keep their times, and Undo trades it back', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, report, fence, block('b1', 't1', '13:58', '15:00'), block('b2', 't2', '16:00', '17:00')]);
  const now = page.getByRole('region', { name: 'Current block' });
  await expect(now.getByRole('heading', { name: 'Write the report' })).toBeVisible();
  const instead = now.getByRole('button', { name: 'Do next block instead' });
  if (phone) await expectTapTarget(instead);
  await instead.click();

  await expect(page.getByText('Swapped with your next block')).toBeVisible();
  await expect(now.getByText('Now, 1:58pm to 3pm')).toBeVisible();
  await expect(now.getByRole('heading', { name: 'Paint the fence' })).toBeVisible();
  // The button goes with the swap, so focus lands on the card's heading rather than the page.
  await expect(now.getByRole('heading', { name: 'Paint the fence' })).toBeFocused();
  await expect(page.getByRole(role(phone), { name: /^Write the report, 4pm to 5pm, Project\./ })).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(now.getByRole('heading', { name: 'Write the report' })).toBeVisible();
  await expect(page.getByRole(role(phone), { name: /^Paint the fence, 4pm to 5pm, One off\./ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('free time before the next block offers Start early, which moves that block to now and starts it', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, fence, block('b2', 't2', '16:00', '17:00')]);
  const now = page.getByRole('region', { name: 'Current block' });
  await expect(now.getByText(phone ? 'Free until 4pm. Next:' : 'Free until 4pm')).toBeVisible();
  await expect(now.getByRole('heading', { name: phone ? 'Paint the fence' : 'Next: Paint the fence' })).toBeVisible();
  const early = now.getByRole('button', { name: 'Start early' });
  if (phone) await expectTapTarget(early);
  await early.click();

  // The same length, from now, and already counting down.
  await expect(now.getByText('Now, 2pm to 3pm')).toBeVisible();
  await expect(now.getByText('In progress, time left')).toBeVisible();
  await expect(now.getByRole('timer')).toHaveText('1:00:00');
  await expect(now.getByRole('heading', { name: 'Paint the fence' })).toBeFocused();
  await expect(page.getByRole('region', { name: "Today's timeline" }).getByRole(role(phone), { name: /^Paint the fence, 2pm to 3pm, One off\. Now\./ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Mark done now with nothing after says the time spent and that nothing else is planned, and Undo brings the block back', async ({ page }) => {
  const errors = await open(page, [planned, report, block('b1', 't1', '13:38', '14:38', { started_at: at('13:38') })]);
  const now = page.getByRole('region', { name: 'Current block' });
  await expect(now.getByRole('timer')).toHaveText('38:00');
  await now.getByRole('button', { name: 'Mark done now' }).click();
  await expect(page.getByText('Marked done after 22m. Nothing else planned today.')).toBeVisible();
  await expect(now.getByText('Nothing else planned today.')).toBeVisible();
  await expect(page.getByRole('region', { name: "Today's timeline" }).getByRole('button', { name: 'Write the report, 1:38pm to 2:38pm, Project. Done.' })).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(now.getByText('Now, 1:38pm to 2:38pm')).toBeVisible();
  await expect(now.getByRole('timer')).toHaveText('38:00');
  expect(errors).toEqual([]);
});

test('a block not started a few minutes in asks whether it has; Do next block instead swaps it with the next one', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, report, fence, block('b1', 't1', '13:50', '15:00'), block('b2', 't2', '16:00', '17:00')]);
  const check = page.getByRole('dialog', { name: 'Have you started?' });
  await expect(check.getByText('Started 10 minutes ago')).toBeVisible();
  await expect(check.getByText('Have you started Write the report?')).toBeVisible();
  if (phone) {
    for (const name of ['Yes, started', 'Ask again in 10 minutes', 'Do next block instead', 'Skip, choose a new time later']) await expectTapTarget(check.getByRole('button', { name }));
  }
  await page.screenshot({ path: info.outputPath(`start-check-${info.project.name}.png`) });

  await check.getByRole('button', { name: 'Do next block instead' }).click();
  await expect(check).toHaveCount(0);
  await expect(page.getByText('Swapped with your next block')).toBeVisible();
  const now = page.getByRole('region', { name: 'Current block' });
  await expect(now.getByText('Now, 1:50pm to 3pm')).toBeVisible();
  await expect(now.getByRole('heading', { name: 'Paint the fence' })).toBeVisible();
  await expect(page.getByRole(role(phone), { name: /^Write the report, 4pm to 5pm, Project\./ })).toBeVisible();
  // Answered once, it doesn't ask again about the block now holding the other work.
  await expect(check).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Skip, choose a new time later takes the block off the calendar into To schedule, and Undo puts it back', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, project, report, fence, block('b1', 't1', '13:50', '15:00'), block('b2', 't2', '16:00', '17:00')]);
  const check = page.getByRole('dialog', { name: 'Have you started?' });
  await check.getByRole('button', { name: 'Skip, choose a new time later' }).click();
  await expect(check).toHaveCount(0);
  await expect(page.getByText("Took Write the report off the calendar. It's in To schedule on Week.")).toBeVisible();

  const now = page.getByRole('region', { name: 'Current block' });
  await expect(now.getByText(phone ? 'Free until 4pm. Next:' : 'Free until 4pm')).toBeVisible();
  const timeline = page.getByRole('region', { name: "Today's timeline" });
  await expect(timeline.getByRole('button', { name: /^Write the report, / })).toHaveCount(0);
  // Its time waits to be placed again, still in this week.
  await expect(page.getByRole('region', { name: 'To schedule' }).getByRole('button', { name: /^Write the report, Project, 1h 10m/ })).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(now.getByText('Now, 1:50pm to 3pm')).toBeVisible();
  await expect(now.getByRole('heading', { name: 'Write the report' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'To schedule' }).getByRole('button', { name: /^Write the report/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a finished block put off with Answer later waits under Review, and Not done sends it to Needs a new time', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, report, block('b1', 't1', '12:00', '13:00')]);
  const prompt = page.getByRole('dialog', { name: 'Block finished' });
  await expect(prompt.getByText('Write the report')).toBeVisible();
  if (phone) {
    for (const name of ['Task finished', 'Partly', 'Not done']) await expectTapTarget(prompt.getByRole('button', { name, exact: true }));
  }
  await prompt.getByRole('button', { name: 'Answer later' }).click();
  await expect(prompt).toHaveCount(0);

  // Put off, it keeps a way back.
  const review = phone
    ? page.getByRole('button', { name: 'Check in on 1 missed block Review' })
    : page.getByRole('status').filter({ hasText: 'Check in on 1 missed block' }).getByRole('button', { name: 'Review' });
  await review.click();
  await prompt.getByRole('button', { name: 'Not done', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByText('Added to Needs a new time. No need to decide now.')).toBeVisible();

  const timeline = page.getByRole('region', { name: "Today's timeline" });
  await expect(timeline.getByRole('button', { name: 'Write the report, 12pm to 1pm, Project. Not done.' })).toBeVisible();
  await (phone
    ? page.getByRole('button', { name: '1 task needs a new time Review' })
    : page.getByRole('status').filter({ hasText: 'Needs a new time' }).getByRole('button', { name: 'Review' })
  ).click();
  const queue = phone ? page.getByRole('dialog', { name: 'Needs a new time' }) : page.getByRole('region', { name: 'Needs a new time' });
  await expect(queue.getByText('Not done today')).toBeVisible();
  await expect(queue.getByRole('button', { name: /^Place Write the report, / })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Still going adds half an hour to a block just ended, which carries on in the Now card', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, report, block('b1', 't1', '13:00', '13:58', { started_at: at('13:00') })]);
  const prompt = page.getByRole('dialog', { name: 'Block finished' });
  await expect(prompt.getByText('Write the report')).toBeVisible();
  const going = prompt.getByRole('button', { name: 'Still going, add 30m' });
  if (phone) await expectTapTarget(going);
  await going.click();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByText('Added 30 minutes')).toBeVisible();

  const now = page.getByRole('region', { name: 'Current block' });
  await expect(now.getByText('Now, 1pm to 2:28pm')).toBeVisible();
  await expect(now.getByRole('timer')).toHaveText('28:00');
  await expect(prompt).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a practice session that ended asks how much was done, logs less when the slider says so, and shows done on the timeline', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const piano: Seed = { type: 'practice', id: 'pr', fields: { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' } };
  const session: Seed = { type: 'time_block', id: 'b1', fields: { practice_id: 'pr', start: at('13:00'), end: at('13:30'), tz: 'America/Chicago' } };
  const errors = await open(page, [planned, piano, session]);
  const prompt = page.getByRole('dialog', { name: 'Block finished' });
  await expect(prompt.getByText('Piano practice')).toBeVisible();
  const amount = prompt.getByRole('slider', { name: 'How much did you do?' });
  await expect(amount).toHaveAttribute('aria-valuetext', '30m');
  await expect(prompt.getByRole('button', { name: 'All 30m' })).toBeVisible();
  if (phone) {
    await expectTapTarget(amount);
    await expectTapTarget(prompt.getByRole('button', { name: 'All 30m' }));
    await expectTapTarget(prompt.getByRole('button', { name: 'Skipped' }));
  }
  await amount.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(amount).toHaveAttribute('aria-valuetext', '25m');
  await prompt.getByRole('button', { name: 'Log 25m' }).click();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByText('Logged 25m')).toBeVisible();
  await expect(page.getByRole('region', { name: "Today's timeline" }).getByRole('button', { name: /^Piano practice, 1pm to 1:30pm, Practice\. Done\./ })).toBeVisible();
  expect(errors).toEqual([]);
});
