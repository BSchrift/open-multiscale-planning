// A block's details, its outcome and what it belongs to, in its popup's block section.

import type { Sql } from '../../../core/db';
import type { BlockRow } from '../../../core/queries';
import { getRecord } from '../../../core/records';
import { useQuery } from '../../app/store';
import { Pill } from '../Pill';
import { describeBlock, OUTCOME_WORD } from './describe';
import type { BlockRecords } from './describe';

/** The records describeBlock needs for one block. */
async function loadBlockRecords(sql: Sql, block: Pick<BlockRow, 'task_id' | 'practice_id'>): Promise<BlockRecords> {
  const task = block.task_id ? await getRecord(sql, 'task', block.task_id) : undefined;
  const practice = block.practice_id ? await getRecord(sql, 'practice', block.practice_id) : undefined;
  const project = task?.project_id ? await getRecord(sql, 'project', task.project_id) : undefined;
  const goalId = practice?.objective_id ?? project?.objective_id;
  const objective = goalId ? await getRecord(sql, 'objective', goalId) : undefined;
  return { task, practice, project, objective };
}

export function BlockDetailBody(props: { block: BlockRow }) {
  const { block } = props;
  const records = useQuery((sql) => loadBlockRecords(sql, block), [block.task_id, block.practice_id]).data;
  const info = records && describeBlock(block, records);
  return (
    <>
      {block.result && (
        <div>
          <Pill tone="grey">{OUTCOME_WORD[block.result]}</Pill>
        </div>
      )}
      {info?.path && (
        <div>
          <span className="quiet">{info.word}: </span>
          {info.path}
        </div>
      )}
    </>
  );
}
