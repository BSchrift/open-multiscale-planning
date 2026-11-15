// Capture: one field. Enter saves to the Inbox and Esc cancels. Add details is optional and folded away. It opens with
// Time first, right under the name, then Send to, where choosing a project, and then one of its milestones, or One offs
// skips the Inbox, then a description, in which Enter makes a new line and ⌘Enter saves, then attachments, which upload
// once the task is saved. A goal's backlog can take it straight away too, with no milestone.
// Opened from a hold on a calendar, it's given that time: it says the day and time, the task is saved with a block
// there, Time is the block's length, and Save's toast has Undo. On desktop it opens beside the draft, with no scrim.

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { addToBacklog, backlogTitle, isBacklog } from '../../../core/backlog';
import { placeBlock } from '../../../core/blocks';
import { captureTitle, MAX_TITLE } from '../../../core/captureTitle';
import { nowInstant } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange, RecordWrite } from '../../../core/plan';
import { inboxCount } from '../../../core/queries';
import { listRecords } from '../../../core/records';
import { GRID, slotInstants } from '../../../core/slots';
import type { Slot } from '../../../core/slots';
import type { Fields, LocalDate, Minutes } from '../../../core/types';
import type { Layout, ScreenProps } from '../../app/registry';
import { useApp, useMutation, useQuery, useToday } from '../../app/store';
import { DraftAttachments, recordOf } from '../../components/attachments/Attachments';
import { dayWord } from '../../components/blocks/describe';
import type { NewAttachment } from '../../components/attachments/Attachments';
import { EstimateSlider } from '../../components/EstimateSlider';
import { NotesField } from '../../components/notes/NotesField';
// From draft rather than the folder's index, so the app's first chunk doesn't carry the one off form and row.
import { emptyDraft, oneOffFields } from '../../components/oneoff/draft';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { useDialogFocus } from '../../components/useDialogFocus';
import { dayName, slotRange } from '../../components/weekgrid';
import './capture.css';
import { Button } from '../../components/ds/Button';
import { Icon } from '../../components/ds/Icon';

const ONE_OFFS = 'oneoffs';
/** A goal's backlog in the Send to choice: `b:<goal id>`. */
const BACKLOG = 'b:';
/** How long desktop shows what it saved before it fades and closes. */
const SAVED_MS = 700;
const FADE_MS = 120;
/** On desktop, how far from the draft Capture opens beside it, and how far up it starts, so its first line meets it. */
const BESIDE_PX = 8;
const RISE_PX = 12;

/**
 * A time on a calendar, which a hold there made, for the new task's block. The calendar keeps the draft and draws it, so
 * another way of filling the time could use the same draft.
 */
export interface CaptureSlot {
  /** The draft's day, start and end. */
  slot: Slot;
  /** Why the draft isn't quite where it was held: kept within the day, or out of the time gone by. */
  note?: string | undefined;
  /** What the draft overlaps, such as "Overlaps Team sync prep by 15m." */
  overlap?: string | undefined;
  /** Time moved: the draft takes the new length as the slider moves. */
  onLength(minutes: Minutes): void;
  /** The name as it's typed, for the draft to show. */
  onName?(name: string): void;
  /** Where the draft is on screen, so desktop opens Capture beside it. */
  anchor?(): DOMRect | undefined;
}

function fieldsFor(title: string, where: string, milestone: string, est: Minutes, notes: string, today: LocalDate): Fields<'task'> {
  const described = notes.trim() ? { notes } : {};
  if (where === ONE_OFFS) return { ...oneOffFields({ ...emptyDraft(today), title, estimate: est }, today), ...described };
  if (where) return { kind: 'project', project_id: where, milestone_id: milestone || null, title, estimate_min: est || null, ...described };
  return { kind: 'inbox', title, estimate_min: est || null, ...described };
}

export default function Screen(props: ScreenProps) {
  return <Capture layout={props.layout} close={props.close} />;
}

