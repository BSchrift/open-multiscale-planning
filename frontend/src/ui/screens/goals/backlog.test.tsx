import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { addToBacklog } from '../../../core/backlog';
import { fixedClock } from '../../../core/clock';
import { getRecord, listRecords } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderScreen } from '../../app/testing';

afterEach(cleanup);

// The harness clock is Monday Nov 2, 2026, in Chicago.
async function bread(w: Writer) {
  await w.create('objective', { title: 'Learn to bake bread', state: 'active' }, 'g1');
  await w.create('objective', { title: 'Run a 10k', state: 'active' }, 'g2');
  await w.create('project', { objective_id: 'g1', title: 'Rye bread', state: 'active', start: '2026-10-01', end: '2026-12-15' }, 'p1');
  await w.create('task', { kind: 'project', project_id: 'p1', title: 'Feed the starter', estimate_min: 30 }, 't1');
  // Filed in April and May, and not touched since.
  await addToBacklog(w, 'g1', { title: 'Ask Sam for his focaccia recipe', estimate_min: 20 }, fixedClock('2026-04-02T12:00:00Z'));
  await addToBacklog(w, 'g1', { title: 'Watch a shaping video', estimate_min: 60 }, fixedClock('2026-05-02T12:00:00Z'));
  await backdate(w, (await w.sql.all<{ id: string }>("SELECT id FROM task WHERE project_id = 'backlog:g1'")).map((r) => r.id), '2026-04-02T12:00:00Z');
}

/** Writes records' field clocks as of a past time, as if nothing had touched them since. */
async function backdate(w: Writer, ids: readonly string[], at: string) {
  const clock = `${Date.parse(at)}-000000-other`;
  for (const id of ids) {
    const row = await w.sql.get<{ clocks: string }>('SELECT clocks FROM records WHERE id = :id', { id });
    const clocks = Object.fromEntries(Object.keys(JSON.parse(row!.clocks) as object).map((field) => [field, clock]));
    await w.sql.run('UPDATE records SET clocks = :clocks WHERE id = :id', { clocks: JSON.stringify(clocks), id });
  }
}

const backlogTasks = async (t: { db: Parameters<typeof listRecords>[0] }) =>
  (await listRecords(t.db, 'task')).filter((x) => x.project_id === 'backlog:g1' && !x.deleted_at);

