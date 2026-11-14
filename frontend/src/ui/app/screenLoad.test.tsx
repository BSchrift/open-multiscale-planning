import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScreenProps } from './registry';
import { AREAS } from './registry';
import { lazyScreen, preloadScreens, ScreenBoundary } from './screenLoad';
import { renderApp } from './testing';

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

const props: ScreenProps = { params: {}, layout: 'desktop', presentation: 'page', close: () => undefined };
const Goals = () => <h1>Goals</h1>;
// As a browser rejects an import() it couldn't fetch, such as offline.
const offline = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'));

function show(Screen: ReturnType<typeof lazyScreen>) {
  return render(
    <div className="pane" role="region" tabIndex={-1} aria-label="Goals">
      <ScreenBoundary>
        <Suspense fallback={null}>
          <Screen {...props} />
        </Suspense>
      </ScreenBoundary>
    </div>,
  );
}

describe('a screen whose code is loaded on first use', () => {
  it('says it couldn’t open when its code doesn’t arrive, and Try again loads it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const load = vi.fn<() => Promise<{ default: typeof Goals }>>().mockImplementationOnce(offline).mockResolvedValue({ default: Goals });
    show(lazyScreen(load));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't open this screen");
    expect(alert).toHaveTextContent("It will try again when you're back online.");
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Goals' })).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
    // Focus stays in the page rather than falling to the body with the button.
    expect(screen.getByRole('region', { name: 'Goals' })).toHaveFocus();
  });

  it('tries again by itself once the browser is back online', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const load = vi.fn<() => Promise<{ default: typeof Goals }>>().mockImplementationOnce(offline).mockResolvedValue({ default: Goals });
    show(lazyScreen(load));
    await screen.findByRole('alert');
    act(() => void window.dispatchEvent(new Event('online')));
    expect(await screen.findByRole('heading', { name: 'Goals' })).toBeVisible();
  });

  it('doesn’t ask for the code while offline, where a failed fetch can stay failed for good, and loads it once back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const load = vi.fn(() => Promise.resolve({ default: Goals }));
    show(lazyScreen(load));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't open this screen");
    expect(load).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
    expect(await screen.findByRole('heading', { name: 'Goals' })).toBeVisible();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('loads offline in the apps, which carry their code', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    vi.stubGlobal('location', { protocol: 'capacitor:' });
    try {
      const load = vi.fn(() => Promise.resolve({ default: Goals }));
      show(lazyScreen(load));
      expect(await screen.findByRole('heading', { name: 'Goals' })).toBeVisible();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still says so after trying again offline, and offers Try again again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const load = vi.fn<() => Promise<{ default: typeof Goals }>>().mockImplementation(offline);
    show(lazyScreen(load));
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('asks for a restart when the screen itself fails, as trying again wouldn’t help', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Broken = () => {
      throw new Error('a bug');
    };
    show(lazyScreen(() => Promise.resolve({ default: Broken })));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    expect(alert).toHaveTextContent('Your data is safe. Restart the app to try again.');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('loading screens ahead of use', () => {
  it('loads each screen in turn, once the one before has loaded', async () => {
    let finishFirst!: (m: { default: typeof Goals }) => void;
    const first = vi.fn(() => new Promise<{ default: typeof Goals }>((resolve) => (finishFirst = resolve)));
    const second = vi.fn(() => Promise.resolve({ default: Goals }));
    preloadScreens([lazyScreen(first), lazyScreen(second)]);
    await waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    // The next waits for the one before.
    await new Promise((r) => setTimeout(r, 300));
    expect(second).not.toHaveBeenCalled();
    finishFirst({ default: Goals });
    await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
  });

  it('opens a screen it loaded without fetching again', async () => {
    const load = vi.fn(() => Promise.resolve({ default: Goals }));
    const Screen = lazyScreen(load);
    preloadScreens([Screen]);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    show(Screen);
    expect(await screen.findByRole('heading', { name: 'Goals' })).toBeVisible();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('leaves a screen it couldn’t load to load when it opens', async () => {
    const load = vi.fn<() => Promise<{ default: typeof Goals }>>().mockImplementationOnce(offline).mockResolvedValue({ default: Goals });
    const Screen = lazyScreen(load);
    preloadScreens([Screen]);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r));
    show(Screen);
    expect(await screen.findByRole('heading', { name: 'Goals' })).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('waits while offline, and tries a screen lost to the connection dropping again once back', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    // The first fails as the connection drops again.
    const first = vi
      .fn<() => Promise<{ default: typeof Goals }>>()
      .mockImplementationOnce(() => {
        online.mockReturnValue(false);
        return offline();
      })
      .mockResolvedValue({ default: Goals });
    const second = vi.fn(() => Promise.resolve({ default: Goals }));
    preloadScreens([lazyScreen(first), lazyScreen(second)]);
    await new Promise((r) => setTimeout(r, 300));
    expect(first).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 300));
    expect(second).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(first).toHaveBeenCalledTimes(2);
  });

  it('moves on from a screen that fails while online, rather than asking for it forever', async () => {
    const first = vi.fn(offline);
    const second = vi.fn(() => Promise.resolve({ default: Goals }));
    preloadScreens([lazyScreen(first), lazyScreen(second)]);
    await waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('stops when asked', async () => {
    const load = vi.fn(() => Promise.resolve({ default: Goals }));
    const stop = preloadScreens([lazyScreen(load)]);
    stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(load).not.toHaveBeenCalled();
  });

  it('happens in the browser, whose screens come from the server, and not in the apps, which carry them', async () => {
    const web = vi.spyOn(AREAS.today.Screen as ReturnType<typeof lazyScreen>, 'preload');
    await renderApp({ kind: 'web' });
    await waitFor(() => expect(web).toHaveBeenCalled());
    cleanup();
    web.mockClear();
    for (const kind of ['ios', 'electron'] as const) {
      await renderApp({ kind });
      await screen.findByRole('navigation', { name: 'Main' });
      await new Promise((r) => setTimeout(r, 300));
      expect(web).not.toHaveBeenCalled();
      cleanup();
    }
  });
});
