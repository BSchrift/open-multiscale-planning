import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { META, setMeta } from '../../../core/db';
import { CALENDAR_ID, getSettings, listRecords, updateSettings } from '../../../core/records';
import type { Writer } from '../../../core/records';
import type { AppSync } from '../../../core/syncRunner';
import type { UpdateStatus, Updater } from '../../../core/updates';
import { configureRetention } from '../../../core/retention';
import { renderApp, renderScreen } from '../../app/testing';
import type { Harness } from '../../app/testing';
import { moreLine } from './moreLine';
import { describePeriod } from './Retention';
import { parsePeriod } from '../../../../../config/retention';
import { noFiles } from '../../../core/sync-testing';

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
      for (const name of ['Account', 'Available hours', 'Planning cadence', 'Google Calendar', 'Away dates', 'Reminders', 'Appearance', 'Data retention']) {
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

  describe('available hours', () => {
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
  function fakeUpdater(initial: UpdateStatus, more: { download?: string } = {}) {
    let status = initial;
    const listeners = new Set<() => void>();
    const updater = {
      version: '0.1.0-aaaaaaa',
      ...more,
      status: () => status,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      check: vi.fn(async () => {
        status = { state: 'current' };
        listeners.forEach((l) => l());
        return status;
      }),
      apply: vi.fn(async () => undefined),
      rolledBack: vi.fn(async () => null),
      stop: vi.fn(),
    } satisfies Updater;
    return updater;
  }

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

  it('offers to restart into a downloaded update', async () => {
    const updates = fakeUpdater({ state: 'ready', version: '0.2.0-bbbbbbb', build: 200 });
    await renderScreen('settings', { updates });
    expect(await within(section('Updates')).findByText('Version 0.2.0-bbbbbbb is ready. It starts the next time the app opens.')).toBeVisible();
    await userEvent.click(within(section('Updates')).getByRole('button', { name: 'Restart now' }));
    expect(updates.apply).toHaveBeenCalled();
  });

  it('links to the new app when an update needs it', async () => {
    const updates = fakeUpdater({ state: 'needs-app', version: '0.2.0-bbbbbbb', build: 200 }, { download: 'https://downloads.example.test/Multiscale.dmg' });
    const t = await renderScreen('settings', { updates });
    expect(await within(section('Updates')).findByText('Version 0.2.0-bbbbbbb needs a new version of the app.')).toBeVisible();
    await userEvent.click(within(section('Updates')).getByRole('button', { name: 'Download the app' }));
    expect(t.platform.opened).toEqual(['https://downloads.example.test/Multiscale.dmg']);
  });

  it('says when checking failed, with no download offered on iPhone', async () => {
    await renderScreen('settings', { updates: fakeUpdater({ state: 'failed', failure: 'fetch' }) });
    expect(await within(section('Updates')).findByText("Couldn't check for updates. It tries again later.")).toBeVisible();
    cleanup();
    await renderScreen('settings', { updates: fakeUpdater({ state: 'needs-app', version: '0.2.0-bbbbbbb', build: 200 }) });
    await within(section('Updates')).findByText('Version 0.2.0-bbbbbbb needs a new version of the app.');
    expect(within(section('Updates')).queryByRole('button', { name: 'Download the app' })).toBeNull();
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
