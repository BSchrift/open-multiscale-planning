// Select mode's actions, under the count: add every ticked Inbox item to a project, make them one offs, or delete
// them, as Process does to one. Each action is one transaction with one Undo in the toast.

import { useRef, useState } from 'react';
import { deleteInboxItems, sendInboxItems } from '../../../core/inbox';
import { applyPlanChange } from '../../../core/plan';
import type { PlanChange } from '../../../core/plan';
import type { InboxRow } from '../../../core/queries';
import { listRecords } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { useApp, useMutation, useQuery } from '../../app/store';
import { useToast } from '../Toast';
import { useFocusLanding } from '../useFocusLanding';

const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

export function SelectBar(props: { selected: readonly InboxRow[]; total: number; phone: boolean; onDone(gone: readonly string[]): void }) {
  const { selected, phone } = props;
  const { clock } = useApp();
  const toast = useToast();
  const land = useFocusLanding();
  const { run, pending } = useMutation((w, fn: (w: Writer) => Promise<PlanChange>) => fn(w));
  // The projects Process can add to: every one still going, paused included.
  const projects = useQuery((sql) => listRecords(sql, 'project'), []).data?.filter((p) => p.state === 'active' || p.state === 'paused') ?? [];
  const [to, setTo] = useState('');
  const [asking, setAsking] = useState(false);
  const bar = useRef<HTMLDivElement>(null);

  const n = selected.length;
  const project = projects.find((p) => p.id === to);
  const size = phone ? 'btn' : 'btn sm';

  const apply = async (fn: (w: Writer, ids: readonly string[]) => Promise<PlanChange>, message: string) => {
    if (pending || n === 0) return;
    const ids = selected.map((i) => i.id);
    const reverse = await run((w) => fn(w, ids));
    if (!reverse) return;
    // With nothing left in the list, Undo is the one place left for focus.
    toast.show(message, { undo: () => run((w) => applyPlanChange(w, reverse)), focusUndo: ids.length === props.total });
    props.onDone(ids);
  };
  const add = () => project && void apply((w, ids) => sendInboxItems(w, ids, project.id), `Added ${items(n)} to ${project.title}.`);
  const oneOffs = () => void apply((w, ids) => sendInboxItems(w, ids, null), `Made ${n} ${n === 1 ? 'one off' : 'one offs'}.`);
  const remove = () => void apply((w, ids) => deleteInboxItems(w, ids, clock), `Deleted ${items(n)}.`);
  // The question takes the button's place, so focus moves to its safe answer, and back again.
  const ask = (on: boolean) => {
    setAsking(on);
    land(() => bar.current?.querySelector<HTMLElement>(on ? '[data-keep]' : '[data-delete]'));
  };

  if (asking) {
    return (
      <div ref={bar} className="inboxacts" role="alert">
        <span className="strong small">Delete {items(n)}?</span>
        <button className={`${size} pri`} type="button" disabled={n === 0 || pending} onClick={remove}>
          Yes, delete
        </button>
        <button className={size} type="button" data-keep onClick={() => ask(false)}>
          Keep them
        </button>
      </div>
    );
  }
  return (
    <div ref={bar} className="inboxacts">
      {projects.length > 0 && (
        <span className="inboxsend">
          <select className="field" aria-label="Project to add to" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose a project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.state === 'paused' ? `${p.title} (Paused)` : p.title}
              </option>
            ))}
          </select>
          <button className={size} type="button" disabled={!project || n === 0 || pending} onClick={add}>
            Add
          </button>
        </span>
      )}
      <button className={size} type="button" disabled={n === 0 || pending} onClick={oneOffs}>
        Make one offs
      </button>
      <button className={size} type="button" data-delete disabled={n === 0} onClick={() => ask(true)}>
        Delete/done
      </button>
    </div>
  );
}
