import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { expectTapTarget, openSeeded, pane } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm
const MAX_NOTES = 20_000;

const records: Seed[] = [
  { type: 'objective', id: 'g1', fields: { title: 'Write the quarterly report', state: 'active' } },
  { type: 'project', id: 'p1', fields: { objective_id: 'g1', title: 'Report', state: 'active', start: '2026-10-01', end: '2026-12-15' } },
  { type: 'milestone', id: 'm1', fields: { project_id: 'p1', title: 'Drafts', due: '2026-11-20' } },
  { type: 'task', id: 't1', fields: { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Draft the summary', estimate_min: 120 } },
  { type: 'task', id: 't2', fields: { kind: 'one_off', title: 'Return the drill', schedule: { type: 'once' } } },
  { type: 'week_plan', id: 'week:2026-11-02', fields: { week_start: '2026-11-02', finished_at: '2026-11-02T14:00:00Z' } },
  // Under way, so the phone doesn't ask whether it's started.
  { type: 'time_block', id: 'b1', fields: { task_id: 't1', start: '2026-11-02T19:00:00Z', end: '2026-11-02T21:00:00Z', tz: 'America/Chicago', started_at: '2026-11-02T19:00:00Z' } },
];

/** The caret at the end of a field: End moves it only to the end of the line, and not at all on a Mac. */
const toEnd = (field: Locator) => field.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));

async function openProject(page: Page, phone: boolean) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Goals' }).click();
  await page.getByRole('button', { name: /^Write the quarterly report/ }).click();
  await page.getByRole('button', { name: /^Report/ }).click();
  if (phone) await expect(page.getByRole('heading', { level: 1, name: 'Report' })).toBeVisible();
}

async function editTask(page: Page) {
  await page.getByRole('button', { name: 'Edit task Draft the summary, 2h' }).click();
  return page.getByRole('dialog', { name: 'Edit task' });
}

test('writes a description with the bar, shows it formatted, and opens its links outside the app', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  await openProject(page, phone);
  let editor = await editTask(page);

  const field = editor.getByLabel('Description');
  await field.fill('Use the Q3 numbers first.\nCheck the totals with finance\nSend it to Sam by Friday');
  // Bold from the bar, on the selected words.
  await field.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(8, 18));
  if (phone) for (const tool of await editor.getByRole('toolbar', { name: 'Formatting' }).getByRole('button').all()) await expectTapTarget(tool);
  await editor.getByRole('button', { name: 'Bold' }).click();
  await expect(field).toHaveValue('Use the **Q3 numbers** first.\nCheck the totals with finance\nSend it to Sam by Friday');
  // The last two lines as a list, then Friday in italic from the keyboard on desktop.
  await field.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(30, el.value.length));
  await editor.getByRole('button', { name: 'Bulleted list' }).click();
  await field.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length - 6, el.value.length));
  if (phone) await editor.getByRole('button', { name: 'Italic' }).click();
  else await field.press('ControlOrMeta+i');
  await toEnd(field);
  await field.pressSequentially('\nThe brief: https://example.com/brief');
  await expect(field).toHaveValue('Use the **Q3 numbers** first.\n- Check the totals with finance\n- Send it to Sam by *Friday*\nThe brief: https://example.com/brief');
  await page.screenshot({ path: info.outputPath(`description-editing-${info.project.name}.png`) });
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toHaveCount(0);

  editor = await editTask(page);
  const shown = editor.getByRole('group', { name: 'Description' });
  await expect(shown.locator('strong')).toHaveText('Q3 numbers');
  await expect(shown.locator('em')).toHaveText('Friday');
  await expect(shown.getByRole('listitem')).toHaveText(['Check the totals with finance', 'Send it to Sam by Friday']);
  const link = shown.getByRole('link', { name: 'https://example.com/brief' });
  await expect(link).toHaveAttribute('target', '_blank');
  const popup = page.waitForEvent('popup');
  await link.click();
  await (await popup).close();
  await expect(editor.getByRole('textbox', { name: 'Description' })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`description-${info.project.name}.png`) });
  if (phone) await expectTapTarget(editor.getByRole('button', { name: 'Edit description' }));
  await editor.getByRole('button', { name: 'Edit description' }).click();
  await expect(editor.getByRole('textbox', { name: 'Description' })).toBeFocused();
  await editor.getByRole('button', { name: 'Cancel' }).click();

  // The Now card shows its first two lines, plain.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Today' }).click();
  const now = page.getByRole('region', { name: 'Current block' });
  await expect(now.locator('.nownotes')).toHaveText('Use the Q3 numbers first.\nCheck the totals with finance');
  expect(errors).toEqual([]);
});

test('stops a description at the limit and counts the last tenth', async ({ page }, info) => {
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  if (info.project.name === 'phone') {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: /^One offs/ }).click();
  } else {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'One offs' }).click();
  }
  await pane(page, 'One offs').getByRole('button', { name: 'Change repeat for Return the drill' }).click();
  const form = page.getByRole('form', { name: 'Change Return the drill' });
  const field = form.getByLabel('Description');
  await field.fill('x'.repeat(MAX_NOTES - 1));
  await expect(form.getByText('19,999 of 20,000')).toBeVisible();
  await toEnd(field);
  await field.pressSequentially('yz');
  await expect(field).toHaveValue(`${'x'.repeat(MAX_NOTES - 1)}y`);
  await expect(form.getByText('20,000 of 20,000')).toBeVisible();
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form).toHaveCount(0);
});
