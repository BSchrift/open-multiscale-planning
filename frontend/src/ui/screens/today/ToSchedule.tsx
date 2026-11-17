// To schedule on Today, just above the day: this week's work waiting for a time, either dated today or with no day
// of its own. A card dragged onto the day (held first on phone) is placed where it's let go; tapped, it opens its
// suggested times, as on Week, and Choose a time opens Week to place it by hand.

import { useMemo, useState } from 'react';
import { weekStart } from '../../../core/dates';
import type { LocalDate } from '../../../core/types';
import { useNav } from '../../app/nav';
import { useApp, useQuery } from '../../app/store';
import { Sheet } from '../../components/Sheet';
import { loadWeek, weekModel } from '../week/data';
import { LaneActions, LaneCard, laneCount } from '../week/lane';
import { useWeekActions } from '../week/useWeekActions';
import { useLanding } from '../week/landing';
import type { Slot } from '../../../core/slots';
import { Button } from '../../components/ds/Button';

export function ToSchedule(props: { date: LocalDate }) {
  const { clock, layout } = useApp();
  const nav = useNav();
  const act = useWeekActions();
  const week = weekStart(props.date);
  const data = useQuery((sql, c) => loadWeek(sql, c, week), [week]).data;
  const model = useMemo(() => data && weekModel(data, clock), [data, clock]);
  const [openId, setOpenId] = useState<string | null>(null);
  // A card let go on a block asks first: keep both, replace it, or leave it.
  const { landing, takeOff, asking } = useLanding(model?.blocks ?? [], week);
  if (!model) return null;
  const dropCard = async (x: (typeof model.unscheduled)[number], slot: Slot) => {
    const { go, off } = await landing(x.title, slot);
    if (go && (await act.place(x, slot))) takeOff(off);
  };
  const phone = layout === 'phone';
  // Planning has its own row on Today.
  // A count's sessions wait on any day without one of its sessions; a set day's, on its own day only.
  const hasSession = (x: (typeof model.unscheduled)[number]) => !!x.practice && !x.dates && model.blocks.some((b) => b.practice_id === x.practice!.id && b.date === props.date);
  const items = model.unscheduled.filter((x) => x.kind !== 'planning' && !hasSession(x) && (!x.dates || (x.dates.from <= props.date && props.date <= x.dates.to)));
  const item = items.find((x) => x.id === openId);
  const close = () => setOpenId(null);
  const actions = item && (
    <LaneActions
      item={item}
      canPlace
      onPlace={(slot) => {
        close();
        void act.place(item, slot);
      }}
      onChoose={() => nav.go('week', { place: item.id })}
      onSkipDay={() => {
        close();
        void act.skipDay(item, week);
      }}
      onTakeOut={() => {
        close();
        void act.takeOut(item, week);
      }}
      onDone={() => {
        close();
        void act.markDone(item.task!);
      }}
      onClose={close}
    />
  );
  const planOne = (
    <Button size="compact" type="button" onClick={() => nav.openFlow('planning', { week, step: 'schedule' })}>
      Schedule one at a time
    </Button>
  );

  return (
    <section className="card stack8 tosched" aria-label="To schedule">
      <div className="between">
        <div className="small">
          <span className="strong">To schedule</span>{' '}
          <span className="quiet">{items.length ? laneCount(items) : model.unscheduled.length ? 'Nothing waiting for today.' : 'Everything this week is on the calendar.'}</span>
        </div>
        {!phone && items.length > 0 && planOne}
      </div>
      {items.length > 0 && (
        <>
          <div className="lanerow">
            {items.map((x) => (
              <LaneCard
                key={x.id}
                item={x}
                ctx={model.ctx}
                open={openId === x.id}
                draggable
                onToggle={() => setOpenId(openId === x.id ? null : x.id)}
                onPreview={() => undefined}
                onDrop={(slot) => void dropCard(x, slot)}
              />
            ))}
          </div>
          <p className="small quiet">
            {phone ? 'Hold a card, then drag it onto the day, or tap it for suggested times.' : 'Hold work, then drag it onto the day to place it, or click it for suggested times.'}
          </p>
          {phone && planOne}
        </>
      )}
      {!phone && item && (
        <div className="panel stack8" role="group" aria-label={item.title}>
          {actions}
        </div>
      )}
      {phone && item && (
        <Sheet label={item.title} onClose={close}>
          {actions}
        </Sheet>
      )}
      {asking}
    </section>
  );
}
