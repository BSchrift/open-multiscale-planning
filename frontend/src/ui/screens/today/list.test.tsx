import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { localToInstant } from '../../../core/dates';
import { CALENDAR_ID, getRecord, outcomeId, weekPlanId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderScreen } from '../../app/testing';
import type { HarnessOptions } from '../../app/testing';
import { listRows } from './list';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const m = (time: string) => {
  const [h, min] = time.split(':').map(Number);
  return h! * 60 + (min ?? 0);
};
const item = (id: string, from: string, to: string) => ({ id, from: m(from), to: m(to) });

describe("the list's rows", () => {
  const day = [item('run', '8:00', '8:30'), item('ch2', '13:30', '15:00'), item('passport', '15:30', '16:00'), item('sam', '16:00', '16:30'), item('bugs', '16:30', '18:00'), item('piano', '19:00', '19:30')];

  it('puts free time of half an hour or more between the blocks and events still to come, to the end of the day', () => {
    // 2:10pm, with chapter two under way: no Now row, since the card is now.
    expect(listRows(day, { now: null, from: m('14:10'), to: m('22:00') })).toEqual([
      { kind: 'item', id: 'run' },
      { kind: 'item', id: 'ch2' },
      { kind: 'free', start: m('15:00'), end: m('15:30') },
      { kind: 'item', id: 'passport' },
      { kind: 'item', id: 'sam' },
      { kind: 'item', id: 'bugs' },
      { kind: 'free', start: m('18:00'), end: m('19:00') },
      { kind: 'item', id: 'piano' },
      { kind: 'free', start: m('19:30'), end: m('22:00') },
    ]);
  });

  it('with nothing under way, a Now row sits where now falls, saying how long it is free, in place of that free row', () => {
    expect(listRows(day.slice(0, 2), { now: m('7:40'), from: m('7:40'), to: m('22:00') })).toEqual([
      { kind: 'now', free: true, until: m('8:00') },
      { kind: 'item', id: 'run' },
      { kind: 'free', start: m('8:30'), end: m('13:30') },
      { kind: 'item', id: 'ch2' },
      { kind: 'free', start: m('15:00'), end: m('22:00') },
    ]);
  });

  it('after everything, the Now row is free for the rest of the day', () => {
    expect(listRows(day.slice(0, 1), { now: m('9:00'), from: m('9:00'), to: m('22:00') })).toEqual([{ kind: 'item', id: 'run' }, { kind: 'now', free: true, until: null }]);
  });

  it("during an event, the Now row isn't free, and the time after the event is", () => {
    const items = [item('call', '13:00', '14:30'), item('ch2', '15:00', '16:00')];
    expect(listRows(items, { now: m('14:00'), from: m('14:00'), to: m('16:00') })).toEqual([
      { kind: 'item', id: 'call' },
      { kind: 'now', free: false, until: m('15:00') },
      { kind: 'free', start: m('14:30'), end: m('15:00') },
      { kind: 'item', id: 'ch2' },
    ]);
  });

  it('on a day gone by, has no free time; on a day to come, counts it from the start of the day', () => {
    const items = [item('ch2', '9:00', '10:00')];
    expect(listRows(items, { now: null, from: null, to: m('22:00') })).toEqual([{ kind: 'item', id: 'ch2' }]);
    expect(listRows(items, { now: null, from: m('7:00'), to: m('11:00') })).toEqual([
      { kind: 'free', start: m('7:00'), end: m('9:00') },
      { kind: 'item', id: 'ch2' },
      { kind: 'free', start: m('10:00'), end: m('11:00') },
    ]);
  });

  it("leaves out free time shorter than half an hour, and counts blocks at the same time as one stretch", () => {
    const items = [item('a', '9:00', '10:00'), item('b', '9:30', '11:00'), item('c', '11:20', '12:00')];
    expect(listRows(items, { now: null, from: m('9:00'), to: m('12:10') }).map((r) => r.kind)).toEqual(['item', 'item', 'item']);
  });
});

// Monday, Nov 2 in Chicago.
const ZONE = 'America/Chicago';
const DAY = '2026-11-02';
const at = (time: string) => localToInstant(DAY, m(time), ZONE);
const task = (w: Writer, id: string, title: string) => w.create('task', { kind: 'project', project_id: 'p', title, estimate_min: 180 }, id);
const block = (w: Writer, id: string, taskId: string, from: string, to: string, extra: Record<string, unknown> = {}) =>
  w.create('time_block', { task_id: taskId, start: at(from), end: at(to), tz: ZONE, ...extra }, id);

async function open(seed: (w: Writer) => Promise<unknown>, time: string, options: HarnessOptions = {}) {
  return renderScreen('today', {
    now: at(time),
    zone: ZONE,
    layout: 'phone',
    ...options,
    seed: async (w) => {
      await w.create('week_plan', { week_start: DAY, finished_at: at('08:00') }, weekPlanId(DAY));
      await seed(w);
    },
  });
}
const showList = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'View and week' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Show as a list' }));
  return list();
};
const list = () => waitFor(() => document.querySelector<HTMLElement>('.tdlist')!, { timeout: 5000 });
const rows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(':scope > .tlrow')].map((r) => r.textContent);
const card = () => waitFor(() => document.querySelector<HTMLElement>('.tdlist .cev.raised')!);

const midDay = async (w: Writer) => {
  await task(w, 't1', 'Write the report');
  await block(w, 'b1', 't1', '09:00', '10:00');
  await w.create('block_outcome', { result: 'done', answered_at: at('10:00') }, outcomeId('b1'));
  await task(w, 't2', 'Paint the fence');
  await block(w, 'b2', 't2', '13:30', '15:00', { started_at: at('13:30') });
  await task(w, 't3', 'Rake the leaves');
  await block(w, 'b3', 't3', '16:30', '17:00');
  await w.create('calendar', { connected: true, events: [{ id: 'e1', calendar: 'work', title: 'Team call', start: at('16:00'), end: at('16:30') }] }, CALENDAR_ID);
};

