import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRecord } from '../../../core/records';
import type { Writer } from '../../../core/records';
import type { Practice } from '../../../core/types';
import { renderScreen } from '../../app/testing';
import { practiceRule } from './PracticeEditor';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const FRI_930 = [null, null, null, null, 570, null, null];

describe('practiceRule', () => {
  const p = (over: Partial<Practice>): Practice => ({ id: 'p', title: 'Run', target_min: 30, per: 'day', state: 'active', preferred_times: [420], ...over });
  it.each<[string, Partial<Practice>]>([
    ['15m every day, around 9pm', { target_min: 15, preferred_times: [1260] }],
    ['20m every weekday, around 7am', { target_min: 20, days: [0, 1, 2, 3, 4] }],
    ['30m on Mon, Tue and Fri, around 7am', { days: [0, 1, 4] }],
    ['30m on Mon and Tue around 7am, Fri around 9:30am', { days: [0, 1, 4], day_times: FRI_930 }],
    ['15m every day: weekdays around 7am, weekends around 9am', { target_min: 15, day_times: [null, null, null, null, null, 540, 540] }],
    ['3 times a week, 1h each, around 6pm', { per: 'week', target_min: 180, sessions: 3, preferred_times: [1080] }],
    ['3 times a week, 1h each, preferably on Mon, Wed and Fri, around 6pm', { per: 'week', target_min: 180, sessions: 3, days: [0, 2, 4], preferred_times: [1080] }],
    ['45m on weekends, any time', { target_min: 45, days: [5, 6], preferred_times: [] }],
    ['3 times a week, 45m each, around 7am', { per: 'week', target_min: 130 }],
  ])('%s', (text, over) => expect(practiceRule(p(over))).toBe(text));

  it('has a spoken form', () => {
    expect(practiceRule(p({ days: [0, 1, 4], day_times: FRI_930 }), true)).toBe('30 minutes on Monday and Tuesday around 7 AM, Friday around 9:30 AM');
  });
});

// The harness clock is Monday Nov 2, 2026, in Chicago.
async function run(w: Writer, fields: Partial<Practice> = {}) {
  await w.create('practice', { title: 'Morning run', target_min: 30, per: 'day', state: 'active', preferred_times: [420], ...fields }, 'pr1');
}

/** Opens Morning run's editor: its row on desktop, its sheet on phone. */
async function open(fields: Partial<Practice> = {}, layout: 'desktop' | 'phone' = 'desktop') {
  const t = await renderScreen('goals', { layout, seed: (w) => run(w, fields) });
  await userEvent.click(await screen.findByRole('button', { name: /Practices with no goal/ }));
  const row = screen.getByRole('button', { name: /^Morning run/ });
  await userEvent.click(row);
  const editor = layout === 'phone' ? screen.getByRole('dialog', { name: 'Edit practice' }) : screen.getByRole('group', { name: 'Edit Morning run' });
  const days = () => within(editor).getByRole('group', { name: /^(Days|Preferred days)$/ });
  const day = (name: string) => within(days()).getByRole('checkbox', { name });
  const save = async () => userEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  const read = () => getRecord(t.db, 'practice', 'pr1');
  return { t, row, editor, days, day, save, read };
}