export function Capture(props: { layout: Layout; close(): void; slot?: CaptureSlot | undefined }) {
  const { layout, close, slot } = props;
  const today = useToday();
  const toast = useToast();
  const { platform, clock } = useApp();
  const projects = useQuery((sql) => listRecords(sql, 'project'), []).data?.filter((p) => p.state === 'active' && !isBacklog(p)) ?? [];
  const goals = useQuery((sql) => listRecords(sql, 'objective'), []).data?.filter((g) => g.state !== 'archived') ?? [];
  const [text, setText] = useState('');
  const [details, setDetails] = useState(false);
  const [where, setWhere] = useState('');
  const [milestone, setMilestone] = useState('');
  // The chosen project's open milestones, soonest due first.
  const milestones =
    useQuery(
      async (sql) =>
        where && where !== ONE_OFFS && !where.startsWith(BACKLOG)
          ? (await listRecords(sql, 'milestone'))
              .filter((m) => m.project_id === where && !m.met_at && !m.dropped_at)
              .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.title.localeCompare(b.title))
          : [],
      [where],
    ).data ?? [];
  const [estimate, setEstimate] = useState<Minutes>(0);
  // With a time, Time is the block's length, which the calendar keeps, never under a quarter hour.
  const est = slot ? slot.slot.end - slot.slot.start : estimate;
  const setTime = (minutes: Minutes) => (slot ? slot.onLength(Math.max(GRID, minutes)) : setEstimate(minutes));
  const [notes, setNotes] = useState('');
  const [drafts, setDrafts] = useState<NewAttachment[]>([]);
  const form = useRef<HTMLFormElement>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [fade, setFade] = useState(false);
  const ids = { field: useId(), where: useId(), milestone: useId() };
  const save = useMutation(async (w, fields: Fields<'task'>, drafts: readonly NewAttachment[], at: Slot | undefined) => {
    const goal = where.startsWith(BACKLOG) ? where.slice(BACKLOG.length) : null;
    const task = goal ? await addToBacklog(w, goal, fields, clock) : await w.create('task', fields);
    // Each attachment goes in with the task; a photo's bytes are kept once both are saved.
    const kept: [string, Blob][] = [];
    const attached: string[] = [];
    for (const a of drafts) {
      const id = await w.create('attachment', { task_id: task, ...recordOf(a) });
      attached.push(id);
      if (a.kind === 'photo') kept.push([id, a.file]);
    }
    const placed = at ? await placeBlock(w, task, slotInstants(at, clock.zone()), clock) : null;
    // Undo takes away what this made: the block, the attachments and the task.
    const gone = { deleted_at: nowInstant(clock) };
    const undo: PlanChange = {
      writes: [
        ...(placed?.writes ?? []),
        ...attached.map((id): RecordWrite => ({ type: 'attachment', id, fields: gone })),
        { type: 'task', id: task, fields: gone },
      ],
    };
    return { waiting: await inboxCount(w.sql), kept, undo };
  });
  const revert = useMutation((w, change: PlanChange) => applyPlanChange(w, change));

  const project = projects.find((p) => p.id === where)?.title;
  const goal = goals.find((g) => `${BACKLOG}${g.id}` === where)?.title;
  const ms = milestones.find((m) => m.id === milestone)?.title;
  const place = where === ONE_OFFS ? 'One offs' : goal ? `the backlog for ${goal}` : project ? (ms ? `${project}, ${ms}` : project) : 'Inbox';
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
    const done = await save.run(fieldsFor(title, where, milestone, est, notes, today), drafts, slot?.slot);
    if (done === undefined) return;
    const { waiting, kept, undo } = done;
    for (const [id, file] of kept) await platform.files.put(id, file);
    if (slot) {
      const at = slot.slot;
      toast.show(`Saved to ${place}, ${at.date === today ? '' : `${dayName(at.date)}, `}${slotRange(at)}`, { undo: () => revert.run(undo) });
      close();
      return;
    }
    const message = where ? `Saved to ${place}` : phone ? 'Saved to Inbox' : `Saved to Inbox, ${waiting} waiting`;
    if (phone) {
      toast.show(message);
      close();
    } else {
      setText('');
      setNotes('');
      setDrafts([]);
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
      {goals.map((g) => (
        <option key={g.id} value={`${BACKLOG}${g.id}`}>
          {backlogTitle(g.title)}
        </option>
      ))}
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
  const slider = <EstimateSlider label="Time" value={est} onChange={setTime} {...(slot ? { onMove: setTime } : {})} />;
  // Under the name: when the new task's block will be, and what it overlaps or why it moved.
  const when = slot && (
    <>
      <p className="capwhen">
        <Icon name="calendar" size={16} />
        <span>
          {dayWord(slot.slot.date, today)}, {slotRange(slot.slot)}
        </span>
      </p>
      {slot.overlap && (
        <p className="capwhen">
          <Icon name="warning" size={16} />
          <span>{slot.overlap}</span>
        </p>
      )}
      {slot.note && (
        <p className="capwhen">
          <Icon name="info" size={16} />
          <span>{slot.note}</span>
        </p>
      )}
    </>
  );
  const description = <NotesField value={notes} onChange={setNotes} onSubmit={() => form.current?.requestSubmit()} />;
  const attachments = <DraftAttachments drafts={drafts} onChange={setDrafts} />;
  const detailsToggle = (className: string) => (
    <button className={className} type="button" aria-expanded={details} onClick={() => setDetails(!details)}>
      {details ? 'Hide details' : 'Add details'}
    </button>
  );

  if (phone) {
    return (
      <Sheet label="Capture" onClose={close}>
        <form ref={form} className="stack capform" onSubmit={submit}>
          <label className="strong" htmlFor={ids.field}>
            Capture to {place}
          </label>
          {when}
          <input
            id={ids.field}
            className="field"
            autoFocus
            maxLength={MAX_TITLE}
            value={text}
            placeholder="What's on your mind?"
            onChange={(e) => {
              setText(e.target.value);
              slot?.onName?.(e.target.value);
            }}
          />
          <div>{detailsToggle('link')}</div>
          {details && (
            <>
              {slider}
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
              {description}
              {attachments}
            </>
          )}
          {slot ? (
            // A draft is on the calendar, which Cancel takes away.
            <div className="capbtns">
              <Button type="button" onClick={close}>
                Cancel
              </Button>
              <Button variant="primary" type="submit">
                Save
              </Button>
            </div>
          ) : (
            <Button variant="primary" type="submit">
              Save
            </Button>
          )}
        </form>
      </Sheet>
    );
  }

  const desktop = (
    <div className={`capoverlay${slot ? ' beside' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && !text.trim() && close()}>
      <DesktopSheet fade={fade} onClose={close} {...(slot?.anchor ? { anchor: slot.anchor } : {})}>
        <form ref={form} onSubmit={submit}>
          <input
            className="capinput"
            autoFocus
            aria-label={`Capture to ${place}`}
            readOnly={!!saved}
            maxLength={MAX_TITLE}
            value={text}
            placeholder="Type a thought"
            onChange={(e) => {
              setText(e.target.value);
              slot?.onName?.(e.target.value);
            }}
          />
          {when}
          {details && !saved && (
            <div className="capdetails">
              {slider}
              <div className="capplace">
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
              </div>
              {description}
              {attachments}
            </div>
          )}
          <div className="capfoot">
            {/* Mounted empty from the start: screen readers skip a live region that arrives already filled. */}
            <span className="capstatus" role="status">
              {saved && (
                <>
                  <Icon name="done" size={16} />{' '}
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
  // From a calendar it's drawn at the layout's root, as a sheet is, so nothing on the page can hold it under the page.
  const root = slot ? document.querySelector<HTMLElement>('[data-layout]') : null;
  return root ? createPortal(desktop, root) : desktop;
}

function DesktopSheet(props: { fade: boolean; onClose(): void; anchor?(): DOMRect | undefined; children: ReactNode }) {
  const ref = useDialogFocus<HTMLDivElement>(props.onClose);
  // Beside the draft, on the side with room, its top level with the draft's and kept on screen. Again after each
  // render, since Add details makes it taller.
  useLayoutEffect(() => {
    const at = props.anchor?.();
    const el = ref.current;
    if (!at || !el) return;
    const after = at.right + BESIDE_PX;
    const left = after + el.offsetWidth > innerWidth - BESIDE_PX ? at.left - BESIDE_PX - el.offsetWidth : after;
    el.style.left = `${Math.max(BESIDE_PX, left)}px`;
    el.style.top = `${Math.max(BESIDE_PX, Math.min(at.top - RISE_PX, innerHeight - el.offsetHeight - BESIDE_PX))}px`;
  });
  return (
    <div ref={ref} className={`capsheet${props.fade ? ' fade' : ''}`} role="dialog" aria-modal="true" aria-label="Capture" tabIndex={-1}>
      {props.children}
    </div>
  );
}
