import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerBlock } from '../../core/blocks';
import { listRecords, updateSettings, weekPlanId } from '../../core/records';
import type { Writer } from '../../core/records';
import { setAppearance } from './appearance';
import { AREAS, DESKTOP_TABS, PHONE_TABS, tabForArea } from './registry';
import type { AreaId } from './registry';
import { renderApp, renderScreen } from './testing';

afterEach(cleanup);

const main = () => screen.getByRole('navigation', { name: 'Main' });
const tab = (name: string | RegExp) => within(main()).getByRole('button', { name });

// By pane rather than by content, so these tests survive whatever each screen goes on to render.
const paneOf = (label: string) => document.querySelector<HTMLElement>(`.pane[aria-label='${label}']`);
const showsPane = (label: string) =>
  waitFor(() => {
    expect(paneOf(label)).not.toBeNull();
    expect(paneOf(label)).not.toHaveAttribute('aria-hidden', 'true');
  });

describe('shell on desktop', () => {
  it('shows the side navigation in order, with Today current', async () => {
    await renderApp();
    await showsPane('Today');
    const labels = within(main()).getAllByRole('button').map((b) => b.textContent);
    expect(labels.slice(2)).toEqual(['Today', 'Inbox', 'Week', 'Plan', 'Goals', 'One offs', 'Analytics', 'Settings']);
    expect(tab('Today')).toHaveAttribute('aria-current', 'page');
  });

  it('switches tabs, and keeps the old one mounted but hidden', async () => {
    await renderApp();
    await showsPane('Today');
    // Screens load lazily, so wait for Today's content before leaving it.
    await waitFor(() => expect(paneOf('Today')!.childElementCount).toBeGreaterThan(0));
    await userEvent.click(tab('Goals'));
    await showsPane('Goals');
    expect(tab('Goals')).toHaveAttribute('aria-current', 'page');
    expect(tab('Today')).not.toHaveAttribute('aria-current');
    expect(paneOf('Today')).toHaveAttribute('aria-hidden', 'true');
    expect(paneOf('Today')).not.toBeVisible();
    expect(paneOf('Today')!.childElementCount).toBeGreaterThan(0);
  });

  it('names the page showing, and a flow over it, as regions, which the hidden pages are not', async () => {
    await renderApp();
    expect(await screen.findByRole('region', { name: 'Today' })).toBe(paneOf('Today'));
    await userEvent.click(tab('Goals'));
    expect(await screen.findByRole('region', { name: 'Goals' })).toBe(paneOf('Goals'));
    expect(screen.queryByRole('region', { name: 'Today' })).toBeNull();
    await userEvent.click(tab('Today'));
    await userEvent.click(await screen.findByRole('button', { name: 'Start planning' }));
    expect(await screen.findByRole('region', { name: 'Plan your week' })).toBe(document.querySelector('.flowpane'));
  });

  it('counts the inbox live', async () => {
    const t = await renderApp({ seed: (w) => w.create('task', { kind: 'inbox', title: 'Paint the fence' }) });
    await screen.findByText('1');
    await act(() => t.write((w) => w.create('task', { kind: 'inbox', title: 'Rake the leaves' })));
    await screen.findByText('2');
  });

  it('lights the tab a flow belongs to: Week while planning the week, Plan while planning ahead', async () => {
    await renderApp();
    await showsPane('Today');
    await userEvent.click(await screen.findByRole('button', { name: 'Start planning' }));
    await waitFor(() => expect(tab('Week')).toHaveAttribute('aria-current', 'page'));
    expect(tab('Today')).not.toHaveAttribute('aria-current');
    await userEvent.click(tab('Plan'));
    await userEvent.click(await screen.findByRole('button', { name: /^Plan now|^Plan (the next|your first) stretch/ }));
    await waitFor(() => expect(tab('Plan')).toHaveAttribute('aria-current', 'page'));
  });

  it("Today's prompt to plan the next stretch opens planning ahead itself", async () => {
    // Christmas Eve: a week before the stretch ends on Dec 31.
    await renderApp({
      now: '2026-12-24T18:00:00Z',
      seed: async (w) => {
        await w.create('week_plan', { week_start: '2026-12-21', finished_at: '2026-12-21T14:00:00Z' }, 'week:2026-12-21');
        await w.create('settings', { plan_stretch: { last_planned: '2026-10-01' } }, 'settings');
      },
    });
    await showsPane('Today');
    await userEvent.click(await screen.findByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('heading', { name: 'Plan the next stretch' })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.flowpane')).not.toBeNull());
  });

  it('opens Capture over the page from the button and the keyboard, and returns focus on Esc', async () => {
    await renderApp();
    await showsPane('Today');
    const button = screen.getByRole('button', { name: /Capture/ });
    button.focus();
    await userEvent.click(button);
    expect(await screen.findByRole('dialog', { name: 'Capture' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(button).toHaveFocus();
    await userEvent.keyboard('{Shift>}{Meta>} {/Meta}{/Shift}');
    expect(await screen.findByRole('dialog', { name: 'Capture' })).toBeInTheDocument();
  });

  it('names the screen on show for telemetry, Capture while it is open', async () => {
    await renderApp();
    await showsPane('Today');
    expect(document.documentElement.dataset.screen).toBe('today');
    await userEvent.click(screen.getByRole('button', { name: /Capture/ }));
    await screen.findByRole('dialog', { name: 'Capture' });
    expect(document.documentElement.dataset.screen).toBe('capture');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.documentElement.dataset.screen).toBe('today'));
  });
});

describe('shell on both layouts', () => {
  it.each(['desktop', 'phone'] as const)('on %s, the first press opens Capture with its field focused before it returns', async (layout) => {
    await renderApp({ layout });
    await showsPane('Today');
    // Nothing awaited: a Capture that had to load first would open 300ms late.
    fireEvent.click(screen.getByRole('button', { name: layout === 'phone' ? 'Capture a task' : /^Capture/ }));
    expect(screen.getByRole('textbox', { name: 'Capture to Inbox' })).toHaveFocus();
  });

  it.each(['desktop', 'phone'] as const)('keeps toasts inside the %s layout, so they get its styles', async (layout) => {
    const t = await renderApp({ layout });
    await showsPane('Today');
    expect(t.container.querySelector('[aria-live="polite"]')?.closest(`[data-layout='${layout}']`)).not.toBeNull();
  });
});

describe('block prompts', () => {
  // The harness reads 2pm in Chicago (20:00Z). A started block runs 1pm to 2:05pm.
  const running = async (w: Writer) => {
    await w.create('week_plan', { week_start: '2026-11-02', finished_at: '2026-11-02T14:00:00Z' }, weekPlanId('2026-11-02'));
    await w.create('task', { kind: 'one_off', title: 'Write the report' }, 't1');
    await w.create('time_block', { task_id: 't1', start: '2026-11-02T19:00:00Z', end: '2026-11-02T20:05:00Z', tz: 'America/Chicago', started_at: '2026-11-02T19:00:00Z' }, 'b1');
  };
  // Moves past the block's end, and writes something so the screens read again, as the clock tick would.
  const blockEnds = (t: Awaited<ReturnType<typeof renderApp>>) => {
    t.clock.set('2026-11-02T20:06:00Z');
    return act(() => t.write((w) => w.create('task', { kind: 'inbox', title: 'Rake the leaves' })));
  };

  it.each(['desktop', 'phone'] as const)('on %s, asks when a block ends while another tab is showing', async (layout) => {
    const t = await renderApp({ layout, seed: running });
    await screen.findByRole('region', { name: 'Current block' });
    await userEvent.click(tab('Week'));
    await showsPane('Week');
    await blockEnds(t);
    expect(await screen.findByRole('dialog', { name: 'Block finished' })).toBeVisible();
  });

  it.each(['desktop', 'phone'] as const)('on %s, waits for Capture to close rather than take its typing', async (layout) => {
    const t = await renderApp({ layout, seed: running });
    await screen.findByRole('region', { name: 'Current block' });
    await userEvent.click(screen.getByRole('button', { name: /^Capture/ }));
    const field = await screen.findByRole('textbox', { name: /^Capture to/ });
    await userEvent.type(field, 'Buy milk');
    await blockEnds(t);
    // Keys only, no click, as someone still typing would.
    await userEvent.keyboard(' and eggs');
    expect(field).toHaveFocus();
    expect(field).toHaveValue('Buy milk and eggs');
    expect(screen.queryByRole('dialog', { name: 'Block finished' })).toBeNull();
    await userEvent.keyboard('{Enter}');
    // Desktop shows what it saved for a moment before closing.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Capture' })).toBeNull(), { timeout: 3000 });
    expect((await listRecords(t.db, 'task')).map((r) => r.title)).toContain('Buy milk and eggs');
    const prompt = await screen.findByRole('dialog', { name: 'Block finished' });
    await waitFor(() => expect(prompt).toHaveFocus());
  });

  it('leaves focus where it is when another device answers an open prompt', async () => {
    const t = await renderApp({ seed: running });
    await screen.findByRole('region', { name: 'Current block' });
    await userEvent.click(tab('Week'));
    await showsPane('Week');
    await blockEnds(t);
    await waitFor(async () => expect(await screen.findByRole('dialog', { name: 'Block finished' })).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: /^Capture/ }));
    const field = await screen.findByRole('textbox', { name: /^Capture to/ });
    await userEvent.type(field, 'Buy milk');
    await act(() => t.write((w) => answerBlock(w, 'b1', { result: 'done' }, t.clock)));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Block finished' })).toBeNull());
    expect(field).toHaveFocus();
  });
});

