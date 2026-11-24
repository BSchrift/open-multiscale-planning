import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localToInstant } from '../../../core/dates';
import { getRecord, listRecords, setWeekPick, weekPlanId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import type { Slot } from '../../../core/slots';
import { renderInApp } from '../../app/testing';
import type { Harness } from '../../app/testing';
import { DraftCapture } from './DraftCapture';

afterEach(cleanup);

// Monday, Nov 2 in Chicago, at 2pm. A hold drafted 5:45pm to 6:45pm, with Team sync prep's block at 7pm after it.
const ZONE = 'America/Chicago';
const DAY = '2026-11-02';
const at = (time: string, date = DAY) => {
  const [h, m] = time.split(':').map(Number);
  return localToInstant(date, h! * 60 + (m ?? 0), ZONE);
};

async function seed(w: Writer) {
  await w.create('week_plan', { week_start: DAY, finished_at: at('08:00') }, weekPlanId(DAY));
  await w.create('project', { title: 'Report', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p');
  const task = (id: string, title: string, extra: Record<string, unknown>) => w.create('task', { kind: 'project', project_id: 'p', title, ...extra }, id);
  // To schedule: two picks, one longer than the free time, a one off dated Wednesday, Thursday's stretch, and a count
  // practice whose session today is already placed.
  await task('t1', 'Write the report', { estimate_min: 60 });
  await setWeekPick(w, DAY, 't1', 60);
  await task('t2', 'Plan the offsite', { estimate_min: 120 });
  await setWeekPick(w, DAY, 't2', 120);
  await w.create('task', { kind: 'one_off', title: 'Renew the passport', estimate_min: 30, schedule: { type: 'once', from: '2026-11-04' } }, 'o1');
  await w.create('practice', { title: 'Stretching', target_min: 20, per: 'day', days: [3], preferred_times: [7 * 60], state: 'active' }, 'stretch');
  await w.create('practice', { title: 'Climbing', target_min: 120, per: 'week', sessions: 2, preferred_times: [7 * 60], state: 'active' }, 'climb');
  await w.create('time_block', { practice_id: 'climb', start: at('07:00'), end: at('08:00'), tz: ZONE }, `session:climb:${DAY}`);
  // Other open tasks: one whose time is all placed, a one off with no date, an Inbox item with no estimate, and a
  // finished one, which isn't searched.
  await task('t3', 'Team sync prep', { estimate_min: 60 });
  await w.create('time_block', { task_id: 't3', start: at('19:00'), end: at('20:00'), tz: ZONE }, 'b3');
  await w.create('task', { kind: 'one_off', title: 'Book flights', estimate_min: 30 }, 'o2');
  await w.create('task', { kind: 'inbox', title: 'Renew the car tax' }, 'i1');
  await task('t4', 'Old report draft', { estimate_min: 30, done_at: at('09:00') });
}

function Held(props: { close(): void }) {
  const [slot] = useState<Slot>({ date: DAY, start: 17 * 60 + 45, end: 18 * 60 + 45 });
  return <DraftCapture layout="desktop" close={props.close} slot={{ slot, onLength: () => {} }} />;
}

const open = async () => {
  const close = vi.fn();
  const t = await renderInApp(<Held close={close} />, { now: at('14:00'), zone: ZONE, seed });
  await screen.findByRole('option', { name: /^Write the report/ }, { timeout: 5000 });
  return { ...t, close };
};
const field = () => screen.getByRole('combobox', { name: 'Capture to Inbox' });
const names = () => screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'));
const groups = () => screen.queryAllByRole('group').map((g) => g.getAttribute('aria-label'));
const live = async (t: Harness) => (await listRecords(t.db, 'time_block')).filter((b) => !b.deleted_at);

describe('Capture on a calendar’s draft, with the tasks you have', () => {
  it('lists this week’s To schedule: ones that fit first, soonest due first, then longer ones, then one that can’t go here', async () => {
    await open();
    expect(groups()).toEqual(['To schedule · 1h 15m free here']);
    expect(names()).toEqual([
      'New Inbox task',
      'Renew the passport, One off · 30m, Fits',
      "Stretching, Practice · Thursday's session · 20m · 7am, Fits",
      'Write the report, Project · 1h, Fits',
      'Plan the offsite, Project · 2h, Longer by 45m',
      'Climbing, Practice · 1 more this week · 1h each, Already on Monday, 7am',
    ]);
  });

  it('typing finds other open tasks too, under where they live, by name or place, and leaves out finished ones', async () => {
    await open();
    await userEvent.type(field(), 'renew');
    expect(groups()).toEqual(['To schedule · 1h 15m free here', 'Inbox']);
    expect(names()).toEqual(['New Inbox task: renew', 'Renew the passport, One off · 30m, Fits', 'Renew the car tax, Inbox · No estimate, so 30m, Fits']);
    await userEvent.clear(field());
    await userEvent.type(field(), 'report');
    expect(groups()).toEqual(['To schedule · 1h 15m free here', 'Report']);
    expect(names()).toEqual(['New Inbox task: report', 'Write the report, Project · 1h, Fits', 'Team sync prep, Project · 1h, all placed, Moves from 7pm']);
  });

  it('picking a task to schedule places a block of its length at the draft’s start, with Undo', async () => {
    const t = await open();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(await screen.findByText(/^Placed Renew the passport, .*5:45pm$/)).toBeVisible();
    expect(t.close).toHaveBeenCalledOnce();
    expect((await live(t)).filter((b) => b.task_id === 'o1')).toMatchObject([{ start: at('17:45'), end: at('18:15') }]);
    expect((await listRecords(t.db, 'task')).filter((x) => x.kind === 'inbox')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await live(t)).filter((b) => b.task_id === 'o1')).toEqual([]));
  });

  it('a task whose time is all placed moves its next block there, keeping its length, with Undo', async () => {
    const t = await open();
    await userEvent.type(field(), 'team');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(await screen.findByText(/^Moved Team sync prep to .*5:45pm$/)).toBeVisible();
    expect(await getRecord(t.db, 'time_block', 'b3')).toMatchObject({ start: at('17:45'), end: at('18:45') });
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await getRecord(t.db, 'time_block', 'b3')).toMatchObject({ start: at('19:00') }));
  });

  it('one that lands on a block asks first, as a drop does: Cancel brings Capture back, and Keep both places it', async () => {
    const t = await open();
    await userEvent.click(screen.getByRole('option', { name: /^Plan the offsite/ }));
    const ask = await screen.findByRole('dialog', { name: 'Schedule both at the same time?' });
    expect(within(ask).getByText('Plan the offsite overlaps Team sync prep.')).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Capture to Inbox' })).toBeNull();
    await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('combobox', { name: 'Capture to Inbox' })).toBeVisible();
    expect(t.close).not.toHaveBeenCalled();
    expect((await live(t)).filter((b) => b.task_id === 't2')).toEqual([]);
    await userEvent.click(screen.getByRole('option', { name: /^Plan the offsite/ }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Schedule both at the same time?' })).getByRole('button', { name: 'Keep both' }));
    await waitFor(async () => expect((await live(t)).filter((b) => b.task_id === 't2')).toMatchObject([{ start: at('17:45'), end: at('19:45') }]));
    expect(t.close).toHaveBeenCalledOnce();
    expect(await getRecord(t.db, 'time_block', 'b3')).toMatchObject({ start: at('19:00') });
  });

  it('a set day’s session waiting for another day is placed here as that day’s, for this week only', async () => {
    const t = await open();
    await userEvent.click(screen.getByRole('option', { name: /^Stretching/ }));
    expect(await screen.findByText(/^Placed Stretching, .*5:45pm$/)).toBeVisible();
    expect(await getRecord(t.db, 'time_block', 'session:stretch:2026-11-05')).toMatchObject({ start: at('17:45'), end: at('18:05') });
  });

  it('a practice that already has its session that day can’t be picked', async () => {
    const t = await open();
    const climbing = screen.getByRole('option', { name: /^Climbing/ });
    expect(climbing).toHaveAttribute('aria-disabled', 'true');
    await act(async () => climbing.click());
    expect(t.close).not.toHaveBeenCalled();
    expect((await live(t)).filter((b) => b.practice_id === 'climb')).toHaveLength(1);
  });
});
