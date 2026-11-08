import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHOW_COMPLETED_KEY, useShowCompleted, useShowCompletedState } from './showCompleted';

afterEach(() => vi.restoreAllMocks());

// Show completed's own toggle, as in components/ShowCompleted.tsx.
const toggle = () => renderHook(() => useShowCompletedState());

describe('show completed', () => {
  it('hides completed tasks by default', () => {
    expect(renderHook(() => useShowCompleted()).result.current).toBe(false);
  });

  it('flips for every list at once, and is kept on this device', () => {
    const show = toggle();
    const first = renderHook(() => useShowCompleted());
    const second = renderHook(() => useShowCompleted());
    act(() => show.result.current[1](true));
    expect(first.result.current).toBe(true);
    expect(second.result.current).toBe(true);
    expect(localStorage.getItem(SHOW_COMPLETED_KEY)).toBe('true');

    act(() => show.result.current[1](false));
    expect(first.result.current).toBe(false);
    expect(localStorage.getItem(SHOW_COMPLETED_KEY)).toBe('false');
  });

  it('reads back what this device kept, as after a restart, including what earlier versions kept', () => {
    localStorage.setItem(SHOW_COMPLETED_KEY, 'true');
    expect(renderHook(() => useShowCompleted()).result.current).toBe(true);
    localStorage.setItem(SHOW_COMPLETED_KEY, 'nonsense');
    expect(renderHook(() => useShowCompleted()).result.current).toBe(false);
  });

  it('holds a choice for this session when storage is blocked', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const show = toggle();
    const { result } = renderHook(() => useShowCompleted());
    act(() => show.result.current[1](true));
    expect(result.current).toBe(true);
  });
});
