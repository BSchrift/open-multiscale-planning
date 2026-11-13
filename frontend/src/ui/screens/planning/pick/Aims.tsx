// Change aims for this week: a slider for each project and One offs, and a way to skip one this week, which Save
// writes as one change with Undo and Cancel drops. The usual aim stays on the project.

import { useState } from 'react';
import type { Minutes } from '../../../../core/types';
import { useLeave } from '../../../components/editors';
import { EstimateSlider } from '../../../components/EstimateSlider';
import { Popover } from '../../../components/Popover';
import type { PickProps } from './PickStep';

export function AimsPopover(props: PickProps & { phone: boolean; onClose(): void }) {
  const { aims } = props;
  const [draft, setDraft] = useState<Record<string, Minutes>>(() => Object.fromEntries(aims.map((a) => [a.bucket, a.value])));
  const [skipped, setSkipped] = useState<readonly string[]>(() => aims.filter((a) => a.skipped).map((a) => a.bucket));
  const [said, setSaid] = useState('');
  const changed = aims.some((a) => draft[a.bucket] !== a.value || skipped.includes(a.bucket) !== a.skipped);
  const { saveRef, leave } = useLeave(changed, props.onClose, setSaid);
  const usual = aims.every((a) => draft[a.bucket] === a.usual);
  const btn = props.phone ? 'btn grow' : 'btn sm';
  const save = () => {
    // Only what differs from the usual aim is kept for this week.
    if (changed) props.saveAims(Object.fromEntries(aims.filter((a) => draft[a.bucket] !== a.usual).map((a) => [a.bucket, draft[a.bucket]!])), [...skipped]);
    props.onClose();
  };
  return (
    <Popover label="Aims for this week" onClose={leave}>
      <h2>Aims for this week</h2>
      <div className="stack8 aimlist">
        {aims.map((a) => {
          const off = skipped.includes(a.bucket);
          const skipLabel = off ? "Count this week's aim" : "Skip this week's aim";
          return (
            <div key={a.bucket} className="stack8">
              <EstimateSlider
                label={`Aim for ${a.name} this week`}
                value={draft[a.bucket]}
                noneLabel="No aim"
                onChange={(m) => {
                  setDraft((d) => ({ ...d, [a.bucket]: m }));
                  setSaid('');
                }}
              />
              {a.canSkip && (
                <div>
                  <button
                    className="link small"
                    type="button"
                    aria-label={`${skipLabel}, ${a.name}`}
                    onClick={() => setSkipped((now) => (off ? now.filter((b) => b !== a.bucket) : [...now, a.bucket]))}
                  >
                    {skipLabel}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!usual && (
        <div>
          <button className="link small" type="button" onClick={() => setDraft(Object.fromEntries(aims.map((a) => [a.bucket, a.usual])))}>
            Back to my usual aims
          </button>
        </div>
      )}
      {said && (
        <div className="fielderr" role="alert">
          {said}
        </div>
      )}
      <div className="row">
        <button ref={saveRef} className={`${btn} pri`} type="button" onClick={save}>
          Save
        </button>
        <button className={btn} type="button" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </Popover>
  );
}
