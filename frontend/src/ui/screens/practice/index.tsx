// A practice's popup and a planning block's: the task popup's frame and order, with each one's own fields. A calendar
// opens one from a practice's session or a planning block, with the block's own section at its top, as a task's block
// opens the task's popup (BlockPopup). Where a session is named away from a calendar, such as the Now card, Done and the
// prompts, it opens over the page with the same section (BlockName), and a practice's card in To schedule and its row on
// Goals open it with no block. Top to bottom: its name, which a tap renames; the block's section, or Pause or Resume practice with no
// block; its goal, its schedule (how often, each session's length and its time) and its notes; then End practice,
// Cancel and Save. The fields save together on Save, with Undo, as the editor on Goals saves them; the actions save as
// they go, each with its own Undo. An ended practice shows its block and says it ended. Planning has no fields: it's
// the app's own task, finished by finishing the plan, so its popup has its block's section and Close.

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { formatDate } from '../../../core/dates';
import type { Sql } from '../../../core/db';
import { planningWeekOf } from '../../../core/planning';
import { blockRow } from '../../../core/queries';
import { getRecord, listRecords } from '../../../core/records';
import type { Fields, Objective, Practice } from '../../../core/types';
import type { ScreenProps } from '../../app/registry';
import { useQuery } from '../../app/store';
import type { PopFor } from '../../components/blocks/BlockName';
import { BlockSection } from '../../components/blocks/BlockSection';
import { Button } from '../../components/ds/Button';
import { GoalSelect, usePracticeActions, usePracticeDraft } from '../../components/editors/PracticeEditor';
import { ScheduleFields } from '../../components/editors/PracticeSchedule';
import { HomeNotes } from '../notes/NoteList';
import { TaskPopupFor } from '../task';
import { PopupShell } from '../task/PopupShell';

/** Over the page: params block, for a session or planning, with practice or planning; or practice alone, with no block. */
export default function Screen(props: ScreenProps) {
  const { block, practice, planning } = props.params;
  const data = useQuery(async (sql) => ({ row: block ? await blockRow(sql, block) : undefined }), [block]).data;
  // Drawn once the block is read, so its section doesn't take the place of the practice's actions as it opens.
  if (!data) return null;
  const section = data.row && <BlockSection block={data.row} />;
  if (practice) return <PracticePopupFor id={practice} close={props.close} block={section} />;
  if (planning) return <PlanningPopupFor id={planning} close={props.close} block={section} />;
  return null;
}

/** The popup a calendar's block opens, drawn by the calendar so the block's section can reach back into it, as Move does. */
export function BlockPopup(props: { pop: PopFor; close(): void; section: ReactNode }) {
  const { pop, close, section } = props;
  if ('practice' in pop) return <PracticePopupFor id={pop.practice} close={close} block={section} />;
  if ('planning' in pop) return <PlanningPopupFor id={pop.planning} close={close} block={section} />;
  return <TaskPopupFor id={pop.task} close={close} block={section} />;
}

/** The way out of a popup with nothing to save, which always closes. */
const closed = (close: () => void) => () => {
  close();
  return true;
};

async function loadPractice(sql: Sql, id: string) {
  return { practice: await getRecord(sql, 'practice', id), goals: await listRecords(sql, 'objective') };
}

/** close has the fields Save wrote, for Goals, whose row moves to the practice's new goal. */
export function PracticePopupFor(props: { id: string; close(saved?: Fields<'practice'>): void; block?: ReactNode }) {
  const { id, close } = props;
  const data = useQuery((sql) => loadPractice(sql, id), [id]).data;
  // Deleted, here or on another device, it has nothing left to show.
  const gone = !!data && (!data.practice || !!data.practice.deleted_at);
  useEffect(() => {
    if (gone) close();
  }, [gone, close]);
  if (!data?.practice || gone) return null;
  return <PracticePopup key={id} practice={data.practice} goals={data.goals} close={close} block={props.block} />;
}

function PracticePopup(props: { practice: Practice; goals: readonly Objective[]; close(saved?: Fields<'practice'>): void; block?: ReactNode }) {
  const { practice: p, close } = props;
  const draft = usePracticeDraft(p, { onClose: close });
  const { paused, pause, end } = usePracticeActions(p, close);
  if (p.state === 'ended') {
    return (
      <PopupShell label={p.title} name={p.title} leave={closed(close)} close={close}>
        {props.block}
        <p className="small quiet">{p.title} has ended. Its history stays.</p>
      </PopupShell>
    );
  }
  return (
    <PopupShell
      label={p.title}
      name={draft.form.title}
      rename={(title) => draft.edit({ title })}
      leave={draft.leave}
      close={close}
      error={draft.error}
      remove={{ label: 'End practice', run: () => void end() }}
      save={{
        ref: draft.saveRef,
        submit: (event) => {
          event.preventDefault();
          void draft.save();
        },
      }}
    >
      {props.block || (
        <section className="taskacts" aria-label="Actions">
          <div className="row blocksecacts">
            <Button size="compact" type="button" onClick={() => void pause()}>
              {paused ? 'Resume practice' : 'Pause practice'}
            </Button>
          </div>
        </section>
      )}
      <GoalSelect goals={props.goals} value={draft.form.objective_id ?? ''} onChange={(id) => draft.edit({ objective_id: id || null })} />
      <ScheduleFields value={draft.form.schedule} onChange={(schedule) => draft.edit({ schedule })} daysError={draft.daysError} mondayRef={draft.monday} />
      <HomeNotes home={{ type: 'practice', id: p.id }} />
    </PopupShell>
  );
}

export function PlanningPopupFor(props: { id: string; close(): void; block?: ReactNode }) {
  const { id, close } = props;
  const data = useQuery(async (sql) => ({ task: await getRecord(sql, 'task', id) }), [id]).data;
  const gone = !!data && (!data.task || !!data.task.deleted_at);
  useEffect(() => {
    if (gone) close();
  }, [gone, close]);
  if (!data?.task || gone) return null;
  const week = planningWeekOf(id);
  return (
    <PopupShell label={data.task.title} name={data.task.title} leave={closed(close)} close={close}>
      {props.block}
      <p className="small quiet">{week ? `Done once you finish planning the week of ${formatDate(week)}.` : 'Done once you finish planning ahead.'}</p>
    </PopupShell>
  );
}
