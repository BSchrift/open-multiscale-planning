import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { availableHours } from '../../../core/capacity';
import type { Clock } from '../../../core/clock';
import { addWeeks, formatDate, formatMinutes, formatTime, localDate, thisWeek, today } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { cadenceLabel } from '../../../core/plan';
import { CALENDAR_ID, getRecord, getSettings, listRecords, updateSettings } from '../../../core/records';
import { slotContext } from '../../../core/slots';
import { syncStatus } from '../../../core/sync';
import type { SyncErrorCode } from '../../../core/sync';
import type { CalendarMode, Instant, ReminderSettings } from '../../../core/types';
import { setAppearance, useAppearance } from '../../app/appearance';
import type { Layout, ScreenProps } from '../../app/registry';
import { useNav } from '../../app/nav';
import { useApp, useMutation, useQuery, useToday } from '../../app/store';
import { EstimateSlider } from '../../components/EstimateSlider';
import { Pill } from '../../components/Pill';
import type { PillTone } from '../../components/Pill';
import { useToast } from '../../components/Toast';
import { UnavailableList } from './Availability';
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
              <button className={btn} type="button" disabled={busy} onClick={() => void call(sync.refreshCalendar)}>
                Refresh
              </button>
            ) : (
              <button className={`${btn} pri`} type="button" disabled={busy} onClick={() => void call(sync.connectCalendar)}>
                Connect
              </button>
            )}
          </div>
        )}
      </div>
      {error && (
        <div className="attn warn" role="status">
          {error}
        </div>
      )}
      {sources.length > 0 && (
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
  const remove = useMutation((w, id: string) => w.delete('away_period', id));
  const phone = props.layout === 'phone';
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
              <button className={phone ? 'btn' : 'btn sm'} type="button" aria-label={`Remove ${text}`} onClick={() => void remove.run(a.id)}>
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

export default function Screen(props: ScreenProps) {
  const { layout } = props;
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
      {/* AGPL-3.0: the app shows where its source is. A target="_blank" link opens in the system browser on Electron and iOS too. */}
      <a className="small source" href="https://github.com/BSchrift/open-multiscale-planning" target="_blank" rel="noreferrer">
        Source code
      </a>
    </div>
  );
}
