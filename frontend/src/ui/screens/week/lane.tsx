// To schedule, on both layouts: work in the week waiting for a time, as cards that drag onto a day or open their
// suggested times.

import { formatDate, formatMinutes, formatTimeOfDay, formatWeekday, weekday } from '../../../core/dates';
import { whySaid } from '../../../core/setTimes';
import { practiceTime } from '../../../core/slots';
import type { Slot, SlotContext } from '../../../core/slots';
import { useApp } from '../../app/store';
import { dragCard } from '../../components/weekgrid';
import { KIND_WORD } from '../../components/blocks/describe';
import { DAY_NAMES, sayMinutes, sayTime } from '../../components/editors/PracticeSchedule';
import { TaskName } from '../../components/task/TaskName';
import { useOpenPractice } from '../../components/blocks/BlockName';
import { dayName } from '../../components/weekgrid';
import type { LaneItem } from './data';
// The card styles, for Today too.
import './week.css';
import { Button } from '../../components/ds/Button';
import { Icon } from '../../components/ds/Icon';

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
  if (s && item.why) return `${sayMinutes(item.length)} on ${DAY_NAMES[s.day]}, ${sayTime(item.why.time)} ${item.why.why}`;
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
  const { platform } = useApp();
  return (
    <button
      type="button"
      className={`lanecard ${KIND_CLASS[item.kind]}${props.open ? ' on' : ''}`}
      aria-expanded={props.open}
      aria-label={`${item.title}, ${KIND_WORD[item.kind]}, ${laneWords(item)}, to schedule`}
      onPointerDown={props.draggable ? (e) => dragCard(e, item, props.ctx, { preview: props.onPreview, drop: props.onDrop, haptic: platform.haptic }) : undefined}
      onClick={props.onToggle}
    >
      <span className="strong lanet">{item.title}</span>
      {item.why && item.dates ? (
        <span className="small quiet lanewarn">
          <Icon name="warning" size={16} />
          {`${formatWeekday(item.dates.from)} · ${whySaid(item.why, false)}`}
        </span>
      ) : (
        <span className="small quiet">{item.line}</span>
      )}
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
  const openPractice = useOpenPractice();
  const btn = { size: 'compact' as const };
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
        {/* A task's name opens its popup, and a practice's opens its own, with no block yet. */}
        <div className="strong mhead">
          {item.task ? (
            <TaskName id={item.task.id} title={item.title} details={!!item.task.notes} />
          ) : item.practice ? (
            <button className="taskname" type="button" onClick={() => openPractice({ practice: item.practice!.id })}>
              {item.title}
            </button>
          ) : (
            item.title
          )}
        </div>
        <div className="small quiet">{sub}</div>
      </div>
      {canPlace && (
        <div className={layout === 'phone' ? 'stack8' : 'row'} role="group" aria-label={`Suggested times for ${item.title}`}>
          {item.offers.map((o, i) => (
            <Button key={`${o.date}${o.start}`} {...btn} variant={i === 0 ? 'primary' : 'secondary'} type="button" onClick={() => props.onPlace(o)}>
              {dayName(o.date).slice(0, 3)} {formatTimeOfDay(o.start)} to {formatTimeOfDay(o.end)}
            </Button>
          ))}
          {item.offers.length === 0 && (
            <p className="small">{s ? `No open time on ${DAY_NAMES[s.day]}. Drag it to any time.` : 'No open time fits it this week. Drag it to any time.'}</p>
          )}
        </div>
      )}
      {canPlace && item.note && <p className="small quiet">{item.note}</p>}
      <div className="row">
        {canPlace && props.onChoose && (
          <Button {...btn} type="button" onClick={props.onChoose}>
            Choose a time
          </Button>
        )}
        {s && props.onSkipDay && (
          <Button {...btn} type="button" onClick={props.onSkipDay}>
            Skip {DAY_NAMES[s.day]}
          </Button>
        )}
        {(item.practice || (item.picked && !item.dates)) && (
          <Button {...btn} type="button" onClick={props.onTakeOut}>
            Take out of this week
          </Button>
        )}
        {item.task && (
          <Button {...btn} type="button" onClick={props.onDone}>
            Mark done
          </Button>
        )}
        <Button {...btn} type="button" onClick={props.onClose}>
          Close
        </Button>
      </div>
    </>
  );
}
