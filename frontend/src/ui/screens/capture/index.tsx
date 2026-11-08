// Capture: one field. Enter saves to the Inbox and Esc cancels. Add details is optional and folded away: choosing a
// project, and then one of its milestones, or One offs skips the Inbox, and a time estimate travels with the task.

import { useEffect, useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { captureTitle, MAX_TITLE } from '../../../core/captureTitle';
import { inboxCount } from '../../../core/queries';
import { listRecords } from '../../../core/records';
import type { Fields, LocalDate, Minutes } from '../../../core/types';
import type { ScreenProps } from '../../app/registry';
import { useMutation, useQuery, useToday } from '../../app/store';
import { EstimateSlider } from '../../components/EstimateSlider';
// From draft rather than the folder's index, so the app's first chunk doesn't carry the one off form and row.
import { emptyDraft, oneOffFields } from '../../components/oneoff/draft';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { useDialogFocus } from '../../components/useDialogFocus';
import './capture.css';

const ONE_OFFS = 'oneoffs';
/** How long desktop shows what it saved before it fades and closes. */
const SAVED_MS = 700;
const FADE_MS = 120;

function fieldsFor(title: string, where: string, milestone: string, est: Minutes, today: LocalDate): Fields<'task'> {
  if (where === ONE_OFFS) return oneOffFields({ ...emptyDraft(today), title, estimate: est }, today);
  if (where) return { kind: 'project', project_id: where, milestone_id: milestone || null, title, estimate_min: est || null };
  return { kind: 'inbox', title, estimate_min: est || null };
}

export default function Screen(props: ScreenProps) {
  const { layout, close } = props;
  const today = useToday();
  const toast = useToast();
  const projects = useQuery((sql) => listRecords(sql, 'project'), []).data?.filter((p) => p.state === 'active') ?? [];
  const [text, setText] = useState('');
  const [details, setDetails] = useState(false);
  const [where, setWhere] = useState('');
  const [milestone, setMilestone] = useState('');
  // The chosen project's open milestones, soonest due first.
  const milestones =
    useQuery(
      async (sql) =>
        where && where !== ONE_OFFS
          ? (await listRecords(sql, 'milestone'))
              .filter((m) => m.project_id === where && !m.met_at && !m.dropped_at && !m.deleted_at)
              .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.title.localeCompare(b.title))
          : [],
      [where],
    ).data ?? [];
  const [est, setEst] = useState<Minutes>(0);
  const [saved, setSaved] = useState<string | null>(null);
  const [fade, setFade] = useState(false);
  const ids = { field: useId(), where: useId(), milestone: useId() };
  const save = useMutation(async (w, fields: Fields<'task'>) => {
    await w.create('task', fields);
    return inboxCount(w.sql);
  });

  const project = projects.find((p) => p.id === where)?.title;
  const ms = milestones.find((m) => m.id === milestone)?.title;
  const place = where === ONE_OFFS ? 'One offs' : project ? (ms ? `${project}, ${ms}` : project) : 'Inbox';
  const phone = layout === 'phone';

  useEffect(() => {
    if (!saved) return;
    const timers = [setTimeout(() => setFade(true), SAVED_MS), setTimeout(close, SAVED_MS + FADE_MS)];
    return () => timers.forEach(clearTimeout);
  }, [saved, close]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const title = captureTitle(text);
    if (!title || saved || save.pending) return;
    const waiting = await save.run(fieldsFor(title, where, milestone, est, today));
    if (waiting === undefined) return;
    const message = where ? `Saved to ${place}` : phone ? 'Saved to Inbox' : `Saved to Inbox, ${waiting} waiting`;
    if (phone) {
      toast.show(message);
      close();
    } else {
      setText('');
      setSaved(message);
    }
  };

  const whereSelect = (
    <select
      id={ids.where}
      className="field"
      value={where}
      onChange={(e) => {
        setWhere(e.target.value);
        setMilestone('');
      }}
    >
      <option value="">Inbox</option>
      <option value={ONE_OFFS}>One offs</option>
      {projects.length > 0 && (
        <optgroup label="Projects">
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
  const milestoneSelect = milestones.length > 0 && (
    <select id={ids.milestone} className="field" value={milestone} onChange={(e) => setMilestone(e.target.value)}>
      <option value="">No milestone</option>
      {milestones.map((m) => (
        <option key={m.id} value={m.id}>
          {m.title}
        </option>
      ))}
    </select>
  );
  const slider = <EstimateSlider label="Time" value={est} onChange={setEst} />;
  const detailsToggle = (className: string) => (
    <button className={className} type="button" aria-expanded={details} onClick={() => setDetails(!details)}>
      {details ? 'Hide details' : 'Add details'}
    </button>
  );

  if (phone) {
    return (
      <Sheet label="Capture" onClose={close}>
        <form className="stack" onSubmit={submit}>
          <label className="strong" htmlFor={ids.field}>
            Capture to {place}
          </label>
          <input
            id={ids.field}
            className="field"
            autoFocus
            maxLength={MAX_TITLE}
            value={text}
            placeholder="What's on your mind?"
            onChange={(e) => setText(e.target.value)}
          />
          <div>{detailsToggle('link')}</div>
          {details && (
            <>
              <div className="stack8">
                <label className="small quiet" htmlFor={ids.where}>
                  Send to
                </label>
                {whereSelect}
              </div>
              {milestoneSelect && (
                <div className="stack8">
                  <label className="small quiet" htmlFor={ids.milestone}>
                    Milestone
                  </label>
                  {milestoneSelect}
                </div>
              )}
              {slider}
            </>
          )}
          <button className="btn pri" type="submit">
            Save
          </button>
        </form>
      </Sheet>
    );
  }

  return (
    <div className="capoverlay" onMouseDown={(e) => e.target === e.currentTarget && !text.trim() && close()}>
      <DesktopSheet fade={fade} onClose={close}>
        <form onSubmit={submit}>
          <input
            className="capinput"
            autoFocus
            aria-label={`Capture to ${place}`}
            readOnly={!!saved}
            maxLength={MAX_TITLE}
            value={text}
            placeholder="Type a thought"
            onChange={(e) => setText(e.target.value)}
          />
          {details && !saved && (
            <div className="capdetails">
              <div className="capfield">
                <label htmlFor={ids.where}>Send to</label>
                {whereSelect}
              </div>
              {milestoneSelect && (
                <div className="capfield">
                  <label htmlFor={ids.milestone}>Milestone</label>
                  {milestoneSelect}
                </div>
              )}
              {slider}
            </div>
          )}
          <div className="capfoot">
            {/* Mounted empty from the start: screen readers skip a live region that arrives already filled. */}
            <span className="capstatus" role="status">
              {saved && (
                <>
                  <span aria-hidden="true">✓ </span>
                  {saved}
                </>
              )}
            </span>
            {!saved && (
              <>
                <span className="row">
                  <span>Saves to {place}</span>
                  {detailsToggle('capact')}
                </span>
                <span className="row capkeys">
                  <button className="capact" type="button" onClick={close}>
                    <kbd className="keycap" aria-hidden="true">
                      esc
                    </kbd>
                    Cancel
                  </button>
                  <button className={`capact${text.trim() ? ' ready' : ''}`} type="submit">
                    <kbd className="keycap" aria-hidden="true">
                      ↵
                    </kbd>
                    Save
                  </button>
                </span>
              </>
            )}
          </div>
        </form>
      </DesktopSheet>
    </div>
  );
}

function DesktopSheet(props: { fade: boolean; onClose(): void; children: ReactNode }) {
  const ref = useDialogFocus<HTMLDivElement>(props.onClose);
  return (
    <div ref={ref} className={`capsheet${props.fade ? ' fade' : ''}`} role="dialog" aria-modal="true" aria-label="Capture" tabIndex={-1}>
      {props.children}
    </div>
  );
}
