import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { addDays, localDate, localToInstant, weekStart } from '../../src/core/dates';
import { go, pane } from '../seed';
import { closeDevices, device, NETWORK, signIn } from './devices';
import { target } from './target';

// Google Calendar from Settings, through the local stack's Google stand-in, which a test can act on as the person in
// Google: Connect opens Google's consent in a tab of its own, Refresh reads the person's calendars, a calendar that
// blocks time takes it from planning until it's set to Ignore, and Disconnect asks first, then removes the app's
// calendar from Google. The server's side of each is in backend/integration/calendar_test.go.

const t = target();
const ZONE = 'America/Chicago';
test.use({ baseURL: `http://localhost:${process.env.STACK_WEB_PORT}` });
test.afterEach(closeDevices);

/** The stand-in's own controls, as the person in Google. */
async function google(path: string, body?: unknown) {
  const res = await fetch(`${t.localApi}/google/_test${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  expect(res.ok, `${path}: ${res.status}`).toBe(true);
  return res.status === 204 ? null : ((await res.json()) as { calendars: { id: string; summary: string }[] });
}

test('connecting Google Calendar reads its calendars, whose events take time from planning until ignored, and disconnecting asks first', async ({ browser }) => {
  test.skip(!t.localApi, 'needs: the local Google stand-in');
  const run = randomUUID().slice(0, 8);
  const home = `Home ${run}`;
  const homeId = `home-${run}@example.test`;
  // Noon to 2pm on next week's Wednesday, inside the default available hours.
  const wednesday = addDays(weekStart(localDate(Date.now(), ZONE)), 9);
  await google('/calendars', { id: homeId, summary: home });
  await google(`/calendars/${encodeURIComponent(homeId)}/events`, {
    summary: 'Team lunch',
    start: { dateTime: localToInstant(wednesday, 12 * 60, ZONE) },
    end: { dateTime: localToInstant(wednesday, 14 * 60, ZONE) },
  });
  const timeBlocks = async () => (await google('/calendars'))!.calendars.filter((c) => c.summary === 'Time blocks').map((c) => c.id);
  const before = await timeBlocks();

  const a = await device(browser, `e2e-${run}`, { timezoneId: ZONE });
  await signIn(a.page);
  const settings = pane(a.page, 'Settings');
  const calendar = settings.getByRole('region', { name: 'Google Calendar' });
  const hours = settings.getByRole('region', { name: 'Available hours' });
  await expect(calendar.getByText('Not connected.')).toBeVisible();

  // Google's consent opens in a tab of its own, as sign-in does. The stand-in agrees at once, and the server says so there.
  const opened = a.page.waitForEvent('popup');
  await calendar.getByRole('button', { name: 'Connect' }).click();
  const consent = await opened;
  await expect(consent.getByText('Calendar connected. You can close this window.')).toBeVisible(NETWORK);
  await consent.close();
  await expect(calendar.getByText('Connected. Blocks go to your Time blocks calendar.')).toBeVisible(NETWORK);
  // The app's own calendar, made in Google for this person.
  await expect.poll(async () => (await timeBlocks()).length).toBe(before.length + 1);

  await calendar.getByRole('button', { name: 'Refresh' }).click();
  const mode = calendar.getByRole('combobox', { name: home });
  await expect(mode).toHaveValue('block', NETWORK);
  await expect(hours.getByText(/, before 2h of calendar busy time next week\.$/)).toBeVisible();
  await go(a.page, 'Week', 'This week');
  await pane(a.page, 'Week').getByRole('button', { name: 'Next week' }).click();
  await expect(pane(a.page, 'Week').getByRole('heading', { name: 'Next week', level: 1 })).toBeVisible();
  await expect(pane(a.page, 'Week').getByText('Team lunch')).toBeVisible();

  // Ignored, it's in neither the hours nor the Week.
  await go(a.page, 'Settings');
  await mode.selectOption('ignore');
  await expect(hours.getByText(/busy time/)).toHaveCount(0);
  await go(a.page, 'Week', 'Next week');
  await expect(pane(a.page, 'Week').getByText('Team lunch')).toHaveCount(0);

  // Disconnect asks first, and Cancel keeps the connection.
  await go(a.page, 'Settings');
  await calendar.getByRole('button', { name: 'Disconnect' }).click();
  await expect(calendar.getByText('Your blocks stay here, and the Time blocks calendar is removed from Google.', { exact: false })).toBeVisible();
  await calendar.getByRole('button', { name: 'Cancel' }).click();
  await expect(calendar.getByRole('button', { name: 'Disconnect Google Calendar' })).toHaveCount(0);
  await expect(calendar.getByText('Connected. Blocks go to your Time blocks calendar.')).toBeVisible();
  await calendar.getByRole('button', { name: 'Disconnect' }).click();
  await calendar.getByRole('button', { name: 'Disconnect Google Calendar' }).click();
  await expect(calendar.getByText('Not connected.')).toBeVisible(NETWORK);
  expect((await timeBlocks()).sort()).toEqual([...before].sort());

  expect(a.errors).toEqual([]);
  await google(`/calendars/${encodeURIComponent(homeId)}/delete`, {});
});
