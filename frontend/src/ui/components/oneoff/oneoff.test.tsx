import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fixedClock } from '../../../core/clock';
import { firstDue, scheduleLabel } from '../../../core/schedule';
import type { Task } from '../../../core/types';
import { createTestPlatform } from '../../../platform/testing';
import type { Layout } from '../../app/registry';
import { AppProvider } from '../../app/store';
import { ToastProvider } from '../Toast';
import { draftSchedule, emptyDraft, oneOffFields, OneOffDates, OneOffForm } from '.';

afterEach(cleanup);

const TODAY = '2026-11-02';

async function inApp(ui: ReactNode, layout: Layout = 'desktop') {
  const platform = await createTestPlatform();
  const view = render(
    <AppProvider platform={platform} clock={fixedClock('2026-11-02T20:00:00Z', 'America/Chicago')} layout={layout}>
      <ToastProvider>
        <div data-layout={layout}>{ui}</div>
      </ToastProvider>
    </AppProvider>,
  );
  return { ...view, platform };
}

describe('a draft becomes a schedule', () => {
  const draft = emptyDraft(TODAY);

  it('starts as a one off with no date and a 30m estimate', () => {
    expect(draft.type).toBe('once');
    expect(oneOffFields({ ...draft, title: ' Paint the fence ' }, TODAY)).toEqual({
      kind: 'one_off',
      project_id: null,
      milestone_id: null,
      title: 'Paint the fence',
      schedule: { type: 'once', from: null, to: null },
      next_due: null,
      estimate_min: 30,
    });
  });

  it('takes a date or a range, and drops an end that matches the start', () => {
    expect(draftSchedule({ ...draft, from: '2026-11-04' })).toEqual({ type: 'once', from: '2026-11-04', to: null });
    expect(draftSchedule({ ...draft, from: '2026-11-04', ranged: true, to: '2026-11-05' })).toEqual({ type: 'once', from: '2026-11-04', to: '2026-11-05' });
    expect(draftSchedule({ ...draft, from: '2026-11-04', ranged: false, to: '2026-11-05' })).toEqual({ type: 'once', from: '2026-11-04', to: null });
    expect(oneOffFields({ ...draft, title: 'x', from: '2026-11-04' }, TODAY).next_due).toBe('2026-11-04');
  });

  it('reads each repeating type as its row will', () => {
    const label = (patch: Partial<typeof draft>) => scheduleLabel(draftSchedule({ ...draft, ...patch }));
    expect(label({ type: 'recurring', unit: 'day' })).toBe('Daily');
    expect(label({ type: 'recurring', unit: 'month', starts: '2026-11-28' })).toBe('Monthly on the 28th');
    expect(label({ type: 'float', weeks: 26 })).toBe('26 weeks after last done');
    expect(label({ type: 'window', winMin: 2, winMax: 3 })).toBe('Every 2 to 3 months');
    expect(label({ type: 'seasonal', months: [10, 4] })).toBe('In April and October');
    expect(label({ type: 'rule', rulePos: 2, ruleDay: 'TU', ruleOf: 'month' })).toBe('Every month on the 2nd Tuesday');
  });

  it('builds calendar rules that land where they say', () => {
    const due = (patch: Partial<typeof draft>) => firstDue(draftSchedule({ ...draft, type: 'rule', ...patch }), TODAY);
    expect(due({ rulePos: 2, ruleDay: 'TU', ruleOf: 'month' })).toBe('2026-11-10');
    expect(due({ rulePos: -1, ruleDay: 'weekday', ruleOf: 'quarter' })).toBe('2026-12-31');
    expect(due({ rulePos: 1, ruleDay: 'MO', ruleOf: 'quarter' })).toBe('2027-01-04');
    expect(due({ rulePos: 1, ruleDay: 'day', ruleOf: 'year' })).toBe('2027-01-01');
    expect(due({ rulePos: -1, ruleDay: 'day', ruleOf: 'month' })).toBe('2026-11-30');
  });
});

