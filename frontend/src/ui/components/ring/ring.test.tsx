import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ringColor } from '../../../core/capacity';
import { CapacityRing, useRingPop } from './CapacityRing';
import type { RingPop } from './CapacityRing';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const pop = (over: Partial<RingPop> = {}): RingPop => ({ shownOld: 120, shownNew: 240, to: 240, delta: 120, fading: false, ...over });

describe('CapacityRing', () => {
  it('shows the change in the middle, coloured by how full the week is', () => {
    const { container } = render(<CapacityRing pop={pop()} open={480} />);
    expect(screen.getByText('+2h')).toBeInTheDocument();
    const arc = container.querySelector<SVGCircleElement>('.dold')!;
    expect(arc.style.stroke).toBe(ringColor(0.5));
    expect(container.querySelector('.donut')).toHaveAttribute('aria-hidden', 'true');
  });

  it('says a removal with a minus sign', () => {
    render(<CapacityRing pop={pop({ delta: -90, to: 60 })} open={480} />);
    expect(screen.getByText('−1h 30m')).toBeInTheDocument();
  });

  it('past full it is solid red, hatches the excess and says how much over', () => {
    const { container } = render(<CapacityRing pop={pop({ to: 540 })} open={480} />);
    expect(screen.getByText('1h over')).toBeInTheDocument();
    expect(container.querySelector('.dold')!.getAttribute('style')).toContain(ringColor(1));
    expect(container.querySelector('.dover')).not.toBeNull();
  });

  it('is smaller when a sheet is up, and fades', () => {
    const { container } = render(<CapacityRing pop={pop({ fading: true })} open={480} small />);
    expect(container.querySelector('.donut')).toHaveClass('small', 'fading');
  });
});

describe('useRingPop', () => {
  function Probe() {
    const ring = useRingPop();
    return (
      <div>
        <button type="button" onClick={() => ring.pulse(0, 120, false)}>first</button>
        <button type="button" onClick={() => ring.pulse(120, 360, false)}>second</button>
        <button type="button" onClick={() => ring.pulse(360, 600, true)}>over</button>
        {ring.pop && <CapacityRing pop={ring.pop} open={480} />}
      </div>
    );
  }

  it('merges rapid changes into one ring, then fades it out', () => {
    vi.useFakeTimers();
    const { container } = render(<Probe />);
    expect(container.querySelector('.donut')).toBeNull();
    act(() => screen.getByText('first').click());
    expect(screen.getByText('+2h')).toBeInTheDocument();
    act(() => screen.getByText('second').click());
    expect(screen.getByText('+6h')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1500));
    expect(container.querySelector('.donut')).toHaveClass('fading');
    act(() => vi.advanceTimersByTime(300));
    expect(container.querySelector('.donut')).toBeNull();
  });

  it('holds longer when the week is over full', () => {
    vi.useFakeTimers();
    const { container } = render(<Probe />);
    act(() => screen.getByText('over').click());
    act(() => vi.advanceTimersByTime(1800));
    expect(container.querySelector('.donut')).not.toHaveClass('fading');
    act(() => vi.advanceTimersByTime(800));
    expect(container.querySelector('.donut')).toHaveClass('fading');
  });
});
