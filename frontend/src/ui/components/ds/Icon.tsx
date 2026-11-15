// The app's one icon set: a 24px grid, stroked in currentColor at --icon-stroke with round caps and joins, drawn at
// 16, 20 or 24px in a fixed slot so icons line up with each other and with text (docs/design.md). Filled shapes (class
// fc) only where a state needs one: the selected tab, the live dot, the Done badge.

import type { ReactNode } from 'react';

const dot = (cx: number, cy: number, r = 1.3) => <circle key={`${cx},${cy}`} className="fc" cx={cx} cy={cy} r={r} />;
const sun = 'M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M6 18l1.4-1.4M16.6 7.4L18 6';

const PATHS = {
  done: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  partly: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path className="fc" d="M12 4.5a7.5 7.5 0 0 0 0 15z" />
    </>
  ),
  'not-done': <path d="M7 7l10 10M17 7L7 17" />,
  'no-answer': <circle cx="12" cy="12" r="7.5" strokeDasharray="2.4 2.9" />,
  'chevron-right': <path d="M10 6l6 6-6 6" />,
  'chevron-left': <path d="M14 6l-6 6 6 6" />,
  'chevron-down': <path d="M6 9.5l6 6 6-6" />,
  pen: (
    <>
      <path d="M4.5 19.5h4l10.2-10.2a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4.5 15.5z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 13.5L6.5 6h11l2.5 7.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z" />
      <path d="M4 13.5h4.5l1.2 2h4.6l1.2-2H20" />
    </>
  ),
  today: (
    <>
      <circle cx="12" cy="12" r="3.6" />
      <path d={sun} />
    </>
  ),
  'today-selected': (
    <>
      <circle className="fc" cx="12" cy="12" r="4.4" />
      <path d={sun} />
    </>
  ),
  week: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
      <path d="M4 10h16M9.3 10v10M14.7 10v10" />
    </>
  ),
  goals: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4.4" />
      {dot(12, 12, 1.1)}
    </>
  ),
  more: <>{[dot(6, 12), dot(12, 12), dot(18, 12)]}</>,
  bin: <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 10.5v6M14 10.5v6" />,
  link: (
    <>
      <path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1" />
      <path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" />
    </>
  ),
  photo: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4 17l5-4.5 3.5 3 3-2.5 4.5 4" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4.5l8.5 15h-17z" />
      <path d="M12 10v4" />
      {dot(12, 16.9, 0.7)}
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l4.5 4.5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5" />
      {dot(12, 8, 0.7)}
    </>
  ),
  notes: (
    <>
      <rect x="5" y="4" width="14" height="16" rx="2.5" />
      <path d="M8.5 9h7M8.5 12.5h7M8.5 16h4" />
    </>
  ),
  'zoom-in': (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l4.5 4.5M8 10.5h5M10.5 8v5" />
    </>
  ),
  'zoom-out': (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l4.5 4.5M8 10.5h5" />
    </>
  ),
  star: <path d="M12 4.5l2.3 4.8 5.2.7-3.8 3.6.9 5.2-4.6-2.5-4.6 2.5.9-5.2L4.5 10l5.2-.7z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14.5L4.5 10 9 5.5" />
      <path d="M4.5 10H14a5 5 0 0 1 0 10h-2.5" />
    </>
  ),
  drag: <>{[dot(9, 7), dot(15, 7), dot(9, 12), dot(15, 12), dot(9, 17), dot(15, 17)]}</>,
  return: (
    <>
      <path d="M19 5.5v6a3 3 0 0 1-3 3H6" />
      <path d="M9.5 11l-3.5 3.5L9.5 18" />
    </>
  ),
  bold: <path d="M8 5h5a3.5 3.5 0 0 1 0 7H8zM8 12h6a3.5 3.5 0 0 1 0 7H8z" />,
  italic: <path d="M11 5h6M7 19h6M14 5l-4 14" />,
  list: (
    <>
      <path d="M10 7h9M10 12h9M10 17h9" />
      {[dot(5.5, 7, 1.1), dot(5.5, 12, 1.1), dot(5.5, 17, 1.1)]}
    </>
  ),
  live: <circle className="fc" cx="12" cy="12" r="4.5" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

/** An icon, hidden from screen readers: the control around it carries the name. */
export function Icon(props: { name: IconName; size?: 16 | 20 | 24; className?: string }) {
  const { name, size = 20, className } = props;
  return (
    <svg className={`ico s${size}${className ? ` ${className}` : ''}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-icon={name}>
      {PATHS[name]}
    </svg>
  );
}
