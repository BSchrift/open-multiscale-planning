import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useKeyboardInset } from './keyboard';

/** Stands in for window.visualViewport, which shrinks when the keyboard opens. */
function fakeViewport(height: number) {
  const listeners = new Set<() => void>();
  const vv = {
    height,
    offsetTop: 0,
    addEventListener: (_: string, l: () => void) => void listeners.add(l),
    removeEventListener: (_: string, l: () => void) => void listeners.delete(l),
    change(next: { height: number; offsetTop?: number }) {
      vv.height = next.height;
      vv.offsetTop = next.offsetTop ?? 0;
      listeners.forEach((l) => l());
    },
  };
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  return vv;
}

describe('the keyboard inset', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'visualViewport');
    document.documentElement.style.removeProperty('--keyboard');
  });
  const inset = () => document.documentElement.style.getPropertyValue('--keyboard');

  it('says how much of the page the keyboard covers, and nothing once it closes', () => {
    const vv = fakeViewport(window.innerHeight);
    const hook = renderHook(() => useKeyboardInset());
    expect(inset()).toBe('0px');
    act(() => vv.change({ height: window.innerHeight - 336 }));
    expect(inset()).toBe('336px');
    // The page scrolled up under the keyboard, so less of the bottom is covered.
    act(() => vv.change({ height: window.innerHeight - 336, offsetTop: 100 }));
    expect(inset()).toBe('236px');
    act(() => vv.change({ height: window.innerHeight }));
    expect(inset()).toBe('0px');
    hook.unmount();
    expect(inset()).toBe('');
  });

  it('does nothing where there is no visual viewport', () => {
    renderHook(() => useKeyboardInset());
    expect(inset()).toBe('');
  });
});
