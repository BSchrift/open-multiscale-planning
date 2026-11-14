import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { expectTapTarget, openSeeded, pane, readRecord, seed } from './seed';
import type { Seed } from './seed';

// Settings, section by section, for what settings.spec.ts's tour leaves out. Signing in, syncing and a connected
// calendar's pushes need a backend, so they're the stack layer's; here the browser is signed out.

test.use({ timezoneId: 'America/Chicago' });

const NOW = new Date('2026-11-02T20:00:00Z'); // Monday 2pm.

const settings = (page: Page) => pane(page, 'Settings');
const section = (page: Page, name: string) => settings(page).getByRole('region', { name });

async function goSettings(page: Page, phone: boolean) {
  const nav = page.getByRole('navigation', { name: 'Main' });
  if (phone) {
    await nav.getByRole('button', { name: 'More' }).click();
    // More keeps the page it was left on.
    const back = page.getByRole('button', { name: 'Back to More' });
    if (await back.isVisible()) await back.click();
    await pane(page, 'More').getByRole('button', { name: /^Settings/ }).click();
  } else {
    await nav.getByRole('button', { name: 'Settings' }).click();
  }
  await expect(settings(page).getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
}

async function open(page: Page, phone: boolean, records: readonly Seed[] = []) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.setFixedTime(NOW);
  await openSeeded(page, records);
  await goSettings(page, phone);
  return errors;
}

/** Reloads once the browser build has saved, as it does a moment after a change, and opens Settings again. */
async function reload(page: Page, phone: boolean) {
  await page.waitForTimeout(600);
  await page.reload();
  await goSettings(page, phone);
}

test("the browser's Settings has each section in order, Keyboard on desktop alone, and ends with a link to the source code", async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone);
  // Capture shortcut and Updates are the apps'.
  const sections = ['Account', 'Available hours', 'Planning cadence', 'Google Calendar', 'Away dates', 'Reminders', 'Appearance', ...(phone ? [] : ['Keyboard']), 'Data retention'];
  await expect(settings(page).getByRole('heading', { level: 2 })).toHaveText(sections);
  const source = settings(page).getByRole('link', { name: 'Source code' });
  await expect(source).toHaveAttribute('href', 'https://github.com/BSchrift/open-multiscale-planning');
  // A new tab in a browser, and the system browser in the apps.
  await expect(source).toHaveAttribute('target', '_blank');
  await expect(source).toHaveAttribute('rel', /noreferrer/);
  expect(errors).toEqual([]);
});

test('desktop: Keyboard turns single-key shortcuts on for this device, and they stay on after a reload', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'Keyboard shortcuts are for the desktop card.');
  const errors = await open(page, false);
  const keys = section(page, 'Keyboard').getByRole('checkbox', { name: 'Single-key shortcuts in Process' });
  await expect(keys).not.toBeChecked();
  await keys.check();
  await reload(page, false);
  await expect(keys).toBeChecked();
  // Kept on this device, not in the settings that sync.
  expect(JSON.stringify(await readRecord(page, 'settings', 'settings'))).not.toContain('process');
  await keys.uncheck();
  await reload(page, false);
  await expect(keys).not.toBeChecked();
  expect(errors).toEqual([]);
});

test('Reminders: Notify at block start, Ask at block end and the planning reminder each turn off and stay off', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone);
  const rem = section(page, 'Reminders');
  const toggles = ['Notify at block start', 'Ask at block end', "Remind me when next week's planning has no time"].map((name) => rem.getByRole('checkbox', { name }));
  for (const toggle of toggles) {
    await expect(toggle).toBeChecked();
    if (phone) await expectTapTarget(toggle.locator('xpath=ancestor::label'));
    // A click, as uncheck() wants the box changed at once, and it shows what was saved, a moment later.
    await toggle.click();
    await expect(toggle).not.toBeChecked();
  }
  // Each one alone: Ask if I've started is still on, with its delay.
  await expect(rem.getByRole('checkbox', { name: "Ask if I've started, unless I already tapped Start" })).toBeChecked();
  await expect(rem.getByRole('slider', { name: 'After' })).toBeVisible();
  expect((await readRecord(page, 'settings', 'settings'))?.reminders).toEqual({ block_start: false, check_in: true, check_in_delay_min: 5, block_end: false, planning: false });

  await reload(page, phone);
  for (const toggle of toggles) await expect(toggle).not.toBeChecked();
  await toggles[2]!.click();
  await expect(toggles[2]!).toBeChecked();
  expect((await readRecord(page, 'settings', 'settings'))?.reminders).toMatchObject({ planning: true });
  expect(errors).toEqual([]);
});

