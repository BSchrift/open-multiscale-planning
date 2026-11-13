// The Inbox: everything captured, in added order, waiting for a home. Its main action is Process, which opens the
// cards over the page; a single row opens them on that item.

import { useRef } from 'react';
import { inboxTasks } from '../../../core/queries';
import { useNav } from '../../app/nav';
import type { ScreenProps } from '../../app/registry';
import { useQuery } from '../../app/store';
import { InboxList } from '../../components/inbox/InboxList';
import { useHeadingAfterProcess } from '../../components/inbox/useHeadingAfterProcess';
import './inbox.css';

export default function Screen(props: ScreenProps) {
  const nav = useNav();
  const rows = useQuery((sql) => inboxTasks(sql), []).data;
  const heading = useRef<HTMLHeadingElement>(null);
  useHeadingAfterProcess(heading, rows?.length === 0);
  if (!rows) return null;
  const phone = props.layout === 'phone';
  const process = (item?: string) => nav.openOverlay('process', item ? { item } : {});
  const startLabel = `Process ${rows.length} ${rows.length === 1 ? 'item' : 'items'}`;

  if (phone) {
    return (
      <div className="stack inboxdocked">
        <h1 ref={heading} tabIndex={-1}>
          Inbox
        </h1>
        {rows.length === 0 && <p className="quiet">Inbox is empty. Anything you capture lands here.</p>}
        <InboxList rows={rows} phone onOpen={process} />
        {rows.length > 0 && (
          <button className="tray go" type="button" onClick={() => process()}>
            {startLabel}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="wrap stack8">
      <h1 ref={heading} tabIndex={-1}>
        Inbox
      </h1>
      <p className="quiet inboxintro">Things you've captured. Give each one a home, now or when you plan.</p>
      {rows.length === 0 ? (
        <p className="quiet">Inbox is empty.</p>
      ) : (
        <button className="btn pri pxstart" type="button" onClick={() => process()}>
          {startLabel}
        </button>
      )}
      <InboxList rows={rows} phone={false} onOpen={process} />
    </div>
  );
}