describe('A goal backlog on Goals, desktop', () => {
  const open = async (seed = bread) => {
    const t = await renderScreen('goals', { seed });
    await userEvent.click(await screen.findByRole('button', { name: /^Learn to bake bread/ }));
    return t;
  };

  it("is the goal's last row, opens in place in arrival order, and the goal's own add row keeps only projects and practices", async () => {
    await open();
    const row = screen.getByRole('button', { name: 'Backlog, 2 tasks, 1h 20m' });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(row).toHaveFocus();
    const list = screen.getByRole('group', { name: 'Tasks in the backlog for Learn to bake bread' });
    const ticks = within(list).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'));
    expect(ticks).toEqual(['Ask Sam for his focaccia recipe done', 'Watch a shaping video done']);
    expect(screen.getByText("Tasks for this goal that aren't part of a project.")).toBeVisible();
    // Untouched for over six months gets a quiet line, and no buttons.
    expect(screen.getAllByText('Untouched since Apr 2')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^Add task/ }).map((b) => b.getAttribute('aria-label'))).toEqual(['Add task to the backlog for Learn to bake bread']);
    expect(screen.getByRole('button', { name: 'Add project' })).toBeVisible();
  });

  it('counts its tasks on the closed goal, and shows No tasks on a goal with none', async () => {
    await renderScreen('goals', {
      seed: async (w) => {
        await bread(w);
        // A project that needs you shows in place of the counts line, so this goal has a practice instead.
        await w.delete('project', 'p1');
        await w.create('practice', { objective_id: 'g1', title: 'Stretch', target_min: 15, per: 'day', state: 'active', preferred_times: [420] }, 'pr1');
      },
    });
    expect(await screen.findByText('1 practice, 2 tasks in backlog')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /^Run a 10k/ }));
    expect(screen.getByRole('button', { name: 'Backlog, No tasks' })).toBeVisible();
  });

  it('adds a task with no milestone, closing on Add, with Undo, and focus back on Add task', async () => {
    const t = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Backlog, 2 tasks, 1h 20m' }));
    const add = screen.getByRole('button', { name: 'Add task to the backlog for Learn to bake bread' });
    await userEvent.click(add);
    const editor = await screen.findByRole('dialog', { name: 'Add task to the backlog for Learn to bake bread' });
    expect(within(editor).queryByRole('combobox', { name: 'Milestone' })).toBeNull();
    expect(within(editor).getByText('Goes in the backlog for Learn to bake bread.')).toBeVisible();
    await userEvent.type(within(editor).getByRole('textbox', { name: 'Title' }), 'Order rye flour{Enter}');
    expect(await screen.findByText('Added Order rye flour to the backlog for Learn to bake bread.')).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Add task/ })).toBeNull());
    await waitFor(() => expect(add).toHaveFocus());
    const added = (await backlogTasks(t)).find((x) => x.title === 'Order rye flour');
    expect(added).toMatchObject({ kind: 'project', milestone_id: null });
    // Last, as it just arrived.
    expect(screen.getAllByRole('checkbox').at(-1)).toHaveAccessibleName('Order rye flour done');
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', added!.id))?.deleted_at).toBeTruthy());
  });

  it('keeps Add task open when left with a title typed, and says so', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Backlog, 2 tasks, 1h 20m' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add task to the backlog for Learn to bake bread' }));
    const editor = await screen.findByRole('dialog', { name: 'Add task to the backlog for Learn to bake bread' });
    await userEvent.type(within(editor).getByRole('textbox', { name: 'Title' }), 'Order rye flour');
    await userEvent.keyboard('{Escape}');
    expect(await within(editor).findByText("This task isn't added yet. Add it, or Cancel to drop it.")).toBeVisible();
    expect(within(editor).getByRole('button', { name: 'Add' })).toHaveFocus();
    await userEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Add task/ })).toBeNull());
  });

  it('ticks a task done with Undo, focus moving to the next tick', async () => {
    const t = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Backlog, 2 tasks, 1h 20m' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Ask Sam for his focaccia recipe done' }));
    expect(await screen.findByText('Completed Ask Sam for his focaccia recipe.')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Watch a shaping video done' })).toHaveFocus());
    expect((await backlogTasks(t)).find((x) => x.title.startsWith('Ask Sam'))?.done_at).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await backlogTasks(t)).find((x) => x.title.startsWith('Ask Sam'))?.done_at).toBeNull());
  });

  it('moves a task with the arrow keys on its handle, saying where it went, with Undo and focus kept', async () => {
    const t = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Backlog, 2 tasks, 1h 20m' }));
    const handle = screen.getByRole('button', { name: 'Reorder Watch a shaping video, 2 of 2' });
    handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(await screen.findByText('Moved Watch a shaping video to 1 of 2.')).toBeVisible();
    await waitFor(() => expect(screen.getAllByRole('checkbox')[0]).toHaveAccessibleName('Watch a shaping video done'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reorder Watch a shaping video, 1 of 2' })).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getAllByRole('checkbox')[0]).toHaveAccessibleName('Ask Sam for his focaccia recipe done'));
    expect((await backlogTasks(t)).length).toBe(2);
  });

  it("never makes a goal active: one with only a backlog that has gone quiet is still asked about", async () => {
    await renderScreen('goals', {
      seed: async (w) => {
        await w.create('objective', { title: 'Grow vegetables', state: 'active' }, 'g3');
        await addToBacklog(w, 'g3', { title: 'Ask about an allotment' }, fixedClock('2026-04-02T12:00:00Z'));
        await backdate(w, (await w.sql.all<{ id: string }>('SELECT id FROM records')).map((r) => r.id), '2026-04-02T12:00:00Z');
      },
    });
    expect(await screen.findByText('Nothing active. 1 task in backlog. Still a goal?')).toBeVisible();
  });
});

describe('A goal backlog on Goals, phone', () => {
  it('is a row on the goal card that pushes its page, headed by the goal', async () => {
    const t = await renderScreen('goals', { layout: 'phone', seed: bread });
    await userEvent.click(await screen.findByRole('button', { name: /^Learn to bake bread/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Backlog, 2 tasks, 1h 20m' }));
    expect(t.nav().route.params).toEqual({ backlog: 'g1' });
  });

  it('as its own page, takes focus on its heading, which names the goal', async () => {
    await renderScreen('goals', { layout: 'phone', seed: bread, params: { backlog: 'g1' } });
    const heading = await screen.findByRole('heading', { level: 1, name: 'Learn to bake bread Backlog' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole('checkbox', { name: 'Ask Sam for his focaccia recipe done' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add task to the backlog for Learn to bake bread' })).toHaveTextContent('+ Task');
  });

  it("adds from the goal card's + Task, in a sheet", async () => {
    const t = await renderScreen('goals', { layout: 'phone', seed: bread });
    await userEvent.click(await screen.findByRole('button', { name: /^Learn to bake bread/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Add task to the backlog for Learn to bake bread' }));
    const sheet = await screen.findByRole('dialog', { name: 'Add task to the backlog for Learn to bake bread' });
    await userEvent.type(within(sheet).getByRole('textbox', { name: 'Title' }), 'Order rye flour');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Added Order rye flour to the backlog for Learn to bake bread.')).toBeVisible();
    expect((await backlogTasks(t)).map((x) => x.title)).toContain('Order rye flour');
    expect(screen.getByRole('button', { name: 'Backlog, 3 tasks, 2h 20m' })).toBeVisible();
  });
});
