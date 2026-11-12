// Week: one week's plan, any week, with arrows that have no limit. Desktop draws a grid of days and hours with
// blocks that drag and resize; phone shows a strip of seven days over one day's timeline. Edit this week's plan
// works from now on and saves as you go; until this week is planned or skipped, it asks to plan instead. Params: place, a task to put on the calendar this week; edit: 'this', to open
// this week ready to edit.

import { useEffect, useMemo, useRef, useState } from 'react';
import { addDays, diffDays, formatDate, formatTime, instantMs, localDate, weekStart } from '../../../core/dates';
import { dayName } from '../../components/weekgrid';
import type { LocalDate } from '../../../core/types';
import { useNav } from '../../app/nav';
import type { ScreenProps } from '../../app/registry';
import { useApp, useQuery, useToday } from '../../app/store';
import { blockAhead, weekGate } from '../../../core/planning';
import type { TimeBlock } from '../../../core/types';
import { loadWeek, weekModel } from './data';
import type { WeekData, WeekModel } from './data';
import { DesktopWeek } from './Desktop';
import { PhoneWeek } from './Phone';
import './week.css';

/** What both layouts get: the week, its figures, and how to move between weeks and modes. */
export interface WeekProps {
  data: WeekData;
  /**
   * The week the arrows last asked for, which data.week catches up to once it loads. The arrows count from it, so a
   * second click while a week loads still moves on.
   */
  week: LocalDate;
  model: WeekModel;
  /** Weeks from this one: 0 is this week. */
  offset: number;
  title: string;
  label: string;
  editing: boolean;
  setEditing(on: boolean): void;
  /** This week, before it's planned and unless skipped: it asks to plan instead of offering to edit, as Today does. */
  gated: boolean;
  /** This week's planning block, when it's set for later: said in place of the prompt. */
  planningSet: TimeBlock | null;
  /** 'Planning: Sun Nov 8, 5pm', when this week's planning has a time still to come. */
  planningAt: string | null;
  goWeek(week: LocalDate): void;
  /** A task to place, from Find a time or Place on calendar. */
  place: string | null;
  donePlacing(): void;
  close(): void;
}

function weekTitle(offset: number, editing: boolean) {
  if (editing) return 'Editing this week';
  if (offset === 0) return 'This week';
  if (offset === 1) return 'Next week';
  return offset > 1 ? 'Future week' : 'Past week';
}

export default function WeekScreen(props: ScreenProps) {
  const { clock } = useApp();
  const nav = useNav();
  const current = weekStart(useToday());
  const [week, setWeek] = useState<LocalDate>(current);
  // Left on this week, the page follows it when the week turns over; a week chosen with the arrows stays.
  const [seen, setSeen] = useState(current);
  if (seen !== current) {
    setSeen(current);
    if (week === seen) setWeek(current);
  }
  const [place, setPlace] = useState<string | null>(props.params.place ?? null);
  const [editing, setEditing] = useState(!!props.params.place || props.params.edit === 'this');
  const data = useQuery((sql, c) => loadWeek(sql, c, week), [week]).data;
  const model = useMemo(() => data && weekModel(data, clock), [data, clock]);

  // Tapping Week again comes back to this week.
  const signal = useRef(nav.topSignal);
  useEffect(() => {
    if (signal.current !== nav.topSignal && nav.tab === 'week' && !place) {
      setWeek(current);
      setEditing(false);
    }
    signal.current = nav.topSignal;
  }, [nav.topSignal, nav.tab, current, place]);

  if (!data || !model) return null;
  const offset = Math.round(diffDays(current, data.week) / 7);
  const ahead = blockAhead(data.planning, clock);
  const zone = clock.zone();
  const planningAt = ahead && instantMs(ahead.start) > clock.now() ? `Planning: ${dayName(localDate(ahead.start, zone))}, ${formatTime(ahead.start, zone)}` : null;
  const shared: WeekProps = {
    data,
    week,
    model,
    offset,
    title: weekTitle(offset, editing && offset === 0),
    label: `${formatDate(data.week)} to ${formatDate(addDays(data.week, 6))}`,
    editing: editing && offset === 0,
    setEditing,
    gated: offset === 0 && !editing && weekGate(data.planning, clock) === 'gate',
    planningAt,
    planningSet: offset === 0 && !editing && weekGate(data.planning, clock) === 'set' ? (blockAhead(data.planning, clock) ?? null) : null,
    goWeek: (to) => {
      setWeek(weekStart(to));
      setEditing(false);
    },
    place: offset === 0 ? place : null,
    donePlacing: () => setPlace(null),
    close: props.close,
  };
  // Keyed by week, so what's open on one week doesn't carry to the next.
  return props.layout === 'phone' ? <PhoneWeek key={data.week} {...shared} /> : <DesktopWeek key={data.week} {...shared} />;
}

