import { useId, useState, useSyncExternalStore } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { availableHours } from '../../../core/capacity';
import type { Clock } from '../../../core/clock';
import { addWeeks, formatDate, formatMinutes, formatTime, localDate, nowInstant, thisWeek, today } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { cadenceLabel } from '../../../core/plan';
import { CALENDAR_ID, getRecord, getSettings, listRecords, updateSettings } from '../../../core/records';
import { PAUSE_REMINDER_MIN } from '../../../core/reminders';
import { slotContext } from '../../../core/slots';
import { syncStatus } from '../../../core/sync';
import type { SyncErrorCode } from '../../../core/sync';
import type { UpdateStatus, Updater } from '../../../core/updates';
import type { CalendarMode, Fields, Instant, ReminderSettings } from '../../../core/types';
import { DEFAULT_SHORTCUT, shortcutFromKeys, shortcutLabel } from '../../../platform/shortcut';
import { setAppearance, useAppearance } from '../../app/appearance';
import { useCaptureShortcut } from '../../app/captureShortcut';
import { useProcessKeys } from '../../app/processKeys';
import type { Layout, ScreenProps } from '../../app/registry';
import { useNav } from '../../app/nav';
import { useApp, useMutation, useQuery, useToday } from '../../app/store';
import { EstimateSlider } from '../../components/EstimateSlider';
import { Pill } from '../../components/Pill';
import type { PillTone } from '../../components/Pill';
import { useToast } from '../../components/Toast';
import { UnavailableList } from './Availability';
import { RetentionPage } from './Retention';
import { useCalendarCall } from './useCalendarCall';
import './settings.css';

function Section(props: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="stack8" aria-labelledby={id}>
      <h2 id={id}>{props.title}</h2>
      <div className="card stack8">{props.children}</div>
    </section>
  );
}

/** '1:30pm' today, 'Oct 30, 10am' on another day. */
function when(at: Instant, clock: Clock): string {
  const date = localDate(at, clock.zone());
  const time = formatTime(at, clock.zone());
  return date === today(clock) ? time : `${formatDate(date)}, ${time}`;
}

const SYNC_STATE: Record<SyncErrorCode, { pill: string; tone: PillTone; line: string }> = {
  offline: { pill: 'Offline', tone: 'grey', line: "Your changes are kept and sync when you're back online." },
  sign_in_expired: { pill: 'Signed out', tone: 'amber', line: 'Sign in to sync your devices. Your work here is kept.' },
  sign_in_failed: { pill: 'Signed out', tone: 'amber', line: "Sign-in didn't finish. Try again." },
  clock_ahead: { pill: 'Not synced', tone: 'red', line: "This device's clock is ahead. Set the right time to sync." },
  other_account: { pill: 'Not synced', tone: 'red', line: 'This device has data from another account. Erase it to sign in, or sign out to keep it.' },
  too_large: { pill: 'Partly synced', tone: 'amber', line: 'One item is too long to sync. Everything else syncs, and it will too once shortened.' },
  error: { pill: 'Not synced', tone: 'red', line: "Sync didn't work. It will try again." },
};

