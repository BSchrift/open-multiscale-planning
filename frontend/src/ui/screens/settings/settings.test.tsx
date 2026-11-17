import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { META, setMeta } from '../../../core/db';
import { CALENDAR_ID, getSettings, listRecords, updateSettings } from '../../../core/records';
import type { Writer } from '../../../core/records';
import type { AppSync } from '../../../core/syncRunner';
import { configureRetention } from '../../../core/retention';
import { fakeUpdater, renderApp, renderScreen } from '../../app/testing';
import type { UpdateStatus } from '../../../core/updates';
import type { Harness } from '../../app/testing';
import { moreLine } from './moreLine';
import { describePeriod } from './Retention';
import { parsePeriod } from '../../../../../config/retention';
import { noFiles } from '../../../core/sync-testing';
import { diagnosticLog } from '../../../core/diagnosticLog';

afterEach(cleanup);

function fakeSync() {
  return {
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    syncNow: vi.fn(async () => undefined),
    connectCalendar: vi.fn(async () => undefined),
    refreshCalendar: vi.fn(async () => undefined),
    disconnectCalendar: vi.fn(async () => undefined),
    stop: vi.fn(),
    email: vi.fn(async () => null),
    eraseAndSignIn: vi.fn(async () => undefined),
    files: noFiles(),
  } satisfies AppSync;
}

async function syncState(t: Harness, at: string | null, error: string | null) {
  await act(async () => {
    if (at) await setMeta(t.db, META.lastSyncAt, at);
    if (error) await setMeta(t.db, META.lastSyncError, error);
    else await t.db.run('DELETE FROM meta WHERE key = :key', { key: META.lastSyncError });
    t.db.notifyChanged({ source: 'remote' });
  });
}

const section = (name: string) => screen.getByRole('region', { name });
const stored = (t: Harness) => getSettings(t.db);

