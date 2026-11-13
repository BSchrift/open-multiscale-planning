// To schedule, on both layouts: work in the week waiting for a time, as cards that drag onto a day or open their
// suggested times.

import { formatDate, formatMinutes, formatTimeOfDay, weekday } from '../../../core/dates';
import { practiceTime } from '../../../core/slots';
import type { Slot, SlotContext } from '../../../core/slots';
import { useApp } from '../../app/store';
import { dragCard } from '../../components/weekgrid';
import { KIND_WORD } from '../../components/blocks/describe';
import { DAY_NAMES, sayMinutes, sayTime } from '../../components/editors/PracticeSchedule';
import { TaskName } from '../../components/task/TaskName';
import { dayName } from '../../components/weekgrid';
import type { LaneItem } from './data';
// The card styles, for Today too.
import './week.css';

const KIND_CLASS = { project: 'k-project', practice: 'k-practice', one_off: 'k-maint', planning: 'k-planning' } as const;

/** '5 · 4h 30m', after To schedule: a practice counts its sessions, anything else counts once. */
export const laneCount = (items: readonly LaneItem[]) =>
  `${items.reduce((n, x) => n + (x.sessions ?? 1), 0)} · ${formatMinutes(items.reduce((sum, x) => sum + x.left, 0))}`;

const datesText = (d: LaneItem['dates']) => (!d ? '' : d.from === d.to ? formatDate(d.from) : `${formatDate(d.from)} to ${formatDate(d.to)}`);

/** A set day's session: its day and the time it aims for there. */
const sessionDay = (item: LaneItem) => {
  if (!item.practice || !item.dates) return null;
  const day = weekday(item.dates.from);
  return { day, time: practiceTime(item.practice, day) };
};

/** What a card says to a screen reader after its name: '30 minutes on Friday around 9:30 AM', or its line and dates. */
export function laneWords(item: LaneItem): string {
  const s = sessionDay(item);
  if (s) return `${sayMinutes(item.length)} on ${DAY_NAMES[s.day]}${s.time === null ? '' : ` around ${sayTime(s.time)}`}`;
  if (item.practice) return item.line.replace(' · ', ', ');
  const when = datesText(item.dates);
  return `${item.line}${when ? `, ${when}` : ''}`;
}

export function LaneCard(props: {
  item: LaneItem;
  ctx: SlotContext;
  open: boolean;
  /** Off for weeks other than this one: the card only opens. */
  draggable: boolean;
  onToggle(): void;
  onPreview(slot: Slot | null): void;
  onDrop(slot: Slot): void;
}) {
  const { item } = props;
  return (
    <button
      type="button"
      className={`lanecard ${KIND_CLASS[item.kind]}${props.open ? ' on' : ''}`}
      aria-expanded={props.open}
      aria-label={`${item.title}, ${KIND_WORD[item.kind]}, ${laneWords(item)}, to schedule`}
      onPointerDown={props.draggable ? (e) => dragCard(e, item, props.ctx, { preview: props.onPreview, drop: props.onDrop }) : undefined}
      onClick={props.onToggle}
    >
      <span className="strong lanet">{item.title}</span>
      <span className="small quiet">{item.line}</span>
    </button>
  );
}

/** An opened card: its suggested times, Choose a time, Skip a set day, Take out of this week and Mark done. */
export function LaneActions(props: {
  item: LaneItem;
  /** Off for weeks other than this one, which plan through Schedule. */
  canPlace: boolean;
  onPlace(slot: Slot): void;
  onChoose?(): void;
  /** A set day's session: skips that one session this week. */
  onSkipDay?(): void;
  onTakeOut(): void;
  onDone(): void;
  onClose(): void;
}) {
  const { item, canPlace } = props;
  const { layout } = useApp();
  const btn = layout === 'phone' ? 'btn' : 'btn sm';
  const when = datesText(item.dates);
  const s = sessionDay(item);
  const sub = s
    ? `Practice, ${formatMinutes(item.length)} on ${DAY_NAMES[s.day]}${s.time === null ? ', any time' : `, usually ${formatTimeOfDay(s.time)}`}`
    : item.practice
      ? `Practice, ${item.line.replace(' · ', ', ')}`
      : `${KIND_WORD[item.kind]}, ${item.line} to schedule${when ? `, ${when}` : ''}`;
  return (
    <>
      <div>
        {/* A task's name opens its popup; a practice's session has none. */}
        <div className="strong mhead">{item.task ? <TaskName id={item.task.id} title={item.title} details={!!item.task.notes} /> : item.title}</div>
        <div className="small quiet">{sub}</div>
      </div>
      {canPlace && (
        <div className={layout === 'phone' ? 'stack8' : 'row'} role="group" aria-label={`Suggested times for ${item.title}`}>
          {item.offers.map((o, i) => (
            <button key={`${o.date}${o.start}`} className={`${btn}${i === 0 ? ' pri' : ''}`} type="button" onClick={() => props.onPlace(o)}>
              {i + 1} · {dayName(o.date).slice(0, 3)} {formatTimeOfDay(o.start)} to {formatTimeOfDay(o.end)}
            </button>
          ))}
          {item.offers.length === 0 && (
            <p className="small">{s ? `No open time on ${DAY_NAMES[s.day]}. Drag it to any time.` : 'No open time fits it this week. Drag it to any time.'}</p>
          )}
        </div>
      )}
      {canPlace && item.note && <p className="small quiet">{item.note}</p>}
      <div className="row">
        {canPlace && props.onChoose && (
          <button className={btn} type="button" onClick={props.onChoose}>
            Choose a time
          </button>
        )}
        {s && props.onSkipDay && (
          <button className={btn} type="button" onClick={props.onSkipDay}>
            Skip {DAY_NAMES[s.day]}
          </button>
        )}
        {(item.practice || (item.picked && !item.dates)) && (
          <button className={btn} type="button" onClick={props.onTakeOut}>
            Take out of this week
          </button>
        )}
        {item.task && (
          <button className={btn} type="button" onClick={props.onDone}>
            Mark done
          </button>
        )}
        <button className={btn} type="button" onClick={props.onClose}>
          Close
        </button>
      </div>
    </>
  );
}
