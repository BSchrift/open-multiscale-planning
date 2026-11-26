// A block's name as a button that opens its popup, wherever a block is named away from a calendar, such as the Now
// card, Done and the prompts. A task's block opens the task's popup, as TaskName does anywhere; a practice's session or
// a planning block opens theirs over the page, with the block's own section at the top, as a calendar opens it.

import { useNav } from '../../app/nav';
import type { BlockRow } from '../../../core/queries';
import { TaskName } from '../task/TaskName';

/** Whose popup a block opens, fixed as it opens, so the popup stays open when its block comes off the calendar. */
export type PopFor = { block: string; task: string } | { block: string; practice: string } | { block: string; planning: string };

type Named = Pick<BlockRow, 'id' | 'task_id' | 'practice_id' | 'task_kind'>;

export function popFor(b: Named): PopFor {
  if (b.practice_id) return { block: b.id, practice: b.practice_id };
  if (b.task_kind === 'planning') return { block: b.id, planning: b.task_id! };
  return { block: b.id, task: b.task_id! };
}

/** A block with something to open: a task, a practice or planning. */
export const opensPopup = (b: Named) => !!b.practice_id || !!b.task_id;

/** Opens a practice's session or planning in its popup, over the page; a practice with no block opens with its own actions. */
export function useOpenPractice() {
  const { openOverlay } = useNav();
  return (params: PopFor | { practice: string }) => openOverlay('practice', params);
}

export function BlockName(props: { block: Named & { title: string | null }; className?: string }) {
  const { block } = props;
  const open = useOpenPractice();
  const title = block.title ?? '';
  if (!opensPopup(block)) return <>{title}</>;
  const pop = popFor(block);
  const className = `taskname${props.className ? ` ${props.className}` : ''}`;
  if ('task' in pop) return <TaskName id={pop.task} title={title} className={props.className} />;
  return (
    <button className={className} type="button" onClick={() => open(pop)}>
      {title}
    </button>
  );
}