describe('Settings', () => {
  describe.each(['desktop', 'phone'] as const)('on %s', (layout) => {
    it('shows each section', async () => {
      await renderScreen('settings', { layout });
      expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
      for (const name of ['Account', 'Unavailable hours', 'Planning cadence', 'Google Calendar', 'Away dates', 'Reminders', 'Appearance', 'Data retention', 'Diagnostics']) {
        expect(screen.getByRole('heading', { level: 2, name })).toBeVisible();
      }
    });

    it('sets the appearance for this device: System until Light or Dark is chosen', async () => {
      await renderScreen('settings', { layout });
      const group = within(await screen.findByRole('region', { name: 'Appearance' })).getByRole('group', { name: 'Appearance' });
      const option = (name: string) => within(group).getByRole('button', { name });
      expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['System', 'Light', 'Dark']);
      expect(option('System')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText(/kept on this device only/i)).toBeVisible();

      await userEvent.click(option('Dark'));
      expect(option('Dark')).toHaveAttribute('aria-pressed', 'true');
      expect(option('System')).toHaveAttribute('aria-pressed', 'false');
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');

      await userEvent.click(option('System'));
      expect(option('System')).toHaveAttribute('aria-pressed', 'true');
      expect(document.documentElement).not.toHaveAttribute('data-theme');
    });

    it('links to the source code, opening outside the app', async () => {
      await renderScreen('settings', { layout });
      const link = await screen.findByRole('link', { name: 'Source code' });
      expect(link).toHaveAttribute('href', 'https://github.com/BSchrift/open-multiscale-planning');
      expect(link).toHaveAttribute('target', '_blank');
    });
  });

  it("offers single-key shortcuts in Process on desktop, off until switched on, and keeps the choice on this device's storage", async () => {
    await renderScreen('settings');
    const keys = await screen.findByRole('checkbox', { name: 'Single-key shortcuts in Process' });
    expect(keys).not.toBeChecked();
    // Process has no number keys now: letters typed in its Add to field search.
    expect(screen.getByText(/^Keys such as S to skip and W for this week work on their own, away from a field\./)).toBeInTheDocument();
    await userEvent.click(keys);
    expect(keys).toBeChecked();
    expect(localStorage.getItem('multiscale.processKeys')).toBe('true');
    await userEvent.click(keys);
    expect(localStorage.getItem('multiscale.processKeys')).toBe('false');
  });

  it("has no keyboard setting on phone, which has no keyboard", async () => {
    await renderScreen('settings', { layout: 'phone' });
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    expect(screen.queryByRole('checkbox', { name: 'Single-key shortcuts in Process' })).toBeNull();
  });

  describe('account and sync', () => {
    it('signed out, offers Sign in', async () => {
      const sync = fakeSync();
      const t = await renderScreen('settings', { sync });
      await syncState(t, null, 'sign_in_expired');
      const account = section('Account');
      expect(await within(account).findByText('Signed out')).toBeVisible();
      expect(within(account).queryByRole('button', { name: 'Sync now' })).toBeNull();
      await userEvent.click(within(account).getByRole('button', { name: 'Sign in' }));
      expect(sync.signIn).toHaveBeenCalledOnce();
    });

    it('signed in, shows the last sync, Sync now and Sign out', async () => {
      const sync = fakeSync();
      const t = await renderScreen('settings', { sync });
      await syncState(t, '2026-11-02T19:30:00Z', null);
      const account = section('Account');
      expect(await within(account).findByText('Synced')).toBeVisible();
      expect(within(account).getByText('Last synced 1:30pm')).toBeVisible();
      await userEvent.click(within(account).getByRole('button', { name: 'Sync now' }));
      expect(sync.syncNow).toHaveBeenCalledOnce();
      await userEvent.click(within(account).getByRole('button', { name: 'Sign out' }));
      expect(sync.signOut).toHaveBeenCalledOnce();
    });

    it('a sync on another day shows its date', async () => {
      const t = await renderScreen('settings', { sync: fakeSync() });
      await syncState(t, '2026-10-30T15:00:00Z', null);
      expect(await within(section('Account')).findByText('Last synced Oct 30, 10am')).toBeVisible();
    });

    it.each([
      ['offline', 'Offline', /kept/],
      ['clock_ahead', 'Not synced', /clock is ahead/],
      ['other_account', 'Not synced', /another account\. Erase it to sign in, or sign out to keep it\./],
      ['too_large', 'Partly synced', /too long to sync/],
      ['error', 'Not synced', /try again/i],
      ['sign_in_failed', 'Signed out', /didn't finish/],
    ])('explains %s calmly, keeping the last sync time', async (code, pill, line) => {
      const t = await renderScreen('settings', { sync: fakeSync() });
      await syncState(t, '2026-11-02T19:30:00Z', code);
      const account = section('Account');
      expect(await within(account).findByText(pill)).toBeVisible();
      expect(within(account).getByText(line)).toBeVisible();
      expect(within(account).getByText('Last synced 1:30pm')).toBeVisible();
    });
  });

  describe('unavailable hours', () => {
    const rows = () => screen.getAllByRole('group', { name: /^Unavailable, / });

    it('starts with 10pm to 7am every day, and sums the week', async () => {
      await renderScreen('settings');
      await waitFor(() => expect(rows()).toHaveLength(1));
      expect(rows()[0]).toHaveAccessibleName('Unavailable, 10pm to 7am');
      expect(within(rows()[0]!).getByRole('combobox', { name: 'Days' })).toHaveValue('all');
      expect(screen.getByText('105h a week for projects and 105h for one offs.')).toBeVisible();
    });

    it('counts next week’s busy calendar time', async () => {
      await renderScreen('settings', {
        seed: async (w) => {
          await w.create('calendar_source', { google_id: 'cal-a', name: 'Work', mode: 'block' });
          await w.create('calendar_source', { google_id: 'cal-b', name: 'Family', mode: 'info' });
          await w.create(
            'calendar',
            {
              connected: true,
              events: [
                { id: 'e1', calendar: 'cal-a', title: 'Team meeting', start: '2026-11-10T21:00:00Z', end: '2026-11-10T23:00:00Z' },
                { id: 'e2', calendar: 'cal-b', title: 'Dinner out', start: '2026-11-11T21:00:00Z', end: '2026-11-11T23:00:00Z' },
              ],
            },
            CALENDAR_ID,
          );
        },
      });
      expect(await screen.findByText('105h a week for projects and 105h for one offs, before 2h of calendar busy time next week.')).toBeVisible();
    });

    it('sliders set a block’s hours', async () => {
      const t = await renderScreen('settings');
      await waitFor(() => expect(rows()).toHaveLength(1));
      fireEvent.change(within(rows()[0]!).getByRole('slider', { name: 'From' }), { target: { value: '1380' } });
      fireEvent.change(within(rows()[0]!).getByRole('slider', { name: 'To' }), { target: { value: '300' } });
      await waitFor(() => expect(rows()[0]).toHaveAccessibleName('Unavailable, 11pm to 5am'));
      expect(within(rows()[0]!).getByRole('slider', { name: 'From' })).toHaveAttribute('aria-valuetext', '11pm');
      expect((await stored(t)).availability).toEqual([{ days: 'all', from: 1380, to: 300, projects: true, one_offs: true }]);
    });

    it('one track holds both ends, with time labels, and shades a window that passes midnight at both ends of the day', async () => {
      await renderScreen('settings');
      await waitFor(() => expect(rows()).toHaveLength(1));
      const hours = () => within(rows()[0]!).getByRole('group', { name: 'Hours' });
      expect(within(hours()).getAllByRole('slider').map((s) => s.getAttribute('aria-label'))).toEqual(['From', 'To']);
      for (const tick of ['12am', '6am', '12pm', '6pm']) expect(within(hours()).getByText(tick)).toBeVisible();
      // 10pm to 7am runs to the end of the day and on from its start.
      expect(hours().querySelectorAll('.timewindow')).toHaveLength(2);
      fireEvent.change(within(hours()).getByRole('slider', { name: 'From' }), { target: { value: '60' } });
      await waitFor(() => expect(rows()[0]).toHaveAccessibleName('Unavailable, 1am to 7am'));
      expect(hours().querySelectorAll('.timewindow')).toHaveLength(1);
    });

    it('each type of work has its own hours', async () => {
      const t = await renderScreen('settings');
      await waitFor(() => expect(rows()).toHaveLength(1));
      await userEvent.click(within(rows()[0]!).getByRole('checkbox', { name: 'One offs' }));
      expect(await screen.findByText('105h a week for projects and 168h for one offs.')).toBeVisible();
      expect((await stored(t)).availability[0]).toMatchObject({ projects: true, one_offs: false });
    });

    it.each(['desktop', 'phone'] as const)('on %s, the ticks sit under Closed to, since a tick closes that time to its kind', async (layout) => {
      const t = await renderScreen('settings', { layout });
      await waitFor(() => expect(rows()).toHaveLength(1));
      const closed = within(rows()[0]!).getByRole('group', { name: 'Closed to' });
      const boxes = within(closed).getAllByRole('checkbox') as HTMLInputElement[];
      expect(boxes.map((c) => [c.labels?.[0]?.textContent, c.checked])).toEqual([
        ['Projects', true],
        ['One offs', true],
      ]);
      // Ticked, 10pm to 7am is closed to projects: 168h less 63h. Unticked, projects may use it.
      expect(screen.getByText('105h a week for projects and 105h for one offs.')).toBeVisible();
      await userEvent.click(within(closed).getByRole('checkbox', { name: 'Projects' }));
      expect(await screen.findByText('168h a week for projects and 105h for one offs.')).toBeVisible();
      expect((await stored(t)).availability[0]).toMatchObject({ projects: false, one_offs: true });
    });

    it('adds a block, with its own days, and removes it', async () => {
      const t = await renderScreen('settings');
      await userEvent.click(await screen.findByRole('button', { name: 'Add unavailable time' }));
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(rows()[1]).toHaveAccessibleName('Unavailable, 12pm to 1pm');
      await userEvent.selectOptions(within(rows()[1]!).getByRole('combobox', { name: 'Days' }), 'weekends');
      await waitFor(async () => expect((await stored(t)).availability[1]).toMatchObject({ days: 'weekends', from: 720, to: 780 }));
      await userEvent.click(within(rows()[1]!).getByRole('button', { name: 'Remove 12pm to 1pm' }));
      await waitFor(() => expect(rows()).toHaveLength(1));
      expect((await stored(t)).availability).toHaveLength(1);
    });

    it('says what a remove took away, and Undo puts that time back as it was, in its place', async () => {
      const t = await renderScreen('settings', {
        seed: (w) =>
          updateSettings(w, {
            availability: [
              { days: 'all', from: 1320, to: 420, projects: true, one_offs: true },
              { days: 'weekends', from: 720, to: 780, projects: true, one_offs: false },
              { days: 'weekdays', from: 1020, to: 1080, projects: false, one_offs: true },
            ],
          }),
      });
      await waitFor(() => expect(rows()).toHaveLength(3));
      const before = (await stored(t)).availability;
      await userEvent.click(within(rows()[1]!).getByRole('button', { name: 'Remove 12pm to 1pm' }));
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect((await stored(t)).availability).toEqual([before[0], before[2]]);
      expect(screen.getByText('Removed unavailable time 12pm to 1pm.')).toBeVisible();
      // The Remove button went with its row, so focus goes to Undo.
      const undo = screen.getByRole('button', { name: 'Undo' });
      expect(undo).toHaveFocus();
      await userEvent.click(undo);
      await waitFor(() => expect(rows()).toHaveLength(3));
      expect(rows()[1]).toHaveAccessibleName('Unavailable, 12pm to 1pm');
      expect((await stored(t)).availability).toEqual(before);
    });

    it('the one offs aim is a slider, all the way left is no aim', async () => {
      const t = await renderScreen('settings');
      const aim = await screen.findByRole('slider', { name: 'Weekly one offs aim' });
      expect(aim).toHaveAttribute('aria-valuetext', 'No aim');
      fireEvent.change(aim, { target: { value: '13' } });
      await waitFor(async () => expect((await stored(t)).one_offs_weekly_aim).toBe(300));
      expect(aim).toHaveAttribute('aria-valuetext', '5h');
    });
  });

  describe('planning cadence', () => {
    it('shows the cadence and opens the Plan page to change it', async () => {
      const t = await renderScreen('settings', { layout: 'phone' });
      act(() => t.nav().go('settings'));
      expect(within(await screen.findByRole('region', { name: 'Planning cadence' })).getByText('Calendar quarters')).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Change planning cadence' }));
      await waitFor(() => expect(t.nav().route).toMatchObject({ area: 'plan', params: { cadence: 'edit' } }));
      expect(t.nav().backLabel).toBe('Settings');
    });

    it('with none, says so', async () => {
      await renderScreen('settings', { seed: (w) => updateSettings(w, { plan_cadence: null }) });
      expect(within(await screen.findByRole('region', { name: 'Planning cadence' })).getByText('Not set')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Set your planning cadence' })).toBeVisible();
    });

    it('has no cadence controls of its own', async () => {
      await renderScreen('settings');
      const cadence = await screen.findByRole('region', { name: 'Planning cadence' });
      expect(within(cadence).queryByRole('combobox')).toBeNull();
      expect(within(cadence).queryByRole('spinbutton')).toBeNull();
    });
  });

  describe('Google Calendar', () => {
    it('not connected, offers Connect', async () => {
      const sync = fakeSync();
      await renderScreen('settings', { sync });
      const cal = await screen.findByRole('region', { name: 'Google Calendar' });
      expect(within(cal).getByText('Not connected.')).toBeVisible();
      await userEvent.click(within(cal).getByRole('button', { name: 'Connect' }));
      expect(sync.connectCalendar).toHaveBeenCalledOnce();
    });

    const connected = async (w: Writer) => {
      await w.create('calendar', { connected: true, synced_at: '2026-11-02T19:58:00Z' }, CALENDAR_ID);
      await w.create('calendar_source', { google_id: 'cal-b', name: 'Work', mode: 'block' });
      await w.create('calendar_source', { google_id: 'cal-a', name: 'Family', mode: 'info' });
    };

    it('connected, lists calendars by name with their modes, and refreshes', async () => {
      const sync = fakeSync();
      const t = await renderScreen('settings', { sync, seed: connected });
      const cal = await screen.findByRole('region', { name: 'Google Calendar' });
      expect(await within(cal).findByText('Connected. Blocks go to your Time blocks calendar.')).toBeVisible();
      expect(within(cal).getByText('Last pushed 1:58pm')).toBeVisible();
      const selects = within(cal).getAllByRole('combobox');
      expect(selects.map((s) => (s as HTMLSelectElement).labels[0]?.textContent)).toEqual(['Family', 'Work']);
      expect(within(cal).getByRole('combobox', { name: 'Work' })).toHaveValue('block');
      await userEvent.selectOptions(within(cal).getByRole('combobox', { name: 'Work' }), 'ignore');
      await waitFor(async () => expect((await listRecords(t.db, 'calendar_source')).find((s) => s.name === 'Work')?.mode).toBe('ignore'));
      await userEvent.click(within(cal).getByRole('button', { name: 'Refresh' }));
      expect(sync.refreshCalendar).toHaveBeenCalledOnce();
    });

    it('a failed refresh says so without losing anything', async () => {
      const sync = fakeSync();
      sync.refreshCalendar.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'offline' }));
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await renderScreen('settings', { sync, seed: connected });
      await userEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
      expect(await screen.findByText(/Couldn't reach the server/)).toBeVisible();
      log.mockRestore();
    });

    it('Disconnect asks first, and Cancel keeps the connection', async () => {
      const sync = fakeSync();
      await renderScreen('settings', { sync, seed: connected });
      const cal = await screen.findByRole('region', { name: 'Google Calendar' });
      await userEvent.click(await within(cal).findByRole('button', { name: 'Disconnect' }));
      expect(within(cal).getByText(/Time blocks calendar is removed from Google/)).toBeVisible();
      await userEvent.click(within(cal).getByRole('button', { name: 'Cancel' }));
      expect(sync.disconnectCalendar).not.toHaveBeenCalled();
      await userEvent.click(within(cal).getByRole('button', { name: 'Disconnect' }));
      await userEvent.click(within(cal).getByRole('button', { name: 'Disconnect Google Calendar' }));
      expect(sync.disconnectCalendar).toHaveBeenCalledOnce();
    });

    it('hides the calendars list once disconnected', async () => {
      await renderScreen('settings', {
        sync: fakeSync(),
        seed: async (w) => {
          await connected(w);
          await w.set('calendar', CALENDAR_ID, { connected: false });
        },
      });
      expect(await screen.findByText('Not connected.')).toBeVisible();
      expect(screen.queryByRole('combobox', { name: 'Work' })).toBeNull();
    });

    it('shows the calendar’s own error', async () => {
      await renderScreen('settings', {
        sync: fakeSync(),
        seed: (w) => w.create('calendar', { connected: false, last_error: 'calendar_revoked' }, CALENDAR_ID),
      });
      expect(await screen.findByText('Google access was removed. Connect again.')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Connect' })).toBeVisible();
    });
  });

  describe('away dates', () => {
    it('needs both dates, in order; adds, clears and removes', async () => {
      const t = await renderScreen('settings');
      const away = await screen.findByRole('region', { name: 'Away dates' });
      const from = within(away).getByLabelText('From');
      const to = within(away).getByLabelText(/^to$/i);
      await userEvent.click(within(away).getByRole('button', { name: 'Add' }));
      expect(await screen.findByText('Choose a start and an end date')).toBeVisible();
      fireEvent.change(from, { target: { value: '2026-12-20' } });
      fireEvent.change(to, { target: { value: '2026-12-10' } });
      await userEvent.click(within(away).getByRole('button', { name: 'Add' }));
      expect(await listRecords(t.db, 'away_period')).toHaveLength(0);
      fireEvent.change(to, { target: { value: '2026-12-28' } });
      await userEvent.click(within(away).getByRole('button', { name: 'Add' }));
      expect(await within(away).findByText('Dec 20 to Dec 28')).toBeVisible();
      expect(from).toHaveValue('');
      expect(to).toHaveValue('');
      expect(await listRecords(t.db, 'away_period')).toMatchObject([{ start: '2026-12-20', end: '2026-12-28' }]);
      await userEvent.click(within(away).getByRole('button', { name: 'Remove Dec 20 to Dec 28' }));
      await waitFor(() => expect(within(away).queryByText('Dec 20 to Dec 28')).toBeNull());
      expect(await listRecords(t.db, 'away_period')).toHaveLength(0);
      expect(screen.getByText('Removed away dates Dec 20 to Dec 28.')).toBeVisible();
      // Remove has gone with its row, so focus goes to Undo rather than the page.
      expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(await within(away).findByText('Dec 20 to Dec 28')).toBeVisible();
      expect(await listRecords(t.db, 'away_period')).toMatchObject([{ start: '2026-12-20', end: '2026-12-28' }]);
    });

    it('leaves out away dates that have passed', async () => {
      await renderScreen('settings', {
        seed: async (w) => {
          await w.create('away_period', { start: '2026-10-01', end: '2026-10-05' });
          await w.create('away_period', { start: '2026-11-01', end: '2026-11-03' });
        },
      });
      const away = await screen.findByRole('region', { name: 'Away dates' });
      expect(await within(away).findByText('Nov 1 to Nov 3')).toBeVisible();
      expect(within(away).queryByText('Oct 1 to Oct 5')).toBeNull();
    });
  });

  describe('reminders', () => {
    it('switch off, and the check-in delay is a slider', async () => {
      const t = await renderScreen('settings');
      const rem = await screen.findByRole('region', { name: 'Reminders' });
      await userEvent.click(within(rem).getByRole('checkbox', { name: 'Notify at block start' }));
      await userEvent.click(within(rem).getByRole('checkbox', { name: 'Ask at block end' }));
      const delay = within(rem).getByRole('slider', { name: 'After' });
      expect(delay).toHaveAttribute('aria-valuetext', '5 minutes');
      expect(within(rem).getByText('A paused block also gets one reminder after 30 minutes.')).toBeVisible();
      fireEvent.change(delay, { target: { value: '15' } });
      await waitFor(() => expect(within(rem).getByRole('slider', { name: 'After' })).toHaveAttribute('aria-valuetext', '15 minutes'));
      await userEvent.click(within(rem).getByRole('checkbox', { name: "Ask if I've started, unless I already tapped Start" }));
      await waitFor(() => expect(within(rem).queryByRole('slider', { name: 'After' })).toBeNull());
      expect((await stored(t)).reminders).toEqual({ block_start: false, check_in: false, check_in_delay_min: 15, block_end: false });
    });

    it("has a switch for the weekly reminder about next week's planning, on until switched off, kept when another changes", async () => {
      const t = await renderScreen('settings');
      const rem = await screen.findByRole('region', { name: 'Reminders' });
      const weekly = within(rem).getByRole('checkbox', { name: "Remind me when next week's planning has no time" });
      expect(weekly).toBeChecked();
      await userEvent.click(weekly);
      await waitFor(async () => expect((await stored(t)).reminders?.planning).toBe(false));
      await userEvent.click(within(rem).getByRole('checkbox', { name: 'Ask at block end' }));
      await waitFor(async () => expect((await stored(t)).reminders).toMatchObject({ block_end: false, planning: false }));
      expect(within(rem).getByRole('checkbox', { name: "Remind me when next week's planning has no time" })).not.toBeChecked();
    });
  });

  describe('More line', () => {
    it('reads the week’s project hours and the one offs aim', async () => {
      const t = await renderScreen('settings');
      expect(await moreLine(t.db, t.clock)).toBe('105h a week for projects, no One offs aim');
      await t.write((w) => updateSettings(w, { one_offs_weekly_aim: 180 }));
      expect(await moreLine(t.db, t.clock)).toBe('105h a week for projects, 3h One offs aim');
    });
  });
});

describe('Settings updates', () => {
  const DMG = 'https://downloads.example.test/Multiscale.dmg';

  it("isn't there where nothing publishes updates", async () => {
    await renderScreen('settings');
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    expect(screen.queryByRole('region', { name: 'Updates' })).toBeNull();
  });

  it('shows the version, and checks on request', async () => {
    const updates = fakeUpdater({ state: 'idle' });
    await renderScreen('settings', { updates });
    expect(await within(section('Updates')).findByText('Version 0.1.0-aaaaaaa')).toBeVisible();
    await userEvent.click(within(section('Updates')).getByRole('button', { name: 'Check for updates' }));
    expect(updates.check).toHaveBeenCalled();
    expect(await within(section('Updates')).findByText('Up to date.')).toBeVisible();
  });

  // One gesture, one name: Restart to update, as a Mac app update will say too.
  it('offers to restart into a downloaded update', async () => {
    const updates = fakeUpdater({ state: 'ready', version: '0.2.0-bbbbbbb', build: 200 });
    await renderScreen('settings', { updates });
    expect(await within(section('Updates')).findByText('An update is ready. It starts the next time Multiscale opens.')).toBeVisible();
    await userEvent.click(within(section('Updates')).getByRole('button', { name: 'Restart to update' }));
    expect(updates.apply).toHaveBeenCalled();
  });

  it('on the Mac, says an update needs the new Mac app, and How to update gives the steps and the download', async () => {
    const updates = fakeUpdater({ state: 'needs-app', version: '0.2.0-bbbbbbb', build: 200 }, { download: DMG });
    const t = await renderScreen('settings', { updates });
    expect(await within(section('Updates')).findByText("This update needs the new Mac app. It's the last one you install by hand.")).toBeVisible();
    // No version outside the Version row, and the download is in the steps.
    expect(within(section('Updates')).queryByText(/0\.2\.0-bbbbbbb/)).toBeNull();
    expect(within(section('Updates')).queryByRole('button', { name: 'Download the app' })).toBeNull();
    const how = within(section('Updates')).getByRole('button', { name: 'How to update' });
    await userEvent.click(how);
    const dialog = screen.getByRole('dialog', { name: 'Install the new Mac app' });
    expect(within(dialog).getByText("This is the last time you install Multiscale by hand. Your plans stay as they are: they're saved on this Mac and synced.")).toBeVisible();
    expect(within(dialog).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Download the app, below.',
      'Quit Multiscale: click its icon in the menu bar, then Quit.',
      'Open Multiscale.dmg from Downloads and drag Multiscale to Applications. Choose Replace.',
      'Open Multiscale from Applications, then eject the disk image.',
    ]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Download the app' }));
    expect(t.platform.opened).toEqual([DMG]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(how).toHaveFocus();
  });

  it('says when checking failed, with no download offered on iPhone', async () => {
    await renderScreen('settings', { updates: fakeUpdater({ state: 'failed', failure: 'fetch' }) });
    expect(await within(section('Updates')).findByText("Couldn't check for updates. It tries again later.")).toBeVisible();
    cleanup();
    await renderScreen('settings', { updates: fakeUpdater({ state: 'needs-app', version: '0.2.0-bbbbbbb', build: 200 }) });
    await within(section('Updates')).findByText('Version 0.2.0-bbbbbbb needs a new version of the app.');
    expect(within(section('Updates')).queryByRole('button', { name: 'Download the app' })).toBeNull();
    expect(within(section('Updates')).queryByRole('button', { name: 'How to update' })).toBeNull();
  });
});

// The Mac app that replaces itself: each state's copy and buttons, exactly, and where Check for updates shows.
describe('Settings updates on a Mac app that updates itself', () => {
  const DMG = 'https://downloads.example.test/Multiscale.dmg';
  const VERSIONED = 'https://downloads.example.test/mac/0.1.200/Multiscale.dmg';
  const named = { version: '0.2.0-bbbbbbb', build: 200, dmg: VERSIONED };
  const HOW = 'App built Nov 3, 2025. Updates download by themselves and install when Multiscale quits or your Mac restarts.';
  const render = (status: UpdateStatus, app: NonNullable<Parameters<typeof fakeUpdater>[1]>['app'] = {}) => {
    const updates = fakeUpdater(status, { download: DMG, app: { built: 1762160000, ...app } });
    return { updates, t: renderScreen('settings', { updates }) };
  };
  const card = () => section('Updates');
  const buttons = () => within(card()).queryAllByRole('button').map((b) => b.textContent);

  it.each([
    ['up to date', { state: 'current' }, {}, ['Up to date.', HOW], ['Check for updates']],
    ['downloading', { state: 'app-downloading', ...named, percent: 42 }, {}, ['Downloading an update… 42%', HOW], []],
    ['ready', { state: 'app-ready', ...named }, {}, ['An update is ready. It installs the next time Multiscale quits or your Mac restarts.', 'Multiscale closes and opens again in a few seconds.'], ['Restart to update']],
    ['from the disk image', { state: 'current' }, { place: { kind: 'disk-image' } }, ["Multiscale is running from the disk image, so it can't update itself or open when you log in."], ['Move to Applications', 'Check for updates']],
    ['from the disk image, with an update waiting', { state: 'failed', failure: 'read-only', place: 'disk-image', ...named }, { place: { kind: 'disk-image' } }, ["Multiscale can't update itself while it runs from the disk image."], ['Move to Applications', 'Check for updates']],
    ['from a temporary copy', { state: 'failed', failure: 'read-only', place: 'translocated', ...named }, { place: { kind: 'translocated' } }, ["Multiscale can't update itself from where it's running."], ['Move to Applications', 'Check for updates']],
    ['with an administrator', { state: 'failed', failure: 'needs-admin', ...named }, { place: { kind: 'needs-admin' } }, ["Updating Multiscale needs an administrator's password. Update the app asks macOS for it, then restarts Multiscale."], ['Update the app', 'Download the app']],
    ['after a failed download', { state: 'failed', failure: 'app-download', failures: 1, ...named }, {}, ["Couldn't download the update. It tries again later.", HOW], ['Check for updates']],
    ['after three failed downloads', { state: 'failed', failure: 'app-download', failures: 3, ...named }, {}, ["Couldn't download the update. It tries again later.", HOW], ['Download the app', 'Check for updates']],
    ['out of space', { state: 'failed', failure: 'app-space', ...named }, {}, ["Couldn't download the update: this Mac is out of space. It tries again later.", HOW], ['Check for updates']],
    ["when it didn't check out", { state: 'failed', failure: 'app-signature', ...named }, {}, ["The update didn't pass its safety check, so it wasn't installed. It tries again with the next update.", HOW], ['Download the app', 'Check for updates']],
    ["when it didn't install", { state: 'failed', failure: 'app-install', ...named }, {}, ["The update didn't install. It tries again the next time Multiscale quits.", HOW], ['Restart to update', 'Download the app']],
    ['on an older app', { state: 'failed', failure: 'older-app', ...named }, { place: { kind: 'older' } }, ["You're using an older version of the app. It stays on this version until you choose Update the app."], ['Update the app', 'Check for updates']],
  ] as [string, UpdateStatus, object, string[], string[]][])('says what is happening %s, with only the buttons that can do something', async (_, status, app, lines, expected) => {
    await render(status, app).t;
    // The first is the line shown; a failure or a ready update is also said once in the status region.
    for (const line of lines) expect((await within(card()).findAllByText(line))[0]).toBeVisible();
    if (!lines.includes(HOW)) expect(within(card()).queryByText(HOW)).toBeNull();
    // No version but in the Version row.
    expect(within(card()).queryByText(/0\.2\.0-bbbbbbb|0\.1\.200/)).toBeNull();
    expect(buttons()).toEqual(expected);
  });

  it('names the download bar, with its value, and never reads the percentage out', async () => {
    await render({ state: 'app-downloading', ...named, percent: 42 }).t;
    const bar = within(card()).getByRole('progressbar', { name: 'Downloading an update' });
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(within(card()).getByText('Downloading an update… 42%').closest('[aria-live],[role=status]')).toBeNull();
  });

  it('restarts to update, saying so on the button, and offers the versioned disk image', async () => {
    const { updates, t } = render({ state: 'app-ready', ...named });
    await t;
    await userEvent.click(within(card()).getByRole('button', { name: 'Restart to update' }));
    expect(updates.app!.restart).toHaveBeenCalled();
    expect(within(card()).getByRole('button', { name: 'Restarting…' })).toBeDisabled();
    cleanup();
    const failed = render({ state: 'failed', failure: 'app-mismatch', ...named });
    const harness = await failed.t;
    await userEvent.click(within(card()).getByRole('button', { name: 'Download the app' }));
    expect(harness.platform.opened).toEqual([VERSIONED]);
  });

  it('moves the app to Applications, and updates the app on request', async () => {
    const moving = render({ state: 'current' }, { place: { kind: 'disk-image' } });
    await moving.t;
    await userEvent.click(within(card()).getByRole('button', { name: 'Move to Applications' }));
    expect(moving.updates.app!.move).toHaveBeenCalled();
    cleanup();
    const older = render({ state: 'failed', failure: 'older-app', ...named }, { place: { kind: 'older' } });
    await older.t;
    await userEvent.click(within(card()).getByRole('button', { name: 'Update the app' }));
    expect(older.updates.app!.install).toHaveBeenCalled();
  });

  it('says once when an update is ready or fails, in a region that stays', async () => {
    const { updates, t } = render({ state: 'app-downloading', ...named, percent: 10 });
    await t;
    const region = within(card()).getByRole('status');
    expect(region).toHaveTextContent('');
    act(() => void updates.set({ state: 'app-ready', ...named }));
    expect(region).toHaveTextContent('An update is ready. It installs the next time Multiscale quits or your Mac restarts.');
  });
});

describe('Capture shortcut', () => {
  const native = (taken: string[] = []) => {
    let accelerator = 'Shift+Command+Space';
    return {
      get: vi.fn(async () => ({ accelerator, registered: true })),
      set: vi.fn(async (a: string) => !taken.includes(a) && ((accelerator = a), true)),
    };
  };

  it("isn't there without a global shortcut, as in a browser", async () => {
    await renderScreen('settings');
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    expect(screen.queryByRole('region', { name: 'Capture shortcut' })).toBeNull();
  });

  it('Change listens for new keys, saves them, and the Capture button shows them', async () => {
    const shortcut = native();
    await renderScreen('settings', { captureShortcut: shortcut });
    const keys = await screen.findByRole('region', { name: 'Capture shortcut' });
    expect(within(keys).getByText('⇧⌘Space')).toBeVisible();
    await userEvent.click(within(keys).getByRole('button', { name: 'Change' }));
    const listening = within(keys).getByRole('button', { name: 'Press the new keys, or Escape' });
    expect(listening).toHaveFocus();
    // Modifiers alone are still being held.
    fireEvent.keyDown(listening, { key: 'Alt', code: 'AltLeft', ctrlKey: true, altKey: true });
    expect(shortcut.set).not.toHaveBeenCalled();
    fireEvent.keyDown(listening, { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true });
    expect(shortcut.set).toHaveBeenCalledWith('Control+Alt+K');
    expect(await within(keys).findByText('Capture opens with ⌃⌥K now.')).toBeVisible();

    await userEvent.click(within(keys).getByRole('button', { name: 'Use ⇧⌘Space' }));
    expect(await within(keys).findByText('Capture opens with ⇧⌘Space now.')).toBeVisible();
    expect(within(keys).queryByRole('button', { name: 'Use ⇧⌘Space' })).toBeNull();
  });

  it('the Capture button shows the shortcut saved', async () => {
    const shortcut = native();
    await shortcut.set('Control+Alt+K');
    await renderApp({ captureShortcut: shortcut });
    expect(await screen.findByRole('button', { name: /^Capture/ })).toHaveTextContent('⌃⌥K');
  });

  it('keys another app holds are refused and the old ones stay; Escape stops listening', async () => {
    const shortcut = native(['Shift+Command+Return']);
    await renderScreen('settings', { captureShortcut: shortcut });
    const keys = await screen.findByRole('region', { name: 'Capture shortcut' });
    await userEvent.click(within(keys).getByRole('button', { name: 'Change' }));
    fireEvent.keyDown(within(keys).getByRole('button', { name: 'Press the new keys, or Escape' }), { key: 'Enter', code: 'Enter', shiftKey: true, metaKey: true });
    expect(await within(keys).findByText('⇧⌘Return is taken by another app. Try other keys.')).toBeVisible();
    expect(within(keys).getByText('⇧⌘Space')).toBeVisible();
    await userEvent.click(within(keys).getByRole('button', { name: 'Change' }));
    await userEvent.keyboard('{Escape}');
    expect(within(keys).getByRole('button', { name: 'Change' })).toBeVisible();
  });
});

describe('Data retention', () => {
  afterEach(() => configureRetention(null));

  it.each(['desktop', 'phone'] as const)("opens from its row on %s and says what's kept and for how long, with no controls", async (layout) => {
    configureRetention({ scheduling: parsePeriod('P2Y'), closed: parsePeriod('P5Y'), deleted: parsePeriod('P30D') });
    await renderApp({ layout, initial: { area: 'settings', params: {} } });
    const row = within(await screen.findByRole('region', { name: 'Data retention' }));
    expect(row.getByText("How long your history is kept before it's removed.")).toBeVisible();
    await userEvent.click(row.getByRole('button', { name: 'Data retention' }));

    const page = within(await screen.findByRole('region', { name: 'Settings', hidden: false }));
    expect(await page.findByRole('heading', { level: 1, name: 'Data retention' })).toBeVisible();
    expect(page.getByText(/removed within a few days of each period/)).toBeVisible();
    expect(page.getByText('2 years after they end')).toBeVisible();
    expect(page.getByText('5 years after they\'re closed')).toBeVisible();
    expect(page.getByText('30 days after you delete them')).toBeVisible();
    expect(page.getByRole('heading', { level: 2, name: 'Kept until you delete it' })).toBeVisible();
    expect(page.queryAllByRole('button').filter((b) => !/^Back/.test(b.getAttribute('aria-label') ?? ''))).toEqual([]);
    expect(page.queryAllByRole('textbox')).toEqual([]);
    expect(screen.getByRole('button', { name: 'Back to Settings' })).toBeVisible();
  });

  it("shows staging's minutes as they are", async () => {
    configureRetention({ scheduling: parsePeriod('PT10M'), closed: parsePeriod('PT20M'), deleted: parsePeriod('PT5M'), cleanup: parsePeriod('PT1M') });
    await renderScreen('settings', { params: { page: 'retention' } });
    expect(await screen.findByText('10 minutes after they end')).toBeVisible();
    expect(screen.getByText('20 minutes after they\'re closed')).toBeVisible();
    expect(screen.getByText('5 minutes after you delete them')).toBeVisible();
  });

  it('describes a period in words', () => {
    expect(describePeriod(parsePeriod('P1Y'))).toBe('1 year');
    expect(describePeriod(parsePeriod('P1W'))).toBe('7 days');
    expect(describePeriod(parsePeriod('PT1H30M'))).toBe('1 hour and 30 minutes');
    expect(describePeriod(parsePeriod('P1Y2M3DT4H'))).toBe('1 year, 2 months, 3 days and 4 hours');
  });
});

describe('Diagnostics', () => {
  it.each(['desktop', 'phone'] as const)('exports the diagnostic log on %s as a file named for today, holding what the log kept and nothing anyone wrote', async (layout) => {
    const t = await renderScreen('settings', {
      layout,
      seed: async (w) => {
        await w.create('task', { kind: 'inbox', title: 'Buy milk' });
      },
    });
    diagnosticLog.add('warn', 'sync', 'Sync failed: offline');
    const row = within(await screen.findByRole('region', { name: 'Diagnostics' }));
    expect(row.getByText(/Recent errors and syncs on this device/)).toBeVisible();
    await userEvent.click(row.getByRole('button', { name: 'Export diagnostic log' }));

    await waitFor(() => expect(t.platform.saved).toHaveLength(1));
    const [{ name, text }] = t.platform.saved as [{ name: string; text: string }];
    expect(name).toBe('multiscale-diagnostics-2026-11-02.json');
    const file = JSON.parse(text);
    expect(file).toMatchObject({ file: 'multiscale-diagnostic-log', records: { task: 1 }, sync: { outbox: { byType: { task: 1 } } } });
    expect(file.entries.at(-1)).toMatchObject({ level: 'warn', source: 'sync', message: 'Sync failed: offline' });
    expect(text).not.toContain('milk');
  });

  it('downloads the file where the platform has no other way to save it, as in a browser or the Mac app', async () => {
    const t = await renderScreen('settings');
    delete (t.platform as { saveFile?: unknown }).saveFile;
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => (blobs.push(blob), 'blob:diagnostics'));
    URL.revokeObjectURL = vi.fn();
    const clicked: HTMLAnchorElement[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
    await userEvent.click(within(await screen.findByRole('region', { name: 'Diagnostics' })).getByRole('button', { name: 'Export diagnostic log' }));
    await waitFor(() => expect(clicked).toHaveLength(1));
    click.mockRestore();
    expect(clicked[0]).toMatchObject({ href: 'blob:diagnostics', download: 'multiscale-diagnostics-2026-11-02.json' });
    expect(JSON.parse(await blobs[0]!.text())).toMatchObject({ file: 'multiscale-diagnostic-log' });
  });

  it("says when the file couldn't be saved", async () => {
    const t = await renderScreen('settings');
    Object.assign(t.platform, {
      saveFile: async () => {
        throw new Error('the share sheet is not there');
      },
    });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await userEvent.click(within(await screen.findByRole('region', { name: 'Diagnostics' })).getByRole('button', { name: 'Export diagnostic log' }));
    expect(await screen.findByText("Couldn't export the diagnostic log. Try again.")).toBeVisible();
    quiet.mockRestore();
  });
});
