// First run: sign in, unavailable hours, then a first goal or capture. Finishing sets setup_done_at, which syncs,
// so a second device that signs in here skips the rest.

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { nowInstant } from '../../../core/dates';
import { updateSettings } from '../../../core/records';
import { syncStatus } from '../../../core/sync';
import type { ScreenProps } from '../../app/registry';
import { useApp, useMutation, useQuery, useStickyState } from '../../app/store';
import { Pill } from '../../components/Pill';
import { UnavailableList } from '../settings/Availability';

const STEPS = 3;

export default function Screen(props: ScreenProps) {
  const { layout } = props;
  const { clock, sync } = useApp();
  // Kept on this device, since signing in leaves for the browser and the OS may close the app meanwhile.
  const [step, setStep] = useStickyState('setup.step', 0);
  const [title, setTitle] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  // Focus follows the step, so keyboards and screen readers land on the new one. The last step focuses its field.
  useEffect(() => {
    if (moved.current) heading.current?.focus();
    moved.current = true;
  }, [step]);
  const { data: status } = useQuery((sql) => syncStatus(sql), []);
  const finish = useMutation(async (w, kind: 'goal' | 'capture' | null) => {
    const text = title.trim();
    if (kind === 'goal' && text) await w.create('objective', { title: text, state: 'active' });
    if (kind === 'capture' && text) await w.create('task', { kind: 'inbox', title: text });
    await updateSettings(w, { setup_done_at: nowInstant(clock) });
  });
  const done = (kind: 'goal' | 'capture' | null) => {
    setStep(0);
    void finish.run(kind);
  };
  const btn = layout === 'phone' ? 'btn grow' : 'btn';
  const back = (
    <button className={btn} type="button" onClick={() => setStep(step - 1)}>
      Back
    </button>
  );
  const next = (primary: boolean, label = 'Next') => (
    <button className={primary ? `${btn} pri` : btn} type="button" onClick={() => setStep(step + 1)}>
      {label}
    </button>
  );
  const signedOut = status?.lastError === 'sign_in_expired' || status?.lastError === 'sign_in_failed';
  const signedIn = !!status && !signedOut && !!(status.lastSyncAt || status.lastError);

  return (
    <div className={layout === 'phone' ? 'stack setup' : 'wrap stack setup'}>
      <p className="small quiet">
        Step {step + 1} of {STEPS}
      </p>
      {step === 0 && (
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
                {next(false, 'Skip')}
              </>
            ) : (
              next(true)
            )}
          </div>
        </>
      )}
      {step === 1 && (
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
      {step === 2 && (
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
