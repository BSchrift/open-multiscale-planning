// Which question Today asks now, one at a time: a notification's Partly, then missed blocks (one prompt, or one sheet
// for several, today's practices among them), then "Have you started?". Closing one without answering puts it away
// for this session; missed blocks keep a Review row so there's always a way back. The sheet, once up, stays for its
// last row. Today's pane stays mounted behind the other tabs, so the prompts show on every tab.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { instantMs } from '../../../core/dates';
import { nextBlock } from '../../../core/blocks';
import { checkInDue, missedBlocks, practicesToLog } from '../../../core/reminders';
import { PaneShown } from '../../app/nav';
import { requestPrompt, usePromptRequest, useSnoozes } from '../../app/reminders';
import { useApp } from '../../app/store';
import { EndPrompt, StartCheck } from '../../components/blocks/BlockPrompts';
import { MissedSheet } from '../../components/blocks/MissedSheet';
import type { TodayData } from './data';

/** Missed work older than this was time away, which Welcome back handles. */
const MISSED_WINDOW_MS = 7 * 86_400_000;

type Open = { kind: 'end'; id: string } | { kind: 'sheet' } | null;

export function usePrompts(data: TodayData): { prompt: ReactNode; missed: { title: string; review(): void } | null } {
  const { clock } = useApp();
  const snoozed = useSnoozes();
  const request = usePromptRequest();
  const [open, setOpen] = useState<Open>(null);
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());

  const now = clock.now();
  const missed = [
    ...missedBlocks(
      data.recent.filter((b) => instantMs(b.end) > now - MISSED_WINDOW_MS),
      data.away,
      clock,
    ),
    ...practicesToLog(data.blocks, data.away, clock),
  ].sort((a, b) => instantMs(a.start) - instantMs(b.start));
  const sheetKey = `missed:${missed.map((b) => b.id).join()}`;
  const starting = checkInDue(data.blocks, data.settings.reminders, data.away, clock, snoozed);
  const find = (id: string) => data.recent.find((b) => b.id === id && !b.result);

  const close = (key: string) => () => {
    setOpen(null);
    setLater((keys) => new Set(keys).add(key));
  };
  const end = (id: string) => {
    const block = find(id);
    return block ? <EndPrompt key={id} block={block} onClose={close(id)} /> : null;
  };

  // The sheet opens by itself for two or more, and stays up as they're answered, until none are left.
  if (!open && !request && missed.length > 1 && !later.has(sheetKey)) setOpen({ kind: 'sheet' });
  if (open?.kind === 'sheet' && missed.length === 0) setOpen(null);

  let prompt: ReactNode = null;
  let askingMissed = true;
  if (request && find(request)) {
    prompt = <EndPrompt key={`request:${request}`} block={find(request)!} partly onClose={() => requestPrompt(null)} />;
  } else if (open?.kind === 'end') {
    prompt = end(open.id);
  } else if (open?.kind === 'sheet' && missed.length > 0) {
    prompt = <MissedSheet blocks={missed} onClose={close(sheetKey)} />;
  } else if (missed.length === 1 && !later.has(missed[0]!.id)) {
    prompt = end(missed[0]!.id);
  } else if (starting && !later.has(`start:${starting.id}:${snoozed[starting.id] ?? ''}`)) {
    // Keyed by its snooze too, so "Ask again" brings it back while closing it doesn't.
    const next = nextBlock(data.blocks.filter((b) => b.id !== starting.id), clock);
    const key = `start:${starting.id}:${snoozed[starting.id] ?? ''}`;
    prompt = <StartCheck key={key} block={starting} next={next} onClose={close(key)} />;
    askingMissed = false;
  } else {
    askingMissed = false;
  }

  const review = () => setOpen(missed.length === 1 ? { kind: 'end', id: missed[0]!.id } : { kind: 'sheet' });
  const title = `Check in on ${missed.length} missed ${missed.length === 1 ? 'block' : 'blocks'}`;
  // Out to the layout root, which keeps its styles: Today's pane is hidden while another tab shows, and a block
  // still asks then, so its sheet shows though the pane doesn't. shortcut: needs Today's pane mounted, true while the
  // app always opens on Today; move the prompts into the Shell if it ever opens elsewhere.
  const host = document.querySelector<HTMLElement>('[data-layout]');
  const shown = prompt && <PaneShown.Provider value>{prompt}</PaneShown.Provider>;
  return { prompt: shown && host ? createPortal(shown, host) : shown, missed: missed.length > 0 && !askingMissed ? { title, review } : null };
}
