import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded, touchDrag } from './seed';
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
const fence: Seed = { type: 'task', id: 't2', fields: { kind: 'one_off', title: 'Paint the fence', estimate_min: 30 } };
const block = (id: string, task: string, from: string, to: string, extra: Record<string, unknown> = {}): Seed => ({
  type: 'time_block',
  id,
  fields: { task_id: task, start: at(from), end: at(to), tz: 'America/Chicago', ...extra },
});

async function open(page: Page, records: Seed[]) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  return errors;
}

test('the Now card: Start counts down, Mark done now frees the time, and Undo puts it back', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, report, fence, block('b1', 't1', '13:58', '15:00'), block('b2', 't2', '16:00', '17:00')]);
  const now = page.getByRole('region', { name: 'Current block' });
  await expect(now.getByText('Now, 1:58pm to 3pm')).toBeVisible();
  await expect(now.getByRole('heading', { name: 'Write the report' })).toBeVisible();

  const start = now.getByRole('button', { name: 'Start', exact: true });
  if (phone) await expectTapTarget(start);
  await start.click();
  await expect(now.getByText('In progress, time left')).toBeVisible();
  await expect(now.getByRole('timer')).toHaveText(/^5\d:\d\d$/);

  const done = now.getByRole('button', { name: 'Mark done now' });
  if (phone) await expectTapTarget(done);
  await done.click();
  await expect(page.getByText("Marked done. You're free until 4pm.")).toBeVisible();
  await expect(now.getByText(phone ? 'Free until 4pm. Next:' : 'Free until 4pm')).toBeVisible();
  await page.screenshot({ path: info.outputPath('today-free.png') });

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(now.getByText('Now, 1:58pm to 3pm')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the time-spent ring pauses with a toast and resumes the block under way, and a tap soon after Resume takes it back', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const shot = (name: string) => page.screenshot({ path: info.outputPath(`${name}-${info.project.name}.png`) });
  const errors = await open(page, [planned, report, fence, block('b1', 't1', '13:38', '14:38', { started_at: at('13:38') }), block('b2', 't2', '16:00', '17:00')]);
  await page.clock.setFixedTime(NOW);
  const now = page.getByRole('region', { name: 'Current block' });

  const ring = now.getByRole('button', { name: 'Pause, 22 minutes spent, 37% of the block' });
  await expect(ring).toBeVisible();
  // The middle shows the percent; the name says the time spent as well.
  await expect(ring).toHaveText('37%');
  await expect(now.getByRole('timer')).toHaveText('38:00');
  const key = now.getByRole('button', { name: 'What the ring means' });
  if (phone) {
    await expectTapTarget(ring);
    await expectTapTarget(key);
  }
  await shot('ring-under-way');

  await key.click();
  await expect(now.getByRole('group', { name: 'Key' })).toContainText(
    phone ? 'Tap the ring to pause the countdown' : 'Tap the ring or press P to pause the countdown',
  );
  await shot('ring-key');
  await key.click();
  await expect(now.getByRole('group', { name: 'Key' })).toHaveCount(0);

  await ring.click();
  const resume = now.getByRole('button', { name: 'Resume, 22 minutes spent, 37% of the block' });
  // Focus stays on the ring. WebKit doesn't focus a button on a tap, so there's none to keep on phone.
  await (phone ? expect(resume).toBeVisible() : expect(resume).toBeFocused());
  await expect(now.getByText('Ends at 2:38pm unless you resume.')).toBeVisible();
  const toast = page.locator('.toast');
  await expect(toast).toContainText('Paused Write the report');
  await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();
  await shot('pause-toast');
  await page.clock.setFixedTime(NOW.getTime() + 6 * 60_000);
  await expect(now.getByText('Paused for 6 min')).toBeVisible();
  await expect(now.getByRole('timer')).toHaveText('38:00');
  await shot('ring-paused');

  // Resume moves the end on by the pause, with no toast: a tap on the ring straight after takes it back. The tap puts
  // Pause's toast away too.
  await now.getByRole('button', { name: /^Resume, / }).click();
  await expect(now.getByText('Now, 1:38pm to 2:44pm')).toBeVisible();
  await expect(now.getByRole('button', { name: /^Pause, 22 minutes spent/ })).toBeVisible();
  await expect(page.locator('.toast')).toHaveCount(0);
  await shot('ring-resumed');
  await now.getByRole('button', { name: /^Pause, / }).click();
  await expect(now.getByText('Now, 1:38pm to 2:38pm')).toBeVisible();
  await expect(now.getByText('Paused for 6 min')).toBeVisible();
  expect(errors).toEqual([]);
});

