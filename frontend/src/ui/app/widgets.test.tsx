import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRecord, weekPlanId } from '../../core/records';
import type { Writer } from '../../core/records';
import type { WidgetSnapshot } from '../../core/widgetSnapshot';
import { memoryWidgets } from '../../platform/memory';
import type { AppSync } from '../../core/syncRunner';
import { renderApp } from './testing';

// The harness's Monday, Nov 2, 2pm in Chicago. One block began at 1:30pm and hasn't been started; one is at 4pm.
const at = (time: string) => `2026-11-02T${time}:00Z`;
async function seed(w: Writer) {
  // A planned week, so Today shows the day rather than asking to plan it.
  await w.create('week_plan', { week_start: '2026-11-02', finished_at: at('14:00') }, weekPlanId('2026-11-02'));
  await w.create('task', { kind: 'project', project_id: 'p', title: 'Write the report', estimate_min: 90, remaining_min: 90 }, 'report');
  await w.create('time_block', { task_id: 'report', start: at('19:30'), end: at('21:00'), tz: 'America/Chicago' }, 'now');
  await w.create('task', { kind: 'one_off', title: 'Call the dentist' }, 'dentist');
  await w.create('time_block', { task_id: 'dentist', start: at('22:00'), end: at('22:15'), tz: 'America/Chicago' }, 'later');
}

const last = (widgets: ReturnType<typeof memoryWidgets>) => JSON.parse(widgets.written.at(-1)!) as WidgetSnapshot;
const fileId = (time: string, n = 1) => `${Date.parse(time)}-6F9619FF-8B86-4011-B42D-00C04FC964${String(n).padStart(2, '0')}.json`;
const queue = (widgets: ReturnType<typeof memoryWidgets>, kind: string, blockId: string, time: string, rev: string, n = 1) =>
  widgets.queued.set(fileId(time, n), JSON.stringify({ v: 1, id: fileId(time, n), kind, blockId, rev, at: time, target: null }));

/** The rev the widget drew: what the app wrote for that block in its first snapshot. */
async function firstRev(blockId: string) {
  const probe = memoryWidgets();
  const t = await renderApp({ seed, widgets: probe, kind: 'ios', layout: 'phone' });
  await waitFor(() => expect(probe.written.length).toBeGreaterThan(0), { timeout: 5000 });
  t.unmount();
  return last(probe).blocks.find((b) => b.id === blockId)!.rev;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('the widget snapshot, written by the app', () => {
  it('is written on opening, then again a second after the plan changes', async () => {
    const widgets = memoryWidgets();
    const t = await renderApp({ seed, widgets, kind: 'ios', layout: 'phone' });
    await waitFor(() => expect(widgets.written.length).toBe(1), { timeout: 3000 });
    expect(last(widgets).blocks.map((b) => b.id)).toEqual(['now', 'later']);
    await t.write((w) => w.set('time_block', 'now', { started_at: at('20:01') }));
    await waitFor(() => expect(last(widgets).blocks[0]!.startedAt).toBe(at('20:01')), { timeout: 3000 });
  });

  it('is written at once as the app leaves the screen', async () => {
    const widgets = memoryWidgets();
    const t = await renderApp({ seed, widgets, kind: 'ios', layout: 'phone' });
    await waitFor(() => expect(widgets.written.length).toBe(1), { timeout: 3000 });
    await t.write((w) => w.create('task', { kind: 'inbox', title: 'Buy flour' }));
    act(() => t.platform.lifecycle.background());
    // Long before the second the change would otherwise wait.
    await waitFor(() => expect(last(widgets).inbox).toEqual({ count: 1 }), { timeout: 500 });
  });

  it('is rewritten when iOS wakes the app to refresh the widgets, after a sync', async () => {
    const widgets = memoryWidgets();
    const order: string[] = [];
    const sync = { syncNow: vi.fn(async () => void order.push('sync')) } as unknown as AppSync;
    await renderApp({ seed, widgets, kind: 'ios', layout: 'phone', sync });
    await waitFor(() => expect(widgets.written.length).toBe(1), { timeout: 3000 });
    const write = widgets.write;
    widgets.write = async (json) => {
      order.push('write');
      await write(json);
    };
    await act(() => widgets.refresh());
    expect(order).toEqual(['sync', 'write']);
  });
});

describe('what the widget’s buttons queued', () => {
  it('is applied on opening, timed at the tap, with a toast whose Undo takes it back', async () => {
    const rev = await firstRev('now');
    const widgets = memoryWidgets();
    queue(widgets, 'start', 'now', at('19:36'), rev);
    const t = await renderApp({ seed, widgets, kind: 'ios', layout: 'phone' });
    expect(await screen.findByText('Started Write the report at 1:36pm from the widget.', {}, { timeout: 10_000 })).toBeVisible();
    expect((await getRecord(t.db, 'time_block', 'now'))!.started_at).toBe(at('19:36'));
    expect(widgets.queued.size).toBe(0);
    // The widget offers its own Undo too, for five minutes from the tap.
    await waitFor(() => expect(last(widgets).fromWidget).toEqual([]), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'now'))!.started_at).toBeNull());
    // And the widget shows it at once, long before the second a change otherwise waits.
    await waitFor(() => expect(last(widgets).blocks[0]!.startedAt).toBeNull(), { timeout: 500 });
  }, 30_000);

  it('still shows the widget its Undo while the five minutes last', async () => {
    const rev = await firstRev('now');
    const widgets = memoryWidgets();
    queue(widgets, 'start', 'now', at('19:58'), rev);
    await renderApp({ seed, widgets, kind: 'ios', layout: 'phone' });
    await screen.findByText('Started Write the report at 1:58pm from the widget.', {}, { timeout: 10_000 });
    await waitFor(() => expect(last(widgets).fromWidget).toEqual([{ id: fileId(at('19:58')), kind: 'start', blockId: 'now', at: at('19:58'), before: null }]), { timeout: 3000 });
  }, 30_000);

  it('is applied when the app comes back to the front, after a sync', async () => {
    const rev = await firstRev('now');
    const widgets = memoryWidgets();
    const sync = { syncNow: vi.fn(async () => undefined) } as unknown as AppSync;
    const t = await renderApp({ seed, widgets, kind: 'ios', layout: 'phone', sync });
    await waitFor(() => expect(widgets.written.length).toBe(1), { timeout: 3000 });
    sync.syncNow = vi.fn(async () => undefined);
    queue(widgets, 'start', 'now', at('19:59'), rev);
    act(() => t.platform.lifecycle.foreground());
    expect(await screen.findByText('Started Write the report at 1:59pm from the widget.', {}, { timeout: 10_000 })).toBeVisible();
    expect(sync.syncNow).toHaveBeenCalled();
  }, 30_000);

  it('is dropped, and says why, when the block changed on another device first', async () => {
    const rev = await firstRev('now');
    const widgets = memoryWidgets();
    queue(widgets, 'start', 'now', at('19:36'), rev);
    const t = await renderApp({
      seed: async (w) => {
        await seed(w);
        await w.set('time_block', 'now', { start: at('23:00'), end: at('23:30') });
      },
      widgets,
      kind: 'ios',
      layout: 'phone',
    });
    const said = await screen.findByText("Didn't start Write the report from the widget. It changed since. It's now 5pm to 5:30pm.", {}, { timeout: 10_000 });
    expect(said).toBeVisible();
    expect(within(said.parentElement!).queryByRole('button', { name: 'Undo' })).toBeNull();
    expect((await getRecord(t.db, 'time_block', 'now'))!.started_at).toBeFalsy();
    expect(widgets.queued.size).toBe(0);
  }, 30_000);

  it('drops a file nothing could read, and applies the rest', async () => {
    const rev = await firstRev('later');
    const widgets = memoryWidgets();
    widgets.queued.set('junk.json', 'not json');
    queue(widgets, 'startEarly', 'later', at('20:00'), rev, 2);
    const t = await renderApp({ seed, widgets, kind: 'ios', layout: 'phone' });
    expect(await screen.findByText('Started Call the dentist early, at 2pm, from the widget.', {}, { timeout: 10_000 })).toBeVisible();
    expect(await getRecord(t.db, 'time_block', 'later')).toMatchObject({ start: at('20:00'), end: at('20:15') });
    expect(widgets.queued.size).toBe(0);
  }, 30_000);
});

