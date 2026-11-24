import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateSettings } from '../../core/records';
import { newestId, WHATS_NEW_KEY } from '../../core/whatsNew';
import { WHATS_NEW } from '../../whatsNew';
import { renderApp } from './testing';
import type { HarnessOptions } from './testing';
// Loaded before the app asks for it, as the iPhone app carries it, so a test's clock doesn't run out while it loads.
import './WhatsNew';

const NEWEST = newestId(WHATS_NEW);
// Built at noon in Chicago, where the tests' clock is, on 24 November 2026.
const BUILD = Date.UTC(2026, 10, 24, 18) / 1000;
const IPHONE: HarnessOptions = { kind: 'ios', layout: 'phone', build: BUILD };

const TITLE = 'Multiscale has been updated';
const whatsNew = () => screen.queryByRole('dialog', { name: TITLE });
/** Long enough, once the app has drawn, for it to settle and the sheet to show, if it's going to. */
const wait = () => act(async () => void (await vi.advanceTimersByTimeAsync(3000)));
async function settle() {
  await screen.findByRole('region', { name: 'Today' });
  await wait();
}
const seen = () => localStorage.getItem(WHATS_NEW_KEY);
/** A phone that last saw the line `id`, then updated to this bundle. */
const sawUpTo = (id: number) => localStorage.setItem(WHATS_NEW_KEY, String(id));

beforeEach(() => void vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'], shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("what's new on the iPhone", () => {
  it('shows the lines this phone has not seen once an update brings them, dated by the update, and Got it puts them away for good', async () => {
    sawUpTo(NEWEST - 2);
    const first = await renderApp(IPHONE);
    await settle();
    const sheet = await screen.findByRole('dialog', { name: TITLE });
    // The title, then What's new over the update's date and its lines.
    expect(within(sheet).getAllByRole('heading').map((h) => h.textContent)).toEqual([TITLE, "What's new"]);
    expect(within(sheet).getByRole('heading', { name: TITLE, level: 2 })).toBeVisible();
    expect(within(sheet).getByText('Nov 24')).toBeVisible();
    expect(within(sheet).getAllByRole('listitem').map((li) => li.textContent)).toEqual(WHATS_NEW.slice(0, 2).map((e) => e.text));
    // Focus goes into the sheet, and what's behind it is out of reach of VoiceOver's swipes.
    expect(sheet).toHaveFocus();
    expect(document.querySelector('.mainarea')).toHaveAttribute('inert');

    await userEvent.click(within(sheet).getByRole('button', { name: 'Got it' }));
    expect(whatsNew()).toBeNull();
    expect(seen()).toBe(String(NEWEST));
    expect(document.querySelector('.mainarea')).not.toHaveAttribute('inert');
    // Focus lands on the page it was over, rather than nowhere.
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('.pane[aria-hidden="false"]')));

    // The next launch on this phone shows nothing.
    first.unmount();
    await renderApp(IPHONE);
    await screen.findByRole('navigation', { name: 'Main' });
    await settle();
    expect(whatsNew()).toBeNull();
  });

  it('shows the newest lines to a phone updating from a bundle from before What’s new', async () => {
    await renderApp(IPHONE);
    await settle();
    const sheet = await screen.findByRole('dialog', { name: TITLE });
    expect(within(sheet).getAllByRole('listitem').map((li) => li.textContent)).toEqual(WHATS_NEW.slice(0, 6).map((e) => e.text));
  });

  it('marks every line seen on a new install, at first-run setup, and shows none after it', async () => {
    const t = await renderApp({ ...IPHONE, firstRun: true });
    await screen.findByRole('heading', { name: 'Welcome' });
    await waitFor(() => expect(seen()).toBe(String(NEWEST)));
    await wait();
    expect(whatsNew()).toBeNull();

    await t.write((w) => updateSettings(w, { setup_done_at: '2026-11-02T20:00:00Z' }));
    await screen.findByRole('navigation', { name: 'Main' });
    await settle();
    expect(whatsNew()).toBeNull();
  });

  it('waits while Capture or another sheet is open, and shows once the app is idle', async () => {
    sawUpTo(NEWEST - 1);
    await renderApp(IPHONE);
    await userEvent.click(await screen.findByRole('button', { name: 'Capture a task' }));
    await screen.findByRole('dialog', { name: 'Capture' });
    await settle();
    expect(whatsNew()).toBeNull();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Capture' })).toBeNull());
    await settle();
    expect(await screen.findByRole('dialog', { name: TITLE })).toBeVisible();
  });

  it('puts the lines away on Esc too', async () => {
    sawUpTo(NEWEST - 1);
    await renderApp(IPHONE);
    await settle();
    await screen.findByRole('dialog', { name: TITLE });
    await userEvent.keyboard('{Escape}');
    expect(whatsNew()).toBeNull();
    expect(seen()).toBe(String(NEWEST));
  });

  it('puts the lines away on a swipe down, but not on a short or sideways one', async () => {
    sawUpTo(NEWEST - 1);
    await renderApp(IPHONE);
    await settle();
    const sheet = await screen.findByRole('dialog', { name: TITLE });
    const swipe = (dx: number, dy: number) => {
      fireEvent.touchStart(sheet, { touches: [{ clientX: 200, clientY: 500 }] });
      fireEvent.touchEnd(sheet, { changedTouches: [{ clientX: 200 + dx, clientY: 500 + dy }] });
    };
    swipe(0, 20);
    swipe(120, 60);
    expect(whatsNew()).toBeVisible();
    expect(seen()).toBe(String(NEWEST - 1));
    swipe(10, 120);
    expect(whatsNew()).toBeNull();
    expect(seen()).toBe(String(NEWEST));
  });

  it('shows only in the iPhone app: not in the browser at phone size or in the Mac app', async () => {
    sawUpTo(NEWEST - 1);
    const browser = await renderApp({ layout: 'phone', build: BUILD });
    await screen.findByRole('navigation', { name: 'Main' });
    await settle();
    expect(whatsNew()).toBeNull();
    browser.unmount();

    await renderApp({ kind: 'electron', layout: 'desktop', build: BUILD });
    await screen.findByRole('navigation', { name: 'Main' });
    await settle();
    expect(whatsNew()).toBeNull();
    expect(seen()).toBe(String(NEWEST - 1));
  });
});