test('on desktop, P pauses and resumes the block under way, and Undo on the toast takes the pause away', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'P is a desktop key');
  const errors = await open(page, [planned, report, block('b1', 't1', '13:38', '14:38', { started_at: at('13:38') })]);
  await page.clock.setFixedTime(NOW);
  const now = page.getByRole('region', { name: 'Current block' });
  await expect(now.getByRole('button', { name: /^Pause, / })).toHaveAttribute('aria-keyshortcuts', 'P');

  await page.keyboard.press('p');
  await expect(now.getByRole('button', { name: /^Resume, / })).toBeVisible();
  await expect(page.locator('.toast')).toContainText('Paused Write the report');
  await page.screenshot({ path: info.outputPath('pause-key-desktop.png') });
  await page.clock.setFixedTime(NOW.getTime() + 6 * 60_000);
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await expect(now.getByRole('button', { name: /^Pause, / })).toBeVisible();
  await expect(now.getByText('Now, 1:38pm to 2:38pm')).toBeVisible();

  await page.keyboard.press('p');
  await expect(now.getByRole('button', { name: /^Resume, / })).toBeVisible();
  await page.clock.setFixedTime(NOW.getTime() + 12 * 60_000);
  await page.keyboard.press('p');
  await expect(now.getByText('Now, 1:38pm to 2:44pm')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the ring changes without animating under reduced motion, and reads in dark mode', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  const errors = await open(page, [planned, report, block('b1', 't1', '13:38', '14:38', { started_at: at('13:38') })]);
  await page.clock.setFixedTime(NOW);
  // The app's reduced-motion rule cuts every transition to a hundredth of a millisecond.
  expect(await page.locator('.spentring .rfill').evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration))).toBeLessThan(0.001);
  await page.screenshot({ path: info.outputPath(`ring-dark-${info.project.name}.png`) });
  await page.getByRole('button', { name: /^Pause, / }).click();
  await expect(page.getByRole('button', { name: /^Resume, / })).toBeVisible();
  await page.screenshot({ path: info.outputPath(`ring-dark-paused-${info.project.name}.png`) });
  expect(errors).toEqual([]);
});