describe('the practice editor', () => {
  it('makes every weekday at 7am in two taps, stored as before', async () => {
    const e = await open();
    expect(within(e.editor).getByRole('radio', { name: 'Set days' })).toBeChecked();
    expect(within(e.days()).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
    await userEvent.click(within(e.days()).getByRole('button', { name: 'Weekdays' }));
    expect(within(e.editor).getByText('30m every weekday, around 7am')).toBeVisible();
    await e.save();
    expect(await screen.findByText('Saved Morning run: 30m every weekday, around 7am.')).toBeVisible();
    expect(await e.read()).toMatchObject({ per: 'day', days: [0, 1, 2, 3, 4], target_min: 30, preferred_times: [420] });
  });

  it('makes Mon, Tue and Fri with Friday at 9:30, and Undo puts back what it opened with', async () => {
    const e = await open({ days: [0, 1, 2, 3, 4] });
    for (const name of ['Wednesday', 'Thursday']) await userEvent.click(e.day(name));
    await userEvent.click(within(e.editor).getByRole('switch', { name: 'Different time on some days' }));
    const rows = within(e.editor).getByRole('group', { name: 'Time on each day' });
    expect(within(rows).getByLabelText('Friday')).toHaveAccessibleDescription('Usual time');
    fireEvent.change(within(rows).getByLabelText('Friday'), { target: { value: '09:30' } });
    expect(within(rows).getByRole('button', { name: 'Use the usual time, 7 AM, on Friday' })).toHaveTextContent('Use 7am');
    expect(within(e.editor).getByText('30m on Mon and Tue around 7am, Fri around 9:30am')).toBeVisible();
    await e.save();
    expect(await screen.findByText('Saved Morning run: 30m on Mon and Tue around 7am, Fri around 9:30am.')).toBeVisible();
    expect(await e.read()).toMatchObject({ per: 'day', days: [0, 1, 4], day_times: FRI_930, preferred_times: [420] });
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await e.read()).toMatchObject({ days: [0, 1, 2, 3, 4], day_times: null }));
  });

  it("Use 7am puts a day back to the usual time, and the switch off leaves the days' times out until it's on again", async () => {
    const e = await open({ days: [0, 1, 4], day_times: FRI_930 });
    const rows = () => within(e.editor).getByRole('group', { name: 'Time on each day' });
    const sw = within(e.editor).getByRole('switch', { name: 'Different time on some days' });
    expect(sw).toBeChecked();
    await userEvent.click(sw);
    expect(within(e.editor).queryByRole('group', { name: 'Time on each day' })).toBeNull();
    expect(within(e.editor).getByText('30m on Mon, Tue and Fri, around 7am')).toBeVisible();
    await userEvent.click(sw);
    expect(within(rows()).getByLabelText('Friday')).toHaveValue('09:30');
    await userEvent.click(within(rows()).getByRole('button', { name: 'Use the usual time, 7 AM, on Friday' }));
    expect(within(rows()).getByLabelText('Friday')).toHaveFocus();
    expect(within(rows()).getByLabelText('Friday')).toHaveValue('07:00');
    await userEvent.click(sw);
    await e.save();
    await screen.findByText('Saved Morning run: 30m on Mon, Tue and Fri, around 7am.');
    expect((await e.read())?.day_times).toBeNull();
  });

  it('makes 3 times a week, any days, and switching back keeps the days', async () => {
    const e = await open({ days: [0, 1, 4] });
    await userEvent.click(within(e.editor).getByRole('radio', { name: 'Times a week' }));
    // The count starts at the number of days chosen, and the days stay as the ones to go first.
    expect(e.editor.querySelector('.stepval')).toHaveTextContent('3 times a week');
    expect(e.day('Friday')).toBeChecked();
    await userEvent.click(within(e.editor).getByRole('radio', { name: 'Set days' }));
    expect(within(e.days()).getAllByRole('checkbox', { checked: true }).map((c) => c.getAttribute('aria-label'))).toEqual(['Monday', 'Tuesday', 'Friday']);
    await userEvent.click(within(e.editor).getByRole('radio', { name: 'Times a week' }));
    await userEvent.click(within(e.days()).getByRole('button', { name: 'Every day' }));
    expect(within(e.editor).getByText(/^On any days\. Planning spreads them out, one a day at most\.$/)).toBeVisible();
    expect(within(e.editor).getByText('3 sessions, 1h 30m a week')).toBeVisible();
    await e.save();
    expect(await e.read()).toMatchObject({ per: 'week', target_min: 90, sessions: 3, days: [0, 1, 2, 3, 4, 5, 6] });
  });

  it('a count can prefer some days, which planning tries first', async () => {
    const e = await open({ per: 'week', target_min: 90, sessions: 3 });
    expect(within(e.editor).getByRole('radio', { name: 'Times a week' })).toBeChecked();
    for (const name of ['Tuesday', 'Thursday', 'Saturday', 'Sunday']) await userEvent.click(e.day(name));
    expect(within(e.editor).getByText(/^Mon, Wed and Fri first\. Planning spreads them out/)).toBeVisible();
    expect(within(e.editor).getByText('3 times a week, 30m each, preferably on Mon, Wed and Fri, around 7am')).toBeVisible();
    await e.save();
    expect(await e.read()).toMatchObject({ per: 'week', target_min: 90, sessions: 3, days: [0, 2, 4] });
  });

  it('the count goes from 1 to 7, says each press, and says why at a limit without losing focus', async () => {
    const e = await open({ per: 'week', target_min: 60, sessions: 1 });
    const fewer = within(e.editor).getByRole('button', { name: 'One fewer time a week' });
    expect(fewer).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(fewer);
    expect(fewer).toHaveFocus();
    expect(within(e.editor).getByText('1 time a week is the least.')).toBeInTheDocument();
    await userEvent.click(within(e.editor).getByRole('button', { name: 'One more time a week' }));
    expect(within(e.editor).getByText('2 times a week', { selector: '[aria-live]' })).toBeInTheDocument();
    expect(fewer).toHaveAttribute('aria-disabled', 'false');
  });

  it('Save with no days keeps it open, says so under the chips, and puts focus on Monday', async () => {
    const e = await open({ days: [0] });
    await userEvent.click(e.day('Monday'));
    expect(within(e.editor).getByText('30m, no days chosen')).toBeVisible();
    await e.save();
    expect(e.day('Monday')).toHaveFocus();
    expect(e.day('Monday')).toHaveAccessibleDescription('Choose at least one day.');
    expect(screen.getByRole('group', { name: 'Edit Morning run' })).toBe(e.editor);
    expect((await e.read())?.days).toEqual([0]);
  });

  it('opening an older weekly practice shows the sessions it works out to, and saving a new name rewrites nothing else', async () => {
    const e = await open({ per: 'week', target_min: 130, preferred_times: [420, 600] });
    expect(within(e.editor).getByRole('radio', { name: 'Times a week' })).toBeChecked();
    expect(within(e.editor).getByRole('slider', { name: 'Each session' })).toHaveAttribute('aria-valuetext', '45 minutes');
    const name = within(e.editor).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Long run');
    await e.save();
    expect(await screen.findByText('Saved Long run.')).toBeVisible();
    const p = await e.read();
    expect(p).toMatchObject({ title: 'Long run', target_min: 130, preferred_times: [420, 600] });
    expect(p?.sessions).toBeUndefined();
    expect(p?.days).toBeUndefined();
  });

  it('a new usual time keeps the times to try after it', async () => {
    const e = await open({ preferred_times: [420, 600] });
    fireEvent.change(within(e.editor).getByLabelText('Usual time'), { target: { value: '06:30' } });
    await e.save();
    await screen.findByText('Saved Morning run: 30m every day, around 6:30am.');
    expect((await e.read())?.preferred_times).toEqual([390, 600]);
  });

  it('says a placed session on a day no longer in it stays', async () => {
    const t = await renderScreen('goals', {
      seed: async (w) => {
        await run(w, { days: [0, 3, 4] });
        await w.create('time_block', { practice_id: 'pr1', start: '2026-11-05T13:00:00Z', end: '2026-11-05T13:30:00Z', tz: 'America/Chicago' }, 'session:pr1:2026-11-05');
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: /Practices with no goal/ }));
    await userEvent.click(screen.getByRole('button', { name: /^Morning run/ }));
    const editor = screen.getByRole('group', { name: 'Edit Morning run' });
    await userEvent.click(within(editor).getByRole('checkbox', { name: 'Thursday' }));
    await userEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText("Saved Morning run: 30m on Mon and Fri, around 7am. Thursday's placed session stays.")).toBeVisible();
    expect((await getRecord(t.db, 'time_block', 'session:pr1:2026-11-05'))?.deleted_at).toBeFalsy();
  });

  it('on phone, the chips and fill-in buttons are in the sheet, and Any time drops the time', async () => {
    const e = await open({}, 'phone');
    await userEvent.click(within(e.editor).getByRole('radio', { name: 'Any time' }));
    expect(within(e.editor).queryByLabelText('Usual time')).toBeNull();
    await userEvent.click(within(e.days()).getByRole('button', { name: 'Weekends' }));
    await e.save();
    expect(await screen.findByText('Saved Morning run: 30m on weekends, any time.')).toBeVisible();
    expect(await e.read()).toMatchObject({ days: [5, 6], preferred_times: [] });
  });
});

describe('Add practice', () => {
  it('starts at every day around 7am, and writes the schedule chosen', async () => {
    const t = await renderScreen('goals', { seed: async (w) => void (await w.create('objective', { title: 'Run a 10k', state: 'active' }, 'g1')) });
    await userEvent.click(await screen.findByRole('button', { name: /^Run a 10k/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Add practice' }));
    const form = screen.getByRole('form', { name: 'Add practice' });
    expect(within(form).getByText('30m every day, around 7am')).toBeVisible();
    await userEvent.type(within(form).getByLabelText('Name'), 'Stretching');
    await userEvent.click(within(form).getByRole('radio', { name: 'Times a week' }));
    for (let i = 0; i < 4; i++) await userEvent.click(within(form).getByRole('button', { name: 'One fewer time a week' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Add practice' }));
    const added = (await t.db.all<{ data: string }>("SELECT data FROM records WHERE type = 'practice'")).map((r) => JSON.parse(r.data) as Practice);
    expect(added[0]).toMatchObject({ title: 'Stretching', objective_id: 'g1', per: 'week', sessions: 3, target_min: 90, preferred_times: [420], state: 'active' });
  });
});
