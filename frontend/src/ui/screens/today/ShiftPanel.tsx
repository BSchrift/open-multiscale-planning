// Shift rest of today: a preview of later blocks moved past a calendar clash, applied in one go with Undo.

import { formatTimeOfDay } from '../../../core/dates';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import { applyShift } from '../../../core/queue';
import type { ShiftPlan } from '../../../core/queue';
import { useNav } from '../../app/nav';
import { useApp, useMutation } from '../../app/store';
import { formatRange } from '../../components/blocks/describe';
import { useToast } from '../../components/Toast';

export function ShiftPanel(props: { plan: ShiftPlan; connected: boolean; onClose(): void }) {
  const { plan, onClose } = props;
  const { clock, layout } = useApp();
  const nav = useNav();
  const toast = useToast();
  // Applies the shift, or with a change given, its Undo.
  const write = useMutation((w, undo: PlanChange | null) => (undo ? applyPlanChange(w, undo) : applyShift(w, plan.moves)));
  const zone = clock.zone();
  const phone = layout === 'phone';

  const apply = async () => {
    const reverse = await write.run(null);
    if (!reverse) return;
    onClose();
    toast.show(props.connected ? 'Rest of today shifted. Time blocks calendar will update.' : 'Rest of today shifted.', {
      undo: () => write.run(reverse),
    });
  };

  return (
    <div className="panel stack" role="region" aria-label="Shift rest of today">
      <h2>Shift rest of today</h2>
      <ul className="stack8 shiftlist">
        {plan.moves.map((m) => {
          const times = (
            <>
              <span className="done">{formatRange(m.block.start, m.block.end, zone)}</span> now {formatRange(m.start, m.end, zone)}
            </>
          );
          return phone ? (
            <li key={m.block.id}>
              <div>{m.block.title}</div>
              <div className="small quiet">{times}</div>
            </li>
          ) : (
            <li key={m.block.id} className="between">
              <span>{m.block.title}</span>
              <span className="quiet">{times}</span>
            </li>
          );
        })}
      </ul>
      {plan.runs_past !== null && <p className="small">That runs past {formatTimeOfDay(plan.runs_past)}.</p>}
      <div className="row">
        <button className={`btn pri${phone ? ' grow' : ''}`} type="button" disabled={write.pending} onClick={() => void apply()}>
          Apply
        </button>
        <button className="btn" type="button" onClick={() => nav.go('week', { edit: 'this' })}>
          Edit
        </button>
        <button className="btn" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
