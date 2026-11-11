// The Plan page: the cadence and this stretch with the way into planning, then the plan for this stretch, and for the
// next one once it's been planned. Projects keep their own dates, and nothing here is ranked.

import { useState } from 'react';
import { addDays } from '../../../core/dates';
import { cadenceLabel } from '../../../core/plan';
import type { Stretch } from '../../../core/plan';
import { updateSettings } from '../../../core/records';
import type { Fields } from '../../../core/types';
import { useNav } from '../../app/nav';
import type { Layout, RouteParams } from '../../app/registry';
import { useApp, useMutation, useToday } from '../../app/store';
import { diamondClass } from '../../components/MilestoneDiamond';
import { CadenceEditor } from './Cadence';
import type { PlanData } from './data';
import { beginFlow, usePlanFlow } from './flowState';
import { planContext, planGroups, range, whereNow } from './model';
import type { PlanGroup } from './model';
import { usePlanningActions } from '../../components/planning/usePlanning';
import { useStretchPlanning } from '../../components/planning/useStretchPlanning';

export function Diamond(props: { cls: string; phone: boolean }) {
  return props.phone ? (
    <span className={`msdia ${props.cls}`.trim()} aria-hidden="true" />
  ) : (
    <span className="pkey" aria-hidden="true">
      <span className={`pdot ${props.cls}`.trim()} />
    </span>
  );
}

function GroupList(props: { groups: PlanGroup[]; phone: boolean }) {
  return (
    <>
      {props.groups.map((g) => (
        <div key={g.key} className="planshow">
          <h3 className={g.oneOffs ? 'mhead' : undefined}>{g.title}</h3>
          {g.items.map((it) => (
            <div key={it.key} className="planshowrow small">
              <Diamond cls={g.oneOffs ? 'oo' : diamondClass(it.state)} phone={props.phone} />
              <span className="grow">{it.name}</span>
              <span className={it.late ? 'latetext' : 'quiet'}>{it.when}</span>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function StretchPlan(props: { data: PlanData; st: Stretch; title: string; phone: boolean }) {
  const { clock } = useApp();
  const groups = planGroups(props.data, props.st, planContext(props.data, clock, false));
  const items = groups.filter((g) => !g.oneOffs).flatMap((g) => g.items);
  const met = items.filter((it) => it.reached).length;
  const open = items.length - met;
  const label = `${props.title}, ${range(props.st)}`;
  return (
    <section className="card stack8" aria-label={label}>
      <div>
        <h2>{label}</h2>
        {items.length > 0 && (
          <p className="small quiet">
            {met} of {items.length} planned milestones met{open ? `, ${open} still open` : ''}.
          </p>
        )}
      </div>
      {groups.length ? <GroupList groups={groups} phone={props.phone} /> : <p className="small quiet">No milestones in this plan.</p>}
    </section>
  );
}

export function PlanPage(props: { data: PlanData; layout: Layout; params: RouteParams }) {
  const { data } = props;
  const phone = props.layout === 'phone';
  const nav = useNav();
  const on = useToday();
  const flow = usePlanFlow();
  const where = whereNow(data.settings, on, flow);
  const [editing, setEditing] = useState(props.params.cadence === 'edit');
  const save = useMutation((w, fields: Fields<'settings'>) => updateSettings(w, fields));
  const planning = useStretchPlanning();
  const act = usePlanningActions();

  // Planning resumes where it was, or begins at its first step. A plan that's due gets a planning block from now, as
  // every Start does.
  const open = () => {
    if (!flow.begun) beginFlow();
    if (planning.due) void act.start(planning.due);
    else nav.openFlow('plan');
  };
  const startCadence = async () => {
    if ((await save.run({ plan_cadence: { every: 1, unit: 'quarters', anchor: addDays(on, 1) } })) === undefined) return;
    beginFlow({ restart: false });
    nav.openFlow('plan');
  };
  return (
    <div className={`${phone ? 'stack' : 'wrap stack'} planpage`}>
      <div>
        <h1>Plan</h1>
        <p className={phone ? 'small quiet' : 'quiet'}>{`Plan ${where.firstPlan ? 'your first' : 'the next'} stretch. Projects keep their own dates.`}</p>
      </div>
      {!data.settings.plan_cadence && !editing ? (
        <section className="card stack8" aria-label="Planning cadence">
          <h2>Set your planning cadence</h2>
          <div className={phone ? 'stack8' : 'row'}>
            <button className="btn pri" type="button" onClick={startCadence}>
              Start planning
            </button>
            <button className="btn" type="button" onClick={() => open()}>
              {flow.begun ? 'Continue planning' : 'Plan without a cadence'}
            </button>
          </div>
        </section>
      ) : (
        <section className={`card stack8${where.due ? ' due' : ''}`} aria-label="Planning cadence">
          <h2>{cadenceLabel(data.settings.plan_cadence)}</h2>
          {data.settings.plan_cadence && <p className={phone ? 'small' : undefined}>{where.lineText}</p>}
          {planning.at && <p className="small quiet">{planning.at}</p>}
          {editing ? (
            <CadenceEditor
              settings={data.settings}
              cur={where.cur}
              on={on}
              onClose={() => setEditing(false)}
              onRestart={() => {
                beginFlow({ restart: true, changes: [] });
                nav.openFlow('plan');
              }}
            />
          ) : (
            <div className={phone ? 'stack8' : 'row'}>
              <button className={`btn${where.due || flow.begun ? ' pri' : ''}`} type="button" onClick={() => open()}>
                {where.lineCta}
              </button>
              <button className="btn" type="button" onClick={() => setEditing(true)}>
                Change planning cadence
              </button>
            </div>
          )}
        </section>
      )}
      {where.cur && <StretchPlan data={data} st={where.cur} title="Current plan" phone={phone} />}
      {where.planned && where.next.start !== where.cur?.start && <StretchPlan data={data} st={where.next} title="Next plan" phone={phone} />}
    </div>
  );
}
