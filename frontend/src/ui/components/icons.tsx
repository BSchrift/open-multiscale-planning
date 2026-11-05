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
