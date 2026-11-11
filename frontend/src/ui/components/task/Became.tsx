// The link from a finished Inbox item to the project, practice or goal Process made of it, wherever the item shows. A
// project opens its page; a practice or goal opens on the Goals page.

import { getRecord } from '../../../core/records';
import type { Task } from '../../../core/types';
import { useNav } from '../../app/nav';
import { useApp, useQuery } from '../../app/store';

const NAMES = { project: 'project', practice: 'practice', objective: 'goal' } as const;

export function Became(props: { became: NonNullable<Task['became']>; onGo?(): void }) {
  const { type, id } = props.became;
  const nav = useNav();
  const { layout } = useApp();
  const record = useQuery((sql) => getRecord(sql, type, id), [type, id]).data;
  // Gone since, it has nothing to link to.
  if (!record || record.deleted_at) return null;
  const go = () => {
    props.onGo?.();
    nav.go('goals', type === 'project' ? { project: id } : { show: id });
  };
  return (
    <button className={layout === 'phone' ? 'link' : 'link small'} type="button" onClick={go}>
      {`Became the ${NAMES[type]} ${record.title}`}
    </button>
  );
}
