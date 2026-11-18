import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EST_STEPS, EstimateSlider } from './EstimateSlider';

afterEach(cleanup);

/** Moves the thumb step by step, as a drag does: an input event at each step, named by its minutes. */
const move = (slider: HTMLElement, minutes: number[]) => {
  for (const m of minutes) fireEvent.input(slider, { target: { value: String(EST_STEPS.indexOf(m)) } });
};

describe('EstimateSlider', () => {
  it('moves in 5-minute steps up to 2h', () => {
    const onChange = vi.fn();
    render(<EstimateSlider label="Time" value={60} onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: 'Time' });
    // One arrow key to the right, as a browser sends it: the next step's index.
    fireEvent.input(slider, { target: { value: String(Number((slider as HTMLInputElement).value) + 1) } });
    expect(slider).toHaveAttribute('aria-valuetext', '1h 5m');
    fireEvent.change(slider);
    expect(onChange.mock.calls).toEqual([[65]]);
  });

  it('follows a drag step by step, and passes the value on once, when it is let go', () => {
    const onChange = vi.fn();
    render(<EstimateSlider label="Time" value={60} onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: 'Time' });
    move(slider, [75, 90, 105, 120]);
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
    move(slider, [75, 90, 105, 120]);
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
    move(slider, [75, 90, 105, 120]);
    fireEvent.change(slider);
    rerender(<EstimateSlider label="Time" value={120} onChange={onChange} />);
    rerender(<EstimateSlider label="Time" value={60} onChange={onChange} />);
    expect(slider).toHaveAttribute('aria-valuetext', '1h');
    expect(slider).toHaveValue(String(EST_STEPS.indexOf(60)));
  });

  it('passes on each arrow key, which browsers send as an input and a change event', () => {
    const onChange = vi.fn();
    render(<EstimateSlider label="Time" value={60} onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: 'Time' });
    move(slider, [75]);
    fireEvent.change(slider);
    move(slider, [90]);
    fireEvent.change(slider);
    expect(onChange.mock.calls).toEqual([[75], [90]]);
  });

  it('passes the value on when it loses focus if no change event came, and only once', () => {
    const onChange = vi.fn();
    render(<EstimateSlider label="Time" value={60} onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: 'Time' });
    move(slider, [105, 120]);
    fireEvent.blur(slider);
    fireEvent.change(slider);
    expect(onChange.mock.calls).toEqual([[120]]);
  });

  it('passes nothing on for a drag that ends where it started, and a value between steps reads as it is', () => {
    const onChange = vi.fn();
    render(<EstimateSlider label="Time left" value={52} onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: 'Time left' });
    expect(slider).toHaveAttribute('aria-valuetext', '52m');
    move(slider, [55, 60, 55, 50]);
    expect(slider).toHaveAttribute('aria-valuetext', '50m');
    fireEvent.change(slider);
    fireEvent.blur(slider);
    expect(onChange).not.toHaveBeenCalled();
    expect(slider).toHaveAttribute('aria-valuetext', '52m');
  });
});