describe('shell on phone', () => {
  it('has exactly five tabs and a Capture button, and no side navigation', async () => {
    await renderApp({ layout: 'phone' });
    await showsPane('Today');
    expect(within(main()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Today', 'Week', 'Inbox', 'Goals', 'More']);
    expect(screen.getByRole('button', { name: 'Capture a task' })).toBeInTheDocument();
  });

  it('lists More rows, keeps More lit in a sub-page, and comes back', async () => {
    await renderApp({ layout: 'phone' });
    await userEvent.click(await screen.findByRole('button', { name: 'More' }));
    // A row's name starts with its label and goes on with its live line.
    for (const name of ['Plan', 'One offs', 'Analytics', 'Settings']) expect(await screen.findByRole('button', { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    await showsPane('Settings');
    expect(tab('More')).toHaveAttribute('aria-current', 'page');
    // The arrow is drawn, not read out.
    const back = screen.getByRole('button', { name: 'Back to More' });
    expect(back).toHaveTextContent('‹ More');
    await userEvent.click(back);
    await screen.findByRole('heading', { name: 'More' });
    expect(screen.queryByRole('button', { name: 'Back to More' })).toBeNull();
  });

  it('tapping the current tab returns to its root, and other tabs keep their page', async () => {
    await renderApp({ layout: 'phone' });
    await userEvent.click(await screen.findByRole('button', { name: 'More' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Analytics' }));
    await showsPane('Analytics');
    await userEvent.click(tab('Today'));
    await showsPane('Today');
    await userEvent.click(tab('More'));
    await showsPane('Analytics');
    await userEvent.click(tab('More'));
    await screen.findByRole('heading', { name: 'More' });
  });

  it('labels the inbox count for screen readers', async () => {
    await renderApp({ layout: 'phone', seed: (w) => w.create('task', { kind: 'inbox', title: 'Paint the fence' }) });
    await screen.findByRole('button', { name: 'Inbox, 1 to sort' });
  });

  it('hides the tab bar during a flow, and returns on exit', async () => {
    const t = await renderScreen('today', { layout: 'phone' });
    expect(t.nav().flow).toBeNull();
    act(() => t.nav().openFlow('planning'));
    expect(t.nav().flow?.area).toBe('planning');
    act(() => t.nav().closeFlow());
    expect(t.nav().flow).toBeNull();
  });
});

describe('navigation', () => {
  it('a cross-link switches tab, and back returns to the source', async () => {
    const t = await renderScreen('today', { layout: 'phone' });
    act(() => t.nav().go('goals', { project: 'p1' }));
    expect(t.nav().tab).toBe('goals');
    expect(t.nav().route).toMatchObject({ area: 'goals', params: { project: 'p1' } });
    expect(t.nav().backLabel).toBe('Today');
    act(() => t.nav().back());
    expect(t.nav().tab).toBe('today');
  });

  it('going to the page already open adds nothing to go back through', async () => {
    const t = await renderScreen('today');
    act(() => t.nav().go('goals', { project: 'p1' }));
    act(() => t.nav().go('goals', { project: 'p1' }));
    act(() => t.nav().back());
    expect(t.nav().tab).toBe('today');
    expect(t.nav().stacks.goals).toHaveLength(1);
  });

  it('a phone sub-area lights More, while on desktop it is its own tab', () => {
    expect(tabForArea('settings', 'phone')).toBe('more');
    expect(tabForArea('settings', 'desktop')).toBe('settings');
    expect(tabForArea('goals', 'phone')).toBe('goals');
  });

  it('has a tab for every page on desktop, and on phone only five', () => {
    expect(PHONE_TABS).toHaveLength(5);
    for (const tabId of DESKTOP_TABS) if (tabId !== 'more') expect(AREAS[tabId]).toBeDefined();
  });
});

describe('appearance', () => {
  it("tells the native window and status bar this device's appearance at launch, and each change", async () => {
    localStorage.setItem('multiscale.appearance', 'dark');
    const t = await renderApp({ firstRun: true });
    await waitFor(() => expect(t.platform.appearances).toEqual(['dark']));
    act(() => setAppearance('light'));
    await waitFor(() => expect(t.platform.appearances).toEqual(['dark', 'light']));
    act(() => setAppearance('system'));
    await waitFor(() => expect(t.platform.appearances).toEqual(['dark', 'light', 'system']));
  });
});

describe('over-the-air updates', () => {
  const native = () => ({ install: vi.fn(), staged: vi.fn(async () => null), apply: vi.fn(), ready: vi.fn(), rolledBack: vi.fn(async () => null) });

  // A new bundle that never says so is rolled back at the next launch.
  it.each([
    ['the app', false],
    ['first-run setup', true],
  ])('tells native code the bundle started once the data has opened and %s shows', async (_, firstRun) => {
    const nativeUpdates = native();
    const t = await renderApp({ nativeUpdates, firstRun });
    await waitFor(() => expect(nativeUpdates.ready).toHaveBeenCalledOnce());
    expect(t.container.querySelector('.pane')).not.toBeNull();
    await act(() => t.write((w) => updateSettings(w, { setup_done_at: '2026-11-02T20:00:00Z' })));
    expect(nativeUpdates.ready).toHaveBeenCalledOnce();
  });
});

describe('first run', () => {
  it('shows setup with no navigation until it finishes', async () => {
    const t = await renderApp({ firstRun: true });
    await waitFor(() => expect(t.container.querySelector('.pane')?.childElementCount ?? 0).toBeGreaterThan(0));
    expect(screen.queryByRole('navigation')).toBeNull();
    await act(() => t.write((w) => updateSettings(w, { setup_done_at: '2026-11-02T20:00:00Z' })));
    await showsPane('Today');
    expect(main()).toBeInTheDocument();
  });
});

describe('registry', () => {
  it.each(Object.keys(AREAS) as AreaId[])('renders %s on both layouts', async (area) => {
    for (const layout of ['desktop', 'phone'] as const) {
      // A task's popup needs its task.
      const task = area === 'task' ? { params: { task: 't1' }, seed: (w: Writer) => w.create('task', { kind: 'inbox', title: 'Call the bank' }, 't1') } : {};
      const t = await renderScreen(area, { layout, ...task });
      // More than the toast region the layout always holds.
      await waitFor(() => expect(t.container.querySelector(`[data-layout='${layout}']`)?.childElementCount ?? 0).toBeGreaterThan(1));
      cleanup();
    }
  });
});
