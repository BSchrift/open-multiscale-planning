// The Overdue pill's question in a popover on desktop and a sheet on phone, with a way to the project in Goals.
// Saving logs the change on the project, where its line offers Undo.

import type { PlanContext, ProjectPlan } from '../../../../core/plan';
import { fixSummary } from '../../../../core/status';
import type { Milestone } from '../../../../core/types';
import { OverdueQuestion } from '../../../components/editors';
import { Popover } from '../../../components/Popover';
import { useToast } from '../../../components/Toast';
import { useNav } from '../../../app/nav';

export function OverdueFix(props: { plan: ProjectPlan; milestone: Milestone; ctx: PlanContext; onSaved(): void; onClose(): void }) {
  const { plan, milestone, ctx } = props;
  const nav = useNav();
  const toast = useToast();
  const openGoals = () => {
    nav.go('goals', { project: plan.project.id });
    toast.show('Your plan is kept.');
  };
  return (
    <Popover label={fixSummary(plan, milestone.id, ctx).title} onClose={props.onClose}>
      <OverdueQuestion
        plan={plan}
        ctx={ctx}
        milestoneId={milestone.id}
        onSaved={props.onSaved}
        footer={
          <div className="between">
            <button className="link small" type="button" onClick={openGoals}>
              Open project in Goals
            </button>
            <button className="link small" type="button" onClick={props.onClose}>
              Close
            </button>
          </div>
        }
      />
    </Popover>
  );
}
