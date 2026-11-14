// Screens whose code loads on first use rather than with the app, and what shows when one fails. In the browser that
// code comes from the server, so a screen first opened offline can't load until the connection is back.

import { Component, createElement, lazy } from 'react';
import type { ComponentType, MouseEvent, ReactNode } from 'react';
import type { ScreenProps } from './registry';

type ScreenModule = { default: ComponentType<ScreenProps> };

/** A screen's code didn't arrive, so opening it again can work, unlike a screen that failed as it drew. */
class ScreenLoadError extends Error {
  override name = 'ScreenLoadError';
}

export interface LazyScreen {
  (props: ScreenProps): ReactNode;
  /** Loads the code now, saying whether it arrived. A failure is left for opening the screen to try again. */
  preload(): Promise<boolean>;
}

// React.lazy keeps a failed load for good, so each screen that failed swaps in a fresh one to try again.
const failed = new Set<() => void>();

export function lazyScreen(load: () => Promise<ScreenModule>): LazyScreen {
  let loading: Promise<ScreenModule> | undefined;
  const fail = (cause: unknown) => {
    failed.add(reset);
    return new ScreenLoadError('A screen failed to load', { cause });
  };
  const get = () => {
    if (loading) return loading;
    // Offline, the browser doesn't ask the server at all: a fetch that fails can stay failed for the page's life, in
    // Safari's modules and in the stylesheet Vite adds only once. The apps load their code from themselves.
    // shortcut: one that fails while the browser says it's online, such as behind a captive portal, can stay failed
    // like that until a reload; reload on Try again if that shows up.
    if (!navigator.onLine && /^https?:$/.test(location.protocol)) return Promise.reject(fail('offline'));
    return (loading = load().catch((error: unknown) => {
      loading = undefined;
      throw fail(error);
    }));
  };
  let Lazy = lazy(get);
  const reset = () => {
    Lazy = lazy(get);
  };
  const Screen = (props: ScreenProps) => createElement(Lazy, props);
  return Object.assign(Screen, { preload: () => get().then(() => true, () => false) });
}

function retryFailedScreens() {
  for (const reset of failed) reset();
  failed.clear();
}

// Safari has no requestIdleCallback.
const whenIdle = (fn: () => void): (() => void) => {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(fn);
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(fn, 100);
  return () => clearTimeout(handle);
};

/**
 * Loads each screen's code in turn while the browser is idle, starting with the first once it's loaded, so a screen
 * opened later, even offline, has its code already. Offline, it waits to be back rather than ask for what can't arrive,
 * then tries again a screen lost to the connection dropping. Returns a function that stops it.
 */
export function preloadScreens(screens: readonly { preload?: () => Promise<boolean> }[]): () => void {
  let stopped = false;
  let cancel = () => {};
  const step = (i: number) => {
    const screen = screens[i];
    if (stopped || !screen) return;
    if (!navigator.onLine) {
      const resume = () => step(i);
      window.addEventListener('online', resume, { once: true });
      cancel = () => window.removeEventListener('online', resume);
      return;
    }
    cancel = whenIdle(() => {
      // One that failed online, such as a file the server no longer has, is left for opening it to try again.
      void (screen.preload?.() ?? Promise.resolve(true)).then((loaded) => step(loaded || navigator.onLine ? i + 1 : i));
    });
  };
  step(0);
  return () => {
    stopped = true;
    cancel();
  };
}

/** Catches a screen that fails. One whose code didn't arrive tries again when asked, and once back online. */
export class ScreenBoundary extends Component<{ children: ReactNode }, { failed: 'load' | 'draw' | null }> {
  override state: { failed: 'load' | 'draw' | null } = { failed: null };
  static getDerivedStateFromError(error: unknown) {
    return { failed: error instanceof ScreenLoadError ? 'load' : 'draw' };
  }
  override componentDidCatch(error: unknown) {
    console.error('Screen failed', error);
  }
  override componentDidMount() {
    window.addEventListener('online', this.onOnline);
  }
  override componentWillUnmount() {
    window.removeEventListener('online', this.onOnline);
  }
  private onOnline = () => {
    if (this.state.failed === 'load') this.retry();
  };
  private retry = () => {
    retryFailedScreens();
    this.setState({ failed: null });
  };
  private onTryAgain = (event: MouseEvent<HTMLButtonElement>) => {
    // The button goes as the screen loads, so focus moves to the page around it rather than falling to the body.
    event.currentTarget.closest<HTMLElement>('[tabindex="-1"]')?.focus({ preventScroll: true });
    this.retry();
  };
  override render() {
    if (!this.state.failed) return this.props.children;
    if (this.state.failed === 'load') {
      return (
        <div role="alert" className="stack8">
          <h1>Couldn't open this screen</h1>
          <p className="quiet">It will try again when you're back online.</p>
          <div>
            <button className="btn" type="button" onClick={this.onTryAgain}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return (
      <div role="alert" className="stack8">
        <h1>Something went wrong</h1>
        <p className="quiet">Your data is safe. Restart the app to try again.</p>
      </div>
    );
  }
}
