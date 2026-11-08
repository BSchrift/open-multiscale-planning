// What's waiting in the Inbox, in added order, as rows of one card: on desktop each with Assign, on phone each a
// row to tap. The Inbox and planning's Inbox step show it, and each opens Process on the item.

import { formatMinutes } from '../../../core/dates';
import type { InboxRow } from '../../../core/queries';
import './inbox.css';

export function InboxList(props: { rows: readonly InboxRow[]; phone: boolean; onOpen(id: string): void }) {
  const { rows, phone, onOpen } = props;
  if (rows.length === 0) return null;
  return (
    <div className="card inboxlist">
      {rows.map((i) => {
        const est = i.estimate_min ? `${formatMinutes(i.estimate_min)} estimate` : null;
        return phone ? (
          <button key={i.id} className="projbtn morerow" type="button" onClick={() => onOpen(i.id)}>
            <span className="inboxlines">
              <span>{i.title}</span>
              {est && <span className="small quiet">{est}</span>}
            </span>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </button>
        ) : (
          <div key={i.id} className="inboxrow">
            <div>
              <div>{i.title}</div>
              {est && <div className="small quiet">{est}</div>}
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
