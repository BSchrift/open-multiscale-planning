// Planning opens with the Inbox. Process opens its cards over the flow, told which week is being planned, so Add to
// this week adds to that plan; a single row opens the cards on that item.

import { useRef } from 'react';
import { inboxTasks } from '../../../../core/queries';
import type { LocalDate } from '../../../../core/types';
import { useNav } from '../../../app/nav';
import type { Layout } from '../../../app/registry';
import { useQuery } from '../../../app/store';
import { InboxList } from '../../../components/inbox/InboxList';
import { useHeadingAfterProcess } from '../../../components/inbox/useHeadingAfterProcess';

export function InboxStep(props: { week: LocalDate; layout: Layout; onNext(): void }) {
  const { week, layout } = props;
  const nav = useNav();
  const rows = useQuery((sql) => inboxTasks(sql), []).data;
  const heading = useRef<HTMLHeadingElement>(null);
  useHeadingAfterProcess(heading, rows?.length === 0);
  if (!rows) return null;
  const process = (item?: string) => nav.openOverlay('process', item ? { planning: week, item } : { planning: week });
  const phone = layout === 'phone';
  return (
    <div className={phone ? 'scroll' : 'wrap stack24'}>
      <div className="stack8">
        <h2 ref={heading} tabIndex={-1}>
          Inbox
        </h2>
        {rows.length === 0 ? (
          <p className="quiet">Inbox is empty.</p>
        ) : (
          <div>
            <button className="btn pri pxstart" type="button" onClick={() => process()}>
              Process {rows.length} {rows.length === 1 ? 'item' : 'items'}
            </button>
          </div>
        )}
        <InboxList rows={rows} phone={phone} onOpen={process} />
      </div>
      {!phone && (
        <div className="row">
          <button className="btn pri" type="button" onClick={props.onNext}>
            Continue to picking tasks
          </button>
        </div>
      )}
    </div>
  );
}
