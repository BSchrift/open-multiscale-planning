// Which question Today asks now, one at a time: a notification's Partly, then missed work (one prompt, or one
// check-in for several), then a practice to log, then "Have you started?". Closing one without answering puts it
// away for this session; missed work keeps a Review row so there's always a way back. Today's pane stays mounted
// behind the other tabs, so the prompts show on every tab.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { instantMs } from '../../../core/dates';
import { nextBlock } from '../../../core/blocks';
import { checkInDue, missedBlocks, practicesToLog } from '../../../core/reminders';
import { requestPrompt, usePromptRequest, useSnoozes } from '../../app/reminders';
import { useApp } from '../../app/store';
import { CheckIn, EndPrompt, StartCheck } from '../../components/blocks/BlockPrompts';
import type { TodayData } from './data';

/** Missed work older than this was time away, which Welcome back handles. */
const MISSED_WINDOW_MS = 7 * 86_400_000;

type Open = { kind: 'end'; id: string; partly?: boolean } | { kind: 'checkin' } | null;

export function usePrompts(data: TodayData): { prompt: ReactNode; missed: { title: string; review(): void } | null } {
  const { clock } = useApp();
  const snoozed = useSnoozes();
  const request = usePromptRequest();
  const [open, setOpen] = useState<Open>(null);
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());

  const now = clock.now();
  const missed = missedBlocks(
    data.recent.filter((b) => instantMs(b.end) > now - MISSED_WINDOW_MS),
    data.away,
    clock,
  );
  const checkKey = `checkin:${missed.map((b) => b.id).join()}`;
  const practice = practicesToLog(data.blocks, data.away, clock)[0];
  const starting = checkInDue(data.blocks, data.settings.reminders, data.away, clock, snoozed);
  const find = (id: string) => data.recent.find((b) => b.id === id && !b.result);

  const close = (key: string) => () => {
    setOpen(null);
    setLater((keys) => new Set(keys).add(key));
  };
  const end = (id: string, partly = false) => {
    const block = find(id);
    return block ? <EndPrompt key={`${id}:${partly}`} block={block} partly={partly} onClose={close(id)} /> : null;
  };

  let prompt: ReactNode = null;
  let askingMissed = true;
  if (request && find(request)) {
    prompt = <EndPrompt key={`request:${request}`} block={find(request)!} partly onClose={() => requestPrompt(null)} />;
  } else if (open?.kind === 'end') {
    prompt = end(open.id, open.partly);
  } else if (missed.length > 0 && (open?.kind === 'checkin' || (missed.length > 1 && !later.has(checkKey)))) {
    prompt = <CheckIn blocks={missed} onPartly={(b) => setOpen({ kind: 'end', id: b.id, partly: true })} onClose={close(checkKey)} />;
  } else if (missed.length === 1 && !later.has(missed[0]!.id)) {
    prompt = end(missed[0]!.id);
  } else if (practice && !later.has(practice.id)) {
    prompt = end(practice.id);
    askingMissed = false;
  } else if (starting && !later.has(`start:${starting.id}:${snoozed[starting.id] ?? ''}`)) {
    // Keyed by its snooze too, so "Ask again" brings it back while closing it doesn't.
    const next = nextBlock(data.blocks.filter((b) => b.id !== starting.id), clock);
    const key = `start:${starting.id}:${snoozed[starting.id] ?? ''}`;
    prompt = <StartCheck key={key} block={starting} next={next} onClose={close(key)} />;
    askingMissed = false;
  } else {
    askingMissed = false;
  }

  const review = () => setOpen(missed.length === 1 ? { kind: 'end', id: missed[0]!.id } : { kind: 'checkin' });
  const title = `Check in on ${missed.length} missed ${missed.length === 1 ? 'block' : 'blocks'}`;
  // Out to the layout root, which keeps its styles: Today's pane is hidden while another tab shows, and a block
  // still asks then. shortcut: needs Today's pane mounted, true while the app always opens on Today; move the
  // prompts into the Shell if it ever opens elsewhere.
  const host = document.querySelector<HTMLElement>('[data-layout]');
  return { prompt: prompt && host ? createPortal(prompt, host) : prompt, missed: missed.length > 0 && !askingMissed ? { title, review } : null };
}
