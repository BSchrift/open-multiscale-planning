// The Inbox: everything captured, in added order, waiting for a home. Its main action is Process, which opens the
// cards over the page; a single row opens them on that item.

import { formatMinutes } from '../../../core/dates';
import { inboxTasks } from '../../../core/queries';
import { useNav } from '../../app/nav';
import type { ScreenProps } from '../../app/registry';
import { useQuery } from '../../app/store';
import './inbox.css';

export default function Screen(props: ScreenProps) {
  const nav = useNav();
  const rows = useQuery((sql) => inboxTasks(sql), []).data;
  if (!rows) return null;
  const phone = props.layout === 'phone';
  const process = (item?: string) => nav.openOverlay('process', item ? { item } : {});
  const startLabel = `Process ${rows.length} ${rows.length === 1 ? 'item' : 'items'}`;
  const est = (minutes: number | null) => (minutes ? `${formatMinutes(minutes)} estimate` : null);

  if (phone) {
    return (
      <div className="stack inboxdocked">
        <h1>Inbox</h1>
        {rows.length === 0 && <p className="quiet">Inbox is empty. Anything you capture lands here.</p>}
        <div className="card inboxlist">
          {rows.map((i) => (
            <button key={i.id} className="projbtn morerow" type="button" onClick={() => process(i.id)}>
              <span className="inboxlines">
                <span>{i.title}</span>
                {est(i.estimate_min) && <span className="small quiet">{est(i.estimate_min)}</span>}
              </span>
              <span className="chev" aria-hidden="true">
                ›
              </span>
            </button>
          ))}
        </div>
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
      <h1>Inbox</h1>
      <p className="quiet inboxintro">Things you've captured. Give each one a home, now or when you plan.</p>
      {rows.length === 0 ? (
        <p className="quiet">Inbox is empty.</p>
      ) : (
        <button className="btn pri pxstart" type="button" onClick={() => process()}>
          {startLabel}
        </button>
      )}
      <div className="card inboxlist">
        {rows.map((i) => (
          <div key={i.id} className="inboxrow">
            <div>
              <div>{i.title}</div>
              {est(i.estimate_min) && <div className="small quiet">{est(i.estimate_min)}</div>}
            </div>
            <button className="btn sm" type="button" aria-label={`Assign ${i.title}`} onClick={() => process(i.id)}>
              Assign
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
