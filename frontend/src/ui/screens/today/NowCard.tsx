// The block in progress with its countdown, or the next one with Start early.

import { useRef } from 'react';
import { currentBlock, nextBlock } from '../../../core/blocks';
import { formatTime, instantMs } from '../../../core/dates';
import type { BlockRow } from '../../../core/queries';
import type { Layout } from '../../app/registry';
import { useApp, useNow } from '../../app/store';
import { formatRange } from '../../components/blocks/describe';
import { useBlockActions } from '../../components/blocks/useBlockActions';

const pad = (n: number) => String(n).padStart(2, '0');

function Countdown(props: { end: string }) {
  const now = useNow(1000);
  const left = Math.max(0, Math.floor((instantMs(props.end) - now) / 1000));
  const h = Math.floor(left / 3600);
  const m = Math.floor(left / 60) % 60;
  return (
    <div className="clock" role="timer">
      {h ? `${h}:${pad(m)}` : m}:{pad(left % 60)}
    </div>
  );
}

export function NowCard(props: { blocks: readonly BlockRow[]; layout: Layout }) {
  const { blocks, layout } = props;
  const { clock } = useApp();
  const actions = useBlockActions();
  const head = useRef<HTMLHeadingElement>(null);
  // Start, Start early and Do next block instead go once pressed, so focus moves to the card's heading, not the page.
  const thenFocus = (done: Promise<unknown>) => void done.then(() => head.current?.focus());
  const zone = clock.zone();
  const cur = currentBlock(blocks, clock);
  const next = nextBlock(blocks, clock);
  const phone = layout === 'phone';

  if (cur) {
    const started = !!cur.started_at;
    const markDone = (
      <button className="btn" type="button" disabled={actions.pending} onClick={() => void actions.markDoneNow(cur, next)}>
        Mark done now
      </button>
    );
    return (
      <section className="now stack" aria-label="Current block">
        <div className="small quiet">Now, {formatRange(cur.start, cur.end, zone)}</div>
        <h2 ref={head} tabIndex={-1}>
          {cur.title}
        </h2>
        {started && (
          <div>
            <div className="small quiet">In progress, time left</div>
            <Countdown end={cur.end} />
          </div>
        )}
        {phone && started && markDone}
        {(!phone || !started) && (
          <div className="row">
            {!started && (
              <>
                <button className={`btn pri${phone ? ' grow' : ''}`} type="button" onClick={() => thenFocus(actions.start(cur))}>
                  Start
                </button>
                {next && (
                  <button className="btn" type="button" onClick={() => thenFocus(actions.swap(cur, next))}>
                    Do next block instead
                  </button>
                )}
              </>
            )}
            {!phone && markDone}
          </div>
        )}
      </section>
    );
  }

  if (next) {
    const free = `Free until ${formatTime(next.start, zone)}`;
    return (
      <section className="now stack" aria-label="Current block">
        <div className="small quiet">{phone ? `${free}. Next:` : free}</div>
        <h2 ref={head} tabIndex={-1}>
          {phone ? next.title : `Next: ${next.title}`}
        </h2>
        <div className="row">
          <button className={phone ? 'btn pri' : 'btn'} type="button" onClick={() => thenFocus(actions.startEarly(next))}>
            Start early
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="now stack" aria-label="Current block">
      <div className="small quiet">Nothing else planned today.</div>
    </section>
  );
}