describe('the widgets’ links', () => {
  it("open the Inbox, Week (Today's week on phone), Plan your week and Today", async () => {
    const t = await renderApp({ seed, kind: 'ios', layout: 'phone' });
    const shows = (area: string) => waitFor(() => expect(document.documentElement.dataset.screen).toBe(area), { timeout: 5000 });
    await shows('today');
    act(() => t.platform.openAppLink({ screen: 'inbox' }));
    await shows('inbox');
    expect(await screen.findByRole('heading', { name: 'Inbox', level: 1 }, { timeout: 5000 })).toBeVisible();
    // The This week widget's link: on phone, Today draws the week over its day.
    act(() => t.platform.openAppLink({ screen: 'week' }));
    await shows('today');
    expect(await screen.findByRole('group', { name: 'Choose a day' }, { timeout: 5000 })).toBeVisible();
    act(() => t.platform.openAppLink({ screen: 'plan' }));
    await shows('planning');
    act(() => t.platform.openAppLink({ screen: 'today' }));
    await shows('today');
  }, 30_000);

  it('close Capture to show the screen they name', async () => {
    const t = await renderApp({ seed, kind: 'ios', layout: 'phone' });
    await waitFor(() => expect(document.documentElement.dataset.screen).toBe('today'), { timeout: 5000 });
    fireEvent.click((await screen.findAllByRole('button', { name: 'Capture a task' }))[0]!);
    await waitFor(() => expect(document.documentElement.dataset.screen).toBe('capture'), { timeout: 5000 });
    act(() => t.platform.openAppLink({ screen: 'inbox' }));
    await waitFor(() => expect(document.documentElement.dataset.screen).toBe('inbox'), { timeout: 5000 });
  }, 30_000);

  it('open Today with the linked block in view and focused', async () => {
    // Started, so no question about it holds focus.
    const started = async (w: Writer) => {
      await seed(w);
      await w.set('time_block', 'now', { started_at: at('19:30') });
    };
    const t = await renderApp({ seed: started, kind: 'ios', layout: 'phone' });
    await waitFor(() => expect(document.documentElement.dataset.screen).toBe('today'), { timeout: 5000 });
    // Away from Today first, on the Inbox: Week's link is Today's own on phone.
    act(() => t.platform.openAppLink({ screen: 'inbox' }));
    await waitFor(() => expect(document.documentElement.dataset.screen).toBe('inbox'), { timeout: 5000 });
    act(() => t.platform.openAppLink({ screen: 'today', block: 'later' }));
    await waitFor(() => expect(document.activeElement?.getAttribute('data-block')).toBe('later'), { timeout: 5000 });
  }, 30_000);
});
