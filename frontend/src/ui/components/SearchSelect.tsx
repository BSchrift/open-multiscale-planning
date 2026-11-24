// A choice of one from a long list, by searching it, as Process's picker chooses where an item goes. On desktop the field
// shows the choice; a click, a key or typing opens the list under it, typing narrows it to what has the letters and lights
// the first, the arrows move, and Enter or a click takes the lit one. Esc closes the list, then clears what was typed.
// On phone the field is a button that opens the list in a sheet, ready to search, and a tap on a row takes it. A row
// that can't be chosen is greyed and says why.

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { count, mark, optionId, SearchList, step } from './SearchList';
import type { Choice } from './SearchList';
import { Sheet } from './Sheet';
import { Button } from './ds/Button';
import { Icon } from './ds/Icon';

export interface SelectOption {
  value: string;
  label: string;
  /** Why it can't be chosen. */
  off?: string | undefined;
}

export function SearchSelect(props: {
  /** The field's name, said and shown above it. */
  label: string;
  phone: boolean;
  value: string;
  options: readonly SelectOption[];
  onChange(value: string): void;
  /** What the search field says while empty. */
  placeholder: string;
  describedBy?: string | undefined;
  className?: string;
}) {
  const { label, phone, options } = props;
  const [q, setQ] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // The lit row, or null for the one the list starts on.
  const [at, setAt] = useState<number | null>(null);
  const fieldId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const shown = options.find((o) => o.value === props.value)?.label ?? '';

  const typed = (q ?? '').trim();
  const found = typed ? options.filter((o) => o.label.toLowerCase().includes(typed.toLowerCase())) : options;
  const choices: Choice[] = found.map((o) => ({ key: o.value, said: o.label, off: o.off, body: <span>{mark(o.label, typed)}</span> }));
  // Typed, the first that can be chosen; else the choice shown.
  const start = typed ? step(choices, -1, 1) : Math.max(0, found.findIndex((o) => o.value === props.value));
  const lit = at ?? start;

  const close = () => {
    setOpen(false);
    setQ(null);
    setAt(null);
  };
  const openList = () => {
    setAt(null);
    setOpen(true);
  };
  const choose = (c: Choice | undefined) => {
    if (!c || c.off) return;
    close();
    props.onChange(c.key);
  };

  // Esc closes the list, then clears what was typed. A listener of its own, since the popup's catches Esc before React
  // would; with nothing to close, Esc goes on to the popup.
  useEffect(() => {
    const field = inputRef.current;
    if (!field || phone) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || (!open && q === null)) return;
      event.stopPropagation();
      if (open) setOpen(false);
      else setQ(null);
    };
    field.addEventListener('keydown', onKey);
    return () => field.removeEventListener('keydown', onKey);
  }, [open, q, phone]);

  // The choice shown is selected whenever it shows in a focused field, so typing replaces it.
  useEffect(() => {
    const field = inputRef.current;
    if (q === null && field && document.activeElement === field) field.select();
  }, [q, props.value]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) return openList();
      setAt(step(choices, lit, event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter' && open) {
      // Takes the lit row rather than saving the form.
      event.preventDefault();
      choose(choices[lit]);
    }
  };

  const list = (
    <SearchList id={listId} label={label} groups={[{ key: 'all', choices }]} lit={choices[lit] ? lit : -1} onChoose={choose}>
      {typed && !found.length && <div className="pkempty">{`Nothing matches “${typed}”.`}</div>}
    </SearchList>
  );
  const field = (placeholder: string, autoFocus = false) => (
    <>
      <input
        ref={inputRef}
        id={phone ? undefined : fieldId}
        className="field ssfield"
        role="combobox"
        // Desktop's is named by its label; phone's, in the sheet, by what it searches.
        aria-label={phone ? props.placeholder : undefined}
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && choices[lit] ? optionId(listId, lit) : undefined}
        aria-describedby={props.describedBy}
        autoComplete="off"
        autoFocus={autoFocus}
        enterKeyHint="go"
        placeholder={placeholder}
        value={q ?? (phone ? '' : shown)}
        onFocus={(event) => q === null && event.currentTarget.select()}
        onClick={(event) => {
          if (q === null) event.currentTarget.select();
          if (!open) openList();
        }}
        onChange={(event) => {
          setQ(event.target.value);
          setAt(null);
          setOpen(true);
        }}
        onBlur={(event) => !phone && !event.currentTarget.parentElement?.contains(event.relatedTarget) && close()}
        onKeyDown={onKeyDown}
      />
      {typed && (
        <span className="sr" aria-live="polite">
          {count(found.length)}
        </span>
      )}
    </>
  );

  if (phone) {
    return (
      <div className={props.className}>
        <label htmlFor={fieldId}>{label}</label>
        <button
          id={fieldId}
          className="field ssfield ssbutton"
          type="button"
          aria-haspopup="dialog"
          aria-label={`${label}: ${shown}`}
          aria-describedby={props.describedBy}
          onClick={openList}
        >
          <span>{shown}</span>
          <Icon name="chevron-down" />
        </button>
        {open && (
          <Sheet label={label} tall className="pksheet" onClose={close}>
            <div className="between">
              <h2>{label}</h2>
              <Button type="button" onClick={close}>
                Close
              </Button>
            </div>
            {field(props.placeholder, true)}
            {list}
          </Sheet>
        )}
      </div>
    );
  }
  return (
    <div className={props.className}>
      <label htmlFor={fieldId}>{label}</label>
      <div className="sselect">
        {field(props.placeholder)}
        {open && list}
      </div>
    </div>
  );
}
