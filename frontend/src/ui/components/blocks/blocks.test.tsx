import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { localToInstant } from '../../../core/dates';
import { getRecord, weekPlanId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderScreen } from '../../app/testing';

afterEach(cleanup);

// Monday, Nov 2 in Chicago. The harness clock reads 2pm there.
const ZONE = 'America/Chicago';
const DAY = '2026-11-02';
const at = (h: number, m = 0) => localToInstant(DAY, h * 60 + m, ZONE);

const open = (seed: (w: Writer) => Promise<unknown>) =>
  renderScreen('today', {
    now: at(14),
    zone: ZONE,
    seed: async (w) => {
      await w.create('week_plan', { week_start: DAY, finished_at: at(8) }, weekPlanId(DAY));
      await w.create('task', { kind: 'project', project_id: 'p', title: 'Write the report', estimate_min: 180 }, 't1');
      await w.create('task', { kind: 'one_off', title: 'Paint the fence' }, 't2');
      await seed(w);
    },
  });

const block = (w: Writer, id: string, taskId: string, from: number, to: number) =>
  w.create('time_block', { task_id: taskId, start: at(from), end: at(to), tz: ZONE }, id);

/** Two clicks before the first one's save is back, as a double click is. */
const doubleClick = (button: HTMLElement) => {
  fireEvent.click(button);
  fireEvent.click(button);
};

// A second press while the first is saving would do it again: Do next block instead would swap the blocks back.
describe('a block action pressed twice runs once', () => {
  it('in Have you started?', async () => {
    const t = await open(async (w) => {
      await w.create('time_block', { task_id: 't1', start: at(13, 50), end: at(15), tz: ZONE }, 'b1');
      await block(w, 'b2', 't2', 16, 17);
    });
    const prompt = await screen.findByRole('dialog', { name: 'Have you started?' });
    doubleClick(within(prompt).getByRole('button', { name: 'Do next block instead' }));
    for (const name of ['Yes, started', 'Do next block instead', 'Skip, choose a new time later']) {
      expect(within(prompt).getByRole('button', { name })).toBeDisabled();
    }
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await getRecord(t.db, 'time_block', 'b1'))?.task_id).toBe('t2');
  });

  it("in the end-of-block prompt's Still going", async () => {
    const t = await open((w) => block(w, 'b1', 't1', 12, 13));
    const prompt = await screen.findByRole('dialog', { name: 'Block finished' });
    doubleClick(within(prompt).getByRole('button', { name: 'Still going, add 30m' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await getRecord(t.db, 'time_block', 'b1'))?.end).toBe(at(13, 30));
  });

  it('on the Now card', async () => {
    const t = await open(async (w) => {
      await block(w, 'b1', 't1', 13, 15);
      await block(w, 'b2', 't2', 16, 17);
    });
    const now = await screen.findByRole('region', { name: 'Current block' });
    doubleClick(await within(now).findByRole('button', { name: 'Do next block instead' }));
    expect(within(now).getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(await within(now).findByRole('heading', { name: 'Paint the fence' })).toBeVisible();
    expect((await getRecord(t.db, 'time_block', 'b1'))?.task_id).toBe('t2');
  });
});
