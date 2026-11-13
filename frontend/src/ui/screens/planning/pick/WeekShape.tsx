// This week, beside the cards on desktop and as a tab on phone: how the open time splits between projects, One offs
// and practices, amber past it, and each project against its aim. On desktop it holds Add suggested, Change aims and
// Continue; on phone, the week's tasks follow it, each with its time and a way out of the week.

import { useRef, useState } from 'react';
import type { AimRow } from '../../../../core/capacity';
import { formatMinutes } from '../../../../core/dates';
import type { Minutes } from '../../../../core/types';
import { AimsPopover } from './Aims';
import { aimWords, weekText } from './model';
import type { PickTask } from './model';
import type { PickProps } from './PickStep';
import { SuggestPreview } from './Suggest';
import { TimePopover } from './TimePopover';

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

export function AimMeter(props: { aim: AimRow }) {
  const w = aimWords(props.aim);
  return (
    <>
      <span className="mmeter" role="img" aria-label={w.alt}>
        {/* Short of its aim, or past it, is calm blue, never amber, which means over the week's open time. Green is met. */}
        <span className={`mfill ${props.aim.got > props.aim.aim && !props.aim.skipped ? 'calm' : w.cls || 'calm'}`} style={{ width: `${props.aim.pct}%` }} />
        <span className="mtick" style={{ left: `${props.aim.tickPct}%` }} />
      </span>
      <span>{w.value}</span>
    </>
  );
}

export function WeekShape(props: PickProps & { phone: boolean; preview: { project: Minutes; oneOff: Minutes } }) {
  const { view, model, phone } = props;
  const [open, setOpen] = useState<'suggest' | 'aims' | null>(null);
  const suggestRef = useRef<HTMLButtonElement>(null);
  const aimsRef = useRef<HTMLButtonElement>(null);
  const { used, free } = model.use;
  const over = free < 0;
  const proj = view.projects.reduce((sum, p) => sum + p.planned, 0);
  const oo = view.oneOffs.planned;
  const pr = model.repeating;
  const { preview } = props;
  const scale = Math.max(proj + oo + pr + preview.project + preview.oneOff, model.open, 1);
  const close = (back: HTMLButtonElement | null) => () => {
    setOpen(null);
    back?.focus();
  };
  const segs = [
    { cls: 'seg-project', label: 'Projects', min: proj },
    { cls: 'seg-maint', label: 'One offs', min: oo },
    { cls: 'seg-practice', label: 'Practices and repeating work', min: pr },
  ];
  return (
    <section className="card wkshape" aria-label="This week">
      <div className="between">
        <h3 className="ct">This week</h3>
        <span className={over ? 'small strong overtext' : 'small quiet'}>
          {formatMinutes(used)} of {formatMinutes(model.open)}, {over ? `${formatMinutes(-free)} over` : `${formatMinutes(free)} free`}
        </span>
      </div>
      <div className={`shapebar${over ? ' over' : ''}`}>
        <div className="capbar" role="img" aria-label={`${segs.map((g) => `${g.label} ${formatMinutes(g.min)}`).join(', ')}, of ${formatMinutes(model.open)} open`}>
          {/* What a selection would add shows pale after its kind, before it's added. */}
          <span className="seg-project" style={{ width: pct(proj / scale) }} />
          {preview.project > 0 && <span className="seg-project pale" style={{ width: pct(preview.project / scale) }} />}
          <span className="seg-maint" style={{ width: pct(oo / scale) }} />
          {preview.oneOff > 0 && <span className="seg-maint pale" style={{ width: pct(preview.oneOff / scale) }} />}
          <span className="seg-practice" style={{ width: pct(pr / scale) }} />
        </div>
        <span className="mtick" style={{ left: pct(model.open / scale) }} />
      </div>
      <div className="legend">
        {segs.map((g) => (
          <span key={g.cls}>
            <i className={`swatch ${g.cls}`} />
            {g.label} {formatMinutes(g.min)}
          </span>
        ))}
      </div>
      <div className="wsrows">
        {view.projects.map((p) => (
          <div key={p.plan.project.id} className="wsr">
            <span className="wn">{p.plan.project.title}</span>
            {p.aim ? <AimMeter aim={p.aim} /> : <><span /><span className="wv">{formatMinutes(p.planned)}, no aim</span></>}
          </div>
        ))}
        <div className="wsr oo">
          <span className="wn">One offs</span>
          {view.oneOffs.aim ? <AimMeter aim={view.oneOffs.aim} /> : <><span /><span className="wv">{formatMinutes(oo)}, no aim</span></>}
        </div>
      </div>
      {!phone && (
        <>
          {view.hintMin > 0 && (
            <div className="editrow">
              <button ref={suggestRef} className="btn sm" type="button" aria-haspopup="dialog" aria-expanded={open === 'suggest'} onClick={() => setOpen(open === 'suggest' ? null : 'suggest')}>
                Add suggested {formatMinutes(view.hintMin)}
              </button>
              {open === 'suggest' && <SuggestPreview {...props} onClose={close(suggestRef.current)} />}
            </div>
          )}
          {(view.projects.length > 0 || !!view.oneOffs.aim) && (
            <div className="editrow">
              <button ref={aimsRef} className="link small" type="button" aria-haspopup="dialog" aria-expanded={open === 'aims'} onClick={() => setOpen(open === 'aims' ? null : 'aims')}>
                Change aims for this week
              </button>
              {open === 'aims' && <AimsPopover {...props} onClose={close(aimsRef.current)} />}
            </div>
          )}
          <button className="btn pri" type="button" onClick={props.onNext}>
            Continue to scheduling
          </button>
        </>
      )}
    </section>
  );
}

/** The week's tasks on phone, each with its time, which opens the time popover, and a way out of the week. */
export function WeekList(props: PickProps) {
  const { view } = props;
  const [timeFor, setTimeFor] = useState<PickTask | null>(null);
  const groups = [
    ...view.projects.map((p) => ({ key: p.plan.project.id, name: p.plan.project.title, rows: p.groups.flatMap((g) => g.rows) })),
    { key: 'oneoffs', name: 'One offs', rows: view.oneOffs.rows },
  ]
    .map((g) => ({ ...g, rows: g.rows.filter((r) => r.c.picked && !props.isDone(r)) }))
    .filter((g) => g.rows.length);
  if (!groups.length) return <p className="small quiet">Nothing yet. Add tasks from your projects or One offs.</p>;
  return (
    <section className="card wklist" aria-label="In this week">
      {groups.map((g) => (
        <div key={g.key}>
          <h3 className="pig">{g.name}</h3>
          <ul className="picklist">
            {g.rows.map((r) => (
              <li key={r.c.task.id} className={`pi${r.oneOff ? ' oo' : ''}`}>
                <span className="pit">{r.title}</span>
                <button className="pim" type="button" aria-haspopup="dialog" aria-label={`Change time: ${r.title}, ${weekText(r.c)}`} onClick={() => setTimeFor(r)}>
                  {weekText(r.c)}
                </button>
                <button className="pix" type="button" aria-label={`Remove ${r.title} from this week`} onClick={() => props.dropFromWeek(r, true)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {timeFor && (
        <TimePopover
          row={timeFor}
          phone
          onSave={(week, estimate) => props.saveTime(timeFor, week, estimate)}
          onDone={() => {
            setTimeFor(null);
            props.markDone(timeFor, true);
          }}
          onRemove={() => {
            setTimeFor(null);
            props.dropFromWeek(timeFor, true);
          }}
          onClose={() => setTimeFor(null)}
        />
      )}
    </section>
  );
}
