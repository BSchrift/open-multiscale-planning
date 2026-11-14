// Pick tasks on phone: the same list as desktop under two tabs: Tasks, and This week, which holds the week's shape and
// its tasks. The week's dates sit on the heading's row and each project's adder goes to the bottom bar's +, which adds
// to the project under the sticky name, so four tasks fit on the first screen. A one-line strip over the bottom bar
// counts what still needs you, at any scroll. Does it fit, in the top bar, shows This week. ⋯ holds Change aims and
// Select; Select's bar takes the bottom bar's place, and the strip's.

import { useEffect, useId, useRef, useState } from 'react';
import { formatMinutes, formatWeekRange } from '../../../../core/dates';
import { Sheet } from '../../../components/Sheet';
import { useFit, useNextName } from '../WeekFit';
import { AimsPopover } from './Aims';
import { EmptyCard } from './Cards';
import { ProjectAdder, useAdding, usePickAddMenu } from './Adders';
import { needOf, NeedYou } from './NeedYou';
import { Lede, StretchLine, useOutside } from './Outside';
import { PickList, selectable } from './PickDesktop';
import type { PickProps } from './PickStep';
import { SelectBar, useSelection } from './Select';
import { SuggestPreview } from './Suggest';
import { WeekList, WeekShape } from './WeekShape';

export function PickPhone(props: PickProps) {
  const { view } = props;
  const [tab, setTab] = useState<'projects' | 'week'>('projects');
  const [sheet, setSheet] = useState<'menu' | 'aims' | 'suggest' | null>(null);
  const sel = useSelection();
  const adder = useAdding();
  const out = useOutside(view, props.week);
  const descId = useId();
  const namesId = useId();
  const need = needOf(view);
  useNextName({ label: need.words.next, ...(need.words.n ? { describedBy: namesId } : {}) });
  // The project in view: the first one still showing at the top of the list as it scrolls.
  const [inView, setInView] = useState<string | undefined>(undefined);
  const onScroll = () => {
    const top = root.current?.getBoundingClientRect().top ?? 0;
    const section = [...(root.current?.querySelectorAll<HTMLElement>('.pproj[data-project]') ?? [])].find((c) => c.getBoundingClientRect().bottom > top + 48);
    setInView(section?.dataset.project);
  };
  usePickAddMenu(props, adder, inView ?? view.projects.find((s) => out.visible(s))?.plan.project.id, () => {
    sel.exit();
    setTab('projects');
  });
  const root = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const empty = view.projects.length === 0 && view.pastEnd.length === 0;
  const n = view.planned.length;
  useFit(null, () => {
    setTab('week');
    root.current?.scrollTo?.({ top: 0 });
  });
  const rows = selectable(props, out);
  useEffect(() => {
    if (sel.on) root.current?.querySelector<HTMLElement>('.selbox')?.focus();
  }, [sel.on]);
  const closeSheet = () => setSheet(null);
  const list = { ...props, phone: true, select: sel, adder, out };
  const projectAdder = <ProjectAdder {...props} adder={adder} onAdded={(id) => adder.setAdding({ kind: 'task', project: id })} />;

  return (
    <>
      <div ref={root} className="scroll pkscroll" onScroll={onScroll}>
        <div className="pkhead">
          <div className="pkt">
            <span className="small strong">{formatWeekRange(props.week)}</span>
            <h2>Pick tasks</h2>
          </div>
          {view.hintMin > 0 && (
            <button className="btn" type="button" aria-haspopup="dialog" onClick={() => setSheet('suggest')}>
              Add suggested {formatMinutes(view.hintMin)}
            </button>
          )}
          <button ref={moreRef} className="pkmore" type="button" aria-haspopup="dialog" aria-label="More: change aims, select" onClick={() => setSheet('menu')}>
            ⋯
          </button>
        </div>
        <div className="seg" role="group" aria-label="Show">
          <button type="button" aria-pressed={tab === 'projects'} onClick={() => setTab('projects')}>
            Tasks
          </button>
          <button type="button" aria-pressed={tab === 'week'} aria-label={`This week, ${n} ${n === 1 ? 'task' : 'tasks'}`} onClick={() => setTab('week')}>
            This week · {n}
          </button>
        </div>
        {tab === 'week' ? (
          <>
            <WeekShape {...props} phone preview={{ project: 0, oneOff: 0 }} />
            <WeekList {...props} />
          </>
        ) : (
          <>
            <Lede view={view} out={out} phone descId={descId} />
            <StretchLine view={view} />
            {empty && <EmptyCard>{projectAdder}</EmptyCard>}
            <PickList {...list} descId={descId} />
            {!empty && !sel.on && <div className="addline">{projectAdder}</div>}
          </>
        )}
        <div className="sr" role="status">
          {props.said}
        </div>
      </div>
      {!sel.on && <NeedYou {...props} phone />}
      <span id={namesId} className="sr">
        {need.names}
      </span>

      {sel.on && (
        <SelectBar
          {...props}
          rows={rows}
          sel={sel}
          phone
          onCancel={() => {
            sel.exit();
            moreRef.current?.focus();
          }}
        />
      )}

      {sheet === 'suggest' && <SuggestPreview {...props} phone onClose={closeSheet} />}
      {sheet === 'aims' && <AimsPopover {...props} phone onClose={closeSheet} />}
      {sheet === 'menu' && (
        <Sheet key="menu" label="More" onClose={closeSheet}>
          <button className="btn" type="button" onClick={() => setSheet('aims')}>
            Change aims for this week
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              closeSheet();
              setTab('projects');
              sel.start();
            }}
          >
            Select
          </button>
          <button className="btn" type="button" onClick={closeSheet}>
            Close
          </button>
        </Sheet>
      )}
    </>
  );
}
