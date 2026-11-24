import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ZoomButtons } from './CalendarZoom';
import { clampZoom, hourHeight, hourLabelStep, ZOOM } from './zoom';

afterEach(cleanup);

describe("a calendar's zoom", () => {
  it("has Today's four steps, as multiples of a calendar's usual hour", () => {
    // Today's hour is 30px: 30, 48, 72 and 96px an hour.
    expect(ZOOM.map((z) => hourHeight(30, z))).toEqual([30, 48, 72, 96]);
    // Week's is 26px, or 40 while editing: each to a whole pixel.
    expect(ZOOM.map((z) => hourHeight(26, z))).toEqual([26, 42, 62, 83]);
    expect(ZOOM.map((z) => hourHeight(40, z))).toEqual([40, 64, 96, 128]);
  });

  it('keeps a pinch within its first and last steps', () => {
    expect(clampZoom(0.5)).toBe(1);
    expect(clampZoom(2)).toBe(2);
    expect(clampZoom(5)).toBe(3.2);
  });

  it('labels every other hour until an hour is drawn 48px tall, then every hour', () => {
    expect(hourLabelStep(26)).toBe(2);
    expect(hourLabelStep(47)).toBe(2);
    expect(hourLabelStep(48)).toBe(1);
    expect(hourLabelStep(128)).toBe(1);
  });

  it('steps in and out a step at a time with named buttons, each stopping at its end, from wherever a pinch left it', async () => {
    let seen = 0;
    function Zoomed(props: { from: number }) {
      const [zoom, setZoom] = useState(props.from);
      seen = zoom;
      return <ZoomButtons zoom={zoom} onZoom={setZoom} />;
    }
    render(<Zoomed from={ZOOM[0]!} />);
    const group = screen.getByRole('group', { name: 'Calendar zoom' });
    const [zoomOut, zoomIn] = [screen.getByRole('button', { name: 'Zoom out' }), screen.getByRole('button', { name: 'Zoom in' })];
    expect(group).toContainElement(zoomOut);
    expect(zoomOut).toHaveAttribute('title', 'Zoom out');
    expect(zoomIn).toHaveAttribute('title', 'Zoom in');
    expect(zoomOut).toBeDisabled();
    for (const step of [1.6, 2.4, 3.2]) {
      await userEvent.click(zoomIn);
      expect(seen).toBe(step);
    }
    expect(zoomIn).toBeDisabled();
    for (const step of [2.4, 1.6, 1]) {
      await userEvent.click(zoomOut);
      expect(seen).toBe(step);
    }
    expect(zoomOut).toBeDisabled();
    cleanup();
    // Between steps, as a pinch leaves it, each button goes to the next step its way.
    render(<Zoomed from={2} />);
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(seen).toBe(2.4);
    cleanup();
    render(<Zoomed from={2} />);
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(seen).toBe(1.6);
  });
});
