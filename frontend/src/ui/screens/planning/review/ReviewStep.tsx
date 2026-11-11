// Review: which weekly aims the placed time doesn't reach, what was picked but not placed, and how the week's time is
// used. Aims are soft, so the plan can still finish short of them.

import { plannedByKind, weekAlerts } from '../../../../core/capacity';
import { spansAhead } from '../../../../core/slots';
import { formatMinutes } from '../../../../core/dates';
import { ONE_OFFS_BUCKET } from '../../../../core/types';
import type { Instant, LocalDate } from '../../../../core/types';
import { NextPlanning } from './NextPlanning';
import type { Layout } from '../../../app/registry';
import { useApp, useQuery } from '../../../app/store';
import { TimeUse } from '../../../components/week/TimeUse';
import { placedBlocks } from '../../../components/weekgrid';
import { loadPlanning, weekModel } from '../model';

export function ReviewStep(props: { week: LocalDate; began: Instant; layout: Layout; onFinish(): void }) {
  const { week, layout } = props;
  const { clock } = useApp();
  const data = useQuery((sql) => loadPlanning(sql, clock, week), [week]).data;
  if (!data) return null;
  const m = weekModel(data, clock);
  const aims = m.aimRows(m.placedBy);
  const unmet = aims.filter((r) => r.short > 0);
  const name = (bucket: string) => (bucket === ONE_OFFS_BUCKET ? 'One offs' : (data.records.projects.find((p) => p.id === bucket)?.title ?? ''));
  // From the blocks as drawn on the week, as Week and Schedule count them: one running into next week counts only its part in this one.
  const drawn = placedBlocks(m.slot.placed, data.blocks, clock.now());
  const placedFor = (taskId: string) => drawn.filter((b) => b.task_id === taskId).reduce((sum, b) => sum + b.end - b.start, 0);
  const left = m.picks.reduce((sum, p) => sum + Math.max(0, p.minutes - placedFor(p.task_id)), 0);

  // Set against the open time left, so only what's still ahead.
  const used = plannedByKind(spansAhead(m.slot.placed, m.slot));
  const free = Math.max(0, m.open - used.total);

  return (
    <div className={layout === 'phone' ? 'scroll' : 'wrap stack'}>
      <div className="stack8">
        <h2>{unmet.length ? `${unmet.length} ${unmet.length === 1 ? 'aim' : 'aims'} not reached` : 'Ready to finish'}</h2>
        <div className="card stack8">
          {!unmet.length && <p className="quiet">All weekly aims are reached.</p>}
          {unmet.map((r) => (
            <div key={r.bucket} className="small">
              {name(r.bucket)}: {formatMinutes(r.got)} of {formatMinutes(r.aim)} aim
            </div>
          ))}
          {left > 0 && <p className="quiet">{formatMinutes(left)} of what you picked isn't scheduled. It stays on its project or in One offs.</p>}
          {data.calendar?.connected && <p className="quiet">Finishing pushes these blocks to the Time blocks calendar.</p>}
          {unmet.length > 0 && <p className="quiet">You can still finish short of an aim.</p>}
        </div>
      </div>
      <TimeUse open={m.open} planned={used} free={free} alerts={weekAlerts(m.slot, aims, m.pushback)} />
      <NextPlanning week={week} began={props.began} />
      {layout === 'desktop' && (
        <div className="row">
          <button className="btn pri" type="button" onClick={props.onFinish}>
            Finish plan
          </button>
        </div>
      )}
    </div>
  );
}
