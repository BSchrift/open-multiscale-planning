import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../../core/clock';
import { noteId, saveAsNote } from '../../../core/memos';
import type { Writer } from '../../../core/records';
import type { MemoHome } from '../../../core/types';
import { renderScreen } from '../../app/testing';

afterEach(cleanup);

// The harness clock is Monday Nov 2, 2pm in Chicago.
async function note(w: Writer, id: string, title: string, home: MemoHome | null, fields: { show_on?: string } = {}) {
  await w.create('task', { kind: 'inbox', title }, id);
  await saveAsNote(w, id, fixedClock('2026-11-02T20:00:00Z', 'America/Chicago'), home);
  if (fields.show_on) await w.set('memo', noteId(id), { show_on: fields.show_on });
}

async function seed(w: Writer) {
  await w.create('objective', { title: 'Home', state: 'active', order: 1 }, 'g1');
  await w.create('objective', { title: 'Stay fit', state: 'active', order: 2 }, 'g2');
  await w.create('project', { objective_id: 'g1', title: 'Kitchen redo', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p1');
  await w.create('practice', { objective_id: 'g2', title: 'Morning run', target_min: 30, per: 'day', state: 'active' }, 'pr1');
  await note(w, 'paint', 'Paint for the hall: Pale Oat', { type: 'objective', id: 'g1' });
  await note(w, 'tiles', 'Tiles: 10x10 white', { type: 'project', id: 'p1' });
  await note(w, 'shoes', 'Shoe size 44', { type: 'practice', id: 'pr1' }, { show_on: '2026-11-02' });
  await note(w, 'gate', 'Gate code', null, { show_on: '2026-11-03' });
}

describe("a note's home shows it", () => {
  it('on an open goal card, in one Notes row grouped by home, and nowhere on a closed one', async () => {
    await renderScreen('goals', { seed });
    // The first render of a screen loads it, which takes longer on a busy machine.
    const home = await screen.findByRole('button', { name: /^Home/, expanded: false }, { timeout: 5000 });
    expect(screen.queryByRole('button', { name: /^Notes, / })).toBeNull();
    await userEvent.click(home);
    const row = await screen.findByRole('button', { name: 'Notes, 2 notes' });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(row);
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['Home', 'Kitchen redo']);
    await userEvent.click(screen.getByRole('button', { name: /^Tiles: 10x10 white/ }));
    expect(await screen.findByRole('dialog', { name: 'Note: Tiles: 10x10 white' })).toBeInTheDocument();
  });

  it("in a Notes section on the project's page", async () => {
    await renderScreen('goals', { seed, layout: 'phone', params: { project: 'p1' } });
    const section = await screen.findByRole('region', { name: 'Notes' }, { timeout: 5000 });
    expect(within(section).getAllByRole('button').map((b) => b.querySelector('.ntitle')?.textContent)).toEqual(['Tiles: 10x10 white']);
  });

  it("in the practice's popup", async () => {
    await renderScreen('goals', { seed, layout: 'phone', params: { show: 'pr1' } });
    const sheet = await screen.findByRole('dialog', { name: 'Morning run' }, { timeout: 5000 });
    expect(within(within(sheet).getByRole('region', { name: 'Notes' })).getByRole('button', { name: /^Shoe size 44/ })).toBeInTheDocument();
  });
});

describe('a note outlives its home', () => {
  it('reads as having no home, in Notes and in Belongs to, once its project is finished', async () => {
    await renderScreen('notes', {
      seed: async (w) => {
        await seed(w);
        await w.set('project', 'p1', { state: 'finished' });
      },
    });
    const tiles = await screen.findByRole('button', { name: /^Tiles: 10x10 white/ }, { timeout: 5000 });
    // Only once the homes are read does the goal's name show on its note.
    await waitFor(() => expect(screen.getByRole('button', { name: /^Paint for the hall/ })).toHaveAccessibleDescription('Saved Nov 2 · Home'));
    expect(tiles).toHaveAccessibleDescription('Saved Nov 2');
    await userEvent.click(tiles);
    const popup = await screen.findByRole('dialog', { name: 'Note: Tiles: 10x10 white' });
    expect(within(popup).getByRole('button', { name: 'Belongs to Notes · On its own' })).toBeInTheDocument();
  });
});

describe('Today', () => {
  it('shows the notes chosen for today above the timeline, to read, and none chosen for another day', async () => {
    // A planned week, so Today shows the day rather than asking to plan it.
    await renderScreen('today', {
      seed: async (w) => {
        await w.create('week_plan', { week_start: '2026-11-02', finished_at: '2026-11-02T14:00:00Z' }, 'week:2026-11-02');
        await seed(w);
      },
    });
    const card = await screen.findByRole('region', { name: 'Notes for today' }, { timeout: 5000 });
    expect(within(card).getAllByRole('button').map((b) => b.querySelector('.ntitle')?.textContent)).toEqual(['Shoe size 44']);
    expect(within(card).getByRole('button', { name: /^Shoe size 44/ })).toHaveAccessibleDescription('Saved Nov 2 · Morning run · On Today now');
    expect(within(card).queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText('Gate code')).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: /^Shoe size 44/ }));
    expect(await screen.findByRole('dialog', { name: 'Note: Shoe size 44' })).toBeInTheDocument();
  });
});
