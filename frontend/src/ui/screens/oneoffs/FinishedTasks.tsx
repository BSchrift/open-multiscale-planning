// Every finish of a one off, newest first in months, ten at a time with more on request, and searchable so a very
// long history stays usable. Unticking a row keeps it here until the list closes, so a slip can be re-ticked.

import { useId, useState } from 'react';
import { formatDate, localDate, today } from '../../../core/dates';
import { finishedCount, finishedTasks } from '../../../core/queries';
import type { FinishedRow } from '../../../core/queries';
import { retickOneOff, untickOneOff } from '../../../core/tasks';
import { useApp, useMutation, useQuery } from '../../app/store';
import { useOpenTask } from '../../components/task/TaskName';
import { TaskRow } from '../../components/TaskRow';

const PAGE = 10;
const MORE = 20;

function monthName(date: string, thisYear: string): string {
  const name = new Date(`${date.slice(0, 7)}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return date.slice(0, 4) === thisYear ? name : `${name} ${date.slice(0, 4)}`;
}

export function FinishedTasks() {
  const { clock, layout } = useApp();
  const openTask = useOpenTask();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [undone, setUndone] = useState<ReadonlyMap<string, FinishedRow>>(new Map());
  const any = useQuery((sql) => finishedCount(sql), []).data ?? 0;
  const { data } = useQuery(
    async (sql) => {
      if (!open) return { rows: [], count: 0 };
      const q = search.trim();
      const rows: FinishedRow[] = [];
      for (let offset = 0; offset < shown; offset += PAGE) rows.push(...(await finishedTasks(sql, { search: q, offset })));
      return { rows, count: await finishedCount(sql, { search: q }) };
    },
    [open, search, shown],
  );
  const toggle = useMutation(async (w, row: FinishedRow, reopen: boolean) => {
    await (reopen ? untickOneOff : retickOneOff)(w, row.id, clock);
    return true;
  });

  if (!any && !open) return null;
  const zone = clock.zone();
  const q = search.trim().toLowerCase();
  const kept = [...undone.values()].filter((r) => r.title.toLowerCase().includes(q) && !data?.rows.some((x) => x.id === r.id));
  const rows = [...(data?.rows ?? []), ...kept].sort((a, b) => b.done_at.localeCompare(a.done_at));
  const count = (data?.count ?? 0) + kept.length;
  const more = (data?.count ?? 0) - (data?.rows.length ?? 0);
  const thisYear = today(clock).slice(0, 4);

  const close = () => {
    setOpen(false);
    setSearch('');
    setShown(PAGE);
    setUndone(new Map());
  };
  const flip = async (row: FinishedRow) => {
    const reopen = !undone.has(row.id);
    if (!(await toggle.run(row, reopen))) return;
    const next = new Map(undone);
    if (reopen) next.set(row.id, row);
    else next.delete(row.id);
    setUndone(next);
  };

  let lastMonth = '';
  return (
    <div className="stack8 oofinished">
      <div>
        <button className={layout === 'phone' ? 'link' : 'link small'} type="button" aria-expanded={open} aria-controls={id} onClick={() => (open ? close() : setOpen(true))}>
          Finished tasks
        </button>
      </div>
      {open && (
        <section id={id} className="card stack8" aria-label="Finished tasks">
          <input
            className="field"
            type="search"
            aria-label="Search finished tasks"
            placeholder="Search finished tasks"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setShown(PAGE);
            }}
          />
          <div className="small quiet" role="status">
            {data && `${count} ${q ? 'matching' : 'finished'}`}
          </div>
          {rows.map((row) => {
            const day = localDate(row.done_at, zone);
            const month = monthName(day, thisYear);
            const heading = month !== lastMonth;
            lastMonth = month;
            const checked = !undone.has(row.id);
            return (
              <div key={row.id}>
                {heading && <h3>{month}</h3>}
                <TaskRow
                  title={row.title}
                  checked={checked}
                  line={checked ? `Done ${formatDate(day)}` : 'Not done'}
                  onOpen={() => openTask(row.task_id)}
                  onToggle={() => void flip(row)}
                />
              </div>
            );
          })}
          {data && count === 0 && <p className="small quiet">No finished tasks match.</p>}
          {more > 0 && (
            <div>
              <button className={layout === 'phone' ? 'btn' : 'btn sm'} type="button" onClick={() => setShown(shown + MORE)}>
                {`Show ${Math.min(MORE, more)} more, ${more} older`}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
