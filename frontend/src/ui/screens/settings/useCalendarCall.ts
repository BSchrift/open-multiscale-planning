// Calendar requests from Settings, setup and Today: busy while one runs, and a toast when it fails.

import { useState } from 'react';
import { useToast } from '../../components/Toast';

/** Calendar and sign-in requests fail with a SyncError code. */
function failure(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'offline') return "Couldn't reach the server. Try again when you're online.";
  if (code === 'sign_in_expired') return 'Sign in first.';
  return "That didn't work. Try again.";
}

export function useCalendarCall() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const call = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      // A SyncError is an expected state, such as being offline; anything else is a bug worth logging.
      if (!(error as { code?: unknown } | null)?.code) console.error('Calendar request failed', error);
      toast.show(failure(error));
    }
    setBusy(false);
  };
  return { busy, call };
}
