import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listRecords } from '../../core/records';
import type { Writer } from '../../core/records';
import type { AppSync } from '../../core/syncRunner';
import type { Fields } from '../../core/types';
import { renderApp } from './testing';

afterEach(cleanup);

// Friday Nov 27, 2026, noon in Chicago: next week's planning has appeared, and today's 7am has passed.
const FRIDAY_NOON = '2026-11-27T18:00:00Z';
const run: Fields<'practice'> = { title: 'Morning run', target_min: 30, per: 'day', days: [0, 1, 2, 3, 4], preferred_times: [7 * 60], state: 'active' };
const seed = (w: Writer) => w.create('practice', run, 'run');
const live = async (t: { db: Parameters<typeof listRecords>[0] }) => (await listRecords(t.db, 'time_block')).filter((b) => !b.cancelled);

describe('practices at their set times', () => {
  it('are placed on opening, said once with Undo, and Undo takes them off', async () => {
    const t = await renderApp({ now: FRIDAY_NOON, seed });
    expect(await screen.findByText('Placed 5 practice sessions at their set times next week.')).toBeVisible();
    expect((await live(t)).map((b) => b.id).sort()).toEqual([
      'session:run:2026-11-30',
      'session:run:2026-12-01',
      'session:run:2026-12-02',
      'session:run:2026-12-03',
      'session:run:2026-12-04',
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await live(t)).toEqual([]));
  });

  it('wait for the sync under way, and leave alone what another device placed', async () => {
    let release = () => {};
    const settled = new Promise<void>((resolve) => (release = resolve));
    const sync = { settled: vi.fn(() => settled), syncNow: vi.fn(async () => {}) } as unknown as AppSync;
    const t = await renderApp({ now: FRIDAY_NOON, seed, sync });
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 50)));
    expect(await live(t)).toEqual([]);
    // What another device placed arrives by that sync, so this one places nothing and says nothing.
    await t.write((w) => w.create('time_block', { practice_id: 'run', start: '2026-11-30T13:00:00Z', end: '2026-11-30T13:30:00Z', tz: 'America/Chicago' }, 'session:run:2026-11-30'));
    act(() => release());
    expect(await screen.findByText('Placed 4 practice sessions at their set times next week.')).toBeVisible();
    expect(await live(t)).toHaveLength(5);
  });

  it('are placed again on coming back to the foreground, for what changed meanwhile', async () => {
    const t = await renderApp({ now: FRIDAY_NOON });
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 50)));
    await t.write(seed);
    act(() => t.platform.lifecycle.foreground());
    expect(await screen.findByText('Placed 5 practice sessions at their set times next week.')).toBeVisible();
  });
});
