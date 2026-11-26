// A day gone by on the phone's Today has a row that opens Done on that day, whose count is its own read, which can come
// after the day has drawn. Its place is kept from the start, so the day under it never moves when the count arrives.

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localToInstant } from '../../../core/dates';
import { weekPlanId } from '../../../core/records';
import { renderScreen } from '../../app/testing';

// The week's finished counts, held back until a test lets them through.
let release: () => void = () => undefined;
vi.mock('../done/data', async (actual) => {
  const real = await actual<typeof import('../done/data')>();
  return {
    ...real,
    loadDoneWeek: (...args: Parameters<typeof real.loadDoneWeek>) =>
      new Promise<Awaited<ReturnType<typeof real.loadDoneWeek>>>((resolve) => {
        release = () => void real.loadDoneWeek(...args).then(resolve);
      }),
  };
});

afterEach(cleanup);

const ZONE = 'America/Chicago';
const WED = '2026-11-04';

describe("a day gone by on the phone's Today", () => {
  it('keeps the place of its Done row while the count is read, so the day under it stays put', async () => {
    await renderScreen('today', {
      layout: 'phone',
      zone: ZONE,
      now: localToInstant(WED, 14 * 60, ZONE),
      seed: (w) => w.create('week_plan', { week_start: '2026-11-02', finished_at: localToInstant('2026-11-02', 8 * 60, ZONE) }, weekPlanId('2026-11-02')),
    });
    await userEvent.click(within(await screen.findByRole('group', { name: 'Choose a day' }, { timeout: 5000 })).getByRole('button', { name: /^Mon Nov 2/ }));
    await screen.findByRole('heading', { level: 1, name: 'Monday' });
    // Before the count: the row's place, the same row, kept from screen readers and taps.
    const held = document.querySelector('.tdpaged > .tdrow');
    expect(held).not.toBeNull();
    expect(held).toHaveAttribute('aria-hidden', 'true');
    expect(held!.nextElementSibling).toHaveClass('tdpager');
    release();
    // The count in, the row takes the same place.
    const row = await screen.findByRole('button', { name: 'Done on Mon Nov 2: nothing finished' });
    expect(row).toHaveClass('tdrow');
    expect(row.nextElementSibling).toHaveClass('tdpager');
    await waitFor(() => expect(document.querySelectorAll('.tdpaged > .tdrow')).toHaveLength(1));
  });
});
