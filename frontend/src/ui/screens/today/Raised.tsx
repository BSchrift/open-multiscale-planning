// The selected block on the phone's day, raised out of its lane as a card over both lane edges: what it can do now, one
// tap each. The block in progress shows its time left, the ring (a tap pauses) and Mark done now and Stop for now; one
// that ended unanswered asks how it went; the next shows Start early; any other offers Move. Details opens the one
// popup every block opens. The card's text repeats its block's name, which screen readers have already heard from the
// block just before it, so only its buttons are read.
// It grows from the lane, its contents fading in, and the one selected before settles back into its lane: 200ms on the
// app's curve. With reduced motion it changes at once.

import { useLayoutEffect, useRef } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { isPaused, timeLeftMs } from '../../../core/blocks';
import { formatMinutes, formatTime, instantMs, localDate } from '../../../core/dates';
import type { BlockRow } from '../../../core/queries';
import { requestPrompt, STILL_GOING_MIN } from '../../app/reminders';
import { useApp, useNow } from '../../app/store';
import { formatRange, KIND_WORD } from '../../components/blocks/describe';
import type { BlockKind } from '../../components/blocks/describe';
import { answerFor, WORDS } from '../../components/blocks/MissedSheet';
import { useBlockActions } from '../../components/blocks/useBlockActions';
import { BlockMarks } from '../../components/ds/Block';
import type { BlockLook, BlockState } from '../../components/ds/Block';
import { Button } from '../../components/ds/Button';
import { Icon } from '../../components/ds/Icon';
import type { useBlockCommands } from '../../components/blocks/useBlockCommands';
import { SpentRing } from './NowCard';
import { usePlanningNow } from './PlanningNow';
import type { Raise } from './selection';

/** "50 min", "1h 30m": the mock's words for a time left or to go. */
export const minutesWords = (n: number) => (n < 60 ? `${n} min` : formatMinutes(n));

/** The app's medium duration and curve, from the tokens, so the card moves as everything else that appears. */
function motion() {
  const css = getComputedStyle(document.documentElement);
  const ms = parseFloat(css.getPropertyValue('--dur-medium')) || 200;
  return { duration: ms, easing: css.getPropertyValue('--ease').trim() || 'ease-out' };
}
const still = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || typeof Element.prototype.animate !== 'function';

/** The transform that draws a box at `to` while it's laid out at `from`, from its top left corner. */
function between(from: DOMRect, to: DOMRect) {
  const sx = to.width / (from.width || 1);
  const sy = to.height / (from.height || 1);
  return `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${sx}, ${sy})`;
}
const laneOf = (id: string, near: Element) => near.closest('.day')?.querySelector<HTMLElement>(`[data-block="${id}"]`) ?? null;

type Actions = ReturnType<typeof useBlockCommands>;

export interface RaisedProps {
  block: BlockRow;
  raise: Raise;
  /** Out of sight while its block is held and dragged. */
  away?: boolean;
  kind: BlockKind;
  look: BlockLook;
  state: BlockState;
  cls: string;
  style: CSSProperties;
  actions: Actions;
  next: BlockRow | undefined;
  /** Move's choices open under it; none when the block stays where it is. */
  onMove?: ((from: HTMLElement) => void) | undefined;
  onDetails(): void;
  /** A hold on the card lifts its block to move, as a hold on the block does. */
  onHold?: ((e: ReactPointerEvent<HTMLElement>) => void) | undefined;
  /** Its last drawn height, for the card that settles back once another is selected. */
  onHeight(px: number): void;
}

