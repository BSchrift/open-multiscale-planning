// What can be done to a task from its popup, in the place a calendar's block puts its own section, opened anywhere
// else: Start now, a block for it from now, as Today's Next up starts one; Mark done, as To schedule's card does, a
// repeating one off for this time only; and Schedule…, the times To schedule suggests for it this week, then Choose a
// time… to place it by hand on Week, as a block's Move… offers new times. Each saves at once with Undo, as the popup's
// attachments do, rather than on Save. An Inbox item has only Mark done: it gets a time once it has a home.

import { useContext, useEffect, useRef, useState } from 'react';
import { addDays, formatTimeOfDay, instantMs, localDate, thisWeek } from '../../../core/dates';
import { taskBlocks } from '../../../core/queries';
import type { Task } from '../../../core/types';
import { useNav } from '../../app/nav';
import { useApp, useQuery } from '../../app/store';
import { LeavePopup } from '../../components/blocks/BlockSection';
import { dayName } from '../../components/blocks/describe';
import { useBlockActions } from '../../components/blocks/useBlockActions';
import { Button } from '../../components/ds/Button';
import { Icon } from '../../components/ds/Icon';
import { Menu } from '../../components/Menu';
import type { MenuEntry } from '../../components/Menu';
import { useToast } from '../../components/Toast';
import { useFocusLanding } from '../../components/useFocusLanding';
import { useWeekActions } from '../week/useWeekActions';

/** Where Schedule…'s choices open: this far below the button, as Move…'s do. */
const MENU_GAP = 8;
const CHOOSE = 'schedule:choose';

export function TaskActions(props: { task: Task }) {
  const { task } = props;
  const { clock } = useApp();
  const nav = useNav();
  const toast = useToast();
  const blocks = useBlockActions();
  const week = useWeekActions();
  const leave = useContext(LeavePopup);
  // A control that takes itself away, such as Start now once it's counting, lands focus on the section, or on the
  // popup's name once the section has gone with the task done.
  const land = useFocusLanding();
  const ref = useRef<HTMLElement>(null);
  const scheduleButton = useRef<HTMLButtonElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const open = !task.done_at && !task.cancelled_at;
  const timed = open && task.kind !== 'inbox';
  // A block of its own already counting needs no other.
  const counting = useQuery(
    (sql, clock) =>
      timed
        ? taskBlocks(sql, { task_id: task.id }).then((bs) => bs.some((b) => !!b.started_at && !b.ended_at && instantMs(b.start) <= clock.now() && clock.now() < instantMs(b.end)))
        : Promise.resolve(false),
    [timed, task.id],
  ).data;
  // The week is read only once Schedule… is pressed, for its suggested times, and its code loads then too, as Week's
  // does, rather than with the app.
  const model = useQuery(async (sql, clock) => {
    if (!menuAt) return undefined;
    const { loadWeek, weekModel } = await import('../week/data');
    return weekModel(await loadWeek(sql, clock, thisWeek(clock)), clock);
  }, [!!menuAt]).data;
  const item = menuAt && model ? model.itemFor(task) : undefined;
  // A time as Move… says one: Today or Tomorrow by name, another day by its date, and when it starts.
  const today = localDate(clock.now(), clock.zone());
  const dayOf = (date: string) => (date === today ? 'Today' : date === addDays(today, 1) ? 'Tomorrow' : dayName(date));
  const entries: MenuEntry[] = item
    ? [
        ...item.offers.map((o, i) => ({ id: `schedule:${i}`, label: `${dayOf(o.date)}, ${formatTimeOfDay(o.start)}`, icon: 'calendar' as const })),
        // Week would close a flow it opened over, such as planning's, so there it offers only the suggested times.
        ...(model!.canChoose(task.id) && !nav.flow ? ([...(item.offers.length ? ['separator' as const] : []), { id: CHOOSE, label: 'Choose a time…', icon: 'week' as const }] as const) : []),
      ]
    : [];
  const empty = !!item && entries.length === 0;
  useEffect(() => {
    if (!empty) return;
    setMenuAt(null);
    toast.show(`No open time fits ${task.title} this week.`);
  }, [empty, task.title, toast]);

  if (!open) return null;
  const landHere = () => {
    const name = ref.current?.closest('.taskpop')?.querySelector<HTMLElement>('h2') ?? null;
    land(() => ref.current ?? name);
  };
  const openMenu = () => {
    const r = scheduleButton.current!.getBoundingClientRect();
    setMenuAt({ x: r.left, y: r.bottom + MENU_GAP });
  };
  const closeMenu = () => {
    setMenuAt(null);
    scheduleButton.current?.focus();
  };
  const choose = (id: string) => {
    closeMenu();
    if (id === CHOOSE) {
      if (leave?.() ?? true) nav.go('week', { place: task.id });
      return;
    }
    const slot = item?.offers[Number(id.slice('schedule:'.length))];
    if (item && slot) void week.place(item, slot);
  };

  return (
    <section ref={ref} className="taskacts" aria-label="Actions" tabIndex={-1}>
      <div className="row blocksecacts">
        {timed && !counting && (
          <Button
            variant="primary"
            size="compact"
            type="button"
            disabled={blocks.pending}
            onClick={() => {
              landHere();
              void blocks.startTask(task);
            }}
          >
            Start now
          </Button>
        )}
        <Button
          size="compact"
          type="button"
          onClick={() => {
            landHere();
            void week.markDone(task);
          }}
        >
          <Icon name="done" size={16} />
          Mark done
        </Button>
        {timed && (
          <Button ref={scheduleButton} size="compact" type="button" aria-haspopup="menu" aria-expanded={!!menuAt} onClick={openMenu}>
            Schedule…
          </Button>
        )}
      </div>
      {menuAt && entries.length > 0 && <Menu label="Schedule" entries={entries} at={menuAt} onChoose={choose} onClose={closeMenu} />}
    </section>
  );
}
