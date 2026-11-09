// The missed blocks sheet: every block that ended unanswered, today's practices among them, oldest first. Each row
// answers itself, Finished, Partly or Not done (Did it, Some or Skipped for a practice), or Select mode answers several
// at once. Partly asks for the time left inside the sheet. Every answer saves at once with one Undo, and nothing is
// answered that you didn't press. On phone it's a sheet over the lower part of the screen; on desktop, a small dialog in
// the middle of the window. Later (Esc, a swipe down, or the button) puts it away until Today's Review row.

import { useEffect, useId, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { partlyLeft } from '../../../core/blocks';
import type { BlockAnswer } from '../../../core/blocks';
import { blockMinutes, formatMinutes, formatTime, formatWeekday, localDate } from '../../../core/dates';
import type { BlockRow } from '../../../core/queries';
import { getRecord } from '../../../core/records';
import type { Minutes } from '../../../core/types';
import { useApp, useQuery } from '../../app/store';
import { EST_STEPS } from '../EstimateSlider';
import { AnswerIcon, InfoIcon } from '../icons';
import { useFocusLanding } from '../useFocusLanding';
import { PromptFrame } from './BlockPrompts';
import { formatRange } from './describe';
import { useBlockActions } from './useBlockActions';
import './missed.css';

type Choice = BlockAnswer['result'];
const CHOICES: readonly Choice[] = ['done', 'partly', 'not'];

/** What the three answers are called, for work and for a practice. */
const WORDS: Record<'task' | 'practice', Record<Choice, string>> = {
  task: { done: 'Finished', partly: 'Partly', not: 'Not done' },
  practice: { done: 'Did it', partly: 'Some', not: 'Skipped' },
};

/** How far down a swipe on the sheet's top puts it away. */
const SWIPE_AWAY_PX = 72;

const nameOf = (b: BlockRow) => b.title ?? 'Time block';
const blocks = (n: number) => `${n} ${n === 1 ? 'block' : 'blocks'}`;
const andLater = (freed: number) => (freed ? `, and ${freed} later ${freed === 1 ? 'block' : 'blocks'}` : '');

/** Time left moves through the estimate's steps; a practice's minutes done move in 5s up to its length. */
function stepsFor(b: BlockRow): readonly Minutes[] {
  if (!b.practice_id) return EST_STEPS.filter((m) => m > 0);
  return Array.from({ length: Math.max(1, Math.floor(blockMinutes(b) / 5)) }, (_, i) => (i + 1) * 5);
}

function answerFor(b: BlockRow, choice: Choice, minutes: Minutes): BlockAnswer {
  if (b.practice_id) {
    if (choice === 'not') return { result: 'not', logged_min: 0 };
    return { result: 'done', logged_min: choice === 'done' ? blockMinutes(b) : minutes };
  }
  return choice === 'partly' ? { result: 'partly', remaining_min: minutes } : { result: choice };
}

/** The toast for one row: 'Draft chapter five: finished.' */
function saidOf(b: BlockRow, choice: Choice, minutes: Minutes, freed: number): string {
  const name = nameOf(b);
  if (b.practice_id) return { done: `${name}: did it.`, partly: `${name}: logged ${formatMinutes(minutes)}.`, not: `${name}: skipped.` }[choice];
  if (choice === 'done') return `${name}: finished${andLater(freed)}.`;
  return choice === 'partly' ? `${name}: partly, ${formatMinutes(minutes)} left.` : `${name}: not done. It's in Needs a new time.`;
}

function Stepper(props: { block: BlockRow; value: Minutes; onChange(minutes: Minutes): void }) {
  const { block, value } = props;
  const steps = stepsFor(block);
  const less = steps.filter((m) => m < value).at(-1);
  const more = steps.find((m) => m > value);
  const what = block.practice_id ? 'done' : 'left';
  return (
    <div className="missstepper">
      <button type="button" aria-label={`Less time ${what}: ${nameOf(block)}`} disabled={less == null} onClick={() => less != null && props.onChange(less)}>
        −
      </button>
      <span aria-live="polite">
        {formatMinutes(value)} {what}
      </span>
      <button type="button" aria-label={`More time ${what}: ${nameOf(block)}`} disabled={more == null} onClick={() => more != null && props.onChange(more)}>
        +
      </button>
    </div>
  );
}

export function MissedSheet(props: { blocks: readonly BlockRow[]; onClose(): void }) {
  const count = props.blocks.length;
  return (
    <PromptFrame label={`${count} missed ${count === 1 ? 'block' : 'blocks'}`} onClose={props.onClose} sheet="missed">
      <MissedRows {...props} />
    </PromptFrame>
  );
}

/** Inside the sheet, so its effect runs before the sheet's own, and focus can start on a row. */
function MissedRows(props: { blocks: readonly BlockRow[]; onClose(): void }) {
  const { blocks: rows } = props;
  const { clock, layout } = useApp();
  const actions = useBlockActions();
  const land = useFocusLanding();
  const [selecting, setSelecting] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  /** The rows in the Partly step, and where Back returns to. */
  const [step, setStep] = useState<{ ids: readonly string[]; from: 'row' | 'bar' } | null>(null);
  const [minutes, setMinutes] = useState<Readonly<Record<string, Minutes>>>({});
  const [showKey, setShowKey] = useState(false);
  const keyId = useId();
  const top = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const taskIds = [...new Set(rows.flatMap((b) => (b.task_id ? [b.task_id] : [])))];
  const tasks = useQuery((sql) => Promise.all(taskIds.map((id) => getRecord(sql, 'task', id))), [taskIds.join()]).data;

  const ids = rows.map((b) => b.id);
  const selected = rows.filter((b) => ticked.has(b.id));
  const stepRows = step ? rows.filter((b) => step.ids.includes(b.id)) : [];
  const stepping = stepRows.length > 0;
  const zone = clock.zone();
  const today = localDate(clock.now(), zone);
  const day = (b: BlockRow) => (localDate(b.start, zone) === today ? 'Today' : formatWeekday(localDate(b.start, zone)));
  const practice = (b: BlockRow) => (b.practice_id ? ' · practice' : '');

  /** Where Partly starts: what was left before, or for a practice half its length. */
  const startOf = (b: BlockRow): Minutes => {
    if (b.practice_id) return Math.max(5, Math.round(blockMinutes(b) / 10) * 5);
    const task = tasks?.find((t) => t?.id === b.task_id);
    return task ? partlyLeft(task, b) : blockMinutes(b);
  };
  const valueOf = (b: BlockRow) => minutes[b.id] ?? startOf(b);

  const rowEl = (id: string) => [...(list.current?.querySelectorAll<HTMLElement>('[data-id]') ?? [])].find((el) => el.dataset.id === id);
  /** Once rows have left: focus the next row (at `part` in it, if given), or the one before, or the title. */
  const landAfter = (gone: readonly string[], part?: string) => {
    const at = ids.findIndex((id) => gone.includes(id));
    const next = ids.slice(at).find((id) => !gone.includes(id)) ?? ids.slice(0, at).filter((id) => !gone.includes(id)).at(-1);
    land(() => {
      const row = next ? rowEl(next) : undefined;
      return (part && row?.querySelector<HTMLElement>(part)) || row || title.current;
    });
  };

  const leaveSelect = () => {
    setSelecting(false);
    setTicked(new Set());
  };
  // Focus stays on its row, which both modes share, or else moves from Select to Cancel and back.
  const toggleSelect = () => {
    const row = document.activeElement?.closest<HTMLElement>('[data-id]');
    land(() => (row?.isConnected ? row : top.current?.querySelector<HTMLElement>('[data-toggle]')));
    if (selecting) leaveSelect();
    else setSelecting(true);
    setShowKey(false);
  };
  const tick = (id: string) =>
    setTicked((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const openStep = (gone: readonly string[], from: 'row' | 'bar') => {
    setStep({ ids: gone, from });
    setShowKey(false);
    land(() => title.current);
  };
  const back = () => {
    const from = step;
    setStep(null);
    setMinutes({});
    land(() => (from?.from === 'row' ? rowEl(from.ids[0]!)?.querySelector<HTMLElement>('[data-answer="partly"]') : list.current?.parentElement?.querySelector<HTMLElement>('.missbar [data-answer="partly"]')));
  };

  const answerRow = (b: BlockRow, choice: Choice, part?: string) => {
    if (actions.pending) return;
    if (choice === 'partly') return openStep([b.id], 'row');
    landAfter([b.id], part);
    void actions.answerAll([{ blockId: b.id, answer: answerFor(b, choice, 0) }], (freed) => saidOf(b, choice, 0, freed));
  };
  const answerSelected = (choice: Choice) => {
    if (actions.pending || selected.length === 0) return;
    if (choice === 'partly') return openStep(selected.map((b) => b.id), 'bar');
    const answering = selected;
    landAfter(answering.map((b) => b.id));
    void actions
      .answerAll(
        answering.map((b) => ({ blockId: b.id, answer: answerFor(b, choice, 0) })),
        (freed) => `Answered ${blocks(answering.length)}${andLater(freed)}.`,
      )
      .then((saved) => saved && leaveSelect());
  };
  const save = () => {
    if (actions.pending) return;
    const answering = stepRows;
    const only = answering.length === 1 ? answering[0] : undefined;
    landAfter(answering.map((b) => b.id));
    void actions
      .answerAll(
        answering.map((b) => ({ blockId: b.id, answer: answerFor(b, 'partly', valueOf(b)) })),
        (freed) => (only ? saidOf(only, 'partly', valueOf(only), freed) : `Answered ${blocks(answering.length)}${andLater(freed)}.`),
      )
      .then((saved) => {
        if (!saved) return;
        setStep(null);
        setMinutes({});
        leaveSelect();
      });
  };

  // The keys, read before the dialog's own Esc: arrows move between rows, 1 2 3 answer, I shows the key, S toggles
  // Select, Space ticks and A selects all there. Esc with the key open puts the key away rather than the sheet, and
  // with focus fallen to the page, as after the toast's Undo, it's still Later.
  const onKey = (event: KeyboardEvent, outside: boolean) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape' && (showKey || outside)) {
      event.stopImmediatePropagation();
      if (showKey) setShowKey(false);
      else props.onClose();
      return;
    }
    if (stepping) return;
    const active = document.activeElement as HTMLElement | null;
    const here = active?.closest<HTMLElement>('[data-id]');
    const row = here ? rows.find((b) => b.id === here.dataset.id) : undefined;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      const at = row ? ids.indexOf(row.id) : key === 'ArrowDown' ? -1 : ids.length;
      const to = ids[Math.min(ids.length - 1, Math.max(0, at + (key === 'ArrowDown' ? 1 : -1)))];
      if (to) rowEl(to)?.focus();
    } else if (key === '1' || key === '2' || key === '3') {
      const choice = CHOICES[Number(key) - 1]!;
      if (selecting) answerSelected(choice);
      else if (row) answerRow(row, choice);
    } else if (key === 'i') {
      setShowKey((open) => !open);
    } else if (key === 's') {
      toggleSelect();
    } else if (key === 'a' && selecting) {
      setTicked(new Set(ids));
    } else if (key === ' ' && selecting && row && active === here) {
      tick(row.id);
    } else {
      return;
    }
    event.preventDefault();
  };
  const keys = useRef(onKey);
  keys.current = onKey;
  useEffect(() => {
    const dialog = top.current?.closest<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    // Keys pressed inside the dialog, or with focus fallen to the page, are the sheet's; anywhere else they aren't.
    // Captured, so they arrive before the dialog's own Esc.
    const listen = (event: KeyboardEvent) => {
      const active = document.activeElement;
      const outside = !active || active === document.body;
      if (outside || dialog.contains(active)) keys.current(event, outside);
    };
    document.addEventListener('keydown', listen, true);
    // On desktop, the first row takes focus, ready for the keys. On phone the dialog does, so its name is read first.
    if (layout === 'desktop') list.current?.querySelector<HTMLElement>('[data-id]')?.focus();
    return () => document.removeEventListener('keydown', listen, true);
  }, [layout]);

  // A swipe down from the sheet's top puts it away, as Later does. Moves and the release are read from the window,
  // since a finger soon leaves the strip it started on.
  const swipe = (event: ReactPointerEvent<HTMLElement>) => {
    if (layout !== 'phone' || (event.target as Element).closest('button, input, label')) return;
    const sheet = event.currentTarget.closest<HTMLElement>('[role="dialog"]');
    if (!sheet) return;
    const from = event.clientY;
    let down = 0;
    const move = (e: PointerEvent) => {
      down = Math.max(0, e.clientY - from);
      sheet.style.transform = down ? `translateY(${down}px)` : '';
    };
    const end = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      sheet.style.transform = '';
      if (e.type === 'pointerup' && down >= SWIPE_AWAY_PX) props.onClose();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const heading = stepping
    ? stepRows.every((b) => b.practice_id)
      ? 'How much did you do?'
      : 'How much is left?'
    : `${rows.length} missed ${rows.length === 1 ? 'block' : 'blocks'}`;

  return (
    <>
      <div className="misstop" ref={top} onPointerDown={swipe}>
        {layout === 'phone' && <div className="missgrab" aria-hidden="true" />}
        <div className="misshead">
          {selecting && !stepping ? (
            <>
              <button type="button" className="link" onClick={() => setTicked(new Set(ids))}>
                Select all
              </button>
              <span className="misscount" role="status">
                {selected.length} selected
              </span>
              <button type="button" className="link" data-toggle onClick={toggleSelect}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <h2 ref={title} tabIndex={-1}>
                {heading}
              </h2>
              {!stepping && (
                <>
                  <button
                    type="button"
                    className="missinfo"
                    aria-label="What the icons mean"
                    aria-expanded={showKey}
                    aria-controls={keyId}
                    onClick={() => setShowKey((open) => !open)}
                  >
                    <InfoIcon />
                  </button>
                  <span className="grow" />
                  <button type="button" className="link" aria-pressed="false" data-toggle onClick={toggleSelect}>
                    Select
                  </button>
                </>
              )}
            </>
          )}
        </div>
        {showKey && !selecting && !stepping && (
          <div id={keyId} className="misskey" role="group" aria-label="Key">
            {CHOICES.map((c) => (
              <div key={c} className="misskeyrow">
                <AnswerIcon answer={c} />
                {c === 'partly' ? 'Partly, some is left' : WORDS.task[c]}
              </div>
            ))}
            {rows.some((b) => b.practice_id) && <div className="small quiet">For a practice: Did it, Some and Skipped.</div>}
          </div>
        )}
      </div>

      <div className="misslist" ref={list}>
        {stepping ? (
          <>
            {stepRows.map((b) => (
              <div key={`step:${b.id}`} className="missstep" role="group" aria-label={nameOf(b)}>
                <div className="missname">{nameOf(b)}</div>
                <Stepper block={b} value={valueOf(b)} onChange={(m) => setMinutes((all) => ({ ...all, [b.id]: m }))} />
              </div>
            ))}
            {stepRows.length > 1 && stepRows.some((b) => !b.practice_id) && <p className="small quiet">Each starts at what was left before.</p>}
          </>
        ) : (
          rows.map((b) => (
            <div key={b.id} className="missrow" role="group" aria-label={nameOf(b)} data-id={b.id} tabIndex={-1}>
              {selecting ? (
                <label className="misstick">
                  <input type="checkbox" aria-label={nameOf(b)} checked={ticked.has(b.id)} onChange={() => tick(b.id)} />
                  <span className="missname grow">{nameOf(b)}</span>
                  <span className="small quiet">
                    {day(b)} {formatTime(b.start, zone)}
                    {practice(b)}
                  </span>
                </label>
              ) : (
                <>
                  <div className="misstext grow">
                    <div className="missname">{nameOf(b)}</div>
                    <div className="small quiet">
                      {day(b)} {formatRange(b.start, b.end, zone)}
                      {practice(b)}
                    </div>
                  </div>
                  {CHOICES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="missans"
                      data-answer={c}
                      aria-label={`${WORDS[b.practice_id ? 'practice' : 'task'][c]}: ${nameOf(b)}`}
                      title={WORDS[b.practice_id ? 'practice' : 'task'][c]}
                      disabled={actions.pending}
                      onClick={() => answerRow(b, c, `[data-answer="${c}"]`)}
                    >
                      <AnswerIcon answer={c} />
                    </button>
                  ))}
                </>
              )}
            </div>
          ))
        )}
      </div>

      <div className="missbar">
        {stepping ? (
          <>
            <button key="back" type="button" className="btn" onClick={back}>
              Back
            </button>
            <button key="save" type="button" className="btn pri grow" disabled={actions.pending} onClick={save}>
              {stepRows.length > 1 ? `Save ${stepRows.length} answers` : 'Save'}
            </button>
          </>
        ) : selecting ? (
          <>
            {selected.some((b) => b.practice_id) && <p key="note" className="small quiet missnote">For a practice, Finished counts as Did it.</p>}
            {CHOICES.map((c) => (
              <button
                key={c}
                type="button"
                className="btn grow"
                data-answer={c}
                disabled={selected.length === 0 || actions.pending}
                onClick={() => answerSelected(c)}
              >
                <AnswerIcon answer={c} />
                {WORDS.task[c]}
              </button>
            ))}
          </>
        ) : (
          <button key="later" type="button" className="link misslater" onClick={props.onClose}>
            Later
          </button>
        )}
      </div>
    </>
  );
}
