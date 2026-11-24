// Settings > Account's Export my data, and the page Delete my account and data opens (docs/retention.md). Deleting is
// immediate once its safeguards are through: an export offered first, what goes said plainly, a sign-in of the last few
// minutes, and DELETE typed. The server checks the last two again.

import { useEffect, useId, useRef, useState } from 'react';
import { protocol } from '@multiscale/config';
import { ExportError } from '../../../core/account';
import { SyncError } from '../../../core/sync';
import { downloadLink } from '../../../platform/openDownload';
import type { Layout } from '../../app/registry';
import { useApp, useQuery } from '../../app/store';
import { Button } from '../../components/ds/Button';
import { TextField } from '../../components/ds/Controls';
import { useToast } from '../../components/Toast';

/** A sign-in this recent can delete the account, with a minute's margin under what the server takes. */
const FRESH_MS = (protocol.account.maxSignInAgeMinutes - 1) * 60_000;
/** How long backups keep an account after it's deleted: the table's point-in-time recovery period. */
export const BACKUP_DAYS = 35;
const CONFIRMATION = 'DELETE';

function exportFailure(error: unknown): string {
  if (error instanceof ExportError) return error.reason === 'unavailable' ? "Export isn't available on this server." : "Your export couldn't be made. Try again.";
  if (error instanceof SyncError && error.code === 'offline') return "You're offline. Export when you're back online.";
  if (error instanceof SyncError && error.code === 'sign_in_expired') return 'Sign in to export your data.';
  return "Your export couldn't be made. Try again.";
}

/** Export my data: the server builds the zip, then the device downloads it its own way. */
export function ExportButton(props: { layout: Layout; primary?: boolean }) {
  const { sync, platform } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!sync) return null;
  const run = async () => {
    setBusy(true);
    try {
      const url = await sync.exportData();
      await (platform.openDownload ?? downloadLink)(url);
      toast.show('Your export is ready and downloading.');
    } catch (error) {
      if (!(error instanceof ExportError || error instanceof SyncError)) console.error('Export failed', error);
      toast.show(exportFailure(error));
    }
    setBusy(false);
  };
  return (
    <>
      <Button
        size="compact"
        variant={props.primary ? 'primary' : 'secondary'}
        className={props.layout === 'phone' ? 'grow' : undefined}
        type="button"
        disabled={busy}
        onClick={() => void run()}
      >
        Export my data
      </Button>
      {busy && (
        <span className="small quiet" role="status">
          Preparing your export. It can take a few minutes.
        </span>
      )}
    </>
  );
}

/** Ticks every few seconds, so a sign-in's freshness runs out on screen. */
function useNow(every: number): number {
  const { clock } = useApp();
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(clock.now()), every);
    return () => clearInterval(timer);
  }, [clock, every]);
  return now;
}

export function DeleteAccountPage(props: { layout: Layout }) {
  const { sync } = useApp();
  const toast = useToast();
  const id = useId();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  // Opened from a button on the page underneath, which is hidden now, so focus starts at this page's heading.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  // Read again whenever the database changes, as when the sign-in comes back and syncs.
  const { data: signedInAt } = useQuery(async () => (sync ? await sync.signedInAt() : null), [sync]);
  // Only the account this device's data belongs to: signed in again as another, nothing may be deleted here.
  const { data: target } = useQuery(async () => (sync ? await sync.deletionTarget() : null), [sync]);
  const now = useNow(15_000);
  const fresh = !!signedInAt && now - signedInAt < FRESH_MS;
  const ready = fresh && !!target?.sameAccount;
  const text = props.layout === 'phone' ? 'small' : undefined;
  const btn = { className: props.layout === 'phone' ? 'grow' : undefined };

  const remove = async () => {
    if (!sync || busy) return;
    setBusy(true);
    try {
      // Done, the app starts over as on a new device, and says the account was deleted.
      const answer = await sync.deleteAccount();
      if (answer === 'sign_in_again') toast.show('Sign in again first: your last sign-in was too long ago.');
      if (answer === 'wrong_account') toast.show("You're signed in to another account. Nothing was deleted.");
      if (answer === 'protected') toast.show("This account is protected and can't be deleted. Nothing was deleted.");
    } catch (error) {
      toast.show(error instanceof SyncError && error.code === 'offline' ? "You're offline. Connect to delete your account." : "That didn't work. Try again.");
    }
    setBusy(false);
  };

  return (
    <div className={props.layout === 'phone' ? 'stack settings' : 'wrap stack32 settings'}>
      <h1 ref={heading} tabIndex={-1}>
        Delete my account and data
      </h1>
      <p className={text}>
        {target?.sameAccount && target.email ? `This deletes the account ${target.email}` : 'This deletes your account'} and everything in it, from Multiscale's servers and
        from every device you're signed in on. It can't be undone.
      </p>
      <section className="stack8" aria-labelledby={`${id}what`}>
        <h2 id={`${id}what`}>What's deleted</h2>
        <div className="card stack8">
          <ul className={`stack8 ${text ?? ''}`}>
            <li>Your goals, projects, milestones, tasks, practices, notes, time blocks and your answers to them, and your settings.</li>
            <li>The photos and files on your tasks and notes.</li>
            <li>Your Google Calendar connection. Its Time blocks calendar is removed from your Google account; your other calendars aren't touched.</li>
            <li>Your sign-in. You can't sign in to this account again.</li>
          </ul>
          <p className={text}>
            Copies in Multiscale's backups are kept for {BACKUP_DAYS} days, then they're gone too. Nothing is restored from them into an account.
          </p>
        </div>
      </section>
      <section className="stack8" aria-labelledby={`${id}export`}>
        <h2 id={`${id}export`}>1. Export your data first</h2>
        <div className="card stack8">
          <p className={text}>A zip of everything: your records as JSON, your notes as Markdown, and your photos and files.</p>
          <div className="row">
            <ExportButton layout={props.layout} />
          </div>
        </div>
      </section>
      <section className="stack8" aria-labelledby={`${id}sign`}>
        <h2 id={`${id}sign`}>2. Sign in again</h2>
        <div className="card stack8">
          {fresh && target && !target.sameAccount ? (
            <p className={text}>
              You're signed in to another account than the one whose data is on this device, so it can't be deleted here. Sign in again as the account
              you mean to delete.
            </p>
          ) : null}
          {fresh && target?.sameAccount ? (
            <p className={text}>You've signed in recently enough to delete.</p>
          ) : (
            <>
              <p className={text}>To make sure it's you, sign in again. You then have {protocol.account.maxSignInAgeMinutes} minutes to delete.</p>
              <div className="row">
                <Button {...btn} variant="primary" type="button" disabled={!sync} onClick={() => void sync?.signIn({ again: true })}>
                  Sign in again
                </Button>
              </div>
            </>
          )}
        </div>
      </section>
      <section className="stack8" aria-labelledby={`${id}confirm`}>
        <h2 id={`${id}confirm`}>3. Delete</h2>
        <form
          className="card stack8"
          onSubmit={(event) => {
            event.preventDefault();
            void remove();
          }}
        >
          <TextField
            label={`Type ${CONFIRMATION} to confirm`}
            value={typed}
            onChange={setTyped}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            disabled={!ready}
          />
          <div className="row">
            <Button {...btn} variant="destructive" filled type="submit" disabled={!ready || typed.trim() !== CONFIRMATION || busy}>
              Delete my account and data
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
