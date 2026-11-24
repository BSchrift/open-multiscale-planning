import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAnalyticsData, weekAnalytics } from '../../../core/analytics';
import { instantMs, localToInstant } from '../../../core/dates';
import { getRecord, listRecords, outcomeId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import type { BlockResult } from '../../../core/types';
import type { Layout } from '../../app/registry';
import { renderScreen } from '../../app/testing';
import { EST_STEPS } from '../../components/EstimateSlider';

afterEach(cleanup);

// Thursday, Nov 12, at 5:40pm in Chicago: the mockups' sample day.
const ZONE = 'America/Chicago';
const NOW = '2026-11-12T23:40:00Z';
const THU = '2026-11-12';
const WED = '2026-11-11';
const at = (time: string, date = THU) => {
  const [h, m] = time.split(':').map(Number);
  return localToInstant(date, h! * 60 + m!, ZONE);
};

const block = (w: Writer, id: string, owner: Record<string, string>, from: string, to: string, date = THU) =>
  w.create('time_block', { ...owner, start: at(from, date), end: at(to, date), tz: ZONE }, id);
const answer = (w: Writer, id: string, result: BlockResult, extra: Record<string, unknown> = {}) =>
  w.create('block_outcome', { result, answered_at: NOW, ...extra }, outcomeId(id));

async function sample(w: Writer) {
  const project = (id: string, title: string) => w.create('project', { title, state: 'active', start: '2026-10-01', end: '2026-12-31' }, id);
  await project('p1', 'Write the report');
  await project('p2', 'Website refresh');
  await w.create('milestone', { project_id: 'p1', title: 'Draft chapters' }, 'm1');
  await w.create('practice', { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' }, 'pr');
  await block(w, 'piano', { practice_id: 'pr' }, '08:30', '09:00');
  await answer(w, 'piano', 'done', { logged_min: 30 });
  await w.create('task', { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Draft the summary', done_at: at('10:30') }, 'summary');
  await block(w, 'b-summary', { task_id: 'summary' }, '09:00', '10:30');
  await answer(w, 'b-summary', 'done');
  await w.create('task', { kind: 'project', project_id: 'p1', title: 'Outline chapter 3', estimate_min: 240, remaining_min: 60 }, 'outline');
  await block(w, 'b-outline', { task_id: 'outline' }, '11:00', '12:30');
  await answer(w, 'b-outline', 'partly', { remaining_min: 60 });
  await w.create('task', { kind: 'one_off', title: 'Pay the water bill', done_at: at('13:30') }, 'water');
  await w.create('task_completion', { task_id: 'water', done_at: at('13:30') }, 'c-water');
  await block(w, 'b-water', { task_id: 'water' }, '13:00', '13:30');
  await answer(w, 'b-water', 'done');
  await w.create('task', { kind: 'planning', title: 'Plan next week', done_at: at('14:30') }, 'plan');
  await block(w, 'b-plan', { task_id: 'plan' }, '14:00', '14:30');
  await answer(w, 'b-plan', 'done');
  await w.create('task', { kind: 'project', project_id: 'p2', title: 'Fix the login redirect', estimate_min: 60 }, 'login');
  await block(w, 'b-login', { task_id: 'login' }, '15:30', '16:30');
  const weekly = { type: 'recurring', every: 1, unit: 'week', anchor: '2026-10-08' } as const;
  await w.create('task', { kind: 'one_off', title: 'Water the plants', schedule: weekly, next_due: '2026-11-19' }, 'plants');
  await w.create('task_completion', { task_id: 'plants', done_at: at('16:52') }, 'c-plants');
  // Wednesday: a one off finished and deleted since.
  await w.create('task', { kind: 'one_off', title: 'Email the landlord', done_at: at('18:10', WED), deleted_at: at('09:00') }, 'landlord');
  await w.create('task_completion', { task_id: 'landlord', done_at: at('18:10', WED) }, 'c-landlord');
}

const open = (layout: Layout = 'desktop', params: Record<string, string> = {}) => renderScreen('done', { now: NOW, zone: ZONE, layout, params, seed: sample });
const section = (name: string) => screen.getByRole('region', { name });
const rows = (name: string) => within(section(name)).getAllByRole('listitem').map((li) => li.textContent);

describe('Done', () => {
  it('opens on today: its totals, what was finished with its blocks under it, time worked, and what is not marked yet', async () => {
    await open();
    expect(await screen.findByRole('heading', { name: 'Thursday, Nov 12', level: 1 })).toBeVisible();
    expect(screen.getByText('4 finished')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Totals' })).toHaveTextContent('4 finished · 4h 30m worked');
    expect(screen.getByRole('img', { name: '3h projects, 30m practices, 30m one offs, 30m planning' })).toBeVisible();
    expect(rows('Finished')).toEqual([
      '10:30amDraft the summaryWrite the report, Draft chapters9am to 10:30am · 1h 30m',
      '10:30amDraft chaptersMilestone reached, Write the report',
      '1:30pmPay the water billOne off1pm to 1:30pm · 30m',
      '4:52pmWater the plantsOne off',
    ]);
    expect(rows('Time worked')).toEqual([
      '8:30amPiano practicePractice, 8:30am to 9am30m',
      '11amOutline chapter 3Write the report, 11am to 12:30pm1h 30m1h left',
      '2pmPlan next weekPlanning, 2pm to 2:30pm30m',
    ]);
    expect(rows('Not marked yet')).toEqual(['3:30pmFix the login redirectWebsite refresh, 3:30pm to 4:30pmMark how it went']);
    expect(screen.getByRole('button', { name: 'Mark how Fix the login redirect went' })).toBeVisible();
    // Today is as far as it goes.
    expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Today' })).toBeNull();
  });

  it('on phone, keeps its lines short, as the mockups draw them', async () => {
    await open('phone');
    expect(await screen.findByRole('heading', { name: 'Thursday, Nov 12', level: 2 })).toBeVisible();
    expect(rows('Time worked')[0]).toBe('8:30amPiano practicePractice30m');
    expect(rows('Not marked yet')).toEqual(['3:30pmFix the login redirectWebsite refresh, until 4:30pmMark how it went']);
  });

  it('steps a day at a time, with Today to come back, and opens a day with nothing finished', async () => {
    await open();
    await screen.findByRole('heading', { name: 'Thursday, Nov 12' });
    await userEvent.click(screen.getByRole('button', { name: 'Previous day' }));
    expect(await screen.findByRole('heading', { name: 'Wednesday, Nov 11' })).toBeVisible();
    expect(rows('Finished')).toEqual(['6:10pmEmail the landlorddeletedOne off']);
    expect(screen.getByRole('button', { name: 'Next day' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Previous day' }));
    expect(await screen.findByRole('heading', { name: 'Tuesday, Nov 10' })).toBeVisible();
    expect(screen.getByText('Nothing finished on Tuesday')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Finished' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(await screen.findByRole('heading', { name: 'Thursday, Nov 12' })).toBeVisible();
  });

  it('opens on the day it was sent to', async () => {
    await open('desktop', { day: WED });
    expect(await screen.findByRole('heading', { name: 'Wednesday, Nov 11' })).toBeVisible();
    expect(screen.getByText('deleted')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Today' })).toBeVisible();
  });

  it('says so when nothing is finished yet today, and still shows the time worked', async () => {
    await renderScreen('done', {
      now: NOW,
      zone: ZONE,
      seed: async (w) => {
        await w.create('task', { kind: 'project', title: 'Outline chapter 3' }, 'outline');
        await block(w, 'b', { task_id: 'outline' }, '11:00', '12:00');
        await answer(w, 'b', 'partly', { remaining_min: 30 });
      },
    });
    expect(await screen.findByText('Nothing finished yet today')).toBeVisible();
    expect(rows('Time worked')).toEqual(['11amOutline chapter 3Project, 11am to 12pm1h30m left']);
  });

  it('Mark how it went asks the end-of-block question, and Done moves the block into the list, with Undo', async () => {
    const t = await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Mark how Fix the login redirect went' }));
    const dialog = await screen.findByRole('dialog', { name: '1 missed block' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done: Fix the login redirect' }));
    expect(await screen.findByText('Fix the login redirect: finished.')).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(rows('Finished')).toContain('4:30pmFix the login redirectWebsite refresh3:30pm to 4:30pm · 1h');
    expect(screen.queryByRole('region', { name: 'Not marked yet' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Totals' })).toHaveTextContent('5 finished · 5h 30m worked');
    // Focus follows the row it moved.
    await waitFor(() => expect(document.activeElement?.textContent).toMatch(/^4:30pmFix the login redirect/));
    expect((await getRecord(t.db, 'task', 'login'))?.done_at).toBe(at('16:30'));

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: 'Mark how Fix the login redirect went' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Totals' })).toHaveTextContent('4 finished · 4h 30m worked');
    expect((await getRecord(t.db, 'task', 'login'))?.done_at).toBeFalsy();
  });

  it('Not done takes the block off the list, and Later leaves it waiting', async () => {
    await open('phone');
    await userEvent.click(await screen.findByRole('button', { name: 'Mark how Fix the login redirect went' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: '1 missed block' })).getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Mark how Fix the login redirect went' })).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Mark how Fix the login redirect went' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: '1 missed block' })).getByRole('button', { name: 'Not done: Fix the login redirect' }));
    expect(await screen.findByText("Fix the login redirect: not done. It's in Needs a new time.")).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Not marked yet' })).toBeNull());
    expect(screen.getByRole('region', { name: 'Totals' })).toHaveTextContent('4 finished · 4h 30m worked');
  });

  it('opens a task from its name', async () => {
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Draft the summary' }));
    expect(await screen.findByRole('dialog', { name: /Draft the summary/ })).toBeVisible();
  });

  describe('Add something you did', () => {
    const field = () => screen.getByRole('textbox', { name: 'What you did' });
    const added = async (db: Parameters<typeof listRecords>[0], title: string) => (await listRecords(db, 'task')).find((x) => x.title === title);

    it('adds a one off finished now to today with Enter, and the toast’s Undo takes it away', async () => {
      const t = await open();
      await userEvent.click(await screen.findByRole('button', { name: 'Add something you did' }));
      expect(field()).toHaveFocus();
      await userEvent.type(field(), 'Called the plumber{Enter}');
      expect(await screen.findByText('Added Called the plumber to Done on Thursday, Nov 12.')).toBeVisible();
      await waitFor(() => expect(rows('Finished').at(-1)).toBe('5:40pmCalled the plumberOne off'));
      expect(section('Totals')).toHaveTextContent('5 finished · 4h 30m worked');
      // An ordinary finished one off, as any app shows one, with its finish logged as a tick logs it.
      const task = (await added(t.db, 'Called the plumber'))!;
      expect(task).toMatchObject({ kind: 'one_off', project_id: null, estimate_min: null });
      expect(instantMs(task.done_at!)).toBe(Date.parse(NOW));
      expect((await listRecords(t.db, 'task_completion')).filter((c) => c.task_id === task.id)).toHaveLength(1);
      // The field has gone, and focus is back where it opens, for the next one.
      expect(screen.queryByRole('textbox', { name: 'What you did' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Add something you did' })).toHaveFocus();

      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await waitFor(() => expect(rows('Finished')).not.toContain('5:40pmCalled the plumberOne off'));
      expect(section('Totals')).toHaveTextContent('4 finished · 4h 30m worked');
      expect((await getRecord(t.db, 'task', task.id))?.deleted_at).toBeTruthy();
    });

    it('on a day gone by, with the time it took: finished at the end of that day, after a block that long answered Done', async () => {
      const t = await open('desktop', { day: WED });
      const oneOffs = async () => weekAnalytics(await loadAnalyticsData(t.db), t.clock, '2026-11-09').time.rows.find((r) => r.name === 'One offs')?.delivered_min;
      const before = await oneOffs();
      await userEvent.click(await screen.findByRole('button', { name: 'Add something you did' }));
      await userEvent.type(field(), 'Fixed the gate');
      fireEvent.change(screen.getByRole('slider', { name: 'Time it took' }), { target: { value: String(EST_STEPS.indexOf(60)) } });
      await userEvent.click(screen.getByRole('button', { name: 'Add' }));
      expect(await screen.findByText('Added Fixed the gate to Done on Wednesday, Nov 11.')).toBeVisible();
      await waitFor(() => expect(rows('Finished')).toEqual(['6:10pmEmail the landlorddeletedOne off', '11:59pmFixed the gateOne off10:59pm to 11:59pm · 1h']));
      expect(section('Totals')).toHaveTextContent('2 finished · 1h worked');
      // Its hour counts in Analytics, as any block's does.
      expect(await oneOffs()).toBe(before! + 60);

      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await waitFor(() => expect(rows('Finished')).toEqual(['6:10pmEmail the landlorddeletedOne off']));
      expect(section('Totals')).toHaveTextContent('1 finished');
      expect(section('Totals')).not.toHaveTextContent('worked');
      expect(await oneOffs()).toBe(before);
    });

    it('on a day with nothing finished, adds the first, and focus comes back to the row as the list appears', async () => {
      await open('desktop', { day: '2026-11-10' });
      expect(await screen.findByText('Nothing finished on Tuesday')).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Add something you did' }));
      await userEvent.type(field(), 'Took the car in{Enter}');
      await waitFor(() => expect(rows('Finished')).toEqual(['11:59pmTook the car inOne off']));
      expect(section('Totals')).toHaveTextContent('1 finished');
      await waitFor(() => expect(screen.getByRole('button', { name: 'Add something you did' })).toHaveFocus());
    });

    it('today, keeps its block within the day when the time it took is longer than the day so far', async () => {
      const t = await open('desktop');
      await userEvent.click(await screen.findByRole('button', { name: 'Add something you did' }));
      await userEvent.type(field(), 'Drove to the coast');
      fireEvent.change(screen.getByRole('slider', { name: 'Time it took' }), { target: { value: String(EST_STEPS.indexOf(960)) } });
      t.clock.set(at('03:00'));
      await userEvent.click(screen.getByRole('button', { name: 'Add' }));
      await waitFor(() => expect(rows('Finished')[0]).toBe('3amDrove to the coastOne off12am to 3am · 16h'));
    });

    it('on phone, Esc puts the field away with nothing added, an empty name adds nothing, and Enter adds', async () => {
      const t = await open('phone');
      await userEvent.click(await screen.findByRole('button', { name: 'Add something you did' }));
      await userEvent.type(field(), 'Booked the dentist{Escape}');
      expect(screen.queryByRole('textbox', { name: 'What you did' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Add something you did' })).toHaveFocus();
      expect(await added(t.db, 'Booked the dentist')).toBeUndefined();

      await userEvent.click(screen.getByRole('button', { name: 'Add something you did' }));
      expect(field()).toHaveValue('');
      await userEvent.type(field(), '   {Enter}');
      expect(field()).toBeVisible();
      expect(rows('Finished')).toHaveLength(4);
      await userEvent.clear(field());
      await userEvent.type(field(), 'Booked the dentist{Enter}');
      expect(await screen.findByText('Added Booked the dentist to Done on Thursday, Nov 12.')).toBeVisible();
      await waitFor(() => expect(rows('Finished').at(-1)).toBe('5:40pmBooked the dentistOne off'));
    });
  });
});
