// A block's details: when, its outcome, first step and what it belongs to. A sheet on phone; on desktop a panel in
// place, or the body alone for a caller that has its own popover.

import type { Sql } from '../../../core/db';
import type { BlockRow } from '../../../core/queries';
import { getRecord } from '../../../core/records';
import { useApp, useQuery } from '../../app/store';
import { Pill } from '../Pill';
import { Sheet } from '../Sheet';
import { describeBlock, formatRange, OUTCOME_WORD } from './describe';
import type { BlockRecords } from './describe';

/** The records describeBlock needs for one block. */
export async function loadBlockRecords(sql: Sql, block: Pick<BlockRow, 'task_id' | 'practice_id'>): Promise<BlockRecords> {
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
      {info?.first && (
        <div>
          <span className="quiet">First step: </span>
          {info.first}
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

export function BlockDetail(props: { block: BlockRow; onClose(): void }) {
  const { block } = props;
  const { layout, clock } = useApp();
  const when = formatRange(block.start, block.end, clock.zone());
  if (layout === 'phone') {
    return (
      <Sheet label={block.title ?? 'Time block'} onClose={props.onClose}>
        <div>
          <div className="small quiet">{when}</div>
          <h2>{block.title}</h2>
        </div>
        <div className="stack8 small">
          <BlockDetailBody block={block} />
        </div>
        <button className="btn" type="button" onClick={props.onClose}>
          Close
        </button>
      </Sheet>
    );
  }
  return (
    <div className="panel stack8 small" role="region" aria-label={block.title ?? 'Time block'}>
      <div className="between">
        <span className="strong">{block.title}</span>
        <button className="link" type="button" onClick={props.onClose}>
          Close
        </button>
      </div>
      <div className="quiet">{when}</div>
      <BlockDetailBody block={block} />
    </div>
  );
}