function Account(props: { layout: Layout }) {
  const { sync, clock } = useApp();
  const { data: status } = useQuery((sql) => syncStatus(sql), []);
  const [busy, setBusy] = useState(false);
  if (!status) return null;
  const state = status.lastError
    ? SYNC_STATE[status.lastError]
    : status.lastSyncAt
      ? { pill: 'Synced', tone: 'green' as const, line: null }
      : { pill: 'Not synced yet', tone: 'grey' as const, line: null };
  const signedOut = status.lastError === 'sign_in_expired' || status.lastError === 'sign_in_failed';
  const btn = props.layout === 'phone' ? 'btn' : 'btn sm';
  const syncNow = async () => {
    setBusy(true);
    await sync?.syncNow();
    setBusy(false);
  };
  return (
    <Section title="Account">
      <div className={props.layout === 'phone' ? 'stack8' : 'setrow'}>
        <div className="stack8">
          <div>
            <Pill tone={state.tone}>{state.pill}</Pill>
          </div>
          {state.line && <span className="small">{state.line}</span>}
          {status.lastSyncAt && <span className="small quiet">Last synced {when(status.lastSyncAt, clock)}</span>}
        </div>
        {sync && (
          <div className="row">
            {signedOut ? (
              <button className={`${btn} pri`} type="button" onClick={() => void sync.signIn()}>
                Sign in
              </button>
            ) : (
              <>
                <button className={btn} type="button" disabled={busy} onClick={() => void syncNow()}>
                  Sync now
                </button>
                <button className={btn} type="button" onClick={() => void sync.signOut()}>
                  Sign out
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

async function hoursSummary(sql: Sql, clock: Clock): Promise<string> {
  const settings = await getSettings(sql);
  const week = thisWeek(clock);
  const hours = availableHours(settings.availability, week);
  const ctx = slotContext({
    week: addWeeks(week, 1),
    availability: settings.availability,
    avoided: [],
    sources: await listRecords(sql, 'calendar_source'),
    calendar: (await getRecord(sql, 'calendar', CALENDAR_ID)) ?? null,
    blocks: [],
    clock,
  });
  const busy = ctx.busy.reduce((sum, span) => sum + span.end - span.start, 0);
  const base = `${formatMinutes(hours.project)} a week for projects and ${formatMinutes(hours.one_off)} for one offs`;
  return busy ? `${base}, before ${formatMinutes(busy)} of calendar busy time next week.` : `${base}.`;
}

function AvailableHours(props: { layout: Layout }) {
  const { data: summary } = useQuery(hoursSummary, []);
  const { data: settings } = useQuery((sql) => getSettings(sql), []);
  const setAim = useMutation((w, minutes: number) => updateSettings(w, { one_offs_weekly_aim: minutes || null }));
  return (
    <Section title="Available hours">
      {summary && <p className={props.layout === 'phone' ? 'small quiet' : 'quiet'}>{summary}</p>}
      <UnavailableList layout={props.layout} />
      {settings && (
        <div className={`${props.layout === 'phone' ? 'rowline' : 'setrow'} mhead`}>
          <EstimateSlider label="Weekly one offs aim" noneLabel="No aim" value={settings.one_offs_weekly_aim} onChange={(m) => void setAim.run(m)} />
        </div>
      )}
    </Section>
  );
}

function Cadence(props: { layout: Layout }) {
  const nav = useNav();
  const { data: settings } = useQuery((sql) => getSettings(sql), []);
  if (!settings) return null;
  const go = (
    <button className={props.layout === 'phone' ? 'btn' : 'btn sm'} type="button" onClick={() => nav.go('plan', { cadence: 'edit' })}>
      {settings.plan_cadence ? 'Change planning cadence' : 'Set your planning cadence'}
    </button>
  );
  const label = <span>{cadenceLabel(settings.plan_cadence)}</span>;
  return (
    <Section title="Planning cadence">
      {props.layout === 'phone' ? (
        <>
          {label}
          {go}
        </>
      ) : (
        <div className="row">
          {label}
          {go}
        </div>
      )}
    </Section>
  );
}

const CALENDAR_ERRORS: Record<string, string> = {
  calendar_revoked: 'Google access was removed. Connect again.',
  calendar_rate_limited: 'Google asked to slow down. It will try again soon.',
  calendar_failed: "Couldn't read your calendars. It will try again.",
  too_many_events: 'Some events were left out. There were too many to read.',
};

function Calendar(props: { layout: Layout }) {
  const { sync, clock } = useApp();
  const { busy, call } = useCalendarCall();
  const { data } = useQuery(
    async (sql) => ({
      calendar: await getRecord(sql, 'calendar', CALENDAR_ID),
      sources: (await listRecords(sql, 'calendar_source')).sort((a, b) => a.name.localeCompare(b.name)),
    }),
    [],
  );
  const setMode = useMutation((w, id: string, mode: CalendarMode) => w.set('calendar_source', id, { mode }));
  const [confirming, setConfirming] = useState(false);
  if (!data) return null;
  const { calendar, sources } = data;
  const phone = props.layout === 'phone';
  const btn = phone ? 'btn' : 'btn sm';
  const error = calendar?.last_error ? (CALENDAR_ERRORS[calendar.last_error] ?? "Couldn't read your calendars. It will try again.") : null;
  return (
    <Section title="Google Calendar">
      <div className={phone ? 'stack8' : 'setrow'}>
        {calendar?.connected ? (
          <div>
            <div>Connected. Blocks go to your Time blocks calendar.</div>
            {calendar.synced_at && <div className="small quiet">Last pushed {when(calendar.synced_at, clock)}</div>}
          </div>
        ) : (
          <span>Not connected.</span>
        )}
        {sync && (
          <div className="row">
            {calendar?.connected ? (
              <>
                <button className={btn} type="button" disabled={busy} onClick={() => void call(sync.refreshCalendar)}>
                  Refresh
                </button>
                <button className={`${btn} danger`} type="button" disabled={busy} aria-expanded={confirming} onClick={() => setConfirming(!confirming)}>
                  Disconnect
                </button>
              </>
            ) : (
              <button className={`${btn} pri`} type="button" disabled={busy} onClick={() => void call(sync.connectCalendar)}>
                Connect
              </button>
            )}
          </div>
        )}
      </div>
      {sync && calendar?.connected && confirming && (
        <div className="stack8">
          <p>Your blocks stay here, and the Time blocks calendar is removed from Google. You can connect again any time.</p>
          <div className="row">
            <button
              className={`${btn} pri danger`}
              type="button"
              disabled={busy}
              onClick={() => void call(sync.disconnectCalendar).then(() => setConfirming(false))}
            >
              Disconnect Google Calendar
            </button>
            <button className={btn} type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="attn warn" role="status">
          {error}
        </div>
      )}
      {calendar?.connected && sources.length > 0 && (
        <>
          <h3>Your calendars</h3>
          {sources.map((s) => (
            <div key={s.id} className={phone ? 'rowline' : 'setrow'}>
              <label htmlFor={`cal-${s.id}`}>{s.name}</label>
              <select id={`cal-${s.id}`} className="field" value={s.mode} onChange={(event) => void setMode.run(s.id, event.target.value as CalendarMode)}>
                <option value="block">Blocks my time</option>
                <option value="info">Just information</option>
                <option value="ignore">Ignore</option>
              </select>
            </div>
          ))}
          <p className="small quiet">
            Blocks my time: planning avoids its events. Just information: its events show in the Week view, but planning ignores them and you can
            schedule over them. Ignore: not shown anywhere.
          </p>
        </>
      )}
    </Section>
  );
}

function Away(props: { layout: Layout }) {
  const { clock } = useApp();
  const toast = useToast();
  const day = useToday();
  const ids = useId();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data: periods } = useQuery(
    async (sql) => (await listRecords(sql, 'away_period')).filter((a) => a.end >= day).sort((a, b) => a.start.localeCompare(b.start)),
    [day],
  );
  const add = useMutation((w, start: string, end: string) => w.create('away_period', { start, end }));
  const setAway = useMutation((w, id: string, fields: Fields<'away_period'>) => w.set('away_period', id, fields));
  const phone = props.layout === 'phone';
  const remove = async (id: string, text: string) => {
    const previous = await setAway.run(id, { deleted_at: nowInstant(clock) });
    if (previous) toast.show(`Removed away dates ${text}.`, { undo: () => setAway.run(id, previous), focusUndo: true });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!from || !to || to < from) {
      toast.show('Choose a start and an end date');
      return;
    }
    if ((await add.run(from, to)) !== undefined) {
      setFrom('');
      setTo('');
    }
  };
  return (
    <Section title="Away dates">
      <form className={phone ? 'stack8' : 'row'} onSubmit={(event) => void submit(event)}>
        <label className="small quiet" htmlFor={`${ids}f`}>
          From
        </label>
        <input id={`${ids}f`} className="field" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        <label className="small quiet" htmlFor={`${ids}t`}>
          {phone ? 'To' : 'to'}
        </label>
        <input id={`${ids}t`} className="field" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        <button className="btn" type="submit">
          Add
        </button>
      </form>
      {periods?.map((a) => {
        const text = `${formatDate(a.start)} to ${formatDate(a.end)}`;
        return (
          <div key={a.id} className={phone ? 'rowline' : 'setrow'}>
            <div className="between">
              <span>{text}</span>
              <button className={phone ? 'btn' : 'btn sm'} type="button" aria-label={`Remove ${text}`} onClick={() => void remove(a.id, text)}>
                Remove
              </button>
            </div>
          </div>
        );
      })}
      <p className="small quiet">Reminders are muted, and pace and reliability exclude these dates.</p>
    </Section>
  );
}

function Reminders(props: { layout: Layout }) {
  const { data: settings } = useQuery((sql) => getSettings(sql), []);
  const id = useId();
  const set = useMutation(async (w, patch: Partial<ReminderSettings>) => {
    const { reminders } = await getSettings(w.sql);
    await updateSettings(w, { reminders: { ...reminders, ...patch } });
  });
  if (!settings) return null;
  const r = settings.reminders;
  const row = props.layout === 'phone' ? 'rowline' : 'setrow';
  const toggle = (key: 'block_start' | 'check_in' | 'block_end', label: string) => (
    <label className="taskrow">
      <input type="checkbox" checked={r[key]} onChange={() => void set.run({ [key]: !r[key] })} />
      <span>{label}</span>
    </label>
  );
  const delay = `${r.check_in_delay_min} minutes`;
  return (
    <Section title="Reminders">
      <div className={row}>{toggle('block_start', 'Notify at block start')}</div>
      <div className={row}>
        {toggle('check_in', "Ask if I've started, unless I already tapped Start")}
        {r.check_in && <p className="small quiet">A paused block also gets one reminder after {PAUSE_REMINDER_MIN} minutes.</p>}
        {r.check_in && (
          <div className="stack8 delay">
            <div className="between">
              <label className="small quiet" htmlFor={id}>
                After
              </label>
              <span className="strong">{delay}</span>
            </div>
            <input
              id={id}
              type="range"
              min={5}
              max={15}
              step={5}
              value={r.check_in_delay_min}
              aria-valuetext={delay}
              onChange={(event) => void set.run({ check_in_delay_min: Number(event.target.value) })}
            />
          </div>
        )}
      </div>
      <div className={row}>{toggle('block_end', 'Ask at block end')}</div>
      <div className={row}>
        <label className="taskrow">
          <input type="checkbox" checked={r.planning !== false} onChange={() => void set.run({ planning: r.planning === false })} />
          <span>Remind me when next week's planning has no time</span>
        </label>
      </div>
    </Section>
  );
}

const APPEARANCES = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
] as const;

function Appearance(props: { layout: Layout }) {
  const appearance = useAppearance();
  return (
    <Section title="Appearance">
      <div className="row" role="group" aria-label="Appearance">
        {APPEARANCES.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`dchip${appearance === value ? ' on' : ''}`}
            aria-pressed={appearance === value}
            onClick={() => setAppearance(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className={props.layout === 'phone' ? 'small quiet' : 'quiet'}>System follows this device's light or dark setting. Kept on this device only.</p>
    </Section>
  );
}

/** Desktop: whether Process takes single keys. Off, Option or Alt with the key still works. */
function ProcessKeys() {
  const [on, set] = useProcessKeys();
  return (
    <Section title="Keyboard">
      <div className="setrow">
        <label className="taskrow">
          <input type="checkbox" checked={on} onChange={() => set(!on)} />
          <span>Single-key shortcuts in Process</span>
        </label>
      </div>
      <p className="quiet">
        Keys such as S to skip and W for this week work on their own, away from a field. Off, hold Option or Alt with the key, so speech input can't press them.
        For this device only.
      </p>
    </Section>
  );
}

/** Opens the Data retention page, which says what's kept and for how long. */
function DataRetention(props: { layout: Layout }) {
  const nav = useNav();
  return (
    <Section title="Data retention">
      <div className={props.layout === 'phone' ? 'stack8' : 'setrow'}>
        <span className={props.layout === 'phone' ? 'small' : undefined}>How long your history is kept before it's removed.</span>
        <button className={props.layout === 'phone' ? 'btn' : 'btn sm'} type="button" onClick={() => nav.go('settings', { page: 'retention' })}>
          Data retention
        </button>
      </div>
    </Section>
  );
}

const UPDATE_LINE: Record<UpdateStatus['state'], string | null> = {
  idle: null,
  checking: 'Checking…',
  current: 'Up to date.',
  failed: "Couldn't check for updates. It tries again later.",
  ready: 'Version {v} is ready. It starts the next time the app opens.',
  'needs-app': 'Version {v} needs a new version of the app.',
};

/** Desktop: the keys that open capture from anywhere. Change listens for the next keys pressed. */
function CaptureKeys() {
  const { shortcut, change } = useCaptureShortcut();
  const [listening, setListening] = useState(false);
  const [said, setSaid] = useState('');
  if (!shortcut) return null;
  const choose = async (accelerator: string) => {
    setListening(false);
    const label = shortcutLabel(accelerator);
    setSaid((await change(accelerator)) ? `Capture opens with ${label} now.` : `${label} is taken by another app. Try other keys.`);
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') return setListening(false);
    const accelerator = shortcutFromKeys(event);
    if (accelerator) void choose(accelerator);
  };
  return (
    <Section title="Capture shortcut">
      <div className="setrow">
        <div className="stack8">
          <span>
            Opens capture from anywhere: <span className="strong">{shortcutLabel(shortcut.accelerator)}</span>
          </span>
          {!shortcut.registered && <span className="small">Another app is using these keys, so they don't open capture. Choose others.</span>}
          <span className="small quiet" role="status">
            {said}
          </span>
        </div>
        <div className="row">
          {listening ? (
            // Focus has to be on it to hear the keys.
            <button className="btn sm pri" type="button" autoFocus onKeyDown={onKeyDown} onBlur={() => setListening(false)}>
              Press the new keys, or Escape
            </button>
          ) : (
            <button
              className="btn sm"
              type="button"
              onClick={() => {
                setSaid('');
                setListening(true);
              }}
            >
              Change
            </button>
          )}
          {shortcut.accelerator !== DEFAULT_SHORTCUT && (
            <button className="btn sm" type="button" onClick={() => void choose(DEFAULT_SHORTCUT)}>
              Use {shortcutLabel(DEFAULT_SHORTCUT)}
            </button>
          )}
        </div>
      </div>
    </Section>
  );
}

/** Updates download by themselves; this shows where they're at and lets someone check or switch now. */
function Updates(props: { layout: Layout; updates: Updater }) {
  const { updates } = props;
  const { platform } = useApp();
  const status = useSyncExternalStore(updates.subscribe, updates.status);
  const line = UPDATE_LINE[status.state]?.replace('{v}', 'version' in status ? status.version : '');
  const btn = props.layout === 'phone' ? 'btn' : 'btn sm';
  return (
    <Section title="Updates">
      <div className={props.layout === 'phone' ? 'stack8' : 'setrow'}>
        <div className="stack8">
          <span>Version {updates.version}</span>
          {line && <span className="small quiet">{line}</span>}
        </div>
        <div className="row">
          {status.state === 'ready' && (
            <button className={`${btn} pri`} type="button" onClick={() => void updates.apply()}>
              Restart now
            </button>
          )}
          {status.state === 'needs-app' && updates.download && (
            <button className={`${btn} pri`} type="button" onClick={() => void platform.openExternal(updates.download!)}>
              Download the app
            </button>
          )}
          <button className={btn} type="button" disabled={status.state === 'checking'} onClick={() => void updates.check()}>
            Check for updates
          </button>
        </div>
      </div>
    </Section>
  );
}

export default function Screen(props: ScreenProps) {
  const { layout } = props;
  const { updates } = useApp();
  if (props.params.page === 'retention') return <RetentionPage layout={layout} />;
  return (
    <div className={layout === 'phone' ? 'stack settings' : 'wrap stack32 settings'}>
      <h1>Settings</h1>
      <Account layout={layout} />
      <AvailableHours layout={layout} />
      <Cadence layout={layout} />
      <Calendar layout={layout} />
      <Away layout={layout} />
      <Reminders layout={layout} />
      <Appearance layout={layout} />
      {layout === 'desktop' && <ProcessKeys />}
      <CaptureKeys />
      {updates && <Updates layout={layout} updates={updates} />}
      <DataRetention layout={layout} />
      {/* AGPL-3.0: the app shows where its source is. A target="_blank" link opens in the system browser on Electron and iOS too. */}
      <a className="small source" href="https://github.com/BSchrift/open-multiscale-planning" target="_blank" rel="noreferrer">
        Source code
      </a>
    </div>
  );
}
