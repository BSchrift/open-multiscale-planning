import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setShowCompleted, useShowCompleted } from './showCompleted';

afterEach(() => {
  vi.restoreAllMocks();
  act(() => setShowCompleted(false));
});

describe('show completed', () => {
  it('hides completed tasks by default', () => {
    expect(renderHook(() => useShowCompleted()).result.current).toBe(false);
  });

  it('flips for every list at once, and is kept on this device', () => {
    const first = renderHook(() => useShowCompleted());
    const second = renderHook(() => useShowCompleted());
    act(() => setShowCompleted(true));
    expect(first.result.current).toBe(true);
    expect(second.result.current).toBe(true);
    expect(localStorage.getItem('multiscale.showCompleted')).toBe('true');

    act(() => setShowCompleted(false));
    expect(first.result.current).toBe(false);
    expect(localStorage.getItem('multiscale.showCompleted')).toBeNull();
  });

  it('reads back what this device kept, as after a restart', () => {
    localStorage.setItem('multiscale.showCompleted', 'true');
    expect(renderHook(() => useShowCompleted()).result.current).toBe(true);
    localStorage.setItem('multiscale.showCompleted', 'nonsense');
    expect(renderHook(() => useShowCompleted()).result.current).toBe(false);
  });

  it('holds a choice for this session when storage is blocked', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useShowCompleted());
    act(() => setShowCompleted(true));
    expect(result.current).toBe(true);
  });
});