export function Raised(props: RaisedProps) {
  const { block, raise } = props;
  const ref = useRef<HTMLDivElement>(null);
  // Grows from its block in the lane: drawn at its full size, then shown over the lane's box and eased out to it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    props.onHeight(el.offsetHeight);
    const lane = laneOf(block.id, el);
    if (!lane || still()) return;
    const m = motion();
    el.animate([{ transformOrigin: '0 0', transform: between(el.getBoundingClientRect(), lane.getBoundingClientRect()) }, { transformOrigin: '0 0', transform: 'none' }], m);
    el.querySelector('.rcin')?.animate([{ opacity: 0 }, { opacity: 1 }], m);
    // Only as it first draws: later drawings keep it where it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useLayoutEffect(() => {
    if (ref.current) props.onHeight(ref.current.offsetHeight);
  });

  // A tap anywhere on the card but its buttons is the second tap on its block: it opens Details.
  const open = (e: ReactMouseEvent) => {
    if (!(e.target as Element).closest('button')) props.onDetails();
  };
  return (
    <div ref={ref} className={`cev raised r-${raise} ${props.cls}${props.away ? ' away' : ''}`} style={props.style} data-raised={block.id} onClick={open} onPointerDown={props.onHold}>
      <div className="rcin">
        <Body {...props} />
      </div>
    </div>
  );
}

