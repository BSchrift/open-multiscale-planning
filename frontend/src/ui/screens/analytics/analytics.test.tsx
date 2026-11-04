import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { localToInstant } from '../../../core/dates';
import { getRecord, getSettings, outcomeId, updateSettings } from '../../../core/records';
import type { Writer } from '../../../core/records';
import type { BlockResult } from '../../../core/types';
import { renderScreen } from '../../app/testing';
import { moreLine } from './moreLine';

afterEach(cleanup);

const ZONE = 'America/Chicago';
const NOW = '2026-11-06T18:00:00Z'; // Friday noon, in the week of Monday Nov 2.

async function base(w: Writer) {
  await w.create('objective', { title: 'Learn to bake bread', state: 'active', order: 1 }, 'g1');
  await w.create('project', { objective_id: 'g1', title: 'Sourdough', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p1');
  await w.create('task', { kind: 'project', project_id: 'p1', title: 'Feed the starter' }, 't1');
  await w.create('task', { kind: 'one_off', title: 'Clean the windows' }, 'o1');
}

async function block(w: Writer, owner: { task?: string; practice?: string }, date: string, at: number, mins: number, result?: BlockResult, logged?: number) {
  const id = await w.create('time_block', {
    task_id: owner.task ?? null,
    practice_id: owner.practice ?? null,
    start: localToInstant(date, at, ZONE),
    end: localToInstant(date, at + mins, ZONE),
    tz: ZONE,
  });
  if (result) await w.create('block_outcome', { result, answered_at: NOW, ...(logged ? { logged_min: logged } : {}) }, outcomeId(id));
  return id;
}

/** A week with two answered project blocks, one unanswered, and a done one off. */
async function thisWeek(w: Writer) {
  await base(w);
  await block(w, { task: 't1' }, '2026-11-02', 540, 60, 'done');
  await block(w, { task: 't1' }, '2026-11-03', 540, 60, 'not');
  await block(w, { task: 'o1' }, '2026-11-04', 540, 60, 'done');
  await block(w, { task: 't1' }, '2026-11-05', 540, 60);
}

const open = (layout: 'desktop' | 'phone', seed: (w: Writer) => Promise<unknown>, params = {}) =>
  renderScreen('analytics', { layout, now: NOW, zone: ZONE, seed, params });

describe('analytics on desktop, week view', () => {
  it('shows this week so far: time by goal, reliability and unanswered blocks', async () => {
    await open('desktop', thisWeek);
    expect(await screen.findByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText('Nov 2 to Nov 8')).toBeVisible();
    expect(screen.getByText('This week, so far')).toBeVisible();
    expect(screen.getByText('2h delivered of 4h planned, with the week still in progress.')).toBeVisible();
    expect(screen.getByTitle('Learn to bake bread: 1h delivered of 3h planned')).toHaveTextContent('1h of 3h');
    expect(screen.getByTitle('One offs: 1h delivered of 1h planned')).toHaveClass('mnt');
    expect(screen.getByRole('img', { name: 'Project tasks: 1 done, 0 partly, 1 not done' })).toBeVisible();
    expect(screen.getByRole('img', { name: 'One offs: 1 done, 0 partly, 0 not done' })).toBeVisible();
    expect(screen.getByText('50%')).toBeVisible();
    expect(screen.getByText('50%').nextSibling).toHaveTextContent('of 2 blocks');
    expect(screen.getByText('100%').nextSibling).toHaveTextContent('of 1 block');
    expect(screen.getByText('100%').nextSibling).not.toHaveTextContent('blocks');
    expect(screen.getByText("1 block went unanswered and isn't included. Moving a block before it starts doesn't count.")).toBeVisible();
    expect(screen.getByRole('button', { name: 'Next week' })).toBeDisabled();
    expect(screen.queryByText('Patterns')).toBeNull();
  });

  it('moves between weeks within the trend, and opens on a week it is given', async () => {
    await open('desktop', thisWeek);
    await userEvent.click(await screen.findByRole('button', { name: 'Previous week' }));
    expect(await screen.findByText('Oct 26 to Nov 1')).toBeVisible();
    expect(screen.getByText('Past week')).toBeVisible();
    expect(screen.getByText('0m delivered of 0m planned.')).toBeVisible();
    for (let i = 0; i < 6; i++) await userEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(await screen.findByText('Sep 14 to Sep 20')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Previous week' })).toBeDisabled();
    cleanup();

    await open('desktop', thisWeek, { week: '2026-10-26' });
    expect(await screen.findByText('Oct 26 to Nov 1')).toBeVisible();
  });

  it('draws eight weeks on one scale, marking the selected week, with the change against the prior week', async () => {
    await open('desktop', async (w) => {
      await thisWeek(w);
      await block(w, { task: 't1' }, '2026-10-27', 540, 30, 'done');
    });
    const all = await screen.findByRole('img', { name: /^All time: Sep 14 0m, .*Oct 26 30m, Nov 2 2h$/ });
    expect(all.querySelectorAll('.tb.on')).toHaveLength(1);
    expect(all).toHaveTextContent('+1h 30m vs prior week');
    expect(screen.getByText('Each bar is one week, on the same scale. The selected week is darker.')).toBeVisible();
    expect(screen.getByRole('img', { name: /^One offs: Sep 14/ })).toHaveClass('mnt');
  });

  it('shows practice time against its target, in teal', async () => {
    await open('desktop', async (w) => {
      await base(w);
      await w.create('practice', { objective_id: 'g1', title: 'Knead dough', target_min: 70, per: 'week', state: 'active' }, 'pr1');
      await block(w, { practice: 'pr1' }, '2026-11-03', 420, 60, 'done');
    });
    const row = await screen.findByTitle('Knead dough: 1h of 1h 10m target');
    expect(row).toHaveTextContent('1h of 1h 10m');
    expect(row).toHaveClass('prac');
  });
});

describe('analytics, stretch view', () => {
  it('reads the current stretch, with milestones met on time and estimate drift', async () => {
    await open('desktop', async (w) => {
      await thisWeek(w);
      await w.create('milestone', { project_id: 'p1', title: 'Starter is alive', due: '2026-10-20', met_at: '2026-10-19T15:00:00Z' });
      await w.create('task', { kind: 'project', project_id: 'p1', title: 'Bake a loaf', estimate_min: 60, done_at: '2026-10-21T15:00:00Z' }, 't2');
      await block(w, { task: 't2' }, '2026-10-21', 540, 90, 'done');
    });
    await userEvent.click(await screen.findByRole('button', { name: 'This stretch' }));
    expect(await screen.findByText('This stretch, Oct 1 to Dec 31')).toBeVisible();
    expect(screen.getByRole('button', { name: 'This stretch' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Previous week' })).toBeNull();
    expect(screen.getByText('Each bar is one week, on the same scale. Weeks in this plan are darker.')).toBeVisible();
    expect(screen.getByRole('img', { name: /^All time: / })).toHaveTextContent('this plan so far');
    expect(screen.getByText('Milestones met on their original date').previousSibling).toHaveTextContent('1 of 1');
    expect(screen.getByText('Actual time compared with estimates').previousSibling).toHaveTextContent('+50%');
  });

  it('reads the last 8 weeks with no planning cadence', async () => {
    await open('desktop', async (w) => {
      await thisWeek(w);
      await updateSettings(w, { plan_cadence: null });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Last 8 weeks' }));
    expect(await screen.findByText('Each bar is one week, on the same scale. All 8 weeks count.')).toBeVisible();
    expect(screen.getByRole('img', { name: /^All time: / })).toHaveTextContent('last 8 weeks');
  });

  it('stops suggesting a time that rarely holds, and suggests it again', async () => {
    const t = await open('desktop', async (w) => {
      await base(w);
      for (const day of ['2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27', '2026-11-03']) await block(w, { task: 't1' }, day, 1080, 60, 'not');
    });
    await userEvent.click(await screen.findByRole('button', { name: 'This stretch' }));
    expect(await screen.findByText('Tuesday evenings rarely hold: 0 of the last 5 blocks were done.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Stop suggesting them' }));
    expect(await screen.findByText('Tuesday evenings are no longer suggested.')).toBeVisible();
    expect((await getSettings(t.db)).avoided_slots).toEqual([{ day: 1, from: 1020, to: 1440 }]);
    await userEvent.click(screen.getByRole('button', { name: 'Suggest them again' }));
    await waitFor(async () => expect((await getSettings(t.db)).avoided_slots).toEqual([]));
    expect(await screen.findByRole('button', { name: 'Stop suggesting them' })).toBeVisible();
  });

  it('raises estimates on open tasks, with Undo', async () => {
    const t = await open('desktop', async (w) => {
      await base(w);
      for (let i = 0; i < 5; i++) {
        const id = await w.create('task', { kind: 'project', project_id: 'p1', title: `Step ${i}`, estimate_min: 60, done_at: '2026-10-21T15:00:00Z' });
        await block(w, { task: id }, '2026-10-21', 540 + i * 100, 90, 'done');
      }
      await w.create('task', { kind: 'project', project_id: 'p1', title: 'Shape the loaf', estimate_min: 60 }, 'open');
    });
    await userEvent.click(await screen.findByRole('button', { name: 'This stretch' }));
    expect(await screen.findByText('Sourdough tasks take about 50% longer than you estimate.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Raise estimates' }));
    expect(await screen.findByText('Sourdough tasks now start with longer estimates.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Raise estimates' })).toBeNull();
    expect((await getRecord(t.db, 'task', 'open'))?.estimate_min).toBe(90);
    // Remembered on the project, so the offer doesn't come back for the same finished work.
    expect((await getRecord(t.db, 'project', 'p1'))?.estimates_raised_at).toBe(NOW);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 'open'))?.estimate_min).toBe(60));
    await waitFor(async () => expect((await getRecord(t.db, 'project', 'p1'))?.estimates_raised_at ?? null).toBeNull());
    expect(await screen.findByRole('button', { name: 'Raise estimates' })).toBeVisible();
  });
});

describe('analytics on phone', () => {
  it('keeps One offs purple, labels every part, and draws no part at zero', async () => {
    const { container } = await open('phone', async (w) => {
      await base(w);
      await block(w, { task: 'o1' }, '2026-11-02', 540, 60, 'done');
      await block(w, { task: 'o1' }, '2026-11-03', 540, 60, 'done');
    });
    const oneOffs = await screen.findByRole('img', { name: 'One offs: 2 done, 0 partly, 0 not done' });
    expect(oneOffs.querySelectorAll('span')).toHaveLength(1);
    const row = oneOffs.closest('.amaint') as HTMLElement;
    expect(within(row).getByText('2 done')).toBeVisible();
    expect(within(row).getByText('0 partly')).toBeVisible();
    expect(within(row).getByText('0 not done')).toBeVisible();
    expect(screen.getByRole('img', { name: 'One offs: 2h delivered of 2h planned' })).toHaveClass('amaint');
    expect(container.querySelector('.hbar, .trow, table')).toBeNull();
    expect(screen.getByRole('button', { name: 'Previous week' })).toHaveTextContent('‹');
    expect(screen.getByText('Each bar is one week, on the same scale. The selected week is darker, with its date in bold.')).toBeVisible();
  });

  it("shows each week's numbers on request", async () => {
    const { container } = await open('phone', thisWeek);
    const toggle = await screen.findByRole('button', { name: "Show each week's numbers" });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.tnums')).toBeNull();
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: "Hide each week's numbers" })).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.tnums')?.lastElementChild).toHaveTextContent('2h');
  });
});

describe('the More line', () => {
  it('reads reliability and time this week, or nothing with no blocks', async () => {
    const t = await open('phone', thisWeek);
    expect(await moreLine(t.db, t.clock)).toBe('50% reliable this week, 2h of 4h so far');
    cleanup();
    const empty = await open('phone', base);
    expect(await moreLine(empty.db, empty.clock)).toBeNull();
  });
});
