// To schedule, on both layouts: work in the week waiting for a time, as cards that drag onto a day or open their
// suggested times.

import { formatDate, formatMinutes, formatTimeOfDay } from '../../../core/dates';
import type { Slot, SlotContext } from '../../../core/slots';
import { useApp } from '../../app/store';
import { dragCard } from '../../components/weekgrid';
import { KIND_WORD } from '../../components/blocks/describe';
import { TaskName } from '../../components/task/TaskName';
import { dayName } from '../../components/weekgrid';
import type { LaneItem } from './data';
// The card styles, for Today too.
import './week.css';

const KIND_CLASS = { project: 'k-project', practice: 'k-practice', one_off: 'k-maint' } as const;

/** '4 · 5h 30m', after To schedule */
export const laneCount = (items: readonly LaneItem[]) => `${items.length} · ${formatMinutes(items.reduce((sum, x) => sum + x.left, 0))}`;

const datesText = (d: LaneItem['dates']) => (!d ? '' : d.from === d.to ? formatDate(d.from) : `${formatDate(d.from)} to ${formatDate(d.to)}`);

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
  const when = datesText(item.dates);
  return (
    <button
      type="button"
      className={`lanecard ${KIND_CLASS[item.kind]}${props.open ? ' on' : ''}`}
      aria-expanded={props.open}
      aria-label={`${item.title}, ${KIND_WORD[item.kind]}, ${item.line}${when ? `, ${when}` : ''}, to schedule`}
      onPointerDown={props.draggable ? (e) => dragCard(e, item, props.ctx, { preview: props.onPreview, drop: props.onDrop }) : undefined}
      onClick={props.onToggle}
    >
      <span className="strong lanet">{item.title}</span>
      <span className="small quiet">{item.line}</span>
    </button>
  );
}

/** An opened card: its suggested times, Choose a time, Take out of this week and Mark done. */
export function LaneActions(props: {
  item: LaneItem;
  /** Off for weeks other than this one, which plan through Schedule. */
  canPlace: boolean;
  onPlace(slot: Slot): void;
  onChoose?(): void;
  onTakeOut(): void;
  onDone(): void;
  onClose(): void;
}) {
  const { item, canPlace } = props;
  const { layout } = useApp();
  const btn = layout === 'phone' ? 'btn' : 'btn sm';
  const when = datesText(item.dates);
  return (
    <>
      <div>
        {/* A task's name opens its popup; a practice's session has none. */}
        <div className="strong mhead">{item.task ? <TaskName id={item.task.id} title={item.title} details={!!item.task.notes} /> : item.title}</div>
        <div className="small quiet">
          {KIND_WORD[item.kind]}, {item.line} to schedule{when ? `, ${when}` : ''}
        </div>
      </div>
      {canPlace && (
        <div className={layout === 'phone' ? 'stack8' : 'row'} role="group" aria-label="Suggested times">
          {item.offers.map((o, i) => (
            <button
              key={`${o.date}${o.start}`}
              className={`${btn}${i === 0 ? ' pri' : ''}`}
              type="button"
              aria-label={`Place ${item.title}, ${dayName(o.date)}, ${formatTimeOfDay(o.start)}`}
              onClick={() => props.onPlace(o)}
            >
              {i + 1} · {dayName(o.date).slice(0, 3)} {formatTimeOfDay(o.start)} to {formatTimeOfDay(o.end)}
            </button>
          ))}
          {item.offers.length === 0 && <p className="small">No open time fits it this week. Drag it to any time.</p>}
        </div>
      )}
      <div className="row">
        {canPlace && props.onChoose && (
          <button className={btn} type="button" onClick={props.onChoose}>
            Choose a time
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
