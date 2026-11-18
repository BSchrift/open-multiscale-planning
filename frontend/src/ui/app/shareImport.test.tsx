import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '../../core/clock';
import { inboxTasks, taskAttachments } from '../../core/queries';
import { getRecord } from '../../core/records';
import { createTestPlatform } from '../../platform/testing';
import { useShareImport } from './shareImport';
import { AppProvider } from './store';

afterEach(cleanup);

function Mount() {
  useShareImport();
  return null;
}

/** The native queue: items stay until the app removes them. `arrive` lists what is shared before each look. */
async function mount(arrive: string[][]) {
  const base = await createTestPlatform();
  const queue: { id: string; text: string }[] = [];
  let next = 0;
  const peek = vi.fn(async () => {
    for (const text of arrive.shift() ?? []) queue.push({ id: `item-${next++}`, text });
    return [...queue];
  });
  const remove = vi.fn(async (ids: string[]) => {
    for (const id of ids) queue.splice(queue.findIndex((item) => item.id === id), 1);
  });
  const platform = { ...base, kind: 'ios' as const, shareImport: { peek, remove } };
  const transaction = vi.spyOn(base.db, 'transaction');
  render(
    <AppProvider platform={platform} clock={fixedClock('2026-11-02T20:00:00Z', 'America/Chicago')}>
      <Mount />
    </AppProvider>,
  );
  const titles = async () => (await inboxTasks(base.db)).map((r) => r.title);
  return { base, queue, peek, remove, transaction, titles };
}

describe('share import', () => {
  it('saves shared text as Inbox tasks in one transaction when the app opens, then clears it from the queue', async () => {
    const t = await mount([['Paint the fence', 'Learn to bake bread']]);
    await waitFor(async () => expect(await t.titles()).toEqual(['Paint the fence', 'Learn to bake bread']));
    expect(t.transaction).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(t.queue).toEqual([]));
  });

  it('looks again each time the app comes to the front', async () => {
    const t = await mount([[], ['Write the report']]);
    await waitFor(() => expect(t.peek).toHaveBeenCalledTimes(1));
    act(() => t.base.lifecycle.foreground());
    await waitFor(async () => expect(await t.titles()).toEqual(['Write the report']));
  });

  it('tidies what it is given: blank text is skipped, space is collapsed, and a very long title is cut', async () => {
    const t = await mount([['  ', '  Call  the\tbank  ', 'x'.repeat(2500), 'fences '.repeat(400)]]);
    // Cut on a whole word: the 286th "fences" would run past 2,000 characters.
    await waitFor(async () => expect(await t.titles()).toEqual(['Call the bank', 'x'.repeat(2000), 'fences '.repeat(285).trim()]));
    await waitFor(() => expect(t.queue).toEqual([]));
  });

  it('makes the first line the title and the rest the description, and a link shared on its own a link attachment', async () => {
    const url = 'https://example.com/recipes/lentil-soup';
    const t = await mount([['Lentil soup\n\n- 200g lentils\n- 1 onion', url]]);
    await waitFor(async () => expect(await t.titles()).toEqual(['Lentil soup', url]));
    const [soup, link] = await inboxTasks(t.base.db);
    expect((await getRecord(t.base.db, 'task', soup!.id))?.notes).toBe('- 200g lentils\n- 1 onion');
    expect(await taskAttachments(t.base.db, soup!.id)).toEqual([]);
    expect((await getRecord(t.base.db, 'task', link!.id))?.notes).toBeUndefined();
    expect(await taskAttachments(t.base.db, link!.id)).toMatchObject([{ kind: 'link', name: url, url }]);
    // Shares that weren't cut leave nothing for Process to say.
    expect(localStorage.getItem('multiscale.cutShares')).toBeNull();
  });

  it('keeps on this device which shares had their description cut, for Process to say so', async () => {
    const t = await mount([[`Notes from the talk\n${'word '.repeat(4196)}`, 'Fix the gate'], [`Slides\n${'x'.repeat(20_001)}`]]);
    await waitFor(async () => expect(await t.titles()).toEqual(['Notes from the talk', 'Fix the gate']));
    const [talk] = await inboxTasks(t.base.db);
    expect((await getRecord(t.base.db, 'task', talk!.id))?.notes).toHaveLength(19_999);
    await waitFor(() => expect(JSON.parse(localStorage.getItem('multiscale.cutShares') ?? '[]')).toEqual([talk!.id]));

    act(() => t.base.lifecycle.foreground());
    await waitFor(async () => expect(await t.titles()).toHaveLength(3));
    const slides = (await inboxTasks(t.base.db)).find((r) => r.title === 'Slides')!;
    await waitFor(() => expect(JSON.parse(localStorage.getItem('multiscale.cutShares') ?? '[]')).toEqual([talk!.id, slides.id]));
  });

  it('leaves what was shared in the queue when the save fails, so a quit before the next try loses nothing', async () => {
    const t = await mount([['Fix the gate'], []]);
    t.transaction.mockRejectedValueOnce(new Error('disk full'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(await t.titles()).toEqual([]);
    expect(t.queue.map((item) => item.text)).toEqual(['Fix the gate']);
    expect(t.remove).not.toHaveBeenCalled();

    act(() => t.base.lifecycle.foreground());
    await waitFor(async () => expect(await t.titles()).toEqual(['Fix the gate']));
    await waitFor(() => expect(t.queue).toEqual([]));
    error.mockRestore();
  });

  it('does nothing where there is no share sheet', async () => {
    const base = await createTestPlatform();
    render(
      <AppProvider platform={base} clock={fixedClock('2026-11-02T20:00:00Z')}>
        <Mount />
      </AppProvider>,
    );
    expect(await inboxTasks(base.db)).toEqual([]);
  });
});
