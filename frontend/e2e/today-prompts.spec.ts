// The Now card's other answers and the questions a block asks as it happens: Do next block instead, Start early, Mark
// done now with nothing after, Stop for now, Start now on another block, "Have you started?" and the end-of-block
// prompt's Not done, Answer later and Still going. today.spec.ts has Start, the ring, Mark done now with a block after,
// and Partly. On phone the Now card is the block raised on the day, and a block that ended asks on itself there.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded } from './seed';
import type { Seed } from './seed';
import { askOnBlock, nowCard, openBlock, waitingSheet } from './today';

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
/** A block's times on the Now card: after "Now," on desktop's, and after the word Now on the phone's raised block. */
const times = (now: ReturnType<typeof nowCard>, phone: boolean, range: string) => now.getByText(phone ? range : `Now, ${range}`);
/** The block's name on the Now card: its heading on desktop's, its text on the phone's raised block. */
const named = (now: ReturnType<typeof nowCard>, phone: boolean, name: string) => (phone ? expect(now).toContainText(name) : expect(now.getByRole('heading', { name })).toBeVisible());

test('Do next block instead trades the work of the block now and the next, which keep their times, and Undo trades it back', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, report, fence, block('b1', 't1', '13:58', '15:00'), block('b2', 't2', '16:00', '17:00')]);
  const now = nowCard(page, phone);
  await named(now, phone, 'Write the report');
  const instead = now.getByRole('button', { name: 'Do next block instead' });
  if (phone) await expectTapTarget(instead);
  await instead.click();

  await expect(page.getByText('Swapped with your next block')).toBeVisible();
  await expect(times(now, phone, '1:58pm to 3pm')).toBeVisible();
  await named(now, phone, 'Paint the fence');
  // The button goes with the swap on desktop, so focus lands on the card's heading rather than the page. The phone's
  // raised block keeps it, with the next block still after it.
  if (!phone) await expect(now.getByRole('heading', { name: 'Paint the fence' })).toBeFocused();
  await expect(page.getByRole(role(phone), { name: /^Write the report, 4pm to 5pm, Project\./ })).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await named(now, phone, 'Write the report');
  await expect(page.getByRole(role(phone), { name: /^Paint the fence, 4pm to 5pm, One off\./ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('free time before the next block offers Start early, which moves that block to now and starts it', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, fence, block('b2', 't2', '16:00', '17:00')]);
  const now = nowCard(page, phone);
  if (phone) {
    // Two hours off, it isn't selected as Today opens: the now line says the time free, and a tap on it raises it.
    await expect(page.getByText('Free until 4pm', { exact: true })).toBeVisible();
    await page.getByRole('slider', { name: /^Paint the fence, 4pm to 5pm/ }).tap();
    await expect(now).toContainText('Next in 2h, 4pm to 5pm');
  } else {
    await expect(now.getByText('Free until 4pm')).toBeVisible();
    await expect(now.getByRole('heading', { name: 'Next: Paint the fence' })).toBeVisible();
  }
  const early = now.getByRole('button', { name: 'Start early' });
  if (phone) await expectTapTarget(early);
  await early.click();

  // The same length, from now, and already counting down.
  await expect(times(now, phone, '2pm to 3pm')).toBeVisible();
  if (phone) await expect(now.getByText('1h left')).toBeVisible();
  else {
    await expect(now.getByText('In progress, time left')).toBeVisible();
    await expect(now.getByRole('timer')).toHaveText('1:00:00');
    await expect(now.getByRole('heading', { name: 'Paint the fence' })).toBeFocused();
  }
  await expect(page.getByRole('region', { name: "Today's timeline" }).getByRole(role(phone), { name: /^Paint the fence, 2pm to 3pm, One off\. Now\./ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Mark done now with nothing after says the time spent and that nothing else is planned, and Undo brings the block back', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, report, block('b1', 't1', '13:38', '14:38', { started_at: at('13:38') })]);
  const now = nowCard(page, phone);
  const left = () => (phone ? expect(now.getByText('38 min left')).toBeVisible() : expect(now.getByRole('timer')).toHaveText('38:00'));
  await left();
  await now.getByRole('button', { name: 'Mark done now' }).click();
  await expect(page.getByText('Marked done after 22m. Nothing else planned today.')).toBeVisible();
  if (!phone) await expect(now.getByText('Nothing else planned today.')).toBeVisible();
  await expect(page.getByRole('region', { name: "Today's timeline" }).getByRole('button', { name: /^Write the report, 1:38pm to 2:38pm, Project\. Done\./ })).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(times(now, phone, '1:38pm to 2:38pm')).toBeVisible();
  await left();
  expect(errors).toEqual([]);
});

test('Stop for now asks how much is left, ends the block with that, and Undo brings the block back as it was', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, project, report, block('b1', 't1', '13:38', '14:38', { started_at: at('13:38') })]);
  const now = nowCard(page, phone);
  const left = () => (phone ? expect(now.getByText('38 min left')).toBeVisible() : expect(now.getByRole('timer')).toHaveText('38:00'));
  await left();
  const stop = now.getByRole('button', { name: 'Stop for now' });
  if (phone) for (const button of [stop, now.getByRole('button', { name: 'Mark done now' })]) await expectTapTarget(button);
  // Reached from the keyboard, as the rest of the card is.
  await stop.focus();
  await page.keyboard.press('Enter');

  // 3h estimated, 22m spent.
  const prompt = page.getByRole('dialog', { name: 'How much is left?' });
  await expect(prompt.getByRole('slider', { name: 'Time left' })).toHaveAttribute('aria-valuetext', '2h 38m');
  const save = prompt.getByRole('button', { name: 'Save' });
  if (phone) for (const button of [save, prompt.getByRole('button', { name: 'Not done' })]) await expectTapTarget(button);
  await save.click();
  await expect(page.getByText('Stopped after 22m. Added to Needs a new time. No need to decide now.')).toBeVisible();
  if (!phone) await expect(now.getByText('Nothing else planned today.')).toBeVisible();
  await expect(page.getByRole('region', { name: "Today's timeline" }).getByRole('button', { name: /^Write the report, 1:38pm to 2:38pm, Project\. Partly\./ })).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(times(now, phone, '1:38pm to 2:38pm')).toBeVisible();
  await left();
  expect(errors).toEqual([]);
});

