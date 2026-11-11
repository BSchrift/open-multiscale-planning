import { expect, test } from '@playwright/test';
import { expectTapTarget, go, openSeeded, pane } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm

const records: Seed[] = [
  { type: 'task', id: 'i1', fields: { kind: 'inbox', title: 'Fix the gate' } },
  { type: 'attachment', id: 'a1', fields: { task_id: 'i1', kind: 'link', name: 'Hinges', url: 'https://example.com/hinges' } },
];

// Photos need a server to keep them, so a device that has never signed in offers links alone. The photo journey, through
// a backend, is in stack/attachments.spec.ts.
test('a task’s links: added, opened outside the app, and removed with Undo', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  await page.clock.install({ time: NOW });
  await openSeeded(page, records);
  if (phone) await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Inbox/ }).click();
  else await go(page, 'Inbox');
  await pane(page, 'Inbox').getByRole('button', { name: 'Fix the gate', exact: true }).click();
  const popup = page.locator('.sheet.taskpop[aria-label="Fix the gate"]');
  const section = popup.getByRole('region', { name: 'Attachments' });
  await expect(section.getByRole('link', { name: 'Hinges' })).toHaveAttribute('target', '_blank');
  await expect(section.getByText('Link · example.com')).toBeVisible();

  const add = section.getByRole('button', { name: '+ Add a link' });
  if (phone) await expectTapTarget(section.getByRole('button', { name: 'Remove Hinges' }));
  await add.click();
  await expect(section.getByRole('button', { name: 'Choose a photo' })).toHaveCount(0);
  await section.getByRole('button', { name: 'Paste a link' }).click();
  await section.getByRole('textbox', { name: 'Address' }).fill('https://docs.example.com/q3');
  await section.getByRole('textbox', { name: 'Name (optional)' }).fill('Q3 numbers');
  // Enter adds the link, and leaves the popup open.
  await section.getByRole('textbox', { name: 'Name (optional)' }).press('Enter');
  await expect(section.getByRole('link', { name: 'Q3 numbers' })).toBeVisible();
  await expect(add).toBeFocused();
  await page.screenshot({ path: info.outputPath(`links-${info.project.name}.png`) });
  const opened = page.waitForEvent('popup');
  await section.getByRole('link', { name: 'Q3 numbers' }).click();
  await (await opened).close();

  await section.getByRole('button', { name: 'Remove Hinges' }).click();
  await expect(page.getByText('Removed Hinges.')).toBeVisible();
  await expect(section.getByRole('link', { name: 'Hinges' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(section.getByRole('link', { name: 'Hinges' })).toBeVisible();
});
