import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { META, setMeta } from '../../core/db';
import { listRecords } from '../../core/records';
import type { AppSync } from '../../core/syncRunner';
import { setAppearance } from './appearance';
import { renderApp } from './testing';
import type { Harness } from './testing';

afterEach(() => {
  cleanup();
  setAppearance('system');
});

function fakeSync(email: string | null = 'reader@example.com') {
  return {
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    syncNow: vi.fn(async () => undefined),
    connectCalendar: vi.fn(async () => undefined),
    refreshCalendar: vi.fn(async () => undefined),
    disconnectCalendar: vi.fn(async () => undefined),
    stop: vi.fn(),
    email: vi.fn(async () => email),
    eraseAndSignIn: vi.fn(async () => undefined),
  } satisfies AppSync;
}

/** A sign-in refused as another account's, with this many records changed here and not yet sent. */
async function signedInAsAnother(t: Harness, unsynced: number) {
  await act(async () => {
    await t.db.run('DELETE FROM outbox');
    for (let i = 1; i <= unsynced; i++) await t.write((w) => w.create('task', { kind: 'inbox', title: `Write the report, part ${i}` }));
    await setMeta(t.db, META.lastSyncError, 'other_account');
    t.db.notifyChanged({ source: 'remote' });
  });
}

const QUESTION = 'This device has data from another account. Signing in as reader@example.com erases it from this device; it stays in the other account.';
const ask = () => screen.findByRole('dialog', { name: 'Switch accounts' });

describe('switching accounts', () => {
  describe.each(['desktop', 'phone'] as const)('on %s', (layout) => {
    it('asks first, naming the account and how many changes would be lost', async () => {
      const sync = fakeSync();
      const t = await renderApp({ layout, sync });
      await signedInAsAnother(t, 2);
      const dialog = await ask();
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(within(dialog).getByText(QUESTION)).toBeVisible();
      expect(within(dialog).getByText("2 changes haven't synced and will be lost.")).toBeVisible();
      // The dialog itself has focus, so Enter can't erase by accident, and the warning is read out with its name.
      expect(dialog).toHaveFocus();
      expect(dialog).toHaveAccessibleDescription(`${QUESTION} 2 changes haven't synced and will be lost.`);
      expect(within(dialog).getByRole('button', { name: 'Erase and sign in' })).toBeVisible();
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeVisible();
      expect(within(dialog).queryByRole('button', { name: 'Erase' })).toBeNull();
    });

    it('says one change in the singular, and nothing about changes when there are none', async () => {
      const t = await renderApp({ layout, sync: fakeSync() });
      await signedInAsAnother(t, 1);
      expect(await within(await ask()).findByText("1 change hasn't synced and will be lost.")).toBeVisible();
      await signedInAsAnother(t, 0);
      await waitFor(() => expect(screen.queryByText(/synced and will be lost/)).toBeNull());
      expect(within(await ask()).getByText(QUESTION)).toBeVisible();
      expect(await ask()).toHaveAccessibleDescription(QUESTION);
    });

    it("Cancel signs that account out and keeps this device's data", async () => {
      const sync = fakeSync();
      const t = await renderApp({ layout, sync });
      await signedInAsAnother(t, 1);
      await userEvent.click(within(await ask()).getByRole('button', { name: 'Cancel' }));
      expect(sync.signOut).toHaveBeenCalledOnce();
      expect(sync.eraseAndSignIn).not.toHaveBeenCalled();
      expect(await listRecords(t.db, 'task')).toHaveLength(1);
    });

    it('Escape is Cancel', async () => {
      const sync = fakeSync();
      const t = await renderApp({ layout, sync });
      await signedInAsAnother(t, 1);
      await ask();
      await userEvent.keyboard('{Escape}');
      expect(sync.signOut).toHaveBeenCalledOnce();
      expect(sync.eraseAndSignIn).not.toHaveBeenCalled();
    });

    it("Erase and sign in erases, and forgets what screens kept on this device for the other account", async () => {
      const sync = fakeSync();
      const t = await renderApp({ layout, sync });
      localStorage.setItem('multiscale.plan.flow', JSON.stringify({ begun: true, note: 'Bake on Sundays' }));
      await signedInAsAnother(t, 1);
      await userEvent.click(within(await ask()).getByRole('button', { name: 'Erase and sign in' }));
      expect(sync.eraseAndSignIn).toHaveBeenCalledOnce();
      expect(sync.signOut).not.toHaveBeenCalled();
      expect(localStorage.getItem('multiscale.plan.flow')).toBeNull();
    });

    it("keeps this device's appearance, which isn't the account's", async () => {
      const sync = fakeSync();
      const t = await renderApp({ layout, sync });
      act(() => setAppearance('dark'));
      // As the real erase does, which closes the dialog.
      sync.eraseAndSignIn.mockImplementation(async () => {
        await t.db.run('DELETE FROM meta WHERE key = :key', { key: META.lastSyncError });
        t.db.notifyChanged({ source: 'remote' });
      });
      await signedInAsAnother(t, 1);
      await userEvent.click(within(await ask()).getByRole('button', { name: 'Erase and sign in' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Switch accounts' })).toBeNull());
      if (layout === 'phone') await userEvent.click(await screen.findByRole('button', { name: 'More' }));
      await userEvent.click(await screen.findByRole('button', { name: /^Settings/ }));
      const group = within(await screen.findByRole('region', { name: 'Appearance' })).getByRole('group', { name: 'Appearance' });
      expect(within(group).getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
      expect(t.platform.appearances.at(-1)).toBe('dark');
      expect(localStorage.getItem('multiscale.appearance')).toBe('dark');
    });

    it("keeps this device's Show completed choice, which isn't the account's either", async () => {
      const sync = fakeSync();
      const t = await renderApp({ layout, sync });
      localStorage.setItem('multiscale.showCompleted', 'true');
      localStorage.setItem('multiscale.plan.flow', JSON.stringify({ begun: true }));
      await signedInAsAnother(t, 1);
      await userEvent.click(within(await ask()).getByRole('button', { name: 'Erase and sign in' }));
      await waitFor(() => expect(localStorage.getItem('multiscale.plan.flow')).toBeNull());
      expect(localStorage.getItem('multiscale.showCompleted')).toBe('true');
    });

    it('a failed erase says so and keeps asking, with everything still here', async () => {
      const sync = fakeSync();
      sync.eraseAndSignIn.mockRejectedValueOnce(Object.assign(new Error('sign_in_expired'), { code: 'sign_in_expired' }));
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const t = await renderApp({ layout, sync });
      localStorage.setItem('multiscale.plan.flow', JSON.stringify({ begun: true }));
      await signedInAsAnother(t, 1);
      await userEvent.click(within(await ask()).getByRole('button', { name: 'Erase and sign in' }));
      expect(await screen.findByText("That didn't work. Try again.")).toBeVisible();
      expect(await ask()).toBeVisible();
      expect(localStorage.getItem('multiscale.plan.flow')).not.toBeNull();
      log.mockRestore();
    });
  });

  it('asks over first-run setup too, where signing in also starts', async () => {
    const t = await renderApp({ firstRun: true, sync: fakeSync() });
    await signedInAsAnother(t, 0);
    expect(within(await ask()).getByText(QUESTION)).toBeVisible();
  });

  it('only for a sign-in refused as another account’s', async () => {
    const t = await renderApp({ sync: fakeSync() });
    await act(async () => {
      await setMeta(t.db, META.lastSyncError, 'offline');
      t.db.notifyChanged({ source: 'remote' });
    });
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Switch accounts' })).toBeNull();
  });
});
