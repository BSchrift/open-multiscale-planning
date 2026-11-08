// First run: sign in, connect Google Calendar, unavailable hours, then a first goal or capture. Finishing sets
// setup_done_at, which syncs, so a second device that signs in here skips the rest.

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { captureTitle } from '../../../core/captureTitle';
import { nowInstant } from '../../../core/dates';
import { getMeta, META } from '../../../core/db';
import { CALENDAR_ID, getRecord, updateSettings } from '../../../core/records';
import { isSignedIn, syncStatus } from '../../../core/sync';
import type { ScreenProps } from '../../app/registry';
import { useApp, useMutation, useQuery, useStickyState } from '../../app/store';
import { Pill } from '../../components/Pill';
import { UnavailableList } from '../settings/Availability';
import { useCalendarCall } from '../settings/useCalendarCall';

type Step = 'welcome' | 'calendar' | 'hours' | 'start';

export default function Screen(props: ScreenProps) {
  const { layout } = props;
  const { clock, sync, platform } = useApp();
  // The web app keeps its data in one browser, so it signs in first. Dev builds keep Skip: the browser tests stand in for
  // the apps there.
  const canSkip = platform.kind !== 'web' || import.meta.env.DEV;
  // Kept on this device, since signing in and connecting leave for the browser and the OS may close the app meanwhile.
  const [saved, setStep] = useStickyState<Step>('setup.at', 'welcome');
  const { busy, call } = useCalendarCall();
  const { data } = useQuery(
    async (sql) => ({
      status: await syncStatus(sql),
      calendar: await getRecord(sql, 'calendar', CALENDAR_ID),
      signingIn: !!(await getMeta(sql, META.signingIn)),
    }),
    [],
  );
  const signedIn = !!data && isSignedIn(data.status);
  // Connecting needs a sign-in. Once it's connected, here or on another device, the step goes.
  const steps: Step[] = ['welcome', ...(sync && signedIn && !data?.calendar?.connected ? (['calendar'] as const) : []), 'hours', 'start'];
  // A step that went gives way to the one after it.
  const step = !data || steps.includes(saved) ? saved : 'hours';
  const index = steps.indexOf(step);
  const [title, setTitle] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  // Focus follows the step, so keyboards and screen readers land on the new one. The last step focuses its field.
  useEffect(() => {
    if (moved.current) heading.current?.focus();
    moved.current = true;
  }, [step]);
  const finish = useMutation(async (w, kind: 'goal' | 'capture' | null) => {
    const text = title.trim();
    const captured = captureTitle(title);
    if (kind === 'goal' && text) await w.create('objective', { title: text, state: 'active' });
    if (kind === 'capture' && captured) await w.create('task', { kind: 'inbox', title: captured });
    await updateSettings(w, { setup_done_at: nowInstant(clock) });
  });
  const done = (kind: 'goal' | 'capture' | null) => {
    setStep('welcome');
    void finish.run(kind);
  };
  if (!data) return null;
  const btn = layout === 'phone' ? 'btn grow' : 'btn';
  const back = (
    <button className={btn} type="button" onClick={() => setStep(steps[index - 1]!)}>
      Back
    </button>
  );
  const next = (primary: boolean, label = 'Next') => (
    <button className={primary ? `${btn} pri` : btn} type="button" onClick={() => setStep(steps[index + 1]!)}>
      {label}
    </button>
  );

  // Back from the browser, the sign-in and its first sync take a moment; the account's data may skip the rest of setup.
  if (step === 'welcome' && data.signingIn) {
    return (
      <div className={`${layout === 'phone' ? 'stack setup' : 'wrap stack setup'} welcome`}>
        <p className="signing" role="status">
          <span className="spinner" aria-hidden="true" />
          Signing in…
        </p>
      </div>
    );
  }
  return (
    <div className={`${layout === 'phone' ? 'stack setup' : 'wrap stack setup'}${step === 'welcome' ? ' welcome' : ''}`}>
      <p className="small quiet">
        Step {index + 1} of {steps.length}
      </p>
      {step === 'welcome' && (
        <>
          <h1 ref={heading} tabIndex={-1}>
            Welcome
          </h1>
          <p>Sign in to sync your plans between your devices.</p>
          {signedIn && (
            <div>
              <Pill tone="green">Signed in</Pill>
            </div>
          )}
          <div className="row">
            {sync && !signedIn ? (
              <>
                <button className={`${btn} pri`} type="button" onClick={() => void sync.signIn()}>
                  Sign in
                </button>
                {canSkip && next(false, 'Skip')}
              </>
            ) : (
              next(true)
            )}
          </div>
        </>
      )}
      {step === 'calendar' && sync && (
        <>
          <h1 ref={heading} tabIndex={-1}>
            Google Calendar
          </h1>
          <p>Connect it to plan around your events and see your blocks in Google.</p>
          <div className="row">
            {back}
            <button className={`${btn} pri`} type="button" disabled={busy} onClick={() => void call(sync.connectCalendar)}>
              Connect
            </button>
            {next(false, 'Skip')}
          </div>
        </>
      )}
      {step === 'hours' && (
        <>
          <h1 ref={heading} tabIndex={-1}>
            Unavailable hours
          </h1>
          <p className="quiet">Planning keeps these times free.</p>
          <div className="card stack8">
            <UnavailableList layout={layout} />
          </div>
          <div className="row">
            {back}
            {next(true)}
          </div>
        </>
      )}
      {step === 'start' && (
        <form
          className="stack"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (title.trim()) done('goal');
          }}
        >
          <h1>Start with one thing</h1>
          <p className="quiet">A goal you're working toward, or anything on your mind.</p>
          <input
            className="field"
            aria-label="A goal or a thought"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
          <div className="row">
            <button className={`${btn} pri`} type="submit" disabled={!title.trim()}>
              Add goal
            </button>
            <button className={btn} type="button" disabled={!title.trim()} onClick={() => done('capture')}>
              Capture
            </button>
          </div>
          <div className="row">
            {back}
            <button className={btn} type="button" onClick={() => done(null)}>
              Skip
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
