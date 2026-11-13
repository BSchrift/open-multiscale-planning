import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded, pane } from './seed';
import type { Seed } from './seed';

// Done: a day's list of what was finished and the time worked, reached from Today's line, Week's day headings, the
// sidebar on desktop and More on phone.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-12T23:40:00Z'); // Thursday 5:40pm in Chicago.
const at = (day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  // Chicago is six hours behind UTC in November.
  return new Date(Date.UTC(2026, 10, day, h! + 6, m ?? 0)).toISOString().replace('.000Z', 'Z');
};
const THU = 12;
const WED = 11;

const block = (id: string, owner: Record<string, string>, day: number, from: string, to: string): Seed => ({
  type: 'time_block',
  id,
  fields: { ...owner, start: at(day, from), end: at(day, to), tz: 'America/Chicago' },
});
const answer = (id: string, result: string, extra: Record<string, unknown> = {}): Seed => ({
  type: 'block_outcome',
  id: `outcome:${id}`,
  fields: { result, answered_at: at(THU, '17:00'), ...extra },
});
const task = (id: string, title: string, fields: Record<string, unknown>): Seed => ({ type: 'task', id, fields: { title, ...fields } });

// The mockups' sample day, and a Wednesday before it.
const records: Seed[] = [
  { type: 'week_plan', id: 'week:2026-11-09', fields: { week_start: '2026-11-09', finished_at: at(9, '08:00') } },
  { type: 'project', id: 'p1', fields: { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-31' } },
  { type: 'project', id: 'p2', fields: { title: 'Website refresh', state: 'active', start: '2026-10-01', end: '2026-12-31' } },
  { type: 'milestone', id: 'm1', fields: { project_id: 'p1', title: 'Draft chapters' } },
  { type: 'practice', id: 'pr', fields: { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' } },
  block('piano', { practice_id: 'pr' }, THU, '08:30', '09:00'),
  answer('piano', 'done', { logged_min: 30 }),
  task('summary', 'Draft the summary', { kind: 'project', project_id: 'p1', milestone_id: 'm1', done_at: at(THU, '10:30') }),
  block('b-summary', { task_id: 'summary' }, THU, '09:00', '10:30'),
  answer('b-summary', 'done'),
  task('outline', 'Outline chapter 3', { kind: 'project', project_id: 'p1', estimate_min: 240, remaining_min: 60 }),
  block('b-outline', { task_id: 'outline' }, THU, '11:00', '12:30'),
  answer('b-outline', 'partly', { remaining_min: 60 }),
  task('water', 'Pay the water bill', { kind: 'one_off', done_at: at(THU, '13:30') }),
  { type: 'task_completion', id: 'c-water', fields: { task_id: 'water', done_at: at(THU, '13:30') } },
  block('b-water', { task_id: 'water' }, THU, '13:00', '13:30'),
  answer('b-water', 'done'),
  task('plan', 'Plan next week', { kind: 'planning', done_at: at(THU, '14:30') }),
  block('b-plan', { task_id: 'plan' }, THU, '14:00', '14:30'),
  answer('b-plan', 'done'),
  task('login', 'Fix the login redirect', { kind: 'project', project_id: 'p2', estimate_min: 60 }),
  block('b-login', { task_id: 'login' }, THU, '15:30', '16:30'),
  task('plants', 'Water the plants', { kind: 'one_off', schedule: { type: 'recurring', every: 1, unit: 'week', anchor: '2026-10-08' }, next_due: '2026-11-19' }),
  { type: 'task_completion', id: 'c-plants', fields: { task_id: 'plants', done_at: at(THU, '16:52') } },
  task('safari', 'Fix the date picker on Safari', { kind: 'project', project_id: 'p2', done_at: at(WED, '11:30') }),
  block('b-safari', { task_id: 'safari' }, WED, '10:00', '11:30'),
  answer('b-safari', 'done'),
];

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  // Today asks about the block that ended unanswered; it can wait for Done.
  await page.getByRole('dialog', { name: 'Block finished' }).getByRole('button', { name: 'Answer later' }).click();
  return errors;
}

const done = (page: Page) => pane(page, 'Done');
const group = (page: Page, name: string) => done(page).getByRole('region', { name });

test('from Today’s line to Done, where a block not marked yet is marked finished, moves into the list, and Undo takes it back', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page);

  const line = page.getByRole('button', { name: 'Done today: 4 finished, 4h 30m worked' });
  await expect(line).toHaveText('Done today · 4 · 4h 30m›');
  if (phone) await expectTapTarget(line);
  await line.click();

  await expect(done(page).getByRole('heading', { name: 'Thursday, Nov 12' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to Today' })).toBeVisible();
  await expect(done(page).getByRole('region', { name: 'Totals' })).toContainText('4 finished · 4h 30m worked');
  await expect(group(page, 'Finished').getByRole('listitem')).toHaveText([/^10:30amDraft the summary/, /^10:30amDraft chapters/, /^1:30pmPay the water bill/, /^4:52pmWater the plants/]);
  await expect(group(page, 'Time worked').getByRole('listitem')).toHaveText([/^8:30amPiano practice/, /^11amOutline chapter 3.*1h 30m1h left$/, /^2pmPlan next week/]);

  const mark = done(page).getByRole('button', { name: 'Mark how Fix the login redirect went' });
  if (phone) {
    await expectTapTarget(mark);
    await expectTapTarget(done(page).getByRole('button', { name: 'Previous day' }));
    await expectTapTarget(done(page).getByRole('button', { name: 'Next day' }));
  }
  await mark.click();
  const sheet = page.getByRole('dialog', { name: '1 missed block' });
  await sheet.getByRole('button', { name: 'Finished: Fix the login redirect' }).click();
  await expect(page.getByText('Fix the login redirect: finished.')).toBeVisible();
  await expect(sheet).toHaveCount(0);
  await expect(group(page, 'Not marked yet')).toHaveCount(0);
  await expect(group(page, 'Finished').getByRole('listitem').last()).toHaveText(/^4:52pmWater the plants/);
  await expect(group(page, 'Finished').getByRole('listitem').filter({ hasText: 'Fix the login redirect' })).toHaveText(/^4:30pmFix the login redirectWebsite refresh3:30pm to 4:30pm · 1h$/);
  await expect(done(page).getByRole('region', { name: 'Totals' })).toContainText('5 finished · 5h 30m worked');

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(mark).toBeVisible();
  await expect(done(page).getByRole('region', { name: 'Totals' })).toContainText('4 finished · 4h 30m worked');

  // A day back, and Today comes back.
  await done(page).getByRole('button', { name: 'Previous day' }).click();
  await expect(done(page).getByRole('heading', { name: 'Wednesday, Nov 11' })).toBeVisible();
  await expect(group(page, 'Finished').getByRole('listitem')).toHaveText([/^11:30amFix the date picker on SafariWebsite refresh10am to 11:30am · 1h 30m$/]);
  const today = done(page).getByRole('button', { name: 'Today', exact: true });
  if (phone) await expectTapTarget(today);
  await today.click();
  await expect(done(page).getByRole('heading', { name: 'Thursday, Nov 12' })).toBeVisible();
  await expect(done(page).getByRole('button', { name: 'Next day' })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('Week’s day headings open Done on that day, and Done has its place in the navigation', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page);
  const nav = page.getByRole('navigation', { name: 'Main' });

  await nav.getByRole('button', { name: 'Week' }).click();
  if (phone) {
    // The chosen day's heading, today, opens it; a later day's doesn't.
    const heading = page.getByRole('button', { name: 'Done on Thu Nov 12: 4 finished' });
    await expect(heading).toHaveText('4 finished ›');
    await expectTapTarget(heading);
    await heading.click();
  } else {
    await expect(page.getByRole('button', { name: /^Done on Fri Nov 13/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Done on Wed Nov 11: 1 finished' }).click();
  }
  await expect(done(page).getByRole('heading', { name: phone ? 'Thursday, Nov 12' : 'Wednesday, Nov 11' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to Week' })).toBeVisible();

  if (phone) {
    // Done lives under More, so More, chosen again, goes back to its list.
    await nav.getByRole('button', { name: 'More' }).click();
    const row = page.getByRole('button', { name: /^Done/ });
    await expect(row).toContainText('4 finished today, 4h 30m worked');
    await row.click();
    await expect(page.getByRole('button', { name: 'Back to More' })).toBeVisible();
  } else {
    const side = nav.getByRole('button', { name: 'Done' });
    await side.click();
    await expect(side).toHaveAttribute('aria-current', 'page');
  }
  await expect(done(page).getByRole('heading', { name: 'Thursday, Nov 12' })).toBeVisible();
  expect(errors).toEqual([]);
});
