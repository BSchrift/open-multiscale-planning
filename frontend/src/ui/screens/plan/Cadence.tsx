// How often to plan. On the Plan page it's a draft until saved, since with a plan in place it also asks when the
// change starts. In the flow's first step each change is saved at once.

import { useId, useState } from 'react';
import { addDays, formatDate } from '../../../core/dates';
import { cadenceLabel, changeCadence, stretchFrom } from '../../../core/plan';
import type { Stretch } from '../../../core/plan';
import type { CadenceUnit, Fields, LocalDate, PlanCadence, Settings } from '../../../core/types';
import { updateSettings } from '../../../core/records';
import { useMutation } from '../../app/store';
import { useToast } from '../../components/Toast';
import { isDay } from './model';

const maxEvery = (unit: CadenceUnit) => (unit === 'weeks' ? 26 : 12);

export interface CadenceDraft {
  every: number;
  unit: CadenceUnit;
  anchor: LocalDate;
}

/** Calendar quarters, or every so many weeks or months, from a date when asked. */
export function CadenceFields(props: { value: CadenceDraft; showAnchor: boolean; onChange(next: CadenceDraft): void }) {
  const { value, onChange } = props;
  const ids = { mode: useId(), every: useId(), unit: useId(), anchor: useId() };
  const word = cadenceLabel(value);
  return (
    <div className="stack8 cadfields">
      <div className="cadfield">
        <label className="small quiet" htmlFor={ids.mode}>
          How often
        </label>
        <select
          id={ids.mode}
          className="field"
          value={value.unit === 'quarters' ? 'quarters' : 'every'}
          onChange={(event) => onChange({ ...value, unit: event.target.value === 'quarters' ? 'quarters' : 'months' })}
        >
          <option value="quarters">Calendar quarters</option>
          <option value="every">Every few weeks or months</option>
        </select>
      </div>
      {value.unit !== 'quarters' && (
        <>
          <div className="cadfield">
            <div className="between">
              <label className="small quiet" htmlFor={ids.every}>
                Every
              </label>
              <span className="strong small">{word}</span>
            </div>
            <input
              id={ids.every}
              className="wideslider"
              type="range"
              min={1}
              max={maxEvery(value.unit)}
              value={value.every}
              aria-valuetext={word}
              onChange={(event) => onChange({ ...value, every: Math.max(1, Number(event.target.value) || 1) })}
            />
          </div>
          <div className="cadfield">
            <label className="small quiet" htmlFor={ids.unit}>
              In
            </label>
            <select
              id={ids.unit}
              className="field"
              value={value.unit}
              onChange={(event) => {
                const unit = event.target.value as CadenceUnit;
                onChange({ ...value, unit, every: Math.min(value.every, maxEvery(unit)) });
              }}
            >
              <option value="weeks">Weeks</option>
              <option value="months">Months</option>
            </select>
          </div>
        </>
      )}
      {props.showAnchor && (
        <div className="cadfield">
          <label className="small quiet" htmlFor={ids.anchor}>
            Starting
          </label>
          <input
            id={ids.anchor}
            className="field datefield"
            type="date"
            value={value.anchor}
            onChange={(event) => isDay(event.target.value) && onChange({ ...value, anchor: event.target.value })}
          />
        </div>
      )}
    </div>
  );
}

/** What a stored cadence looks like as a draft, with today's tomorrow as the start when it has none. */
export function draftOf(cadence: PlanCadence | null, on: LocalDate): CadenceDraft {
  return { every: cadence?.every ?? 1, unit: cadence?.unit ?? 'quarters', anchor: cadence?.anchor ?? addDays(on, 1) };
}

/** The Plan page's in-place editor. Saving with "end this plan now" goes straight into planning. */
export function CadenceEditor(props: { settings: Settings; cur: Stretch | null; on: LocalDate; onClose(): void; onRestart(): void }) {
  const { settings, cur, on } = props;
  const toast = useToast();
  const name = useId();
  const [scheduled, setScheduled] = useState(!!settings.plan_cadence);
  const [draft, setDraft] = useState(() => draftOf(settings.plan_cadence, on));
  const [when, setWhen] = useState<'end' | 'now'>('end');
  const save = useMutation((w, fields: Fields<'settings'>) => updateSettings(w, fields));
  const now = !!cur && when === 'now';
  const from = !cur ? draft.anchor : now ? addDays(on, 1) : addDays(cur.end, 1);
  const first = stretchFrom(from, draft);

  const submit = async () => {
    const cadence = scheduled ? { every: draft.every, unit: draft.unit, anchor: draft.anchor } : null;
    if ((await save.run(changeCadence(settings, cadence, now ? 'now' : 'end', on))) === undefined) return;
    props.onClose();
    if (!scheduled || !cur) return;
    if (now) props.onRestart();
    else toast.show(`Your new cadence starts ${formatDate(from)}.`);
  };

  return (
    <div className="stack8" role="group" aria-label="Change planning cadence">
      <label className="taskrow small">
        <input type="checkbox" checked={scheduled} onChange={() => setScheduled(!scheduled)} />
        <span>Remind me to plan on a schedule</span>
      </label>
      {!scheduled && <p className="small quiet">No stretches or reminders. You can still plan whenever you like.</p>}
      {scheduled && (
        <>
          <CadenceFields value={draft} showAnchor={!cur} onChange={setDraft} />
          {cur && (
            <fieldset className="stack8 plainset">
              <legend className="small">When should it start?</legend>
              <label className="taskrow small">
                <input type="radio" name={name} checked={!now} onChange={() => setWhen('end')} />
                <span>When this plan ends, {formatDate(cur.end)}</span>
              </label>
              <label className="taskrow small">
                <input type="radio" name={name} checked={now} onChange={() => setWhen('now')} />
                <span>End this plan now and start again</span>
              </label>
            </fieldset>
          )}
          <p className="small">
            {now ? 'New stretch' : 'Next stretch'}: {formatDate(first.start)} to {formatDate(first.end)}
          </p>
        </>
      )}
      <div className="row">
        <button className="btn pri" type="button" onClick={submit}>
          {scheduled && now ? 'End this plan and start again' : 'Save'}
        </button>
        <button className="btn" type="button" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
