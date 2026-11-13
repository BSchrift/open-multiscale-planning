import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EstimateSlider } from './EstimateSlider';

afterEach(cleanup);

/** Moves the thumb step by step, as a drag does: an input event at each step. */
const move = (slider: HTMLElement, steps: number[]) => {
  for (const step of steps) fireEvent.input(slider, { target: { value: String(step) } });
};

describe('EstimateSlider', () => {
  it('follows a drag step by step, and passes the value on once, when it is let go', () => {
    const onChange = vi.fn();
    render(<EstimateSlider label="Time" value={60} onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: 'Time' });
    move(slider, [5, 6, 7, 8]);
    expect(onChange).not.toHaveBeenCalled();
    expect(slider).toHaveAttribute('aria-valuetext', '2h');
    expect(screen.getByText('2h')).toBeInTheDocument();
    // Letting go sends a change event.
    fireEvent.change(slider);
    expect(onChange.mock.calls).toEqual([[120]]);
  });

  it('keeps the thumb where it was let go while a saved value is read back, and shows a value from elsewhere', () => {
    const onChange = vi.fn();
    const { rerender } = render(<EstimateSlider label="Time" value={60} onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: 'Time' });
    move(slider, [5, 6, 7, 8]);
    fireEvent.change(slider);
    rerender(<EstimateSlider label="Time" value={60} onChange={onChange} />);
    expect(slider).toHaveAttribute('aria-valuetext', '2h');
    rerender(<EstimateSlider label="Time" value={120} onChange={onChange} />);
    expect(slider).toHaveAttribute('aria-valuetext', '2h');
    // Such as a sync.
    rerender(<EstimateSlider label="Time" value={30} onChange={onChange} />);
    expect(slider).toHaveAttribute('aria-valuetext', '30m');
  });

  it('shows the old value when it comes back after a save, as an Undo does', () => {
    const onChange = vi.fn();
    const { rerender } = render(<EstimateSlider label="Time" value={60} onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: 'Time' });
    move(slider, [5, 6, 7, 8]);
    fireEvent.change(slider);
    rerender(<EstimateSlider label="Time" value={120} onChange={onChange} />);
    rerender(<EstimateSlider label="Time" value={60} onChange={onChange} />);
    expect(slider).toHaveAttribute('aria-valuetext', '1h');
    expect(slider).toHaveValue('4');
  });

  it('passes on each arrow key, which browsers send as an input and a change event', () => {
    const onChange = vi.fn();
    render(<EstimateSlider label="Time" value={60} onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: 'Time' });
    move(slider, [5]);
    fireEvent.change(slider);
    move(slider, [6]);
    fireEvent.change(slider);
    expect(onChange.mock.calls).toEqual([[75], [90]]);
  });

  it('passes the value on when it loses focus if no change event came, and only once', () => {
    const onChange = vi.fn();
    render(<EstimateSlider label="Time" value={60} onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: 'Time' });
    move(slider, [7, 8]);
    fireEvent.blur(slider);
    fireEvent.change(slider);
    expect(onChange.mock.calls).toEqual([[120]]);
  });

  it('passes nothing on for a drag that ends where it started, and a value between steps reads as it is', () => {
    const onChange = vi.fn();
    render(<EstimateSlider label="Time left" value={50} onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: 'Time left' });
    expect(slider).toHaveAttribute('aria-valuetext', '50m');
    move(slider, [4, 5, 4, 3]);
    expect(slider).toHaveAttribute('aria-valuetext', '45m');
    fireEvent.change(slider);
    fireEvent.blur(slider);
    expect(onChange).not.toHaveBeenCalled();
    expect(slider).toHaveAttribute('aria-valuetext', '50m');
  });
});
