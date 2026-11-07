// What a task's title opens in Pick tasks: the project task editor, or a one off's own form, in place on desktop and
// in a sheet on phone. Saving writes at once, and the rows follow from the query.

import type { PlanContext } from '../../../../core/plan';
import { useApp } from '../../../app/store';
import { TaskEditor } from '../../../components/editors';
import { OneOffEditor } from '../../../components/oneoff';
import { Sheet } from '../../../components/Sheet';
import type { PickTask, PickView } from './model';

export function EditTask(props: { row: PickTask; view: PickView; ctx: PlanContext; onClose(): void }) {
  const { row, onClose } = props;
  const phone = useApp().layout === 'phone';
  // shortcut: a task moves only between its own project's milestones, as TaskEditor offers; give TaskEditor a project
  // choice when tasks need moving between projects.
  const plan = props.view.projects.find((p) => p.plan.project.id === row.c.task.project_id)?.plan;
  // The phone row has no room for the note, so its editor shows it.
  const note = phone ? row.note : '';
  if (plan) return <TaskEditor plan={plan} ctx={props.ctx} taskId={row.c.task.id} note={note} onClose={onClose} />;
  if (!phone) return <OneOffEditor task={row.c.task} onClose={onClose} />;
  return (
    <Sheet label="Edit one off" tall onClose={onClose}>
      <h2>Edit one off</h2>
      {note && <p className="small quiet">{note}</p>}
      <OneOffEditor task={row.c.task} onClose={onClose} />
    </Sheet>
  );
}