test('a pause running to the end asks the end question, whose Resume runs into the next block and offers the shift', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const paused = block('b1', 't1', '13:00', '13:50', { started_at: at('13:00'), paused_at: at('13:22') });
  const errors = await open(page, [planned, report, fence, paused, block('b2', 't2', '14:15', '14:45')]);
  await page.clock.setFixedTime(NOW);
  const prompt = page.getByRole('dialog', { name: 'Block finished' });
  await expect(prompt.getByText('22m spent. Paused at 1:22pm.')).toBeVisible();
  await expect(prompt.getByRole('button', { name: /Still going/ })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`end-paused-${info.project.name}.png`) });
  await prompt.getByRole('button', { name: 'Resume, 28m left' }).click();
  const now = page.getByRole('region', { name: 'Current block' });
  await expect(now.getByText('Now, 1pm to 2:28pm')).toBeVisible();
  await expect(now.getByRole('button', { name: 'Pause, 22 minutes spent, 44% of the block' })).toBeVisible();

  await expect(page.getByText('Paint the fence conflicts with Write the report.')).toBeVisible();
  await page.getByRole('button', { name: 'Shift rest of today' }).click();
  const panel = page.getByRole('region', { name: 'Shift rest of today' });
  await expect(panel.getByRole('listitem').first()).toContainText('now 2:28pm to 2:58pm');
  await page.screenshot({ path: info.outputPath(`resume-shift-${info.project.name}.png`) });
  await panel.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Rest of today shifted.')).toBeVisible();
  await expect(page.getByRole(phone ? 'slider' : 'button', { name: /^Paint the fence, 2:28pm to 2:58pm/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a finished block asks how it went; Partly sets the time left and it waits in Needs a new time', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, report, block('b1', 't1', '12:00', '13:00')]);
  const prompt = page.getByRole('dialog', { name: 'Block finished' });
  await expect(prompt.getByText('Write the report')).toBeVisible();
  await expect(prompt.getByRole('button', { name: 'Not done' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('today-prompt.png') });
  await prompt.getByRole('button', { name: 'Partly' }).click();

  const left = page.getByRole('dialog', { name: 'How much is left?' }).getByRole('slider', { name: 'Time left' });
  await expect(left).toHaveAttribute('aria-valuetext', '2h');
  await left.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(left).toHaveAttribute('aria-valuetext', '1h 30m');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Added to Needs a new time. No need to decide now.')).toBeVisible();

  // The answer's own alert: until the screen reads the saved answer back, the block still shows as missed, with a
  // Review of its own.
  await (phone
    ? page.getByRole('button', { name: '1 task needs a new time Review' })
    : page.getByRole('status').filter({ hasText: 'Needs a new time' }).getByRole('button', { name: 'Review' })
  ).click();
  const queue = phone ? page.getByRole('dialog', { name: 'Needs a new time' }) : page.getByRole('region', { name: 'Needs a new time' });
  await expect(queue.getByText('Partly done today, 1h 30m left')).toBeVisible();
  await expect(queue.getByRole('button', { name: /^Place Write the report, / })).toBeVisible();
  if (phone) await expect(queue.getByRole('button', { name: 'Place on calendar' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('an unplanned week opens on the prompt to plan; skipping leaves a banner and Next up', async ({ page }) => {
  const errors = await open(page, [fence]);
  await expect(page.getByRole('heading', { name: 'Plan your week' })).toBeVisible();
  await expect(page.getByText('1 one off due.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByText("This week isn't planned")).toBeVisible();
  const next = page.getByRole('region', { name: 'Next up' });
  await next.getByRole('button', { name: 'Start Paint the fence' }).click();
  await expect(page.getByRole('region', { name: 'Current block' }).getByText('Now, 2pm to 2:30pm')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('on phone, a short block on the calendar still has a 44pt tap target', async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'Phone only');
  const errors = await open(page, [planned, fence, block('b2', 't2', '16:00', '16:15')]);
  // Still to come, so it's a slider, as on Week.
  const short = page.getByRole('slider', { name: /^Paint the fence, 4pm to 4:15pm/ });
  // Scrolled clear of the floating tab bar, as a finger would.
  await short.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = (await short.boundingBox())!;
  expect(box.height).toBeLessThan(44);
  for (const dy of [-21, 21]) {
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 + dy };
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.cev')?.getAttribute('aria-label'), at);
    expect(hit, `${dy}px from the middle`).toMatch(/^Paint the fence, 4pm to 4:15pm/);
  }
  expect(errors).toEqual([]);
});

test("on phone, a block's resize grip stays under the block right below it, so a tap there opens that one", async ({ page }, info) => {
  test.skip(info.project.name !== 'phone', 'Phone only');
  const errors = await open(page, [planned, report, fence, block('b1', 't1', '16:00', '17:00'), block('b2', 't2', '17:00', '18:00')]);
  // Zoomed in, so the block above is tall enough that 10px into this one is past its own grip.
  await page.getByRole('button', { name: 'Zoom in' }).click();
  const below = page.getByRole('slider', { name: /^Paint the fence, 5pm to 6pm/ });
  await below.scrollIntoViewIfNeeded();
  const box = (await below.boundingBox())!;
  expect(box.height).toBeGreaterThan(44);
  const at = { x: box.x + box.width - 12, y: box.y + 10 };
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.cev')?.getAttribute('aria-label'), at);
  expect(hit).toMatch(/^Paint the fence, 5pm to 6pm/);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByRole('dialog', { name: 'Paint the fence' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a block still to come drags to a new time, held first on phone; arrow keys move it on; Undo takes it back', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, [planned, report, fence, block('b1', 't1', '16:00', '17:00'), block('b2', 't2', '17:30', '18:00')]);
  // On phone it's a slider, as on Week, so VoiceOver's swipes move it too.
  const role = phone ? 'slider' : 'button';
  // To schedule, above the day, reads the week on its own, and changes height once it has. Measured before that, the
  // block had moved down 80px by the time the mouse pressed, which then missed it.
  await expect(page.getByRole('region', { name: 'To schedule' }).getByText('Everything this week is on the calendar.')).toBeVisible();
  const b = page.getByRole(role, { name: /^Write the report, 4pm to 5pm/ });
  await b.scrollIntoViewIfNeeded();
  const box = (await b.boundingBox())!;
  const x = box.x + box.width / 3;
  await page.mouse.move(x, box.y + 4);
  await page.mouse.down();
  if (phone) await page.waitForTimeout(500);
  // The first zoom draws 30px an hour, so 15px down is half an hour later.
  await page.mouse.move(x, box.y + 12, { steps: 3 });
  await page.mouse.move(x, box.y + 19, { steps: 3 });
  await page.screenshot({ path: info.outputPath(phone ? 'today-drag-phone.png' : 'today-drag-desktop.png') });
  await page.mouse.up();
  await expect(page.getByText('Write the report is now 4:30pm to 5:30pm.')).toBeVisible();
  const moved = page.getByRole(role, { name: /^Write the report, 4:30pm to 5:30pm/ });
  await expect(moved).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Five steps of 15 minutes take it past Paint the fence, and it keeps focus there.
  await moved.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await expect(page.getByText('Write the report is now 5:45pm to 6:45pm. That overlaps Paint the fence.')).toBeVisible();
  await expect(page.getByRole(role, { name: /^Write the report, 5:45pm to 6:45pm/ })).toBeFocused();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole(role, { name: /^Write the report, 4:30pm to 5:30pm/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a clash with the calendar shifts the rest of today', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const calendar: Seed = {
    type: 'calendar',
    id: 'calendar',
    fields: { connected: true, events: [{ id: 'e1', calendar: 'g1', title: 'Quiz night', start: at('16:00'), end: at('16:30') }] },
  };
  const errors = await open(page, [planned, calendar, report, fence, block('b1', 't1', '16:00', '17:00'), block('b2', 't2', '17:00', '17:30')]);
  await expect(page.getByText('Write the report conflicts with Quiz night.')).toBeVisible();
  await expect(page.getByRole(phone ? 'slider' : 'button', { name: /^Write the report, 4pm to 5pm, Project\. Conflicts with Quiz night/ })).toBeVisible();
  await page.getByRole('button', { name: 'Shift rest of today' }).click();
  const panel = page.getByRole('region', { name: 'Shift rest of today' });
  await expect(panel.getByRole('listitem').first()).toContainText('now 4:30pm to 5:30pm');
  await page.screenshot({ path: info.outputPath(phone ? 'shift-phone.png' : 'shift-desktop.png') });
  await panel.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Rest of today shifted. Time blocks calendar will update.')).toBeVisible();
  await expect(page.getByRole(phone ? 'slider' : 'button', { name: /^Write the report, 4:30pm to 5:30pm/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('to schedule sits just above the day, and a card dragged onto it is placed there, held first on phone', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const pick: Seed = { type: 'week_pick', id: 'pick:2026-11-02:t2', fields: { week_start: '2026-11-02', task_id: 't2', minutes: 30 } };
  const errors = await open(page, [planned, report, fence, pick, block('b1', 't1', '16:00', '17:00')]);
  const lane = page.getByRole('region', { name: 'To schedule' });
  const card = lane.getByRole('button', { name: /^Paint the fence, One off, 30m/ });
  await expect(card).toBeVisible();
  if (phone) await expectTapTarget(card);
  await lane.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  const day = page.locator('[data-drop-date="2026-11-02"]');
  const [l, d] = [(await lane.boundingBox())!, (await day.boundingBox())!];
  expect(d.y).toBeGreaterThanOrEqual(l.y + l.height);
  await page.screenshot({ path: info.outputPath(`today-to-schedule-${info.project.name}.png`) });

  // The first zoom draws 30px an hour from 7am, so 3pm is 240px down.
  const to = { x: d.x + d.width / 2, y: d.y + 240 + 2 };
  if (phone) await touchDrag(page, card, to);
  else {
    const c = (await card.boundingBox())!;
    await page.mouse.move(c.x + 20, c.y + 10);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
  }
  await expect(page.getByRole(phone ? 'slider' : 'button', { name: /^Paint the fence, 3pm to 3:30pm/ })).toBeVisible();
  await expect(card).toHaveCount(0);
  expect(errors).toEqual([]);
});
