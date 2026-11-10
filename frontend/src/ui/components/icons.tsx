export function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

export function PenIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="M13 7l4 4" />
    </svg>
  );
}

/** An answer to a missed block: Finished (a tick), Partly (half a circle, filled) or Not done (a cross). */
export function AnswerIcon(props: { answer: 'done' | 'partly' | 'not' }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {props.answer === 'done' && <path d="M5.5 12.5l4.25 4.25L18.5 8" />}
      {props.answer === 'partly' && (
        <>
          <circle cx="12" cy="12" r="7" />
          <path className="solid" d="M12 5a7 7 0 0 0 0 14z" />
        </>
      )}
      {props.answer === 'not' && <path d="M7 7l10 10M17 7L7 17" />}
    </svg>
  );
}

/** An i in a circle, for a button that explains what's around it. */
export function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.5" />
    </svg>
  );
}

/** A phone tab's icon, drawn in the tab's text colour. */
export function TabIcon(props: { tab: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {props.tab === 'today' && (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
        </>
      )}
      {props.tab === 'week' && (
        <>
          <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
          <path d="M3.5 10h17M8 3v4M16 3v4" />
        </>
      )}
      {props.tab === 'inbox' && (
        <>
          <path d="M3.5 13.5 5.7 6.4A2 2 0 0 1 7.6 5h8.8a2 2 0 0 1 1.9 1.4l2.2 7.1V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
          <path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5" />
        </>
      )}
      {props.tab === 'goals' && (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <circle cx="12" cy="12" r="4.5" />
          <circle cx="12" cy="12" r="1" fill="currentColor" />
        </>
      )}
      {props.tab === 'more' &&
        [5.5, 12, 18.5].map((cx) => <circle key={cx} cx={cx} cy="12" r="1.6" fill="currentColor" stroke="none" />)}
    </svg>
  );
}

/** Lines of text, for a task that has a description. */
export function NotesIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 7h14M5 12h14M5 17h9" />
    </svg>
  );
}

/** A cross, for a button that closes a dialog. */
export function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
