import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { META, setMeta } from '../../../core/db';
import { getSettings, listRecords } from '../../../core/records';
import type { AppSync } from '../../../core/syncRunner';
import { renderApp, renderScreen } from '../../app/testing';
import type { Harness } from '../../app/testing';

afterEach(cleanup);

function fakeSync() {
  return {
    signIn: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    syncNow: vi.fn(async () => undefined),
    connectCalendar: vi.fn(async () => undefined),
    refreshCalendar: vi.fn(async () => undefined),
    stop: vi.fn(),
    email: vi.fn(async () => null),
    eraseAndSignIn: vi.fn(async () => undefined),
  } satisfies AppSync;
}

async function syncState(t: Harness, at: string | null, error: string | null) {
  await act(async () => {
    if (at) await setMeta(t.db, META.lastSyncAt, at);
    if (error) await setMeta(t.db, META.lastSyncError, error);
    else await t.db.run('DELETE FROM meta WHERE key = :key', { key: META.lastSyncError });
    t.db.notifyChanged({ types: [], source: 'remote' });
  });
}

const heading = (name: string) => screen.findByRole('heading', { level: 1, name });
const click = async (name: string) => userEvent.click(await screen.findByRole('button', { name }));

describe('first-run setup', () => {
  describe.each(['desktop', 'phone'] as const)('on %s', (layout) => {
    it('signs in, sets unavailable hours, then starts with a goal', async () => {
      const sync = fakeSync();
      const t = await renderScreen('setup', { layout, firstRun: true, sync });
      await syncState(t, null, 'sign_in_expired');
      expect(await heading('Welcome')).toBeVisible();
      await click('Sign in');
      expect(sync.signIn).toHaveBeenCalledOnce();

      await syncState(t, '2026-11-02T20:00:00Z', null);
      expect(await screen.findByText('Signed in')).toBeVisible();
      await click('Next');

      expect(await heading('Unavailable hours')).toBeVisible();
      const night = await screen.findByRole('group', { name: 'Unavailable, 10pm to 7am' });
      fireEvent.change(within(night).getByRole('slider', { name: 'To' }), { target: { value: '360' } });
      expect(await screen.findByRole('group', { name: 'Unavailable, 10pm to 6am' })).toBeVisible();
      await click('Next');

      expect(await heading('Start with one thing')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Add goal' })).toBeDisabled();
      await userEvent.type(screen.getByRole('textbox'), 'Learn to bake bread');
      await click('Add goal');

      await waitFor(async () => expect((await getSettings(t.db)).setup_done_at).toBe('2026-11-02T20:00:00Z'));
      expect(await listRecords(t.db, 'objective')).toMatchObject([{ title: 'Learn to bake bread', state: 'active' }]);
      expect((await getSettings(t.db)).availability[0]).toMatchObject({ from: 22 * 60, to: 6 * 60 });
    });
  });

  it('can skip sign-in, and go back a step', async () => {
    await renderScreen('setup', { firstRun: true, sync: fakeSync() });
    await click('Skip');
    expect(await heading('Unavailable hours')).toHaveFocus();
    await click('Back');
    expect(await heading('Welcome')).toBeVisible();
  });

  it('a capture goes to the Inbox', async () => {
    const t = await renderScreen('setup', { firstRun: true });
    await click('Next');
    await click('Next');
    await userEvent.type(await screen.findByRole('textbox'), 'Paint the fence');
    await click('Capture');
    await waitFor(async () => expect((await getSettings(t.db)).setup_done_at).toBeTruthy());
    expect(await listRecords(t.db, 'task')).toMatchObject([{ kind: 'inbox', title: 'Paint the fence' }]);
    expect(await listRecords(t.db, 'objective')).toHaveLength(0);
  });

  it('Enter in the field adds it as a goal', async () => {
    const t = await renderScreen('setup', { firstRun: true });
    await click('Next');
    await click('Next');
    await userEvent.type(await screen.findByRole('textbox'), 'Learn to bake bread{Enter}');
    await waitFor(async () => expect(await listRecords(t.db, 'objective')).toHaveLength(1));
  });

  it('skipping the last step finishes with nothing added, and the app opens', async () => {
    const t = await renderApp({ firstRun: true });
    await click('Next');
    await click('Next');
    await click('Skip');
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeVisible();
    expect((await getSettings(t.db)).setup_done_at).toBeTruthy();
    expect(await listRecords(t.db, 'objective')).toHaveLength(0);
    expect(await listRecords(t.db, 'task')).toHaveLength(0);
  });
});
