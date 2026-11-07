// Needs a new time: planned work that didn't get done. Each row still belongs to its project or One offs; it offers
// its best open time in one tap, and work passed over at the last planning first asks "Still want this?".

import { placeBlock } from '../../../core/blocks';
import { addWeeks, formatDate, formatTimeOfDay, formatWeekday, thisWeek, weekRange } from '../../../core/dates';
import { applyPlanChange, gatherPlans, taskDue, taskWork } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import { blocksInRange } from '../../../core/queries';
import { deleteWork, keepWork } from '../../../core/queue';
import type { QueueItem } from '../../../core/queue';
import { CALENDAR_ID, getRecord, getSettings, listRecords } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { offers, slotContext, slotInstants } from '../../../core/slots';
import type { Offer, SlotContext, Work } from '../../../core/slots';
import type { LocalDate } from '../../../core/types';
import { useNav } from '../../app/nav';
import { useApp, useMutation, useQuery } from '../../app/store';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';

const INTRO = "Planned work that didn't get done. It still belongs to its project or One offs, and you choose a new time when it suits you.";

type WorkOf = (item: QueueItem, week: LocalDate) => Work;

/** This week, then next, so there's nearly always a time to offer. Due dates rank the times, as in Week. */
function bestOffer(item: QueueItem, contexts: readonly SlotContext[], workOf: WorkOf): Offer | undefined {
  for (const ctx of contexts) {
    const offer = offers(item.minutes, workOf(item, ctx.week), ctx)[0];
    if (offer) return offer;
  }
  return undefined;
}

function QueueRow(props: { item: QueueItem; offer: Offer | undefined }) {
  const { item, offer } = props;
  const { clock, layout } = useApp();
  const nav = useNav();
  const toast = useToast();
  const write = useMutation((w, fn: (w: Writer) => Promise<unknown>) => fn(w));
  const phone = layout === 'phone';
  const label = offer && `${formatWeekday(offer.date)} ${formatDate(offer.date)}, ${formatTimeOfDay(offer.start)}`;

  // As placing on Week: an estimate the time no longer fits goes up, and Undo takes both back.
  const place = async () => {
    if (!offer) return;
    const reverse = await write.run((w) => placeBlock(w, item.id, slotInstants(offer, clock.zone()), clock));
    if (reverse) toast.show(`Placed ${item.title}, ${label}`, { undo: () => write.run((w) => applyPlanChange(w, reverse as PlanChange)), focusUndo: true });
  };
  const remove = async () => {
    const reverse = await write.run((w) => deleteWork(w, item, clock));
    if (reverse) toast.show('Deleted', { undo: () => write.run((w) => applyPlanChange(w, reverse as PlanChange)), focusUndo: true });
  };
  const deleteButton = (
    <button className="btn sm" type="button" aria-label={`Delete ${item.title}`} disabled={write.pending} onClick={() => void remove()}>
      Delete
    </button>
  );

  return (
    <div className={phone ? 'rowline' : 'qrow'}>
      <div>
        <div>{item.title}</div>
        <div className="small quiet">{item.reason}</div>
      </div>
      {item.stale ? (
        <div className="row">
          <span className="small">Still want this?</span>
          <button className="btn sm pri" type="button" aria-label={`Keep ${item.title}`} onClick={() => void write.run((w) => keepWork(w, item, clock))}>
            Keep
          </button>
          {deleteButton}
        </div>
      ) : (
        <div className="row">
          {offer && (
            <button className={`btn sm pri${phone ? ' grow' : ''}`} type="button" aria-label={`Place ${item.title}, ${label}`} disabled={write.pending} onClick={() => void place()}>
              {label}
            </button>
          )}
          {phone && (
            <button className="btn sm grow" type="button" onClick={() => nav.go('week', { place: item.id })}>
              Place on calendar
            </button>
          )}
          {deleteButton}
        </div>
      )}
    </div>
  );
}

export function QueuePanel(props: { items: readonly QueueItem[]; onClose(): void }) {
  const { items, onClose } = props;
  const { layout } = useApp();
  const slots = useQuery(async (sql, clock) => {
    const settings = await getSettings(sql);
    const [projects, milestones, tasks, away] = await Promise.all([
      listRecords(sql, 'project'),
      listRecords(sql, 'milestone'),
      listRecords(sql, 'task'),
      listRecords(sql, 'away_period'),
    ]);
    const plans = gatherPlans(projects, milestones, tasks);
    const workOf: WorkOf = (item, week) => {
      const t = tasks.find((x) => x.id === item.id);
      if (!t) return { kind: item.kind === 'one_off' ? 'one_off' : 'project' };
      const plan = plans.find((p) => p.project.id === t.project_id) ?? null;
      return taskWork(t, taskDue(t, plan, week, { settings, clock, away }), week);
    };
    const calendar = (await getRecord(sql, 'calendar', CALENDAR_ID)) ?? null;
    const sources = await listRecords(sql, 'calendar_source');
    const weeks = [thisWeek(clock), addWeeks(thisWeek(clock), 1)];
    const out: SlotContext[] = [];
    for (const week of weeks) {
      const blocks = await blocksInRange(sql, weekRange(week, clock.zone()));
      out.push(slotContext({ week, availability: settings.availability, avoided: settings.avoided_slots, sources, calendar, blocks, clock }));
    }
    return { contexts: out, workOf };
  }, []).data;

  const body = (
    <>
      {items.length === 0 && <p className="quiet">Nothing needs a new time.</p>}
      {items.map((item) => (
        <QueueRow key={item.block_id} item={item} offer={slots && bestOffer(item, slots.contexts, slots.workOf)} />
      ))}
    </>
  );

  if (layout === 'phone') {
    return (
      <Sheet label="Needs a new time" onClose={onClose} tall>
        <div className="between">
          <h2>Needs a new time</h2>
          <button className="btn" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="small quiet">Planned work that didn't get done. It still belongs to its project or One offs.</p>
        {body}
      </Sheet>
    );
  }
  return (
    <div className="panel stack8" role="region" aria-label="Needs a new time">
      <div className="between">
        <h2>Needs a new time</h2>
        <button className="link" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="small quiet">{INTRO}</p>
      {body}
    </div>
  );
}
