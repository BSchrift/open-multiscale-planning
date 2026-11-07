// To schedule on Today, just above the day: this week's work waiting for a time, either dated today or with no day
// of its own. A card dragged onto the day (held first on phone) is placed where it's let go; tapped, it opens its
// suggested times, as on Week.

import { useMemo, useState } from 'react';
import { weekStart } from '../../../core/dates';
import type { LocalDate } from '../../../core/types';
import { useNav } from '../../app/nav';
import { useApp, useQuery } from '../../app/store';
import { Sheet } from '../../components/Sheet';
import { loadWeek, weekModel } from '../week/data';
import { LaneActions, LaneCard, laneCount } from '../week/lane';
import { useWeekActions } from '../week/useWeekActions';

export function ToSchedule(props: { date: LocalDate }) {
  const { clock, layout } = useApp();
  const nav = useNav();
  const act = useWeekActions();
  const week = weekStart(props.date);
  const data = useQuery((sql, c) => loadWeek(sql, c, week), [week]).data;
  const model = useMemo(() => data && weekModel(data, clock), [data, clock]);
  const [openId, setOpenId] = useState<string | null>(null);
  if (!model) return null;
  const phone = layout === 'phone';
  const items = model.unscheduled.filter((x) => !x.dates || (x.dates.from <= props.date && props.date <= x.dates.to));
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
      onChoose={item.task ? () => nav.go('week', { place: item.id }) : undefined}
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
    <button className={phone ? 'btn' : 'btn sm'} type="button" onClick={() => nav.openFlow('planning', { week, step: 'schedule' })}>
      Schedule one at a time
    </button>
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
                onDrop={(slot) => void act.place(x, slot)}
              />
            ))}
          </div>
          <p className="small quiet">
            {phone ? 'Hold a card, then drag it onto the day, or tap it for suggested times.' : 'Drag work onto the day to place it, or click it for suggested times.'}
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
    </section>
  );
}
