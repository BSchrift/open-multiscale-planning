// Phone's strip of the week's seven days over one day: each day's shape on a shared time axis, with its free time,
// and a warning when the day looked at is packed. Week and planning's Schedule step use it. Free time counts from
// now on, so a day gone by shows what happened and never free time.

import { addDays, formatMinutes, formatTimeOfDay } from '../../../core/dates';
import { dayBaseAhead, dayFree, DRAWN_DAY, isOpen, isPast, TIGHT_SHARE } from '../../../core/slots';
import type { Slot, SlotContext, Span } from '../../../core/slots';
import type { LocalDate, Minutes } from '../../../core/types';
import { dayName } from '../weekgrid';

const { from: DAY_FROM, to: DAY_TO } = DRAWN_DAY;
const LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAYS = [0, 1, 2, 3, 4, 5, 6];
const overlaps = (list: readonly Slot[], date: LocalDate, start: number, end: number) => list.some((x) => x.date === date && x.start < end && start < x.end);

const free = (date: LocalDate, ctx: SlotContext) => dayFree(date, 'project', ctx);
const packed = (date: LocalDate, ctx: SlotContext) => free(date, ctx) < dayBaseAhead(date, 'project', ctx) * TIGHT_SHARE;

/** The week's free time from now on, as the strip counts it. */
export const weekFree = (week: LocalDate, ctx: SlotContext): Minutes => DAYS.reduce((sum, i) => sum + free(addDays(week, i), ctx), 0);

/** A day in the strip, half an hour a slice: the block being placed, a suggested time, then planned, busy or closed. Open time gone by is drawn as closed. */
function DayShape(props: { ctx: SlotContext; placed: readonly Span[]; date: LocalDate; draft?: Slot | null; suggested?: Slot | null }) {
  const { ctx, date } = props;
  const hit = (x: Slot | null | undefined, m: number) => !!x && x.date === date && x.start < m + 30 && m < x.end;
  return (
    <span className="wshape" aria-hidden="true">
      {Array.from({ length: (DAY_TO - DAY_FROM) / 30 }, (_, k) => {
        const m = DAY_FROM + k * 30;
        const busy = overlaps(ctx.busy, date, m, m + 30);
        const placed = props.placed.find((x) => hit(x, m));
        const cls = hit(props.draft, m)
          ? 'draft'
          : hit(props.suggested, m)
            ? 'sug'
            : !isOpen(ctx.availability, date, m, 'project') && !busy
              ? 'closed'
              : placed
                ? `planned${placed.kind === 'practice' ? ' practice' : placed.kind === 'one_off' ? ' maint' : ''}`
                : busy
                  ? 'busy'
                  : isPast(date, m, ctx)
                    ? 'closed'
                    : '';
        return <span key={m} className={`sl ${cls}`} />;
      })}
    </span>
  );
}

/** What a day says about the work being placed: its suggested time there, or that it fits nowhere that day. */
export interface DayHint {
  suggested?: Slot | null;
  noFit?: boolean;
}

export function DayStrip(props: {
  week: LocalDate;
  /** What the group is called: 'Choose a day', or 'Compare days' while scheduling. */
  label: string;
  selected: LocalDate;
  /** Free time, events and open hours. */
  ctx: SlotContext;
  /** What the shapes draw as planned: ctx's own, less any block being changed. */
  placed: readonly Span[];
  /** The block being placed or moved. */
  draft?: Slot | null;
  hint?(date: LocalDate): DayHint;
  /** Names each day's suggested time on a line of its own, as Schedule does. */
  suggestions?: boolean;
  onPick(date: LocalDate): void;
}) {
  const { week, ctx, draft } = props;
  const today = ctx.earliest.date;
  return (
    <div className="wstrip" role="group" aria-label={props.label}>
      {DAYS.map((i) => {
        const date = addDays(week, i);
        const on = date === props.selected;
        const tight = packed(date, ctx);
        const freeText = date < today ? '' : formatMinutes(free(date, ctx));
        const { suggested, noFit } = props.hint?.(date) ?? {};
        const time = suggested && formatTimeOfDay(suggested.start);
        const say = time ? `, suggested ${time}` : noFit ? ', no slot for this task' : '';
        return (
          <button
            key={date}
            type="button"
            className={`wday${props.suggestions ? ' sched' : ''}${on ? ' on' : ''}${date === today ? ' today' : ''}${tight ? ' tight' : ''}${noFit ? ' nofit' : ''}`}
            aria-pressed={on}
            aria-current={date === today ? 'date' : undefined}
            aria-label={`${dayName(date)}${freeText && `, ${freeText} free`}${tight ? ', packed' : ''}${say}`}
            onClick={() => props.onPick(date)}
          >
            <span>
              <span>{LETTERS[i]} </span>
              <span className="strong">{Number(date.slice(8))}</span>
            </span>
            {/* A suggestion at the block's own time is the block. */}
            <DayShape ctx={ctx} placed={props.placed} date={date} draft={draft} suggested={suggested && !(draft?.date === date && draft.start === suggested.start) ? suggested : null} />
            {props.suggestions ? (
              <>
                <span className="wfree">{freeText}</span>
                <span className="wsug">{time || (noFit ? 'No slot' : '')}</span>
              </>
            ) : (
              <span className="wfree">{noFit ? 'No slot' : freeText}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Says when a day is packed, as its button in the strip does. */
export function PackedDay(props: { date: LocalDate; ctx: SlotContext }) {
  const { date, ctx } = props;
  if (!packed(date, ctx)) return null;
  return (
    <div className="warn">
      <div>
        <div className="strong">{dayName(date)} is packed</div>
        <div>
          {formatMinutes(free(date, ctx))} free of {formatMinutes(dayBaseAhead(date, 'project', ctx))} available that day.
        </div>
      </div>
    </div>
  );
}
