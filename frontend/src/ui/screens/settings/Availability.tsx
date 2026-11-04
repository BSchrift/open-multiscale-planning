// The unavailable list: times closed to projects, one offs or both. Settings and first-run setup both edit it here.

import { formatTimeOfDay } from '../../../core/dates';
import { getSettings, updateSettings } from '../../../core/records';
import type { Writer } from '../../../core/records';
import type { AvailabilityBlock, TimeOfDay } from '../../../core/types';
import type { Layout } from '../../app/registry';
import { useMutation, useQuery } from '../../app/store';
import './settings.css';

const NEW_BLOCK: AvailabilityBlock = { days: 'all', from: 12 * 60, to: 13 * 60, projects: true, one_offs: true };

/** Reads the list inside the transaction, so quick changes in a row never write over each other. */
async function editList(w: Writer, edit: (list: AvailabilityBlock[]) => AvailabilityBlock[]) {
  const { availability } = await getSettings(w.sql);
  await updateSettings(w, { availability: edit(availability) });
}

const blockName = (b: AvailabilityBlock) => `${formatTimeOfDay(b.from)} to ${formatTimeOfDay(b.to)}`;

const LAST = 1410;
const TICKS = [0, 360, 720, 1080];
// Where a time sits on the track: the handles' centres run from half a handle in to half a handle short of the end.
const at = (minutes: TimeOfDay) => `calc(var(--thumb) / 2 + (100% - var(--thumb)) * ${minutes / LAST})`;
const span = (from: TimeOfDay, to: TimeOfDay) => `calc((100% - var(--thumb)) * ${(to - from) / LAST})`;

/** One track with a handle at each end of the block. A block that passes midnight is shaded at both ends of the day. */
function HoursSlider(props: { block: AvailabilityBlock; onChange(patch: Partial<AvailabilityBlock>): void }) {
  const { from, to } = props.block;
  const windows: [TimeOfDay, TimeOfDay][] = from <= to ? [[from, to]] : [[from, LAST], [0, to]];
  const handle = (end: 'from' | 'to', label: string) => (
    <input
      type="range"
      aria-label={label}
      min={0}
      max={LAST}
      step={30}
      value={props.block[end]}
      aria-valuetext={formatTimeOfDay(props.block[end])}
      onChange={(event) => props.onChange({ [end]: Number(event.target.value) })}
    />
  );
  return (
    <div className="hourslider" role="group" aria-label="Hours">
      <div className="hourtrack">
        {windows.map(([a, b]) => (
          <span key={a} className="timewindow" style={{ left: at(a), width: span(a, b) }} />
        ))}
        {handle('from', 'From')}
        {handle('to', 'To')}
      </div>
      <div className="hourticks" aria-hidden="true">
        {TICKS.map((m) => (
          <span key={m} style={{ left: at(m) }}>
            {formatTimeOfDay(m)}
          </span>
        ))}
      </div>
    </div>
  );
}

function BlockRow(props: { block: AvailabilityBlock; layout: Layout; onChange(patch: Partial<AvailabilityBlock>): void; onRemove(): void }) {
  const { block: b, layout, onChange } = props;
  const name = blockName(b);
  const days = (
    <select className="field" aria-label="Days" value={b.days} onChange={(event) => onChange({ days: event.target.value as AvailabilityBlock['days'] })}>
      <option value="all">Every day</option>
      <option value="weekdays">Weekdays</option>
      <option value="weekends">Weekends</option>
    </select>
  );
  const remove = (
    <button className={layout === 'phone' ? 'btn' : 'btn sm'} type="button" aria-label={`Remove ${name}`} onClick={props.onRemove}>
      Remove
    </button>
  );
  const kinds = (
    <>
      <label className="taskrow">
        <input type="checkbox" checked={b.projects} onChange={() => onChange({ projects: !b.projects })} />
        <span>Projects</span>
      </label>
      <label className="taskrow mhead">
        <input type="checkbox" checked={b.one_offs} onChange={() => onChange({ one_offs: !b.one_offs })} />
        <span>One offs</span>
      </label>
    </>
  );
  const sliders = <HoursSlider block={b} onChange={onChange} />;
  if (layout === 'phone') {
    return (
      <div className="rowline stack8 unavrow" role="group" aria-label={`Unavailable, ${name}`}>
        <div className="between">
          <span className="strong">{name}</span>
          {remove}
        </div>
        {days}
        {sliders}
        {kinds}
      </div>
    );
  }
  return (
    <div className="setrow unavrow" role="group" aria-label={`Unavailable, ${name}`}>
      <div className="row small">
        <span className="strong">{name}</span>
        {days}
      </div>
      {sliders}
      <div className="row">
        {kinds}
        {remove}
      </div>
    </div>
  );
}

export function UnavailableList(props: { layout: Layout }) {
  const { data: settings } = useQuery((sql) => getSettings(sql), []);
  const edit = useMutation((w, change: (list: AvailabilityBlock[]) => AvailabilityBlock[]) => editList(w, change));
  if (!settings) return null;
  return (
    <>
      {settings.availability.map((block, i) => (
        <BlockRow
          // Blocks have no ids; a row's place in the list is what identifies it.
          key={i}
          block={block}
          layout={props.layout}
          onChange={(patch) => void edit.run((list) => list.map((x, j) => (j === i ? { ...x, ...patch } : x)))}
          onRemove={() => void edit.run((list) => list.filter((_, j) => j !== i))}
        />
      ))}
      <div className={props.layout === 'phone' ? undefined : 'setrow'}>
        <button className={props.layout === 'phone' ? 'btn' : 'btn sm'} type="button" onClick={() => void edit.run((list) => [...list, NEW_BLOCK])}>
          Add unavailable time
        </button>
      </div>
    </>
  );
}