test('Start now on another block stops the one counting, Undo puts both back, and the stopped one asks how it went', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, project, report, fence, block('b1', 't1', '13:38', '14:38', { started_at: at('13:38') }), block('b2', 't2', '16:00', '17:00')]);
  const now = nowCard(page, phone);
  const counting = () =>
    phone
      ? expect(page.getByRole('button', { name: /^Write the report, 1:38pm to 2:38pm, Project\. Now\./ })).toBeVisible()
      : Promise.all([expect(now.getByRole('heading', { name: 'Write the report' })).toBeVisible(), expect(now.getByRole('timer')).toHaveText('38:00')]);
  await counting();
  const later = page.getByRole(phone ? 'slider' : 'button', { name: /^Paint the fence, 4pm to 5pm/ });
  await later.scrollIntoViewIfNeeded();
  await openBlock(page, later, phone);
  const popup = page.getByRole('dialog', { name: 'Paint the fence' });
  const start = popup.getByRole('region', { name: 'Time block' }).getByRole('button', { name: 'Start now' });
  if (phone) await expectTapTarget(start);
  await start.click();
  const said = page.getByText('Started Paint the fence. It now runs 2pm to 3pm. Stopped Write the report at 2pm.');
  await expect(said).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  // The report counts again where it was, and the fence is back at 4pm, not started.
  await expect(start).toBeVisible();
  await popup.getByRole('button', { name: 'Cancel' }).click();
  await counting();
  await expect(later).toBeVisible();

  await openBlock(page, later, phone);
  await start.click();
  await expect(said).toBeVisible();
  await popup.getByRole('button', { name: 'Cancel' }).click();
  // Once the popup closes, the stopped block asks how it went, as the end of a block does: in its prompt on desktop,
  // and on phone on the block itself.
  const prompt = phone ? await askOnBlock(page, /^Write the report, 1:38pm/) : page.getByRole('dialog', { name: 'Block finished' });
  await expect(prompt.getByText('Write the report')).toBeVisible();
  if (!phone) await expect(prompt.getByText('22m spent.')).toBeVisible();
  await prompt.getByRole('button', { name: 'Partly' }).click();
  // 3h estimated, 22m spent.
  await expect(page.getByRole('dialog', { name: 'How much is left?' }).getByRole('slider', { name: 'Time left' })).toHaveAttribute('aria-valuetext', '2h 38m');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Added to Needs a new time. No need to decide now.')).toBeVisible();
  if (phone) await expect(page.getByRole('slider', { name: /^Paint the fence, 2pm to 3pm, One off\. Now\./ })).toBeVisible();
  else {
    await expect(now.getByRole('heading', { name: 'Paint the fence' })).toBeVisible();
    await expect(now.getByText('Now, 2pm to 3pm')).toBeVisible();
  }
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
  const now = nowCard(page, phone);
  await expect(times(now, phone, '1:50pm to 3pm')).toBeVisible();
  await named(now, phone, 'Paint the fence');
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
  await expect(page.getByText(`Took Write the report off the calendar. It's in ${phone ? 'To schedule' : 'To schedule on Week'}.`)).toBeVisible();

  const now = nowCard(page, phone);
  await expect((phone ? page : now).getByText('Free until 4pm', { exact: true })).toBeVisible();
  const timeline = page.getByRole('region', { name: "Today's timeline" });
  await expect(timeline.getByRole('button', { name: /^Write the report, / })).toHaveCount(0);
  // Its time waits to be placed again, still in this week: above the day on desktop, and on phone behind the waiting
  // row, whose sheet opening would put the toast away.
  if (phone) await expect(page.getByRole('button', { name: '1 to schedule' })).toBeVisible();
  else await expect(page.getByRole('region', { name: 'To schedule' }).getByRole('button', { name: /^Write the report, Project, 1h 10m/ })).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(times(now, phone, '1:50pm to 3pm')).toBeVisible();
  await named(now, phone, 'Write the report');
  if (phone) await expect(page.getByRole('button', { name: /\d+ to schedule/ })).toHaveCount(0);
  else await expect(page.getByRole('region', { name: 'To schedule' }).getByRole('button', { name: /^Write the report/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a finished block put off with Answer later waits under Review, and Not done sends it to Needs a new time', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, report, block('b1', 't1', '12:00', '13:00')]);
  if (phone) {
    // On phone it asks on itself, raised on the day, for as long as it's unanswered: there's nothing to put off.
    const card = await askOnBlock(page, /^Write the report, 12pm to 1pm/);
    for (const name of ['Done', 'Partly', 'Not done']) await expectTapTarget(card.getByRole('button', { name, exact: true }));
    await card.getByRole('button', { name: 'Not done', exact: true }).click();
    await expect(page.getByText('Added to Needs a new time. No need to decide now.')).toBeVisible();
    await expect(page.getByRole('region', { name: "Today's timeline" }).getByRole('button', { name: /^Write the report, 12pm to 1pm, Project\. Not done\./ })).toBeVisible();
    const queue = (await waitingSheet(page)).getByRole('region', { name: 'Needs a new time' });
    await expect(queue.getByText('Not done today')).toBeVisible();
    await expect(queue.getByRole('button', { name: /^Place Write the report, / })).toBeVisible();
    expect(errors).toEqual([]);
    return;
  }
  const prompt = page.getByRole('dialog', { name: 'Block finished' });
  await expect(prompt.getByText('Write the report')).toBeVisible();
  await prompt.getByRole('button', { name: 'Answer later' }).click();
  await expect(prompt).toHaveCount(0);

  // Put off, it keeps a way back.
  await page.getByRole('status').filter({ hasText: 'Check in on 1 missed block' }).getByRole('button', { name: 'Review' }).click();
  await prompt.getByRole('button', { name: 'Not done', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByText('Added to Needs a new time. No need to decide now.')).toBeVisible();

  const timeline = page.getByRole('region', { name: "Today's timeline" });
  await expect(timeline.getByRole('button', { name: 'Write the report, 12pm to 1pm, Project. Not done.' })).toBeVisible();
  await page.getByRole('status').filter({ hasText: 'Needs a new time' }).getByRole('button', { name: 'Review' }).click();
  const queue = page.getByRole('region', { name: 'Needs a new time' });
  await expect(queue.getByText('Not done today')).toBeVisible();
  await expect(queue.getByRole('button', { name: /^Place Write the report, / })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Still going adds half an hour to a block just ended, which carries on in the Now card', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, report, block('b1', 't1', '13:00', '13:58', { started_at: at('13:00') })]);
  // On phone the block asks on itself, raised on the day, with Still going under its answers.
  const prompt = phone ? await askOnBlock(page, /^Write the report, 1pm to 1:58pm/) : page.getByRole('dialog', { name: 'Block finished' });
  await expect(prompt.getByText('Write the report')).toBeVisible();
  const going = prompt.getByRole('button', { name: 'Still going, add 30m' });
  if (phone) await expectTapTarget(going);
  await going.click();
  if (!phone) await expect(prompt).toHaveCount(0);
  await expect(page.getByText('Added 30 minutes')).toBeVisible();

  const now = nowCard(page, phone);
  await expect(times(now, phone, '1pm to 2:28pm')).toBeVisible();
  await (phone ? expect(now.getByText('28 min left')).toBeVisible() : expect(now.getByRole('timer')).toHaveText('28:00'));
  await expect(page.getByRole('dialog', { name: 'Block finished' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a practice session that ended offers All, Partly or Skipped, logs less when Partly and the slider say so, and shows done on the timeline', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const piano: Seed = { type: 'practice', id: 'pr', fields: { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' } };
  const session: Seed = { type: 'time_block', id: 'b1', fields: { practice_id: 'pr', start: at('13:00'), end: at('13:30'), tz: 'America/Chicago' } };
  const errors = await open(page, [planned, piano, session]);
  // On phone the session asks on itself, raised on the day, in a practice's words; Some opens the same log.
  if (phone) {
    const card = await askOnBlock(page, /^Piano practice, 1pm to 1:30pm/);
    for (const name of ['Did it', 'Some', 'Skipped']) await expectTapTarget(card.getByRole('button', { name, exact: true }));
    await card.getByRole('button', { name: 'Some' }).click();
  }
  const prompt = page.getByRole('dialog', { name: 'Block finished' });
  await expect(prompt.getByText('Piano practice')).toBeVisible();
  // All, Partly or Skipped first; Partly asks how much, from half the session.
  await expect(prompt.getByRole('button', { name: 'All 30m' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('practice-prompt.png') });
  const partly = prompt.getByRole('button', { name: 'Partly' });
  if (phone) {
    await expectTapTarget(prompt.getByRole('button', { name: 'All 30m' }));
    await expectTapTarget(partly);
    await expectTapTarget(prompt.getByRole('button', { name: 'Skipped' }));
  }
  await partly.click();
  const amount = prompt.getByRole('slider', { name: 'How much did you do?' });
  await expect(amount).toHaveAttribute('aria-valuetext', '15m');
  await expect(amount).toBeFocused();
  if (phone) await expectTapTarget(amount);
  for (const text of ['20m', '25m']) {
    await page.keyboard.press('ArrowRight');
    await expect(amount).toHaveAttribute('aria-valuetext', text);
  }
  await page.screenshot({ path: info.outputPath('practice-partly.png') });
  await prompt.getByRole('button', { name: 'Log 25m' }).click();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByText('Logged 25m')).toBeVisible();
  await expect(page.getByRole('region', { name: "Today's timeline" }).getByRole('button', { name: /^Piano practice, 1pm to 1:30pm, Practice\. Done\./ })).toBeVisible();
  expect(errors).toEqual([]);
});
