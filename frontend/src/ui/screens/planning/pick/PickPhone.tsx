// Pick tasks on phone: the same cards as desktop, one under another, under two tabs: Projects, and This week, which
// holds the week's shape and its tasks. Does it fit, in the top bar, shows This week. ⋯ holds Change aims, Select and
// the timeline's key; Select's bar takes the bottom bar's place.

import { useEffect, useRef, useState } from 'react';
import { formatMinutes } from '../../../../core/dates';
import { ONE_OFFS_BUCKET } from '../../../../core/types';
import { Pill } from '../../../components/Pill';
import { Sheet } from '../../../components/Sheet';
import { useFit } from '../WeekFit';
import { AimsPopover } from './Aims';
import { EmptyCard, Legend, OneOffsCard, OtherCard, ProjectCard, useOpenCards } from './Cards';
import { ProjectAdder, useAdding, usePickAddMenu } from './Adders';
import { PastEnd } from './PastEnd';
import { selectable } from './PickDesktop';
import type { PickProps } from './PickStep';
import { SelectBar, useSelection } from './Select';
import { SuggestPreview } from './Suggest';
import { WeekList, WeekShape } from './WeekShape';

export function PickPhone(props: PickProps) {
  const { view, model } = props;
  const [tab, setTab] = useState<'projects' | 'week'>('projects');
  const [sheet, setSheet] = useState<'menu' | 'key' | 'aims' | 'suggest' | null>(null);
  const cards = useOpenCards(view);
  const sel = useSelection();
  const adder = useAdding();
  // The project in view: the first card still showing at the top of the list as it scrolls.
  const [inView, setInView] = useState<string | undefined>(undefined);
  const firstOpen = (view.projects.find((p) => cards.isOpen(p.plan.project.id)) ?? view.projects[0])?.plan.project.id;
  const onScroll = () => {
    const top = root.current?.getBoundingClientRect().top ?? 0;
    const card = [...(root.current?.querySelectorAll<HTMLElement>('.pcd[data-project]') ?? [])].find((c) => c.getBoundingClientRect().bottom > top + 48);
    setInView(card?.dataset.project);
  };
  usePickAddMenu(props, adder, cards, inView ?? firstOpen, () => {
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
  const rows = selectable(props, cards.isOpen);
  useEffect(() => {
    if (sel.on) root.current?.querySelector<HTMLElement>('.selbox')?.focus();
  }, [sel.on]);
  const closeSheet = () => setSheet(null);
  const card = { ...props, phone: true, select: sel, adder };
  const projectAdder = (
    <ProjectAdder
      {...props}
      adder={adder}
      onAdded={(id) => {
        cards.open(id);
        adder.setAdding({ kind: 'task', project: id });
      }}
    />
  );

  return (
    <>
      <div ref={root} className="scroll pkscroll" onScroll={onScroll}>
        <div className="pkhead">
          <h2>Pick tasks</h2>
          {view.hintMin > 0 && (
            <button className="btn" type="button" aria-haspopup="dialog" onClick={() => setSheet('suggest')}>
              Add suggested {formatMinutes(view.hintMin)}
            </button>
          )}
          <button ref={moreRef} className="pkmore" type="button" aria-haspopup="dialog" aria-label="More: change aims, select, timeline key" onClick={() => setSheet('menu')}>
            ⋯
          </button>
        </div>
        <div className="seg" role="group" aria-label="Show">
          <button type="button" aria-pressed={tab === 'projects'} onClick={() => setTab('projects')}>
            Projects
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
            {view.pastEnd.map(({ plan, status }) => (
              <div key={plan.project.id} className="card stack8">
                <PastEnd plan={plan} status={status} ctx={model.ctx} onSkip={() => props.skipPastEnd(plan.project.id)} />
              </div>
            ))}
            {empty && <EmptyCard>{projectAdder}</EmptyCard>}
            {view.projects.map((s) => (
              <ProjectCard key={s.plan.project.id} {...card} s={s} open={cards.isOpen(s.plan.project.id)} toggle={() => cards.toggle(s.plan.project.id)} />
            ))}
            <OneOffsCard {...card} open={cards.isOpen(ONE_OFFS_BUCKET)} toggle={() => cards.toggle(ONE_OFFS_BUCKET)} />
            {view.others.map((o) => (
              <OtherCard key={o.plan.project.id} title={o.plan.project.title} pill={<Pill tone={o.status.tone}>{o.status.pill}</Pill>} sum={o.sum} />
            ))}
            {!empty && !sel.on && <div className="card pcd emptycard addcard">{projectAdder}</div>}
          </>
        )}
        <div className="sr" role="status">
          {props.said}
        </div>
      </div>

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
          <button className="btn" type="button" onClick={() => setSheet('key')}>
            Timeline key
          </button>
          <button className="btn" type="button" onClick={closeSheet}>
            Close
          </button>
        </Sheet>
      )}
      {sheet === 'key' && (
        <Sheet key="key" label="Timeline key" onClose={closeSheet}>
          <div className="between">
            <h2>Timeline key</h2>
            <button className="btn" type="button" onClick={closeSheet}>
              Close
            </button>
          </div>
          <Legend stretch={!!view.stretch} className="col" />
        </Sheet>
      )}
    </>
  );
}