describe('OneOffForm', () => {
  const field = (name: string) => screen.getByLabelText(name);

  it('offers six ways to repeat, one-off first, and needs a title', async () => {
    const onSave = vi.fn();
    await inApp(<OneOffForm onSave={onSave} />);
    const repeats = field('Repeats') as HTMLSelectElement;
    expect([...repeats.options].map((o) => o.text)).toEqual([
      'Does not repeat',
      'On a regular schedule',
      'A set time after I last did it',
      'Within a flexible window',
      'In certain months',
      'By a calendar rule',
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Add one off' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Give it a title.');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('refuses an end before the start, then saves the range and its time, and clears', async () => {
    const onSave = vi.fn();
    await inApp(<OneOffForm onSave={onSave} />);
    await userEvent.type(field('Title'), 'Collect the parcel');
    fireEvent.change(field('Date (optional)'), { target: { value: '2026-11-04' } });
    await userEvent.click(screen.getByRole('button', { name: '+ End date' }));
    fireEvent.change(field('End date'), { target: { value: '2026-11-01' } });
    await userEvent.click(screen.getByRole('button', { name: 'Add one off' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The end date is before the start date.');
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(field('End date'), { target: { value: '2026-11-05' } });
    fireEvent.change(field('Time'), { target: { value: '3' } });
    await userEvent.click(screen.getByRole('button', { name: 'Add one off' }));
    expect(onSave).toHaveBeenCalledWith({
      kind: 'one_off',
      project_id: null,
      milestone_id: null,
      title: 'Collect the parcel',
      schedule: { type: 'once', from: '2026-11-04', to: '2026-11-05' },
      next_due: '2026-11-04',
      estimate_min: 45,
    });
    expect(field('Title')).toHaveValue('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('uses sliders for spans of time, and a window cannot run backwards', async () => {
    await inApp(<OneOffForm onSave={() => undefined} />);
    await userEvent.selectOptions(field('Repeats'), 'float');
    expect(field('After you last did it')).toHaveAttribute('type', 'range');
    expect(field('After you last did it')).toHaveAttribute('aria-valuetext', '6 weeks');

    await userEvent.selectOptions(field('Repeats'), 'window');
    fireEvent.change(field('Every, at least'), { target: { value: '4' } });
    expect(field('At most')).toHaveAttribute('aria-valuetext', '4 months');
    fireEvent.change(field('At most'), { target: { value: '1' } });
    expect(field('Every, at least')).toHaveAttribute('aria-valuetext', '1 month');
  });

  it('picks months as toggles, and asks for one', async () => {
    const onSave = vi.fn();
    await inApp(<OneOffForm onSave={onSave} />);
    await userEvent.type(field('Title'), 'Oil the hinges');
    await userEvent.selectOptions(field('Repeats'), 'seasonal');
    await userEvent.click(screen.getByRole('button', { name: 'Add one off' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a month.');
    const months = screen.getByRole('group', { name: 'Months' });
    await userEvent.click(within(months).getByRole('button', { name: 'April' }));
    await userEvent.click(within(months).getByRole('button', { name: 'October' }));
    expect(within(months).getByRole('button', { name: 'April' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Add one off' }));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ schedule: { type: 'seasonal', months: [4, 10] }, next_due: '2027-04-01' });
  });

  it('builds a calendar rule from three choices', async () => {
    const onSave = vi.fn();
    await inApp(<OneOffForm onSave={onSave} />);
    await userEvent.type(field('Title'), 'Test the doorbell');
    await userEvent.selectOptions(field('Repeats'), 'rule');
    await userEvent.selectOptions(field('Which'), 'Last');
    await userEvent.selectOptions(field('Day'), 'Weekday');
    await userEvent.selectOptions(field('Of each'), 'Quarter');
    await userEvent.click(screen.getByRole('button', { name: 'Add one off' }));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ schedule: { type: 'rule' }, next_due: '2026-12-31' });
  });

  it('can be cancelled when it sits in a sheet', async () => {
    const onCancel = vi.fn();
    await inApp(<OneOffForm onSave={() => undefined} onCancel={onCancel} />, 'phone');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('OneOffDates', () => {
  const task = (schedule: Task['schedule'], extra: Partial<Task> = {}): Task => ({ id: 't', kind: 'one_off', title: 'Tidy the shed', schedule, ...extra });

  it('is offered only on one off tasks that do not repeat and are still to do', async () => {
    await inApp(<OneOffDates task={task({ type: 'recurring', every: 1, unit: 'week', anchor: TODAY })} commit={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    await inApp(<OneOffDates task={task({ type: 'once' }, { done_at: '2026-11-02T10:00:00Z' })} commit={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('adds a date in place, refuses a missing or backwards one, and returns focus on close', async () => {
    const commit = vi.fn();
    await inApp(<OneOffDates task={task({ type: 'once' })} commit={commit} />);
    const toggle = screen.getByRole('button', { name: 'Add date for Tidy the shed' });
    await userEvent.click(toggle);
    expect(screen.getByLabelText('Date')).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Set date' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a date.');

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-11-20' } });
    await userEvent.click(screen.getByRole('button', { name: '+ End date' }));
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-11-10' } });
    await userEvent.click(screen.getByRole('button', { name: 'Set date' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The end date is before the start date.');

    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-11-25' } });
    await userEvent.click(screen.getByRole('button', { name: 'Set date' }));
    expect(commit).toHaveBeenCalledWith('2026-11-20', '2026-11-25');
    expect(screen.queryByLabelText('Date')).toBeNull();
    expect(toggle).toHaveFocus();
  });

  it('changes or clears a date, and Escape closes it', async () => {
    const commit = vi.fn();
    await inApp(<OneOffDates task={task({ type: 'once', from: '2026-11-03', to: '2026-11-06' })} commit={commit} />);
    await userEvent.click(screen.getByRole('button', { name: 'Change date for Tidy the shed' }));
    expect(screen.getByLabelText('Date')).toHaveValue('2026-11-03');
    expect(screen.getByLabelText('End date')).toHaveValue('2026-11-06');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByLabelText('Date')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Change date for Tidy the shed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Clear date' }));
    expect(commit).toHaveBeenCalledWith(null, null);
  });

  it('stays open with the date typed when the save fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { platform } = await inApp(<OneOffDates task={task({ type: 'once' })} />);
    vi.spyOn(platform.db, 'transaction').mockRejectedValueOnce(new Error('disk full'));
    await userEvent.click(screen.getByRole('button', { name: 'Add date for Tidy the shed' }));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-11-20' } });
    await userEvent.click(screen.getByRole('button', { name: 'Set date' }));
    expect(await screen.findByText("Couldn't save that. Try again.")).toBeVisible();
    expect(screen.getByLabelText('Date')).toHaveValue('2026-11-20');
    error.mockRestore();
  });

  it('stays open when the screen saving the dates says it could not', async () => {
    await inApp(<OneOffDates task={task({ type: 'once', from: '2026-11-03' })} commit={async () => false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Change date for Tidy the shed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Clear date' }));
    expect(screen.getByLabelText('Date')).toHaveValue('2026-11-03');
  });
});
