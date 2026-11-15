import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addToBacklog } from '../../../core/backlog';
import { fixedClock } from '../../../core/clock';
import { getRecord, updateSettings } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderScreen } from '../../app/testing';
import { writeFlow } from './flowState';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// The harness clock is Monday Nov 2, 2026, 2pm in Chicago.
async function seed(w: Writer) {
  await updateSettings(w, { plan_stretch: { last_planned: '2026-10-01' } });
  await w.create('objective', { title: 'Learn to bake bread', state: 'active' }, 'g1');
  await w.create('objective', { title: 'Run a 10k', state: 'active' }, 'g2');
  await w.create('project', { objective_id: 'g1', title: 'Rye bread', state: 'active', start: '2026-10-01', end: '2027-06-30' }, 'p1');
  await w.create('task', { kind: 'project', project_id: 'p1', title: 'Feed the starter', estimate_min: 60 }, 't1');
  await addToBacklog(w, 'g1', { title: 'Ask Sam for his focaccia recipe', estimate_min: 20 }, fixedClock('2026-04-02T12:00:00Z'));
  await addToBacklog(w, 'g1', { title: 'Watch a shaping video', estimate_min: 60 }, fixedClock('2026-10-20T12:00:00Z'));
  // The first was filed in April and not touched since.
  const april = `${Date.parse('2026-04-02T12:00:00Z')}-000000-other`;
  const [ask] = await w.sql.all<{ id: string; clocks: string }>("SELECT r.id, r.clocks FROM records r JOIN task t ON t.id = r.id WHERE t.title LIKE 'Ask Sam%'");
  const clocks = Object.fromEntries(Object.keys(JSON.parse(ask!.clocks) as object).map((f) => [f, april]));
  await w.sql.run('UPDATE records SET clocks = :clocks WHERE id = :id', { clocks: JSON.stringify(clocks), id: ask!.id });
}

const goals = async (layout: 'desktop' | 'phone') => {
  writeFlow({ begun: true, step: 0, stepKey: 'goals' });
  const t = await renderScreen('plan', { layout, seed, presentation: 'flow', close: vi.fn() });
  return t;
};
const idOf = async (t: Awaited<ReturnType<typeof goals>>, title: string) =>
  (await t.db.get<{ id: string }>('SELECT id FROM task WHERE title = :title', { title }))!.id;

describe.each(['desktop', 'phone'] as const)('The stretch Goals step with a goal backlog, on %s', (layout) => {
  it("shows the backlog as a block after the goal's projects, and its preview asks Keep or Delete of untouched tasks first", { timeout: 15000 }, async () => {
    const t = await goals(layout);
    const card = await screen.findByRole('region', { name: 'Learn to bake bread' }, { timeout: 5000 });
    const block = within(card).getByRole('button', { name: 'Open the backlog for Learn to bake bread' });
    expect(block).toHaveAccessibleDescription('2 tasks, 1h 20m, 1 untouched since Apr 2');
    expect(within(card).getByRole('button', { name: 'Open project Rye bread' }).compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A goal whose backlog is empty shows no block.
    expect(within(screen.getByRole('region', { name: 'Run a 10k' })).queryByRole('button', { name: /backlog/ })).toBeNull();

    await userEvent.click(block);
    const sheet = await screen.findByRole('dialog', { name: 'The backlog for Learn to bake bread' });
    const untouched = within(sheet).getByRole('group', { name: 'Untouched since Apr 2' });
    expect(within(untouched).getByText('Ask Sam for his focaccia recipe')).toBeVisible();
    expect(within(sheet).getByText('Watch a shaping video')).toBeVisible();

    const ask = await idOf(t, 'Ask Sam for his focaccia recipe');
    await userEvent.click(within(untouched).getByRole('button', { name: 'Keep Ask Sam for his focaccia recipe' }));
    expect((await screen.findAllByText('Kept Ask Sam for his focaccia recipe.')).length).toBeGreaterThan(0);
    await waitFor(async () => expect((await getRecord(t.db, 'task', ask))?.kept_at).toBeTruthy());
    // Kept, it's touched again, so it leaves the untouched group.
    await waitFor(() => expect(within(sheet).queryByRole('group', { name: /Untouched/ })).toBeNull());
  });

  it('deletes an untouched task with Undo', { timeout: 15000 }, async () => {
    const t = await goals(layout);
    const card = await screen.findByRole('region', { name: 'Learn to bake bread' }, { timeout: 5000 });
    await userEvent.click(within(card).getByRole('button', { name: 'Open the backlog for Learn to bake bread' }));
    const sheet = await screen.findByRole('dialog', { name: 'The backlog for Learn to bake bread' });
    const ask = await idOf(t, 'Ask Sam for his focaccia recipe');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Delete Ask Sam for his focaccia recipe' }));
    expect((await screen.findAllByText('Deleted Ask Sam for his focaccia recipe.')).length).toBeGreaterThan(0);
    await waitFor(async () => expect((await getRecord(t.db, 'task', ask))?.deleted_at).toBeTruthy());
    await userEvent.click(await screen.findByRole('button', { name: 'Undo: Deleted Ask Sam for his focaccia recipe.' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', ask))?.deleted_at).toBeNull());
  });
});
