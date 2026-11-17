import { describe, expect, it } from 'vitest';
import { anchorShift, fitZoom, pinched } from './pinch';

describe("pinching a day's calendar", () => {
  it('scales the zoom by how far the fingers have spread, within its limits', () => {
    expect(pinched(1, 100, 150, 0.5, 3)).toBe(1.5);
    expect(pinched(2, 100, 50, 0.5, 3)).toBe(1);
    // Spread past three times the usual, or pinched past the whole day, it stops there.
    expect(pinched(1, 100, 500, 0.5, 3)).toBe(3);
    expect(pinched(1, 100, 10, 0.5, 3)).toBe(0.5);
  });

  it('is smallest where the whole drawn day fits the room left for it', () => {
    // A day drawn 816px tall at the usual size fits 408px at half of it.
    expect(fitZoom(408, 816)).toBe(0.5);
  });

  it('scrolls so the time between the fingers stays under them', () => {
    // 40% down a row now drawn from 300px to 500px is 380px; the fingers are at 350px, so the page scrolls 30px on.
    expect(anchorShift(0.4, 300, 200, 350)).toBe(30);
    expect(anchorShift(0.5, 100, 100, 150)).toBe(0);
  });
});
