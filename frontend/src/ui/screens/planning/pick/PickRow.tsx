// A task in Pick, the same at both sizes: a circle that finishes it, its title and why, and one time button. The
// button adds the suggested part, or all that's left, at once; once the task is in the week it opens This week and the
// estimate. A picked row is tinted, blue, or purple for a one off. A ticked one is struck through where it is.

import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { formatMinutes } from '../../../../core/dates';
import { NoteMark } from '../../../components/notes/NoteMark';
import { useOpenTask } from '../../../components/task/TaskName';
import { CheckCircle } from '../../../components/TaskRow';
import { allOnCalendar, weekText } from './model';
import type { PickTask } from './model';
import type { PickProps } from './PickStep';
import type { Selection } from './Select';
import { TimePopover } from './TimePopover';

/** What a row's time button says, and its name: '+ 1h', '2h of 4h', '15m on calendar', 'On the calendar'. */
export function timeWords(r: PickTask) {
  const t = r.c.task;
  const none = t.estimate_min == null && t.remaining_min == null;
  if (r.c.picked && allOnCalendar(r.c)) {
    return { text: weekText(r.c), name: `${formatMinutes(r.c.ahead)} of ${r.title} on your calendar this week`, opens: true };
  }
  if (r.c.picked) {
    const shown = r.c.week < r.c.left ? `${formatMinutes(r.c.week)} of ${formatMinutes(r.c.left)}` : formatMinutes(r.c.week);
    return { text: shown, name: `${shown} this week: ${r.title}`, opens: true };
  }
  // All of it is on this week's calendar already, so there's nothing to add.
  if (!r.c.left && r.c.placed && !none) return { text: 'On the calendar', name: '', opens: false, full: true };
  if (!r.adds) return { text: '+ Add', name: `Add to this week: ${r.title}`, opens: true };
  return { text: `+ ${formatMinutes(r.adds)}`, name: `Add ${formatMinutes(r.adds)} to this week: ${r.title}`, opens: false };
}

/** The line under the title: why it's suggested, a date, or that it has no estimate. Picked, the tint says so. */
function Why(props: { row: PickTask; selecting: boolean }) {
  const { row: r } = props;
  const t = r.c.task;
  if (r.done) return null;
  // Selecting, the only tint is the selection, so being in the week is said in words.
  if (props.selecting && r.c.picked) return <span className="tm">In this week · {weekText(r.c)}</span>;
  const suggested = !r.c.picked && r.hint;
  const rest = r.note.replace(/^Suggested: [^.]*(\. )?/, '');
  const none = t.estimate_min == null && t.remaining_min == null && !r.c.picked;
  if (!suggested && !rest && !none) return null;
  return (
    <span className="tm">
      {suggested && (
        <>
          <span className="why">★ Suggested</span>: {r.hint!.why.replace(/^Suggested: /, '')}
          {rest && '. '}
        </>
      )}
      {rest}
      {none && !suggested && !rest && 'No estimate'}
    </span>
  );
}

export function PickRow(props: PickProps & { row: PickTask; phone: boolean; select?: Selection }) {
  const { row: r, phone } = props;
  const selecting = !!props.select?.on;
  const chosen = !!props.select?.has(r);
  const openTask = useOpenTask();
  const [open, setOpen] = useState(false);
  const timeRef = useRef<HTMLButtonElement>(null);
  const [tipOff, setTipOff] = useState(false);
  const done = props.isDone(r);
  const time = timeWords(r);
  const close = () => {
    setOpen(false);
    timeRef.current?.focus();
  };
  const pill = (
    <button
      ref={timeRef}
      className={`tp${r.c.picked ? ' on' : ''}${r.oneOff ? ' oo' : ''}`}
      type="button"
      aria-label={time.name}
      aria-haspopup={time.opens ? 'dialog' : undefined}
      aria-expanded={time.opens && r.c.picked ? open : undefined}
      onClick={() => (time.opens ? setOpen(!open) : props.add(r))}
    >
      {time.text}
      {r.c.picked && (
        <span className="tv" aria-hidden="true">
          {' '}
          ▾
        </span>
      )}
    </button>
  );
  return (
    <li className={`tk editrow${r.c.picked && !done && !selecting ? ' on' : ''}${chosen ? ' chk' : ''}${r.oneOff ? ' oo' : ''}${done ? ' done' : ''}`}>
      {selecting ? (
        <span className="ckt">
          {!done && (
            <input
              className="selbox"
              type="checkbox"
              aria-label={`Select ${r.title}${r.c.picked ? ', in this week' : ''}`}
              checked={chosen}
              onChange={() => props.select!.toggle(r)}
            />
          )}
        </span>
      ) : (
      /* The tooltip says what the circle's name says, so Voice Control's "Click Already done" matches it. */
      <span
        className={`ckt${tipOff ? ' tipoff' : ''}`}
        onKeyDown={(event: KeyboardEvent) => event.key === 'Escape' && setTipOff(true)}
        onBlur={() => setTipOff(false)}
        onPointerLeave={() => setTipOff(false)}
      >
        <CheckCircle checked={done} label={`Already done: ${r.title}`} onChange={(on) => (on ? props.markDone(r) : props.undoDone(r))} />
        <span className="tip" aria-hidden="true">
          Already done
        </span>
      </span>
      )}
      <span className="tkw">
        <button className="tt" type="button" aria-haspopup="dialog" aria-label={`Edit task ${r.title}${done ? ', done' : ''}`} onClick={() => openTask(r.c.task.id, r.note)}>
          {r.title}
          {r.c.task.notes && <NoteMark />}
        </button>
        <Why row={r} selecting={selecting} />
      </span>
      {done || (selecting && r.c.picked) ? (
        <span />
      ) : selecting ? (
        <span className="tq">{r.adds ? formatMinutes(r.adds) : time.full ? time.text : 'No estimate'}</span>
      ) : time.full ? <span className="tq">{time.text}</span> : phone ? <span className="tpw">{pill}</span> : pill}
      {open && !done && (
        <TimePopover
          row={r}
          phone={phone}
          onSave={(week, estimate) => props.saveTime(r, week, estimate)}
          onDone={() => {
            setOpen(false);
            props.markDone(r, true);
          }}
          onRemove={() => {
            close();
            props.dropFromWeek(r);
          }}
          onClose={close}
        />
      )}
    </li>
  );
}
