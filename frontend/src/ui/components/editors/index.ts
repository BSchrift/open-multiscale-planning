// Shared editors for projects, milestones, tasks and practices. Each takes live records from its caller's query and
// a PlanContext (pass planning: true inside the planning flow), and writes through core.
//
//   <TaskEditor plan={plan} ctx={ctx} milestoneId={id} onClose={close} />     adds tasks; a task's popup changes one
//   <MilestoneEditor plan={plan} ctx={ctx} milestoneId={id} onClose={close} /> omit the id to add one
//   <OverdueFix plan={plan} ctx={ctx} />                                        renders nothing unless overdue
//   <CloseProject plan={plan} ctx={ctx} onClosed={leave} />                     Finish, Change end date, Drop
//   <PracticeFields practice={p} goals={objectives} onClose={close} />           edits in place, until Save or Cancel
//   <HomeForm item={title} kind="project" ... onSave={make} />                  a new home for an Inbox item

import './editors.css';

export { CloseProject, CloseQuestion } from './CloseProject';
export { HomeForm } from './HomeForm';
export type { HomeKind } from './HomeForm';
export { diamondFor, doneDiamond, MilestoneEditor } from './MilestoneEditor';
export { OverdueFix, OverdueQuestion } from './OverdueFix';
export { GoalSelect, PracticeAdd, PracticeFields, practiceRule, PracticeSheet } from './PracticeEditor';
export { ProjectAdd } from './ProjectAdd';
export { TaskEditor } from './TaskEditor';
export { DATE_UNSET, useLeave } from './useLeave';
export { usePlanChange } from './usePlanChange';