test('the weekly one offs aim moves up from No aim and is kept, and on phone the More line says it', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone);
  const aim = section(page, 'Available hours').getByRole('slider', { name: 'Weekly one offs aim' });
  await expect(aim).toHaveAttribute('aria-valuetext', 'No aim');
  if (phone) await expectTapTarget(aim);
  // In one move: arrow keys pressed faster than each save reads back can lose a step.
  await aim.fill('4');
  await expect(aim).toHaveAttribute('aria-valuetext', '1h');
  await expect.poll(async () => (await readRecord(page, 'settings', 'settings'))?.one_offs_weekly_aim).toBe(60);

  await reload(page, phone);
  await expect(aim).toHaveAttribute('aria-valuetext', '1h');
  if (phone) {
    await page.getByRole('button', { name: 'Back to More' }).click();
    await expect(pane(page, 'More').getByRole('button', { name: /^Settings/ })).toContainText('105h a week for projects, 1h One offs aim');
  }
  // All the way left is no aim again.
  if (phone) await goSettings(page, phone);
  await aim.focus();
  await page.keyboard.press('Home');
  await expect(aim).toHaveAttribute('aria-valuetext', 'No aim');
  await expect.poll(async () => (await readRecord(page, 'settings', 'settings'))?.one_offs_weekly_aim).toBeNull();
  expect(errors).toEqual([]);
});

test('Away dates: an end before the start is refused with a message, and Remove says what it removed, with Undo', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone);
  const away = section(page, 'Away dates');
  await away.getByLabel('From').fill('2026-12-28');
  await away.getByLabel(/^to$/i).fill('2026-12-20');
  await away.getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('.toast')).toContainText('Choose a start and an end date');
  await expect(away.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  // What was typed stays, to be put right.
  await expect(away.getByLabel('From')).toHaveValue('2026-12-28');

  await away.getByLabel('From').fill('2026-12-20');
  await away.getByLabel(/^to$/i).fill('2026-12-28');
  await away.getByRole('button', { name: 'Add' }).click();
  const remove = away.getByRole('button', { name: 'Remove Dec 20 to Dec 28' });
  if (phone) await expectTapTarget(remove);
  await remove.click();
  const toast = page.locator('.toast');
  await expect(toast).toContainText('Removed away dates Dec 20 to Dec 28.');
  await expect(away.getByText('Dec 20 to Dec 28')).toHaveCount(0);
  const undo = toast.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeFocused();
  await undo.click();
  await expect(away.getByText('Dec 20 to Dec 28')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Google Calendar, signed out: Connect asks for a sign-in, and Disconnect asks first, with Cancel changing nothing', async ({ page }, info) => {
  const phone = info.project.name === 'phone';
  const errors = await open(page, phone);
  const cal = section(page, 'Google Calendar');
  await expect(cal.getByText('Not connected.')).toBeVisible();
  const connect = cal.getByRole('button', { name: 'Connect' });
  if (phone) await expectTapTarget(connect);
  await connect.click();
  await expect(page.locator('.toast')).toContainText('Sign in first.');
  await expect(cal.getByText('Not connected.')).toBeVisible();

  // Connected on another device: the record arrives by sync.
  await seed(page, [{ type: 'calendar', id: 'calendar', fields: { connected: true, synced_at: '2026-11-02T19:58:00Z', events: [] } }]);
  await expect(cal.getByText('Connected. Blocks go to your Time blocks calendar.')).toBeVisible();
  const disconnect = cal.getByRole('button', { name: 'Disconnect', exact: true });
  await expect(disconnect).toHaveAttribute('aria-expanded', 'false');
  await disconnect.click();
  await expect(disconnect).toHaveAttribute('aria-expanded', 'true');
  await expect(cal.getByText('Your blocks stay here, and the Time blocks calendar is removed from Google. You can connect again any time.')).toBeVisible();
  if (phone) for (const name of ['Disconnect Google Calendar', 'Cancel']) await expectTapTarget(cal.getByRole('button', { name }));
  await cal.getByRole('button', { name: 'Cancel' }).click();
  await expect(cal.getByText(/^Your blocks stay here/)).toHaveCount(0);
  await expect(cal.getByText('Connected. Blocks go to your Time blocks calendar.')).toBeVisible();

  // Signed out, Disconnect can't reach Google, so it says so and stays connected.
  await disconnect.click();
  await cal.getByRole('button', { name: 'Disconnect Google Calendar' }).click();
  await expect(page.locator('.toast')).toContainText('Sign in first.');
  await expect(cal.getByText('Connected. Blocks go to your Time blocks calendar.')).toBeVisible();
  expect(errors).toEqual([]);
});
