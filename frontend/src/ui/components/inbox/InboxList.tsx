// What's waiting in the Inbox, in added order, as rows of one card. Each item's name opens its popup, to change it or
// write its description, and beside it Assign on desktop, or › on phone, opens Process on the item. The Inbox and
// planning's Inbox step show it.

import { formatMinutes } from '../../../core/dates';
import type { InboxRow } from '../../../core/queries';
import { TaskName } from '../task/TaskName';
import './inbox.css';

export function InboxList(props: { rows: readonly InboxRow[]; phone: boolean; onOpen(id: string): void }) {
  const { rows, phone, onOpen } = props;
  if (rows.length === 0) return null;
  return (
    <div className="card inboxlist">
      {rows.map((i) => {
        const est = i.estimate_min ? `${formatMinutes(i.estimate_min)} estimate` : null;
        return phone ? (
          <div key={i.id} className="inboxrow phone">
            <TaskName id={i.id} title={i.title} details={!!i.has_notes} className="rowname inboxname" />
            {est && <span className="small quiet inboxest">{est}</span>}
            <button className="inboxgo" type="button" aria-label={`Process ${i.title}`} onClick={() => onOpen(i.id)}>
              <span className="chev" aria-hidden="true">
                ›
              </span>
            </button>
          </div>
        ) : (
          <div key={i.id} className="inboxrow">
            <div className="inboxlines">
              <TaskName id={i.id} title={i.title} details={!!i.has_notes} className="rowname" />
              {est && <span className="small quiet">{est}</span>}
            </div>
            <button className="btn sm" type="button" aria-label={`Assign ${i.title}`} onClick={() => onOpen(i.id)}>
              Assign
            </button>
          </div>
        );
      })}
    </div>
  );
}
