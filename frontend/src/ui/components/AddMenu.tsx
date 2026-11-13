// Add, from a planning flow: what can be made from where you are, hanging from its button on desktop and a sheet on
// phone, with Cancel there. Stretch planning and weekly planning's Pick tasks each list their own kinds.

import { Popover } from './Popover';
import './addmenu.css';

export interface AddItem {
  label: string;
  onPick(): void;
}

export function AddMenu(props: { items: readonly AddItem[]; phone: boolean; onClose(): void }) {
  return (
    <Popover label="Add" onClose={props.onClose}>
      {props.phone && <h2>Add</h2>}
      <div className="stack8 addmenu">
        {props.items.map((item) => (
          <button key={item.label} className={props.phone ? 'btn' : 'btn sm'} type="button" onClick={item.onPick}>
            {item.label}
          </button>
        ))}
      </div>
      {props.phone && (
        <button className="btn" type="button" onClick={props.onClose}>
          Cancel
        </button>
      )}
    </Popover>
  );
}
