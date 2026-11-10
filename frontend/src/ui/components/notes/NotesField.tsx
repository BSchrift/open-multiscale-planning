// Writing a description: a plain text field with a bar above it. Bold, Italic, List and Link put their marks around
// the selection, and so do ⌘B and ⌘I (Ctrl on other systems). Once written, it shows formatted until it's tapped. The
// field stops at the limit, and from 90% of it a count shows.

import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { MAX_NOTES, toggleList, wrapLink, wrapMark } from '../../../core/notes';
import type { NotesEdit } from '../../../core/notes';
import { Notes } from './Notes';
import './notes.css';

const number = new Intl.NumberFormat('en-US');
const onMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

type Tool = (text: string, start: number, end: number) => NotesEdit | null;

const TOOLS: readonly { label: string; text: string; className: string; make: Tool }[] = [
  { label: 'Bold', text: 'B', className: 'b', make: (t, s, e) => wrapMark(t, s, e, '**') },
  { label: 'Italic', text: 'I', className: 'i', make: (t, s, e) => wrapMark(t, s, e, '*') },
  { label: 'Bulleted list', text: '•', className: 'l', make: toggleList },
  { label: 'Link', text: 'Link', className: 'k', make: wrapLink },
];

export function NotesField(props: {
  value: string;
  onChange(text: string): void;
  /** Called on ⌘Enter, for a form whose Enter saves. */
  onSubmit?(): void;
}) {
  const { value, onChange } = props;
  const [editing, setEditing] = useState(!value);
  const area = useRef<HTMLTextAreaElement>(null);
  // The selection to put back once the text a tool changed has rendered.
  const selection = useRef<[number, number] | null>(null);
  const ids = { label: useId(), field: useId(), count: useId() };
  const counting = value.length >= MAX_NOTES * 0.9;

  useLayoutEffect(() => {
    const el = area.current;
    if (!el || !selection.current) return;
    el.focus();
    el.setSelectionRange(...selection.current);
    selection.current = null;
  });

  const use = (make: Tool) => {
    const el = area.current;
    if (!el) return;
    const edit = make(el.value, el.selectionStart, el.selectionEnd);
    if (!edit) return;
    selection.current = [edit.start, edit.end];
    onChange(edit.text);
  };

  const edit = () => {
    selection.current = [value.length, value.length];
    setEditing(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(onMac() ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key === 'enter' && props.onSubmit) {
      event.preventDefault();
      props.onSubmit();
    } else if (key === 'b' || key === 'i') {
      event.preventDefault();
      use(TOOLS[key === 'b' ? 0 : 1]!.make);
    }
  };

  if (!editing) {
    return (
      <div className="notesfield stack8">
        <div className="between">
          <span className="notesname" id={ids.label}>
            Description
          </span>
          <button className="link small notesedit" type="button" aria-label="Edit description" onClick={edit}>
            Edit
          </button>
        </div>
        {/* A tap anywhere but on a link edits it too; Edit is the way in by keyboard. */}
        <div role="group" aria-labelledby={ids.label} onClick={(event) => !(event.target as Element).closest('a') && edit()}>
          <Notes text={value} />
        </div>
      </div>
    );
  }

  return (
    <div className="notesfield stack8">
      <label className="notesname" htmlFor={ids.field}>
        Description
      </label>
      <div className="notesbox">
        <div className="notesbar" role="toolbar" aria-label="Formatting" aria-controls={ids.field}>
          {TOOLS.map((tool) => (
            <button
              key={tool.label}
              className={`notestool ${tool.className}`}
              type="button"
              aria-label={tool.label}
              title={tool.label}
              // Keeps the field's focus and selection, and the phone's keyboard up.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => use(tool.make)}
            >
              {tool.text}
            </button>
          ))}
        </div>
        <textarea
          ref={area}
          id={ids.field}
          className="notesarea"
          rows={4}
          maxLength={MAX_NOTES}
          value={value}
          aria-describedby={counting ? ids.count : undefined}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      {counting && (
        <div id={ids.count} className="small quiet">
          {number.format(value.length)} of {number.format(MAX_NOTES)}
        </div>
      )}
    </div>
  );
}
