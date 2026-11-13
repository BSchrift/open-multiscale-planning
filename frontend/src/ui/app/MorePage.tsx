// The phone's More tab: full-width rows, each with a live line. Each area supplies its line in its moreLine.ts.

import type { Clock } from '../../core/clock';
import type { Sql } from '../../core/db';
import { moreLine as analyticsLine } from '../screens/analytics/moreLine';
import { moreLine as doneLine } from '../screens/done/moreLine';
import { moreLine as oneoffsLine } from '../screens/oneoffs/moreLine';
import { moreLine as planLine } from '../screens/plan/moreLine';
import { moreLine as settingsLine } from '../screens/settings/moreLine';
import { useNav } from './nav';
import { AREAS, MORE_ROWS } from './registry';
import type { AreaId } from './registry';
import { useQuery } from './store';

const LINES: Partial<Record<AreaId, (sql: Sql, clock: Clock) => Promise<string | null>>> = {
  plan: planLine,
  oneoffs: oneoffsLine,
  analytics: analyticsLine,
  done: doneLine,
  settings: settingsLine,
};

function MoreRow(props: { area: AreaId }) {
  const nav = useNav();
  const { data: line } = useQuery((sql, clock) => LINES[props.area]?.(sql, clock) ?? Promise.resolve(null), [props.area]);
  return (
    <button className="projbtn morerow" type="button" onClick={() => nav.go(props.area)}>
      <span className={props.area === 'oneoffs' ? 'mhead' : undefined}>
        <span style={{ display: 'block' }}>{AREAS[props.area].label}</span>
        {line && (
          <span className="small quiet" style={{ display: 'block' }}>
            {line}
          </span>
        )}
      </span>
      <span className="chev" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

export function MorePage() {
  return (
    <>
      <h1>More</h1>
      <div className="card morelist">
        {MORE_ROWS.map((area) => (
          <MoreRow key={area} area={area} />
        ))}
      </div>
    </>
  );
}
