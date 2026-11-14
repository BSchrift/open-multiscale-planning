// Everything that needs you and isn't in the week or answered, counted before Continue: questions to answer, tasks
// that need a new time, and work due or overdue not in the week. On desktop it's a line over Continue, on phone a
// one-line strip over the bottom bar, and at 0 it says so, so its absence never means it broke. It never blocks. Show
// opens a dialog that lists them by reason, each naming its project, to answer or add right there; a title goes to it
// in its project. Esc gives focus back to Show, or to Continue once nothing is left.

import { useId, useRef, useState } from 'react';
import { formatMinutes } from '../../../../core/dates';
import { Sheet } from '../../../components/Sheet';
import { needWords } from './model';
import type { NeedItem, PickView } from './model';
import type { PickProps } from './PickStep';

export function needOf(view: PickView) {
  const { questions, newTime, due } = view.needYou;
  return { words: needWords(view.needYou), names: [...questions, ...newTime, ...due].map((i) => i.title).join(', ') };
}

/** Where an item is in the list: a task's row, or the question asked on a milestone's line or a project past its end. */
const placeOf = (item: NeedItem) => document.querySelector<HTMLElement>(item.row ? `[data-task="${item.row.c.task.id}"]` : `[data-ask="${item.key.slice(2)}"]`);

/** The line, or the strip, with Show and the dialog it opens. */
export function NeedYou(props: PickProps & { phone: boolean }) {
  const { view, phone } = props;
  const [open, setOpen] = useState(false);
  const showRef = useRef<HTMLButtonElement>(null);
  const { words } = needOf(view);
  const { n } = words;
  const close = () => {
    setOpen(false);
    // The dialog gives focus back to Show; with nothing left, Show has gone, so it goes to Continue.
    setTimeout(() => {
      if (!document.activeElement || document.activeElement === document.body) document.querySelector<HTMLElement>('[data-continue]')?.focus();
    });
  };
  // A title goes to it in its project; Answer also opens the question there on phone, where it starts as one line.
  const go = (item: NeedItem, answer: boolean) => {
    close();
    setTimeout(() => {
      const place = placeOf(item);
      if (!place) return;
      place.scrollIntoView?.({ block: 'center' });
      if (answer) {
        const opener = place.querySelector<HTMLElement>('.answer[aria-expanded="false"]');
        opener?.click();
        place.focus({ preventScroll: true });
      } else place.querySelector<HTMLElement>('.tt, button')?.focus({ preventScroll: true });
    });
  };
  const show = n > 0 && (
    <button ref={showRef} className="link small" type="button" aria-haspopup="dialog" aria-label={phone ? words.link : `Show the ${n} that need you`} onClick={() => setOpen(true)}>
      {phone ? 'Show' : `Show the ${n}`}
    </button>
  );
  return (
    <>
      {phone ? (
        <div className="needstrip small">
          <span className="needw">
            {n > 0 ? (
              <>
                <strong>{n} need you</strong> · {words.short}
              </>
            ) : (
              words.short
            )}
          </span>
          {show}
        </div>
      ) : (
        <div className="needyou small">
          {n > 0 ? (
            <>
              <strong>{n} need you:</strong> {words.line} {show}
            </>
          ) : (
            words.line
          )}
        </div>
      )}
      {open && <NeedDialog {...props} onClose={close} onGo={go} />}
    </>
  );
}

function NeedDialog(props: PickProps & { phone: boolean; onClose(): void; onGo(item: NeedItem, answer: boolean): void }) {
  const { view } = props;
  const { words } = needOf(view);
  const id = useId();
  const groups: [string, NeedItem[], 'answer' | 'add'][] = [
    ['To answer', view.needYou.questions, 'answer'],
    ['Needs a new time', view.needYou.newTime, 'answer'],
    ['Due or overdue, not in the week', view.needYou.due, 'add'],
  ];
  return (
    <Sheet label={`Need you (${words.n})`} onClose={props.onClose}>
      <div className="between">
        <h2>Need you ({words.n})</h2>
        <button className="btn" type="button" onClick={props.onClose}>
          Close
        </button>
      </div>
      {words.n === 0 && <p className="small">{words.line}</p>}
      {groups.map(([head, items, kind], i) =>
        items.length ? (
          <section key={head} className="needgrp" aria-labelledby={`${id}-${i}`}>
            <h3 id={`${id}-${i}`} className="needh">
              {head} ({items.length})
            </h3>
            <ul className="picklist">
              {items.map((item) => (
                <li key={item.key} className="needrow">
                  <span className="tkw">
                    <button className="tt" type="button" onClick={() => props.onGo(item, false)}>
                      {item.title}
                    </button>
                    <span className="tm">
                      {item.where} · {item.why}
                    </span>
                  </span>
                  {kind === 'add' && item.row?.adds ? (
                    <button className="tp" type="button" aria-label={`Add ${formatMinutes(item.row.adds)} to this week: ${item.title}, ${item.where}`} onClick={() => props.add(item.row!)}>
                      + {formatMinutes(item.row.adds)}
                    </button>
                  ) : (
                    <button className="link answer" type="button" aria-label={`${kind === 'add' ? 'Go to' : 'Answer:'} ${item.title}`} onClick={() => props.onGo(item, kind === 'answer')}>
                      {kind === 'add' ? 'Go to it' : 'Answer'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
      <p className="small quiet">A title goes to it in its project.</p>
    </Sheet>
  );
}
