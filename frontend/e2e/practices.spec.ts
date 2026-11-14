import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded } from './seed';
import type { Seed } from './seed';

// A practice's editor on Goals: a number of times a week with a session length and no set time, and Pause, Resume and
// End practice, which act at once.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm

const records: Seed[] = [
  { type: 'objective', id: 'g1', fields: { title: 'Run a 10k', state: 'active' } },
  { type: 'practice', id: 'pr1', fields: { title: 'Stretch', target_min: 15, per: 'day', state: 'active', preferred_times: [420] } },
];

async function openPractice(page: Page, phone: boolean) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Goals' }).click();
  await page.getByRole('button', { name: /^Practices with no goal/ }).click();
  return { errors, open: () => edit(page, phone) };
}

async function edit(page: Page, phone: boolean) {
  await page.getByRole('button', { name: /^Stretch/ }).click();
  return phone ? page.getByRole('dialog', { name: 'Edit practice' }) : page.getByRole('group', { name: 'Edit Stretch' });
}

test('Pause marks a practice Paused until Resume, and End practice takes it off Goals with Undo', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const { errors, open } = await openPractice(page, phone);
  const row = page.getByRole('button', { name: /^Stretch/ });
  let editor = await open();
  await expect(row).not.toContainText('Paused');
  const pause = editor.getByRole('button', { name: 'Pause' });
  if (phone) {
    await expectTapTarget(pause);
    await expectTapTarget(editor.getByRole('button', { name: 'End practice' }));
  }
  await pause.click();
  // It acts at once, and the editor stays open with its way back.
  await expect(row).toContainText('Paused');
  const resume = editor.getByRole('button', { name: 'Resume' });
  await expect(resume).toBeVisible();
  await page.screenshot({ path: info.outputPath(`practice-paused-${info.project.name}.png`) });
  await resume.click();
  await expect(editor.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(row).not.toContainText('Paused');

  // Paused, it reads so with the editor closed too.
  await editor.getByRole('button', { name: 'Pause' }).click();
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toHaveCount(0);
  await expect(row).toContainText('Paused');

  editor = await open();
  await editor.getByRole('button', { name: 'End practice' }).click();
  await expect(page.getByText('Stretch ended. Its history stays.')).toBeVisible();
  await expect(editor).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  // Back as it was before it ended, paused.
  await expect(row).toContainText('Paused');
  expect(errors).toEqual([]);
});

test('Times a week with a longer session and no set time saves as one line, and reopens as saved', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const { errors, open } = await openPractice(page, phone);
  let editor = await open();
  await editor.getByRole('radio', { name: 'Times a week' }).click();
  const fewer = editor.getByRole('button', { name: 'One fewer time a week' });
  const more = editor.getByRole('button', { name: 'One more time a week' });
  if (phone) for (const step of [fewer, more]) await expectTapTarget(step);
  await expect(editor.getByRole('group', { name: 'How many times' })).toContainText('7 times a week');
  // Seven is the most there is.
  await expect(more).toHaveAttribute('aria-disabled', 'true');
  for (let i = 0; i < 4; i++) await fewer.click();
  await expect(editor.getByRole('group', { name: 'How many times' })).toContainText('3 times a week');
  const preferred = editor.getByRole('group', { name: 'Preferred days' });
  await preferred.getByRole('button', { name: 'Weekends' }).click();
  await expect(editor.getByText('Sat and Sun first.', { exact: false })).toBeVisible();

  const length = editor.getByRole('slider', { name: 'Each session' });
  await length.fill('30');
  await expect(length).toHaveAttribute('aria-valuetext', '30 minutes');
  await expect(editor.getByText('3 sessions, 1h 30m a week')).toBeVisible();
  await editor.getByRole('radio', { name: 'Any time' }).click();
  await expect(editor.getByLabel('Usual time')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved Stretch: 3 times a week, 30m each, preferably on weekends, any time.')).toBeVisible();

  editor = await open();
  await expect(editor.getByRole('radio', { name: 'Times a week' })).toBeChecked();
  await expect(editor.getByRole('group', { name: 'How many times' })).toContainText('3 times a week');
  await expect(editor.getByRole('radio', { name: 'Any time' })).toBeChecked();
  await expect(editor.getByRole('slider', { name: 'Each session' })).toHaveValue('30');
  await expect(editor.getByRole('group', { name: 'Preferred days' }).getByRole('checkbox', { checked: true })).toHaveCount(2);
  await editor.getByRole('button', { name: 'Cancel' }).click();
  expect(errors).toEqual([]);
});