describe("Today's day as a list, on phone", () => {
  it('lists the day by time: the block in progress in its row, free time that adds a task there, events as busy, and the morning folded', async () => {
    await open(midDay, '14:10');
    const el = await showList();
    // The morning folds into the Earlier row, as on the calendar, an hour before the block in progress.
    expect(screen.getByRole('button', { name: 'Earlier, 7am to 12pm, 1 block', expanded: false })).toBeVisible();
    expect(screen.queryByText('Write the report')).toBeNull();
    // Selected by Today, not a tap, the block in progress stays a row, with its time left; only a tap grows it.
    expect(await card()).toHaveClass('inlane');
    expect(screen.queryByRole('button', { name: 'Mark done now' })).toBeNull();
    expect(rows(el)).toEqual([
      '1:30pmPaint the fence50 min left',
      '3pmFree until 4pm, 1h',
      '4pmTeam callBusy, 30 min',
      '4:30pmRake the leaves30 min',
      '5pmFree until 10pm, 5h',
    ]);
    // A tap grows it into its card, across the list, with what it can do.
    await userEvent.click(screen.getByRole('button', { name: /^Paint the fence, 1:30pm to 3pm/ }));
    await waitFor(() => expect(document.querySelector('.tdlist .cev.raised')).not.toHaveClass('inlane'));
    expect(within(await card()).getByRole('button', { name: 'Mark done now' })).toBeVisible();
    expect(within(await card()).getByRole('button', { name: 'Stop for now' })).toBeVisible();
    // Free time adds a task there, as the calendar's hold does.
    await userEvent.click(screen.getByRole('button', { name: 'Free, 3pm to 4pm. Add a task then' }));
    expect(within(await screen.findByRole('dialog', { name: 'Capture' })).getByText('Today, 3pm to 4pm')).toBeVisible();
  });

  it('a tap selects a block, which becomes its card with Move and Details, and a second tap opens it', async () => {
    await open(midDay, '14:10');
    await showList();
    await userEvent.click(screen.getByRole('button', { name: /^Rake the leaves, 4:30pm to 5pm, Project\.$/ }));
    const selected = await waitFor(() => screen.getByRole('button', { name: /^Rake the leaves, 4:30pm to 5pm, Project\. Selected\.$/ }));
    expect(within(await card()).getByRole('button', { name: 'Move' })).toBeVisible();
    // The block in progress goes back to a plain row.
    expect(screen.getByRole('button', { name: /^Paint the fence, 1:30pm to 3pm/ }).closest('.tlrow')).toHaveTextContent(/^1:30pmNowPaint the fence1h 30m$/);
    await userEvent.click(selected);
    expect(await screen.findByRole('dialog', { name: 'Rake the leaves' })).toBeVisible();
  });

  it('in the morning, a Now row says how long until the next block, which shows Start early on itself', async () => {
    const t = await open(async (w) => {
      await task(w, 't1', 'Write the report');
      await block(w, 'b1', 't1', '09:00', '10:00');
    }, '08:20');
    const el = await showList();
    expect(rows(el)).toEqual(['Now8:20am, free until 9am', '9amWrite the reportStart early', '10amFree until 10pm, 12h']);
    await userEvent.click(within(await card()).getByRole('button', { name: 'Start early' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.started_at).toBeTruthy());
  });

  it('a block that just ended asks how it went: one button, which grows it to its answers', async () => {
    await open(async (w) => {
      await task(w, 't1', 'Write the report');
      await block(w, 'b1', 't1', '13:00', '13:55');
    }, '14:00');
    await showList();
    await userEvent.click(within(await card()).getByRole('button', { name: 'How did it go?' }));
    await waitFor(() => expect(document.querySelector('.tdlist .cev.raised')).not.toHaveClass('inlane'));
    expect(within(await card()).getByRole('button', { name: 'Not done' })).toBeVisible();
  });

  it('on a day with nothing on it, the Now row offers Start something', async () => {
    await open(async () => undefined, '14:00');
    const el = await showList();
    expect(rows(el)).toEqual(['Now2pm, free for the rest of the dayStart something']);
    await userEvent.click(within(el).getByRole('button', { name: 'Start something' }));
    expect(await screen.findByRole('dialog', { name: 'Start something' })).toBeVisible();
  });

  it('at the accessibility text sizes, is the day by itself; the calendar is a choice from the menu, kept for those sizes', async () => {
    await open(midDay, '14:10');
    await screen.findByRole('region', { name: "Today's timeline" });
    const big = (on: boolean) => {
      document.querySelector<HTMLElement>('[data-layout]')!.style.fontSize = on ? '28px' : '';
      // Read again as the app comes back from Settings, where the text size is changed.
      act(() => void document.dispatchEvent(new Event('visibilitychange')));
    };
    big(true);
    expect(await list()).toHaveClass('big');
    big(false);
    await waitFor(() => expect(document.querySelector('.tdlist')).toBeNull());
    big(true);
    await list();
    await userEvent.click(screen.getByRole('button', { name: 'View and week' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Show as a calendar' }));
    await waitFor(() => expect(document.querySelector('.tdlist')).toBeNull());
    big(false);
    big(true);
    expect(document.querySelector('.tdlist')).toBeNull();
    // The choice at the usual sizes is its own.
    expect(localStorage.getItem('multiscale.today.view')).toBeNull();
  });
});
