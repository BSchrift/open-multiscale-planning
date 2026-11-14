// +N more, beside or under blocks at the same time that have no room to be drawn, and the list it opens. It's apart
// from the columns' layout, so the screens' data modules, which import the grid's helpers, don't load a sheet.

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { formatTimeOfDay } from '../../../core/dates';
import { KIND_WORD } from '../blocks/describe';
import type { BlockKind } from '../blocks/describe';
import { Sheet } from '../Sheet';
import { overlapNote } from './columns';
import type { OverlapGroup } from './columns';

interface Listed {
  id: string;
  title: string;
  start: number;
  end: number;
  kind: BlockKind;
}

const names = new Intl.ListFormat('en-GB');
const range = (s: { start: number; end: number }) => `${formatTimeOfDay(s.start)} to ${formatTimeOfDay(s.end)}`;

/**
 * +N more, for the blocks of a group with no room to be drawn. It opens a list of every block in the group, each
 * opening as a tap on the block does; one that doesn't open, gone by or read only, is listed as text.
 */
export function MoreButton<T extends Listed>(props: {
  group: OverlapGroup<T>;
  shown: number;
  className: string;
  style?: CSSProperties;
  canOpen?(item: T): boolean;
  onOpen(item: T): void;
}) {
  const { group } = props;
  const [open, setOpen] = useState(false);
  const hidden = group.items.filter((c) => c.col >= props.shown).map((c) => c.item);
  const label = `Blocks from ${range(group)}`;
  return (
    <>
      <button
        type="button"
        className={props.className}
        style={props.style}
        aria-label={`+${hidden.length} more: ${names.format(hidden.map((x) => x.title))}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        +{hidden.length} more
      </button>
      {open && (
        <Sheet label={label} onClose={() => setOpen(false)}>
          <h2>{label}</h2>
          <div>
            {group.items.map(({ item, with: others }) => {
              const body = (
                <>
                  <span>{item.title}</span>
                  <span className="small quiet">
                    {KIND_WORD[item.kind]}, {range(item)}
                  </span>
                </>
              );
              return (
                <div key={item.id} className="rowline">
                  {props.canOpen && !props.canOpen(item) ? (
                    <div className="candbtn">{body}</div>
                  ) : (
                    <button
                      type="button"
                      className="candbtn"
                      aria-label={`${item.title}, ${range(item)}, ${KIND_WORD[item.kind]}.${overlapNote(others)}`}
                      onClick={() => {
                        setOpen(false);
                        props.onOpen(item);
                      }}
                    >
                      {body}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <button className="btn" type="button" onClick={() => setOpen(false)}>
            Close
          </button>
        </Sheet>
      )}
    </>
  );
}
