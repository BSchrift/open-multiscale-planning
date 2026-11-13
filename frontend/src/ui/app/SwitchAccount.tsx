// Signing in as another account than the one this device's data belongs to. Sync refuses that sign-in until the
// person chooses here: erase this device's data and sign in, or cancel, which signs that account out again.

import { useId, useState } from 'react';
import { syncStatus, unsyncedChanges } from '../../core/sync';
import { Sheet } from '../components/Sheet';
import { useToast } from '../components/Toast';
import { APPEARANCE_KEY } from './appearance';
import { PROCESS_KEYS_KEY } from './processKeys';
import { SHOW_COMPLETED_KEY } from './showCompleted';
import { useApp, useQuery } from './store';

/** Choices about this device rather than the account, so an account switch keeps them. */
const DEVICE_KEYS = [APPEARANCE_KEY, SHOW_COMPLETED_KEY, PROCESS_KEYS_KEY];

export function SwitchAccount() {
  const { sync, layout } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const id = useId();
  const { data } = useQuery(
    async (sql) =>
      sync && (await syncStatus(sql)).lastError === 'other_account' ? { email: await sync.email(), unsynced: await unsyncedChanges(sql) } : null,
    [sync],
  );
  if (!sync || !data) return null;
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      console.error('Switching accounts failed', error);
      toast.show("That didn't work. Try again.");
    }
    setBusy(false);
  };
  const erase = async () => {
    await sync.eraseAndSignIn();
    // What screens keep on this device, such as a plan in progress, was the other account's too. DEVICE_KEYS are the
    // device's own.
    try {
      const kept = DEVICE_KEYS.map((key) => [key, localStorage.getItem(key)] as const);
      localStorage.clear();
      for (const [key, value] of kept) if (value !== null) localStorage.setItem(key, value);
    } catch {
      // Storage can be blocked, and then holds nothing.
    }
  };
  const cancel = () => void run(sync.signOut);
  const { email, unsynced } = data;
  const btn = layout === 'phone' ? 'btn grow' : 'btn';
  return (
    // The dialog itself takes focus, so the warning is its description, read out with its name.
    <Sheet label="Switch accounts" describedBy={unsynced > 0 ? `${id}q ${id}n` : `${id}q`} onClose={cancel}>
      <p id={`${id}q`}>
        This device has data from another account. {email ? `Signing in as ${email}` : 'Signing in'} erases it from this device; it stays in the
        other account.
      </p>
      {unsynced > 0 && <p id={`${id}n`}>{unsynced === 1 ? "1 change hasn't" : `${unsynced} changes haven't`} synced and will be lost.</p>}
      <div className="row">
        <button className={`${btn} pri`} type="button" disabled={busy} onClick={() => void run(erase)}>
          Erase and sign in
        </button>
        <button className={btn} type="button" disabled={busy} onClick={cancel}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}
