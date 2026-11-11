// Adds a project under a goal. It needs a name and an end date on or after its start. Planning gives it the end of the
// stretch it plans, and saves it its own way, so the project lands on its Undo line rather than in a toast.

import { useState } from 'react';
import type { FormEvent } from 'react';
import { addMonths, formatDate, isDay, today } from '../../../core/dates';
import { currentStretch } from '../../../core/plan';
import { getSettings } from '../../../core/records';
import type { Fields, LocalDate } from '../../../core/types';
import { useApp, useMutation, useQuery } from '../../app/store';
import { useToast } from '../Toast';
import { SheetOnPhone } from './SheetOnPhone';


export function ProjectAdd(props: {
  objectiveId: string | null;
  goalTitle?: string;
  /** The end it starts with, in place of the stretch's. */
  end?: LocalDate;
  /** Saves the project instead of the form, resolving to its id. The caller then reports it. */
  write?(fields: Fields<'project'>): Promise<string | undefined>;
  onClose(): void;
  onAdded?(id: string): void;
}) {
  const { clock } = useApp();
  const toast = useToast();
  const on = today(clock);
  const [title, setTitle] = useState('');
  const [start, setStart] = useState(on);
  const settings = useQuery((sql) => getSettings(sql), []).data;
  // The end of the stretch being planned, or 3 months without a cadence, until the person picks one.
  const [picked, setEnd] = useState<string | null>(null);
  const end = picked ?? props.end ?? (settings && currentStretch(settings, on)?.end) ?? addMonths(on, 3);
  const [error, setError] = useState('');
  const add = useMutation((w, fields: Fields<'project'>) => w.create('project', fields));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    if (!name) return setError('Give it a name.');
    if (!isDay(start) || !isDay(end) || end < start) return setError('Pick an end date on or after the start.');
    const fields: Fields<'project'> = { objective_id: props.objectiveId, title: name, state: 'active', start, end };
    const id = props.write ? await props.write(fields) : await add.run(fields);
    if (!id) return;
    if (!props.write) toast.show(`Project added, ${formatDate(start)} to ${formatDate(end)}.`);
    props.onAdded?.(id);
    props.onClose();
  };

  const change = (set: (v: string) => void) => (event: { target: { value: string } }) => {
    set(event.target.value);
    setError('');
  };

  return (
    <SheetOnPhone label="Add project" onClose={props.onClose}>
      <form className="stack8 editor" aria-label="Add project" onSubmit={save}>
        <div>
          {props.goalTitle && <div className="small quiet">{props.goalTitle}</div>}
          <h2>Add project</h2>
        </div>
        <label className="popfield">
          Name
          <input className="field" autoFocus value={title} onChange={change(setTitle)} />
        </label>
        <div className="row nowrap">
          <label className="popfield grow">
            Starts
            <input className="field datefield" type="date" value={start} onChange={change(setStart)} />
          </label>
          <label className="popfield grow">
            Ends
            <input className="field datefield" type="date" value={end} onChange={change(setEnd)} />
          </label>
        </div>
        {error && (
          <div className="fielderr" role="alert">
            {error}
          </div>
        )}
        <div className="row">
          <button className="btn sm pri grow" type="submit">
            Add project
          </button>
          <button className="btn sm" type="button" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </form>
    </SheetOnPhone>
  );
}
