// The popup's frame, the same for everything that opens in it: a task, a practice and a planning block. A sheet on
// phone and a centred dialog on desktop. Top to bottom: its name, read as the heading, which a tap turns into a field to
// rename it; then its body, what can be done to it first and then its fields; then its bar, with the record's own way to
// go on the left, such as Delete task, then Cancel and Save. With nothing to save, as for planning, the bar has Close
// alone. Focus starts on the name, so the phone's keyboard stays down until a field is tapped.

import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode, Ref } from 'react';
import { MAX_TITLE } from '../../../core/captureTitle';
import { useApp } from '../../app/store';
import { LeavePopup } from '../../components/blocks/BlockSection';
import { Button } from '../../components/ds/Button';
import { Icon } from '../../components/ds/Icon';
import { Sheet } from '../../components/Sheet';

export function PopupShell(props: {
  /** The dialog's name: the title as saved. */
  label: string;
  /** The name as it's being edited. */
  name: string;
  /** Without it, the name is only the heading, as planning's is. */
  rename?(name: string): void;
  /** Esc, the backdrop and the close button: with changes not saved, it stays open and says so. Returns whether it closed. */
  leave(): boolean;
  close(): void;
  /** Under the name, such as why a task is suggested. */
  top?: ReactNode;
  /** What can be done to it first, then its fields. Actions that leave the popup for the calendar reach `leave`. */
  children: ReactNode;
  error?: string;
  /** The record's own way to go, at the bar's left, such as Delete task. */
  remove?: { label: string; run(): void };
  save?: { ref: Ref<HTMLButtonElement>; submit(event: FormEvent): void };
}) {
  const { layout } = useApp();
  const phone = layout === 'phone';
  const [renaming, setRenaming] = useState(false);
  const head = useRef<HTMLHeadingElement>(null);

  // After the dialog takes focus, which its own effect does first.
  useEffect(() => head.current?.focus(), []);

  const submit = (event: FormEvent) => (props.save ? props.save.submit(event) : event.preventDefault());
  return (
    <Sheet label={props.label} className="taskpop" onClose={props.leave}>
      <form className="taskpopform" onSubmit={submit} noValidate>
        <div className="taskpoptop">
          {phone && <div className="taskpopgrab" aria-hidden="true" />}
          <div className="taskpophead">
            {renaming && props.rename ? (
              <input className="field taskpopnamefield" aria-label="Name" autoFocus maxLength={MAX_TITLE} value={props.name} onChange={(event) => props.rename!(event.target.value)} />
            ) : (
              <h2 ref={head} tabIndex={-1}>
                {props.rename ? (
                  <button className="taskpopname" type="button" aria-label={`Rename ${props.name}`} onClick={() => setRenaming(true)}>
                    <span>{props.name}</span>
                    <span className="pen" aria-hidden="true">
                      <Icon name="pen" />
                    </span>
                  </button>
                ) : (
                  props.name
                )}
              </h2>
            )}
            {!phone && (
              <button className="taskpopclose" type="button" aria-label="Close" onClick={props.leave}>
                <Icon name="close" />
              </button>
            )}
          </div>
          {props.top}
        </div>
        <div className="taskpopbody">
          <LeavePopup.Provider value={props.leave}>{props.children}</LeavePopup.Provider>
          {props.error && (
            <div className="fielderr" role="alert">
              {props.error}
            </div>
          )}
        </div>
        <div className="taskpopbar">
          {props.remove && (
            <button className="link taskpopdelete" type="button" onClick={props.remove.run}>
              {props.remove.label}
            </button>
          )}
          {props.save ? (
            <>
              <Button type="button" onClick={props.close}>
                Cancel
              </Button>
              <Button ref={props.save.ref} variant="primary" type="submit">
                Save
              </Button>
            </>
          ) : (
            <Button className="taskpopclosebar" type="button" onClick={props.close}>
              Close
            </Button>
          )}
        </div>
      </form>
    </Sheet>
  );
}
