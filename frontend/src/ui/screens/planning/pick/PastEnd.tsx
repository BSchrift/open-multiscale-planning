// A project past its end date asks first: Finish, Change end date or Drop, or Skip for now. Finish and Drop ask
// again, since they cancel the hours left, and both offer Undo.

import { formatDate, formatMinutes } from '../../../../core/dates';
import type { PlanContext, ProjectPlan } from '../../../../core/plan';
import type { ProjectStatus } from '../../../../core/status';
import { CloseProject } from '../../../components/editors';
import { Pill } from '../../../components/Pill';

export function pastEndLine(plan: ProjectPlan, status: ProjectStatus): string {
  return `Ended ${formatDate(plan.project.end)}, ${formatMinutes(status.doneMin)} done and ${formatMinutes(status.leftMin)} left`;
}

export function PastEnd(props: { plan: ProjectPlan; status: ProjectStatus; ctx: PlanContext; onSkip(): void; heading?: boolean }) {
  const { plan, status, ctx } = props;
  const skip = (
    <button className={props.heading ? 'btn sm' : 'link small'} type="button" onClick={props.onSkip}>
      Skip for now
    </button>
  );
  return (
    <>
      <div className="between">
        <div className="row">
          {props.heading ? <h2>{plan.project.title}</h2> : <h3>{plan.project.title}</h3>}
          <Pill tone="red">Past end date</Pill>
        </div>
        {!props.heading && skip}
      </div>
      <div className="small latetext">{pastEndLine(plan, status)}</div>
      <CloseProject plan={plan} ctx={ctx} {...(props.heading ? { extra: skip } : {})} />
    </>
  );
}
