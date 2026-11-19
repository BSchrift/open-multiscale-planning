// Week's side of "Schedule both at the same time?" (BothAsk.tsx), for both layouts: before a block, a card or Place
// here lands on placed blocks, it asks. Replace takes those blocks off the calendar once the landing has saved, each
// with its Undo. A block under way or gone by can only be kept.

import type { Slot } from '../../../core/slots';
import type { LocalDate } from '../../../core/types';
import { landsOn, useBothAsk } from '../../components/blocks/BothAsk';
import type { PlacedBlock } from '../../components/weekgrid';
import { useWeekActions } from './useWeekActions';

export function useLanding(blocks: readonly PlacedBlock[], week: LocalDate) {
  const both = useBothAsk();
  const act = useWeekActions();
  /**
   * Whether to go ahead, and what to take off once it has. `self` and `from` are a block being moved and where it was,
   * so what it already overlapped doesn't ask again.
   */
  const landing = async (title: string, slot: Slot, self: string | null = null, from: Slot | null = null): Promise<{ go: boolean; off: PlacedBlock[] }> => {
    const on = landsOn(blocks, self, slot, from);
    if (!on.length) return { go: true, off: [] };
    const answer = await both.ask(title, on.map((b) => ({ id: b.id, title: b.title, fixed: b.past })));
    return { go: answer !== 'cancel', off: answer === 'replace' ? on.filter((b) => !b.past) : [] };
  };
  const takeOff = (off: readonly PlacedBlock[]) => {
    for (const b of off) void act.unschedule(b.id, b.title, week);
  };
  return { landing, takeOff, asking: both.asking };
}
