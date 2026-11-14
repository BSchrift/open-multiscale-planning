// What's outside this stretch, and how it's shown. Work that needs you always shows; the rest folds in place under its
// milestone, counted, and a project with nothing that needs you waits whole. The lede line says how much and where,
// and is a toggle; the end of the list repeats it, and once open links to where tasks opened, above it. Both are one
// state, kept for the week on this device, so a new week starts at this stretch. Focus stays on the button pressed,
// nothing scrolls by itself, and a live region says once where the tasks opened.

import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { formatDate } from '../../../../core/dates';
import type { LocalDate } from '../../../../core/types';
import { useNav } from '../../../app/nav';
import { useStickyState } from '../../../app/store';
import { useToast } from '../../../components/Toast';
import type { PickGroup, PickProject, PickView } from './model';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A fold's key: a group's own key repeats across projects, as Done and Needs a new time do. */
export const foldKey = (s: PickProject, g: PickGroup) => `${s.plan.project.id}:${g.key}`;

export function useOutside(view: PickView, week: LocalDate) {
  const [open, setOpen] = useStickyState<boolean>(`pick.outside.${week}`, false);
  // Folds opened or closed one at a time, until the toggle sets them all.
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  const [said, setSaid] = useState('');
  // What showed by itself this visit stays, so nothing leaves under the pointer once it stops needing you.
  const seen = useRef(new Set<string>());
  for (const p of view.projects) {
    if (p.shown) seen.current.add(p.plan.project.id);
    for (const g of p.groups) if (!g.folded) seen.current.add(foldKey(p, g));
  }
  const filter = view.filter;
  /** Shown by itself, rather than by the toggle. */
  const own = (s: PickProject) => !filter || seen.current.has(s.plan.project.id);
  const foldable = (s: PickProject, g: PickGroup) => filter && g.folded && own(s) && !seen.current.has(foldKey(s, g));
  const isOpen = (s: PickProject, g: PickGroup) => !foldable(s, g) || (folds[foldKey(s, g)] ?? open);
  const { n, where } = view.outside;
  return {
    open: filter && open,
    said,
    visible: (s: PickProject) => own(s) || (filter && open),
    foldable,
    isOpen,
    /** A row the toggle or a fold showed, which focus can be moved to. */
    revealed: (s: PickProject, g: PickGroup) => filter && (!own(s) || foldable(s, g)),
    setFold: (s: PickProject, g: PickGroup, to: boolean) => setFolds((f) => ({ ...f, [foldKey(s, g)]: to })),
    /** Paused projects and those not started wait behind the toggle while there's one. */
    others: !filter || open || n === 0,
    toggle: () => {
      setOpen(!open);
      setFolds({});
      setSaid(open ? '' : `Showing ${plural(n, 'more task', 'more tasks')}, in date order: ${where.map((w) => `${w.n} in ${w.title}`).join(', ')}.`);
    },
  };
}
export type Outside = ReturnType<typeof useOutside>;

/** '1 folded in their projects, 4 in Write a cookbook', and when the earliest of them is due. */
export function outsideWords(view: PickView) {
  const { folded, where, earliest } = view.outside;
  const parts = [folded ? `${folded} folded in their projects` : '', ...where.filter((w) => w.hidden).map((w) => `${w.n} in ${w.title}`)].filter(Boolean);
  return { where: parts.join(', '), earliest: earliest ? ` Earliest due ${formatDate(earliest)}.` : '' };
}

/** The toggle's name, the same on both buttons. */
const toggleName = (view: PickView, open: boolean) => (open ? `Hide ${plural(view.outside.n, 'task')} outside this stretch` : `Show ${plural(view.outside.n, 'more task', 'more tasks')} outside this stretch`);

/** The lede: how many tasks show, how many more are outside this stretch and where, and the toggle. */
export function Lede(props: { view: PickView; out: Outside; phone: boolean; descId: string }) {
  const { view, out, phone } = props;
  const all = [...view.projects.flatMap((p) => p.groups.flatMap((g) => g.rows)), ...view.oneOffs.rows].filter((r) => !r.done).length;
  const { n } = view.outside;
  const words = outsideWords(view);
  if (!view.filter) return null;
  const shown = out.open ? all : all - n;
  return (
    <div className="plede">
      <p className="small">
        <strong>{plural(shown, 'task')}</strong>
        {n === 0 ? ', all in this stretch.' : phone ? <> · {n} more outside this stretch</> : <>, this stretch first · <strong>{n} more</strong> outside it: {words.where}</>}
      </p>
      {n > 0 && (
        <>
          <span id={props.descId} className="sr">
            {words.where}.{words.earliest}
          </span>
          <button className="btn sm" type="button" aria-expanded={out.open} aria-label={toggleName(view, out.open)} aria-describedby={props.descId} onClick={out.toggle}>
            {out.open ? 'Hide' : 'Show'}
          </button>
        </>
      )}
    </div>
  );
}

/** The end of the list: the toggle again, and once open, links to where tasks opened, above it. */
export function EndToggle(props: { view: PickView; out: Outside; descId: string }) {
  const { view, out } = props;
  const { n, where } = view.outside;
  if (!view.filter || n === 0) return null;
  const words = outsideWords(view);
  const cant = view.others.map((o) =>
    o.plan.project.state === 'paused' ? `${o.plan.project.title} is paused, so it can't be planned.` : `${o.plan.project.title} starts ${formatDate(o.plan.project.start)}, so it can't be planned yet.`,
  );
  // Focus moves to the first task that opened there; the row takes focus without being a tab stop.
  const goTo = (id: string) => {
    const row = document.querySelector<HTMLElement>(`[data-project="${id}"] li[data-revealed]`);
    row?.scrollIntoView?.({ block: 'center' });
    row?.focus({ preventScroll: true });
  };
  const links: ReactNode[] = where.map((w, i) => (
    <span key={w.id}>
      {i > 0 && <span aria-hidden="true"> · </span>}
      <button className="link small" type="button" aria-label={`Go to ${w.title}`} onClick={() => goTo(w.id)}>
        {w.title}
      </button>
    </span>
  ));
  return (
    <div className="pend">
      <button className="endtog" type="button" aria-expanded={out.open} aria-describedby={props.descId} onClick={out.toggle}>
        <span className="foldc" aria-hidden="true">
          {out.open ? '⌄' : '›'}
        </span>
        {toggleName(view, out.open)}
      </button>
      {out.open ? (
        <p className="small">They opened in date order, above: {links}</p>
      ) : (
        <p className="small">
          {where.map((w) => `${w.title} ${w.n}`).join(', ')}.{words.earliest} {cant.join(' ')}
        </p>
      )}
    </div>
  );
}

/** Why nothing is filtered: no stretch planned yet, or no stretches at all. And planned milestones with nothing under them. */
export function StretchLine(props: { view: PickView }) {
  const { view } = props;
  const nav = useNav();
  const toast = useToast();
  if (view.why === 'no cadence') return <p className="pstretch small">You plan without stretches, so every project shows.</p>;
  if (view.why) {
    const st = view.why.unplanned;
    return (
      <p className="pstretch small">
        {formatDate(st.start)} to {formatDate(st.end)} isn't planned yet, so every project shows.{' '}
        <button
          className="link small"
          type="button"
          onClick={() => {
            nav.go('plan');
            toast.show('Your plan is kept.');
          }}
        >
          Plan this stretch
        </button>
      </p>
    );
  }
  if (!view.noTasks) return null;
  return <p className="pstretch small">{view.noTasks === 1 ? '1 planned milestone has' : `${view.noTasks} planned milestones have`} no tasks yet.</p>;
}
