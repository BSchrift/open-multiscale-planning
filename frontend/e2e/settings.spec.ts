import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { expectTapTarget, openSeeded, pane } from './seed';
import type { Seed } from './seed';

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm.

const records: Seed[] = [
  { type: 'calendar_source', id: 'src1', fields: { google_id: 'cal-a', name: 'Work', mode: 'block' } },
  { type: 'calendar_source', id: 'src2', fields: { google_id: 'cal-b', name: 'Family', mode: 'info' } },
  {
    type: 'calendar',
    id: 'calendar',
    fields: {
      connected: true,
      synced_at: '2026-11-02T19:58:00Z',
      events: [{ id: 'e1', calendar: 'cal-a', title: 'Team meeting', start: '2026-11-10T21:00:00Z', end: '2026-11-10T23:00:00Z' }],
    },
  },
];

async function openSettings(page: Page, phone: boolean) {
  await page.clock.setFixedTime(NOW);
  await openSeeded(page, records);
  const nav = page.getByRole('navigation', { name: 'Main' });
  if (phone) {
    await nav.getByRole('button', { name: 'More' }).click();
    const row = page.getByRole('button', { name: /^Settings/ });
    await expect(row).toContainText('105h a week for projects, no One offs aim');
    await row.click();
  } else {
    await nav.getByRole('button', { name: 'Settings' }).click();
  }
  await expect(pane(page, 'Settings').getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
}

async function expectTargets(controls: Locator) {
  for (const control of await controls.all()) if (await control.isVisible()) await expectTapTarget(control);
}

test('first run: skips sign-in, sets unavailable hours, starts with a goal', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.setFixedTime(NOW);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip' }).click();

  await expect(page.getByRole('heading', { name: 'Unavailable hours' })).toBeFocused();
  await page.getByRole('group', { name: 'Unavailable, 10pm to 7am' }).getByRole('slider', { name: 'To' }).fill('360');
  await expect(page.getByRole('group', { name: 'Unavailable, 10pm to 6am' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByRole('textbox', { name: 'A goal or a thought' }).fill('Learn to bake bread');
  await page.getByRole('button', { name: 'Add goal' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  // The browser build saves its database a moment after each change.
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('edits settings in place', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openSettings(page, phone);
  const p = pane(page, 'Settings');

  // Account: this build has no sign-in yet, so it says so and offers it.
  const account = p.getByRole('region', { name: 'Account' });
  await expect(account.getByText('Signed out')).toBeVisible();
  await expect(account.getByRole('button', { name: 'Sign in' })).toBeVisible();

  // Available hours, with next week's busy time from the blocking calendar.
  const hours = p.getByRole('region', { name: 'Available hours' });
  await expect(hours.getByText('105h a week for projects and 105h for one offs, before 2h of calendar busy time next week.')).toBeVisible();
  await hours.getByRole('button', { name: 'Add unavailable time' }).click();
  const lunch = hours.getByRole('group', { name: 'Unavailable, 12pm to 1pm' });
  await lunch.getByRole('combobox', { name: 'Days' }).selectOption('weekdays');
  await expect(hours.getByText(/^100h a week for projects and 100h for one offs/)).toBeVisible();
  // A click, as uncheck() wants the box changed at once, and it shows what was saved, a moment later.
  await lunch.getByRole('checkbox', { name: 'One offs' }).click();
  await expect(hours.getByText(/^100h a week for projects and 105h for one offs/)).toBeVisible();
  await lunch.getByRole('button', { name: 'Remove 12pm to 1pm' }).click();
  await expect(hours.getByRole('group', { name: /^Unavailable, / })).toHaveCount(1);

  // Calendars by name, with their modes.
  const cal = p.getByRole('region', { name: 'Google Calendar' });
  await expect(cal.getByText('Connected. Blocks go to your Time blocks calendar.')).toBeVisible();
  await expect(cal.getByText('Last pushed 1:58pm')).toBeVisible();
  await cal.getByRole('combobox', { name: 'Work' }).selectOption('info');
  await expect(hours.getByText('105h a week for projects and 105h for one offs.')).toBeVisible();
  await cal.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('Sign in first.')).toBeVisible();

  // Away dates.
  const away = p.getByRole('region', { name: 'Away dates' });
  await away.getByLabel('From').fill('2026-12-20');
  await away.getByLabel(/^to$/i).fill('2026-12-28');
  await away.getByRole('button', { name: 'Add' }).click();
  await expect(away.getByText('Dec 20 to Dec 28')).toBeVisible();
  await away.getByRole('button', { name: 'Remove Dec 20 to Dec 28' }).click();
  await expect(away.getByText('Dec 20 to Dec 28')).toHaveCount(0);

  // Reminders.
  const rem = p.getByRole('region', { name: 'Reminders' });
  await rem.getByRole('slider', { name: 'After' }).fill('15');
  await expect(rem.getByText('15 minutes')).toBeVisible();
  await rem.getByRole('checkbox', { name: "Ask if I've started, unless I already tapped Start" }).click();
  await expect(rem.getByRole('slider', { name: 'After' })).toHaveCount(0);

  if (phone) await expectTargets(p.locator('button, select, input:not([type=checkbox]), label.taskrow'));
  await page.screenshot({ path: info.outputPath('settings.png'), fullPage: true });

  // The cadence changes on the Plan page, and back returns here.
  const cadence = p.getByRole('region', { name: 'Planning cadence' });
  await expect(cadence.getByText('Calendar quarters')).toBeVisible();
  await cadence.getByRole('button', { name: 'Change planning cadence' }).click();
  await expect(pane(page, 'Plan')).toBeVisible();
  await page.getByRole('button', { name: 'Back to Settings' }).click();
  await expect(pane(page, 'Settings')).toBeVisible();

  // Everything above was saved.
  await page.waitForTimeout(500);
  await page.reload();
  if (phone) {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'More' }).click();
    await page.getByRole('button', { name: /^Settings/ }).click();
  } else {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
  }
  await expect(pane(page, 'Settings').getByRole('region', { name: 'Google Calendar' }).getByRole('combobox', { name: 'Work' })).toHaveValue('info');
  await expect(pane(page, 'Settings').getByRole('region', { name: 'Reminders' }).getByRole('checkbox', { name: "Ask if I've started, unless I already tapped Start" })).not.toBeChecked();
  expect(errors).toEqual([]);
});

test('appearance follows the system live until chosen, and a choice holds from the first paint', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const [LIGHT_PAGE, DARK_PAGE] = ['rgb(250, 250, 248)', 'rgb(20, 21, 23)'];
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.emulateMedia({ colorScheme: 'light' });
  await openSettings(page, phone);
  const group = pane(page, 'Settings').getByRole('group', { name: 'Appearance' });
  await expect(group.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true');
  expect(await background()).toBe(LIGHT_PAGE);
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await background()).toBe(DARK_PAGE);

  await group.getByRole('button', { name: 'Light' }).click();
  expect(await background()).toBe(LIGHT_PAGE);
  await page.emulateMedia({ colorScheme: 'light' });
  await group.getByRole('button', { name: 'Dark' }).click();
  expect(await background()).toBe(DARK_PAGE);
  if (phone) await expectTargets(group.getByRole('button'));

  // On the next launch the root is marked before the page has a body, so the system's theme never shows first.
  await page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      if (!document.body) return;
      Object.assign(window, { themeAtBody: document.documentElement.dataset.theme ?? null });
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  expect(await page.evaluate(() => (window as unknown as { themeAtBody: unknown }).themeAtBody)).toBe('dark');
  expect(await background()).toBe(DARK_PAGE);
});
