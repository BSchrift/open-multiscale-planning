// Shared editors for projects, milestones, tasks and practices. Each takes live records from its caller's query and
// a PlanContext (pass planning: true inside the planning flow), and writes through core.
//
//   <TaskEditor plan={plan} ctx={ctx} taskId={id} onClose={close} />          popover on desktop, sheet on phone
//   <MilestoneEditor plan={plan} ctx={ctx} milestoneId={id} onClose={close} /> omit the id to add one
//   <OverdueFix plan={plan} ctx={ctx} />                                        renders nothing unless overdue
//   <CloseProject plan={plan} ctx={ctx} onClosed={leave} />                     Finish, Change end date, Drop
//   <PracticeFields practice={p} goals={objectives} />                          edits in place

import './editors.css';

export { ChangeEndDate, CloseProject, CloseQuestion } from './CloseProject';
export { DropMilestone } from './DropMilestone';
export { diamondFor, doneDiamond, MilestoneEditor } from './MilestoneEditor';
export { OverdueFix, OverdueQuestion } from './OverdueFix';
export { GoalSelect, PracticeAdd, PracticeFields, practiceRule, PracticeSheet } from './PracticeEditor';
export { ProjectAdd } from './ProjectAdd';
export { TaskEditor } from './TaskEditor';
export { usePlanChange } from './usePlanChange';
