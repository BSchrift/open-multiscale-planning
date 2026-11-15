// A task's popup opens from every place the task shows, by its name. Where a tap on a row or card already does
// something, that stays, and the name in what it opens is the way in. A task's block on a calendar opens it directly,
// with the block's own section at its top.

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { localToInstant } from '../../../core/dates';
import { setWeekPick, weekPlanId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderScreen } from '../../app/testing';

afterEach(cleanup);

// Monday, Nov 2 in Chicago, at 2pm.
const ZONE = 'America/Chicago';
const DAY = '2026-11-02';
const at = (hour: number) => localToInstant(DAY, hour * 60, ZONE);

async function day(w: Writer) {
  await w.create('week_plan', { week_start: DAY, finished_at: at(8) }, weekPlanId(DAY));
  await w.create('project', { title: 'Report', state: 'active', start: '2026-10-01', end: '2026-12-15' }, 'p1');
  await w.create('milestone', { project_id: 'p1', title: 'Drafts', due: '2026-11-20' }, 'm1');
  await w.create('task', { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Draft the summary', estimate_min: 120, notes: 'Use **it**' }, 't1');
  await w.create('time_block', { task_id: 't1', start: at(16), end: at(17), tz: ZONE }, 'b1');
  await w.create('task', { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Check the totals', estimate_min: 60 }, 't2');
  await setWeekPick(w, DAY, 't2', 60);
  await w.create('task', { kind: 'one_off', title: 'Return the drill', schedule: { type: 'once' } }, 'o1');
  await w.create('task', { kind: 'one_off', title: 'Paint the fence', schedule: { type: 'once' }, done_at: '2026-10-28T15:00:00Z' }, 'o2');
  await w.create('task_completion', { task_id: 'o2', done_at: '2026-10-28T15:00:00Z', previous_next: null }, 'o2-done');
}

/** The popup for a task, over whatever it opened from, which may be a sheet of the same name. */
async function popup(title: string) {
  await waitFor(() => expect(document.querySelector(`.sheet.taskpop[aria-label="${title}"]`)).not.toBeNull());
  const element = document.querySelector<HTMLElement>(`.sheet.taskpop[aria-label="${title}"]`)!;
  await waitFor(() => expect(within(element).getByRole('heading', { name: title })).toHaveFocus());
  return element;
}

/** Closes the popup with Esc, and checks focus went back to what opened it. */
async function closeBackTo(opener: HTMLElement) {
  await userEvent.keyboard('{Escape}');
  expect(document.querySelector('.sheet.taskpop')).toBeNull();
  expect(opener).toHaveFocus();
}

const open = (area: 'today' | 'week' | 'oneoffs', layout: 'desktop' | 'phone' = 'desktop') => renderScreen(area, { now: at(14), zone: ZONE, layout, seed: day });

describe('the task popup opens from', () => {
  it('a one off’s row', async () => {
    await open('oneoffs');
    const name = await screen.findByRole('button', { name: 'Return the drill' });
    await userEvent.click(name);
    await popup('Return the drill');
    await closeBackTo(name);
  });

  it('Finished tasks', async () => {
    await open('oneoffs');
    await userEvent.click(await screen.findByRole('button', { name: 'Finished tasks' }));
    const name = await within(screen.getByRole('region', { name: 'Finished tasks' })).findByRole('button', { name: 'Paint the fence' });
    await userEvent.click(name);
    await popup('Paint the fence');
    await closeBackTo(name);
  });

  for (const layout of ['desktop', 'phone'] as const) {
    it(`the Now card (${layout})`, async () => {
      await open('today', layout);
      const now = await screen.findByRole('region', { name: 'Current block' });
      const name = within(now).getByRole('button', { name: 'Draft the summary' });
      await userEvent.click(name);
      const element = await popup('Draft the summary');
      expect(within(element).getByText('it').tagName).toBe('STRONG');
      await closeBackTo(name);
    });
  }

  it('a To schedule card, whose tap still opens its times', async () => {
    await open('today');
    await userEvent.click(await screen.findByRole('button', { name: /^Check the totals, Project, .*to schedule$/ }));
    const panel = screen.getByRole('group', { name: 'Check the totals' });
    expect(within(panel).getByRole('group', { name: /^Suggested times for / })).toBeVisible();
    const name = within(panel).getByRole('button', { name: 'Check the totals' });
    await userEvent.click(name);
    await popup('Check the totals');
    await closeBackTo(name);
  });

  /** The block's section, at the popup's top, with its time and what can be done to it. */
  const blockSection = (element: HTMLElement) => {
    const section = within(element).getByRole('region', { name: 'Time block' });
    expect(within(section).getByText('Mon Nov 2, 4pm to 5pm')).toBeVisible();
    expect(within(section).getByRole('button', { name: 'Start now' })).toBeVisible();
    expect(within(section).getByRole('button', { name: 'Remove from calendar' })).toBeVisible();
    return section;
  };

  for (const layout of ['desktop', 'phone'] as const) {
    it(`a block on Today's timeline, by a tap on the block itself (${layout})`, async () => {
      await open('today', layout);
      // On phone a block still to come is a slider, so VoiceOver's swipes move it.
      const block = await screen.findByRole(layout === 'phone' ? 'slider' : 'button', { name: /^Draft the summary, 4pm to 5pm/ });
      await userEvent.click(block);
      blockSection(await popup('Draft the summary'));
      await closeBackTo(block);
    });

    it(`a block on Week, by a tap on the block itself (${layout})`, async () => {
      await open('week', layout);
      const block = await screen.findByRole('button', { name: layout === 'phone' ? /^Draft the summary, 4pm to 5pm/ : /^Draft the summary/ });
      expect(block).toHaveAttribute('aria-haspopup', 'dialog');
      await userEvent.click(block);
      expect(within(blockSection(await popup('Draft the summary'))).getByRole('button', { name: 'Move' })).toBeVisible();
      await closeBackTo(block);
    });
  }
});