/** The box the card was, easing back into its lane once another block is selected, then gone. */
export function Settling(props: { id: string; cls: string; style: CSSProperties; height: number; onDone(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const lane = el && laneOf(props.id, el);
    if (!el || !lane || still()) return props.onDone();
    const m = motion();
    const run = el.animate([{ transformOrigin: '0 0', transform: 'none' }, { transformOrigin: '0 0', transform: between(el.getBoundingClientRect(), lane.getBoundingClientRect()) }], { ...m, fill: 'forwards' });
    run.finished.then(props.onDone, props.onDone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={ref} className={`cev raised settling ${props.cls}`} style={{ ...props.style, height: props.height }} aria-hidden="true" />;
}

function Body(props: RaisedProps) {
  const { block, raise, actions } = props;
  const { clock } = useApp();
  // Answered as the end of a block asks, with its words.
  const asked = useBlockActions();
  const answer = (choice: 'done' | 'not') => void asked.answer(block, answerFor(block, choice, 0));
  const zone = clock.zone();
  const range = formatRange(block.start, block.end, zone);
  const title = (
    <div className="rctitle" aria-hidden="true">
      <span className="blktitle">{block.title ?? 'Time block'}</span>
    </div>
  );
  const details = (
    <Button type="button" className="grow" onClick={props.onDetails}>
      Details
    </Button>
  );
  if (raise === 'now') return block.task_kind === 'planning' ? <PlanningBody {...props} range={range} title={title} details={details} /> : <NowBody {...props} range={range} title={title} details={details} />;
  if (raise === 'answer') {
    const words = WORDS[block.practice_id ? 'practice' : 'task'];
    return (
      <>
        <div className="rcmeta" aria-hidden="true">
          <Icon name="no-answer" size={16} />
          Ended at {formatTime(block.ended_at ?? block.end, zone)}
        </div>
        {title}
        <div className="rcmeta" aria-hidden="true">
          How did it go?
        </div>
        <div className="rcans">
          <Button variant="primary" type="button" disabled={asked.pending} onClick={() => answer('done')}>
            <Icon name="done" size={16} />
            {words.done}
          </Button>
          {/* Partly asks how much is left, or for a practice how much was done, as the end of a block does. */}
          <Button type="button" onClick={() => requestPrompt(block.id)}>
            <Icon name="partly" size={16} />
            {words.partly}
          </Button>
          <Button type="button" disabled={asked.pending} onClick={() => answer('not')}>
            <Icon name="not-done" size={16} />
            {words.not}
          </Button>
        </div>
        <Carry {...props} />
      </>
    );
  }
  if (raise === 'next') {
    const until = Math.max(1, Math.round((instantMs(block.start) - clock.now()) / 60_000));
    return (
      <>
        <div className="rcmeta" aria-hidden="true">
          <span className="nexttag">Next</span> in {minutesWords(until)}, {range}
        </div>
        {title}
        <div className="rcacts">
          <Button variant="primary" type="button" className="grow" disabled={actions.pending} onClick={() => void actions.startEarly(block)}>
            Start early
          </Button>
          {details}
        </div>
      </>
    );
  }
  return (
    <>
      <div className="rcmeta" aria-hidden="true">
        {range}, {KIND_WORD[props.kind]}
      </div>
      {title}
      <div className="rcacts">
        {props.onMove && (
          <Button type="button" className="grow" aria-haspopup="menu" onClick={(e) => props.onMove!(e.currentTarget)}>
            Move
          </Button>
        )}
        {details}
      </div>
    </>
  );
}

/**
 * As the end of a block asks: one paused till it ended resumes into the time after, if it's today's, and one that ran
 * to its end without stopping can keep going. Neither for a practice, which only logs what it got.
 */
function Carry(props: RaisedProps) {
  const { block, actions } = props;
  const { clock } = useApp();
  if (block.practice_id) return null;
  const now = clock.now();
  const paused = isPaused(block);
  const resumable = paused && localDate(block.start, clock.zone()) === localDate(now, clock.zone());
  if (resumable) {
    return (
      <Button variant="quiet" type="button" className="rclink" disabled={actions.pending} onClick={() => void actions.resume(block)}>
        Resume, {formatMinutes(Math.round(timeLeftMs(block, now) / 60_000))} left
      </Button>
    );
  }
  if (paused || block.ended_at) return null;
  return (
    <Button variant="quiet" type="button" className="rclink" disabled={actions.pending} onClick={() => void actions.stillGoing(block)}>
      Still going, add {formatMinutes(STILL_GOING_MIN)}
    </Button>
  );
}

type Parts = RaisedProps & { range: string; title: ReactNode; details: ReactNode };

function NowBody(props: Parts) {
  const { block, actions, next } = props;
  const now = useNow(1000);
  const started = !!block.started_at;
  const paused = isPaused(block);
  const left = Math.max(0, Math.ceil(timeLeftMs(block, now) / 60_000));
  const toggle = () => void (paused ? actions.resume(block) : actions.pause(block));
  return (
    <>
      <div className="rcnow">
        <div className="rcnowtxt">
          <div className="rcmeta" aria-hidden="true">
            <BlockMarks state="now" look={props.look} />
            {props.range}
          </div>
          {props.title}
          {started && (
            <div className="rcmeta strong" aria-hidden="true">
              {paused ? `Paused, ${minutesWords(left)} left` : `${minutesWords(left)} left`}
            </div>
          )}
        </div>
        {started && <SpentRing block={block} now={now} phone onToggle={toggle} />}
      </div>
      <div className="rcacts">
        {started ? (
          <>
            <Button type="button" className="grow" disabled={actions.pending} onClick={() => void actions.markDoneNow(block, next)}>
              Mark done now
            </Button>
            {block.task_id ? (
              <Button type="button" className="grow" disabled={actions.pending} onClick={() => requestPrompt(block.id, true)}>
                Stop for now
              </Button>
            ) : (
              props.details
            )}
          </>
        ) : (
          <>
            <Button variant="primary" type="button" className="grow" disabled={actions.pending} onClick={() => void actions.start(block)}>
              Start
            </Button>
            {next ? (
              <Button type="button" className="grow" disabled={actions.pending} onClick={() => void actions.swap(block, next)}>
                Do next block instead
              </Button>
            ) : (
              props.details
            )}
          </>
        )}
      </div>
    </>
  );
}

/** Planning in progress: its one action, as the Now card had it. Finishing the plan is what finishes it. */
function PlanningBody(props: Parts) {
  const now = usePlanningNow(props.block);
  return (
    <>
      <div className="rcmeta" aria-hidden="true">
        <BlockMarks state="now" look={props.look} />
        {props.range}
        {now.inbox ? `, ${now.inbox} in your Inbox` : ''}
      </div>
      {props.title}
      {now.planned && <div className="rcmeta">This week is already planned.</div>}
      <div className="rcacts">
        <Button variant={now.action.primary ? 'primary' : 'secondary'} type="button" className="grow" disabled={now.action.pending} onClick={now.action.run}>
          {now.action.label}
        </Button>
        {props.details}
      </div>
    </>
  );
}
