import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { holdDown } from '../../app/testing';
import { HOLD_MS, holdToDrag } from './drop';

/** A block with holdToDrag on its press and a click of its own, noting what each part of a press calls. */
function block(pointerType = 'mouse') {
  const calls: string[] = [];
  const { container } = render(
    <button
      type="button"
      onPointerDown={(e) =>
        holdToDrag(e, {
          lift: () => calls.push('lift'),
          drag: (dx, dy) => calls.push(`drag ${dx},${dy}`),
          drop: () => calls.push('drop'),
          tap: () => calls.push('tap'),
          cancel: () => calls.push('cancel'),
          haptic: () => calls.push('haptic'),
        })
      }
      onClick={() => calls.push('click')}
    >
      Write the report
    </button>,
  );
  const el = container.querySelector('button')!;
  const at = { pointerId: 1, pointerType, button: 0 };
  return {
    calls,
    el,
    down: () => fireEvent.pointerDown(el, { ...at, clientX: 100, clientY: 100 }),
    hold: () => holdDown(el, { ...at, clientX: 100, clientY: 100 }),
    move: (x: number, y: number) => fireEvent.pointerMove(window, { ...at, clientX: x, clientY: y }),
    up: (x: number, y: number) => {
      fireEvent.pointerUp(window, { ...at, clientX: x, clientY: y });
      fireEvent.click(el);
    },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('a press on a block that moves', () => {
  it('is a click when let go before the hold, however the mouse wobbled', () => {
    const b = block();
    b.down();
    b.move(103, 104);
    b.move(110, 112);
    b.up(110, 112);
    expect(b.calls).toEqual(['tap', 'click']);
  });

  it('lifts after the hold with a mouse too, drags from the press once past a wobble, and swallows the click after the drop', () => {
    const b = block();
    b.hold();
    b.move(102, 103);
    expect(b.calls).toEqual(['lift']);
    b.move(100, 130);
    b.up(100, 130);
    // A mouse gives no tap from the device.
    expect(b.calls).toEqual(['lift', 'drag 0,30', 'drop']);
  });

  it('lifts on its timer, and let go in place opens nothing', () => {
    vi.useFakeTimers();
    const b = block();
    b.down();
    vi.advanceTimersByTime(HOLD_MS);
    expect(b.calls).toEqual(['lift']);
    b.up(100, 100);
    expect(b.calls).toEqual(['lift', 'cancel']);
  });

  it('lets a finger that moves before the hold scroll, and lifts with a tap from the device after one', () => {
    vi.useFakeTimers();
    const swipe = block('touch');
    swipe.down();
    swipe.move(100, 112);
    vi.advanceTimersByTime(HOLD_MS);
    swipe.move(100, 160);
    expect(swipe.calls).toEqual([]);

    const held = block('touch');
    held.down();
    vi.advanceTimersByTime(HOLD_MS);
    held.move(100, 140);
    held.up(100, 140);
    expect(held.calls).toEqual(['haptic', 'lift', 'drag 0,40', 'drop']);
  });

  it('lets go when the browser takes the press back', () => {
    const b = block('touch');
    b.hold();
    b.move(100, 140);
    fireEvent.pointerCancel(window, { pointerId: 1, pointerType: 'touch' });
    b.move(100, 180);
    expect(b.calls).toEqual(['haptic', 'lift', 'drag 0,40', 'cancel']);
  });
});
