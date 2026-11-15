// Goal backlogs in Pick tasks: one band after the projects, a group per goal, every group closed at first, at both
// sizes. Rows work as a project's do: the time to add, Mark done, and Add or Remove. Nothing here is suggested, since
// nothing in a backlog is due.

import { Rows } from './Cards';
import type { ListProps } from './Cards';

export function BacklogsSection(props: ListProps) {
  const { view, out } = props;
  if (!view.backlogs.length) return null;
  return (
    <section className="pproj bl" aria-label="Backlogs">
      <h3 className="pph">
        <span className="pn">Backlogs</span>
        <span className="ppr small">For a goal, not part of a project</span>
      </h3>
      {view.backlogs.map((b) => {
        const open = out.backlogOpen(b.goalId);
        return (
          <div key={b.goalId} className="pgroup">
            <button className="blfold" type="button" aria-expanded={open} onClick={() => out.toggleBacklog(b.goalId)}>
              <span className="caret" aria-hidden="true">
                {open ? '▾' : '▸'}
              </span>
              <span className="strong">{b.goal}</span>
              <span className="small quiet">{b.counts}</span>
            </button>
            {open && <Rows {...props} rows={b.rows} />}
          </div>
        );
      })}
    </section>
  );
}
