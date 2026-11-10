import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localToInstant } from '../../../core/dates';
import { META, setMeta } from '../../../core/db';
import { CALENDAR_ID, getRecord, listRecords, outcomeId, setWeekPick, weekPickId, weekPlanId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import type { AppSync } from '../../../core/syncRunner';
import { EST_STEPS } from '../../components/EstimateSlider';
import type { Layout } from '../../app/registry';
import { renderScreen } from '../../app/testing';
import type { Harness, HarnessOptions } from '../../app/testing';

afterEach(cleanup);

// Monday, Nov 2 in Chicago. The harness clock reads 2pm there.
const ZONE = 'America/Chicago';
const DAY = '2026-11-02';
const at = (time: string, date = DAY) => {
  const [h, m] = time.split(':').map(Number);
  return localToInstant(date, h! * 60 + (m ?? 0), ZONE);
};
const NOW = at('14:00');

const planned = (w: Writer) => w.create('week_plan', { week_start: DAY, finished_at: at('08:00') }, weekPlanId(DAY));
const task = (w: Writer, id: string, title: string, extra: Record<string, unknown> = {}) =>
  w.create('task', { kind: 'project', project_id: 'p', title, estimate_min: 180, ...extra }, id);
const block = (w: Writer, id: string, taskId: string, from: string, to: string, extra: Record<string, unknown> = {}) =>
  w.create('time_block', { task_id: taskId, start: at(from), end: at(to), tz: ZONE, ...extra }, id);

async function open(seed: (w: Writer) => Promise<unknown>, options: HarnessOptions = {}) {
  return renderScreen('today', {
    now: NOW,
    zone: ZONE,
    ...options,
    seed: async (w) => {
      await planned(w);
      await seed(w);
    },
  });
}

const dialog = (name: string | RegExp) => screen.findByRole('dialog', { name });
const slideTo = (slider: HTMLElement, minutes: number) => fireEvent.change(slider, { target: { value: String(EST_STEPS.indexOf(minutes)) } });

describe('the Now card', () => {
  const day = async (w: Writer) => {
    await task(w, 't1', 'Write the report');
    await block(w, 'b1', 't1', '13:00', '15:00');
    await w.create('task', { kind: 'one_off', title: 'Paint the fence' }, 't2');
    await block(w, 'b2', 't2', '16:00', '17:00');
  };

  it('shows the block in progress, and Start sets the clock going', async () => {
    const t = await open(day);
    const now = await screen.findByRole('region', { name: 'Current block' });
    expect(within(now).getByText('Now, 1pm to 3pm')).toBeVisible();
    expect(within(now).getByRole('heading', { name: 'Write the report' })).toBeVisible();
    await userEvent.click(within(now).getByRole('button', { name: 'Start' }));
    expect(await within(now).findByText('In progress, time left')).toBeVisible();
    expect(within(now).getByRole('timer')).toHaveTextContent('1:00:00');
    expect((await getRecord(t.db, 'time_block', 'b1'))?.started_at).toBe(NOW);
    // Start has gone, so focus lands on the card's heading rather than the page.
    await waitFor(() => expect(within(now).getByRole('heading', { name: 'Write the report' })).toHaveFocus());
  });

  it('Mark done now finishes at once, shows what is next, and Undo puts it back', async () => {
    const t = await open(day);
    await userEvent.click(await screen.findByRole('button', { name: 'Mark done now' }));
    expect(await screen.findByText("Marked done. You're free until 4pm.")).toBeVisible();
    // The button that had focus is gone, so focus lands on Undo rather than the page.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus());
    const now = screen.getByRole('region', { name: 'Current block' });
    expect(await within(now).findByText('Free until 4pm')).toBeVisible();
    expect(within(now).getByRole('heading', { name: 'Next: Paint the fence' })).toBeVisible();
    expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBe(NOW);
    expect((await getRecord(t.db, 'time_block', 'b1'))?.ended_at).toBe(NOW);

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await within(now).findByText('Now, 1pm to 3pm')).toBeVisible();
    expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBeNull();
  });

  it('Do next block instead trades the two', async () => {
    await open(day);
    const now = await screen.findByRole('region', { name: 'Current block' });
    await userEvent.click(await within(now).findByRole('button', { name: 'Do next block instead' }));
    expect(await within(now).findByRole('heading', { name: 'Paint the fence' })).toBeVisible();
    expect(within(now).getByText('Now, 1pm to 3pm')).toBeVisible();
    expect(screen.getByText('Swapped with your next block')).toBeVisible();
    await waitFor(() => expect(within(now).getByRole('heading', { name: 'Paint the fence' })).toHaveFocus());
  });

  it('Start early moves the next block to now and starts it', async () => {
    const t = await open(async (w) => {
      await task(w, 't1', 'Write the report');
      await block(w, 'b1', 't1', '16:00', '17:00');
    });
    const now = await screen.findByRole('region', { name: 'Current block' });
    expect(await within(now).findByText('Free until 4pm')).toBeVisible();
    await userEvent.click(within(now).getByRole('button', { name: 'Start early' }));
    expect(await within(now).findByText('Now, 2pm to 3pm')).toBeVisible();
    expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ start: NOW, end: at('15:00'), started_at: NOW });
    await waitFor(() => expect(within(now).getByRole('heading', { name: 'Write the report' })).toHaveFocus());
  });

  it('says when nothing else is planned', async () => {
    await open(async () => undefined);
    expect(await screen.findByText('Nothing else planned today.')).toBeVisible();
  });

  describe('the time-spent ring', () => {
    const running = async (w: Writer) => {
      await day(w);
      await w.set('time_block', 'b1', { started_at: at('13:00') });
    };
    const later = (t: Harness, minutes: number) => act(() => t.clock.set(Date.parse(NOW) + minutes * 60_000));

    it('shows the time spent once started, and tapping it pauses: the countdown stops and the card says when it ends', async () => {
      const t = await open(running);
      const now = await screen.findByRole('region', { name: 'Current block' });
      await userEvent.click(within(now).getByRole('button', { name: 'Pause, 1 hour spent, 50% of the block' }));
      const ring = await within(now).findByRole('button', { name: 'Resume, 1 hour spent, 50% of the block' });
      // Focus stays on the ring, which now resumes, and no toast: tapping it again is Pause's undo.
      expect(ring).toHaveFocus();
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
      expect((await getRecord(t.db, 'time_block', 'b1'))?.paused_at).toBe(NOW);
      expect(within(now).getByText('Ends at 3pm unless you resume.')).toBeVisible();
      later(t, 9);
      expect(await within(now).findByText('Paused for 9 min', {}, { timeout: 2000 })).toBeVisible();
      expect(within(now).getByRole('timer')).toHaveTextContent('1:00:00');
    });

    it('Resume moves the end later by the pause, with no toast, and a tap on the ring within 30 seconds takes it back exactly', async () => {
      const t = await open(running);
      const now = await screen.findByRole('region', { name: 'Current block' });
      await userEvent.click(within(now).getByRole('button', { name: /^Pause, / }));
      await within(now).findByRole('button', { name: /^Resume, / });
      later(t, 9);
      await userEvent.click(within(now).getByRole('button', { name: /^Resume, / }));
      expect(await within(now).findByText('Now, 1pm to 3:09pm')).toBeVisible();
      expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ paused_at: null, paused_min: 9, end: at('15:09') });
      expect(await within(now).findByRole('button', { name: 'Pause, 1 hour spent, 50% of the block' }, { timeout: 2000 })).toBeVisible();
      expect(screen.queryByText(/^Resumed/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
      await userEvent.click(within(now).getByRole('button', { name: /^Pause, / }));
      await waitFor(async () => expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ paused_at: NOW, end: at('15:00') }));
      expect((await getRecord(t.db, 'time_block', 'b1'))?.paused_min ?? null).toBeNull();
    });

    it('a tap more than 30 seconds after Resume is a new pause', async () => {
      const t = await open(running);
      const now = await screen.findByRole('region', { name: 'Current block' });
      await userEvent.click(within(now).getByRole('button', { name: /^Pause, / }));
      later(t, 9);
      await userEvent.click(await within(now).findByRole('button', { name: /^Resume, / }));
      await within(now).findByText('Now, 1pm to 3:09pm');
      later(t, 20);
      await userEvent.click(within(now).getByRole('button', { name: /^Pause, / }));
      await waitFor(async () =>
        expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ paused_at: at('14:20'), paused_min: 9, end: at('15:09') }),
      );
    });

    it('a quick second tap leaves no trace and no toast', async () => {
      const t = await open(running);
      const now = await screen.findByRole('region', { name: 'Current block' });
      await userEvent.click(within(now).getByRole('button', { name: /^Pause, / }));
      await userEvent.click(await within(now).findByRole('button', { name: /^Resume, / }));
      await within(now).findByRole('button', { name: /^Pause, / });
      expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ paused_at: null, end: at('15:00') });
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    });

    it('the ⓘ shows what the ring and its signs mean, and hides it again', async () => {
      await open(running);
      const now = await screen.findByRole('region', { name: 'Current block' });
      const info = within(now).getByRole('button', { name: 'What the ring means' });
      expect(info).toHaveAttribute('aria-expanded', 'false');
      await userEvent.click(info);
      expect(info).toHaveAttribute('aria-expanded', 'true');
      const key = within(now).getByRole('group', { name: 'Key' });
      expect(within(key).getByText('Time spent, filling toward the end')).toBeVisible();
      expect(within(key).getByText('Tap the ring to pause the countdown')).toBeVisible();
      expect(within(key).getByText('Resume, and the end moves later')).toBeVisible();
      await userEvent.click(info);
      expect(within(now).queryByRole('group', { name: 'Key' })).toBeNull();
    });

    it('is not there before Start', async () => {
      await open(day);
      const now = await screen.findByRole('region', { name: 'Current block' });
      await within(now).findByRole('button', { name: 'Start' });
      expect(within(now).queryByRole('button', { name: /^Pause, / })).toBeNull();
    });

    it('Mark done now says the time spent, pauses left out', async () => {
      const t = await open(running);
      const now = await screen.findByRole('region', { name: 'Current block' });
      await userEvent.click(within(now).getByRole('button', { name: /^Pause, / }));
      later(t, 9);
      await userEvent.click(within(now).getByRole('button', { name: 'Mark done now' }));
      expect(await screen.findByText("Marked done after 1h. You're free until 4pm.")).toBeVisible();
    });
  });

  it('on phone, Mark done now appears once the block is started', async () => {
    await open(day, { layout: 'phone' });
    const now = await screen.findByRole('region', { name: 'Current block' });
    await within(now).findByRole('heading', { name: 'Write the report' });
    expect(within(now).queryByRole('button', { name: 'Mark done now' })).toBeNull();
    await userEvent.click(within(now).getByRole('button', { name: 'Start' }));
    expect(await within(now).findByRole('button', { name: 'Mark done now' })).toBeVisible();
  });
});

describe('the end-of-block prompt', () => {
  const ended = async (w: Writer) => {
    await task(w, 't1', 'Write the report', { estimate_min: 180 });
    await block(w, 'b1', 't1', '12:00', '13:00');
  };

  it('asks Task finished, Partly or Not done, and only Task finished finishes the task, as of when its block ended', async () => {
    const t = await open(ended);
    const prompt = await dialog('Block finished');
    expect(within(prompt).getByText('Write the report')).toBeVisible();
    expect(within(prompt).queryByRole('button', { name: 'Done' })).toBeNull();
    await userEvent.click(within(prompt).getByRole('button', { name: 'Task finished' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBe(at('13:00'));
  });

  it('says the time spent and the pauses on a block that was started', async () => {
    await open(async (w) => {
      await task(w, 't1', 'Write the report');
      await block(w, 'b1', 't1', '12:00', '13:09', { started_at: at('12:00'), paused_min: 9 });
    });
    const prompt = await dialog('Block finished');
    expect(within(prompt).getByText('1h spent, 9 min paused.')).toBeVisible();
    expect(within(prompt).getByRole('button', { name: 'Still going, add 30m' })).toBeVisible();
  });

  it('a pause still running at the end offers Resume with the time left in place of Still going', async () => {
    const t = await open(async (w) => {
      await task(w, 't1', 'Write the report');
      await block(w, 'b1', 't1', '13:00', '13:50', { started_at: at('13:00'), paused_at: at('13:22') });
    });
    const prompt = await dialog('Block finished');
    expect(within(prompt).getByText('22m spent. Paused at 1:22pm.')).toBeVisible();
    expect(within(prompt).queryByRole('button', { name: /Still going/ })).toBeNull();
    await userEvent.click(within(prompt).getByRole('button', { name: 'Resume, 28m left' }));
    const now = screen.getByRole('region', { name: 'Current block' });
    const ring = await within(now).findByRole('button', { name: 'Pause, 22 minutes spent, 44% of the block' });
    expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ paused_at: null, paused_min: 38, end: at('14:28') });
    expect(screen.queryByText(/^Resumed/)).toBeNull();
    // Pressed by mistake, a tap on the ring takes it back: paused from the same moment, and the block missed again.
    await userEvent.click(ring);
    await waitFor(async () => expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ paused_at: at('13:22'), end: at('13:50') }));
    expect(await screen.findByRole('button', { name: 'Review' })).toBeVisible();
  });

  it('Partly sets the time left on a slider that starts at what is left', async () => {
    const t = await open(ended);
    await userEvent.click(within(await dialog('Block finished')).getByRole('button', { name: 'Partly' }));
    const slider = within(await dialog('How much is left?')).getByRole('slider', { name: 'Time left' });
    expect(slider).toHaveAttribute('aria-valuetext', '2h');
    slideTo(slider, 90);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Added to Needs a new time. No need to decide now.')).toBeVisible();
    expect(await getRecord(t.db, 'block_outcome', outcomeId('b1'))).toMatchObject({ result: 'partly', remaining_min: 90 });
    expect((await getRecord(t.db, 'task', 't1'))?.remaining_min).toBe(90);
  });

  it('Not done sends it to Needs a new time, and Still going adds 30 minutes', async () => {
    const t = await open(async (w) => {
      await ended(w);
      await task(w, 't2', 'Paint the fence');
      await block(w, 'b2', 't2', '13:00', '13:55');
    });
    // Two missed blocks ask together in one sheet. Put away, one left over gets its own prompt.
    const sheet = await dialog('2 missed blocks');
    expect(within(sheet).getByRole('heading', { name: '2 missed blocks' })).toBeVisible();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Not done: Write the report' }));
    await userEvent.click(within(await dialog('1 missed block')).getByRole('button', { name: 'Later' }));
    expect((await getRecord(t.db, 'block_outcome', outcomeId('b1')))?.result).toBe('not');
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    const prompt = await dialog('Block finished');
    await userEvent.click(within(prompt).getByRole('button', { name: 'Still going, add 30m' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b2'))?.end).toBe(at('14:25')));
  });

  it('Select all then Not done sends every missed block to Needs a new time', async () => {
    const t = await open(async (w) => {
      await ended(w);
      await task(w, 't2', 'Paint the fence');
      await block(w, 'b2', 't2', '13:00', '13:30');
    });
    const sheet = await dialog('2 missed blocks');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Select' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Select all' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Not done' }));
    expect(await screen.findByText('Answered 2 blocks.')).toBeVisible();
    expect((await getRecord(t.db, 'block_outcome', outcomeId('b1')))?.result).toBe('not');
    expect((await getRecord(t.db, 'block_outcome', outcomeId('b2')))?.result).toBe('not');
  });

  it('Answer later puts it away, with a way back', async () => {
    await open(ended);
    await userEvent.click(within(await dialog('Block finished')).getByRole('button', { name: 'Answer later' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await dialog('Block finished')).toBeVisible();
  });

  it('a practice, however short, logs the time done', async () => {
    const t = await open(async (w) => {
      await w.create('practice', { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' }, 'pr');
      await w.create('time_block', { practice_id: 'pr', start: at('13:00'), end: at('13:30'), tz: ZONE }, 'pb');
    });
    const prompt = await dialog('Block finished');
    const slider = within(prompt).getByRole('slider', { name: 'How much did you do?' });
    expect(within(prompt).getByRole('button', { name: 'All 30m' })).toBeVisible();
    fireEvent.change(slider, { target: { value: '20' } });
    await userEvent.click(within(prompt).getByRole('button', { name: 'Log 20m' }));
    expect(await screen.findByText('Logged 20m')).toBeVisible();
    expect(await getRecord(t.db, 'block_outcome', outcomeId('pb'))).toMatchObject({ result: 'done', logged_min: 20 });
  });

  it('on phone it is a sheet', async () => {
    await open(ended, { layout: 'phone' });
    expect(await dialog('Block finished')).toHaveAttribute('aria-modal', 'true');
  });
});

describe('the start check-in', () => {
  const late = async (w: Writer) => {
    await task(w, 't1', 'Write the report');
    await block(w, 'b1', 't1', '13:50', '15:00');
  };

  it('asks a few minutes in, and Yes, started starts it', async () => {
    const t = await open(late);
    const prompt = await dialog('Have you started?');
    expect(within(prompt).getByText('Have you started Write the report?')).toBeVisible();
    await userEvent.click(within(prompt).getByRole('button', { name: 'Yes, started' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await getRecord(t.db, 'time_block', 'b1'))?.started_at).toBe(NOW);
  });

  it('Ask again in 10 minutes waits, and Skip takes it off the calendar into To schedule, with Undo', async () => {
    const t = await open(late);
    await userEvent.click(within(await dialog('Have you started?')).getByRole('button', { name: 'Ask again in 10 minutes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    t.clock.set(at('14:10'));
    await act(() => t.write((w) => w.create('task', { kind: 'inbox', title: 'Rake the leaves' })));
    await userEvent.click(within(await dialog('Have you started?')).getByRole('button', { name: 'Skip, choose a new time later' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBe(true));
    // Not answered, so it isn't crossed off or sent to Needs a new time: it waits in To schedule.
    expect(await getRecord(t.db, 'block_outcome', outcomeId('b1'))).toBeUndefined();
    expect(await getRecord(t.db, 'week_pick', weekPickId(DAY, 't1'))).toMatchObject({ minutes: 70 });
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBeFalsy());
  });

  it('stays quiet on away dates', async () => {
    await open(async (w) => {
      await late(w);
      await w.create('away_period', { start: DAY, end: DAY });
    });
    await screen.findByRole('region', { name: 'Current block' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('records the prompts leave', () => {
  it('nothing for a block still running', async () => {
    const t = await open(async (w) => {
      await task(w, 't1', 'Write the report');
      await block(w, 'b1', 't1', '13:58', '15:00');
    });
    await screen.findByRole('region', { name: 'Current block' });
    expect(await listRecords(t.db, 'block_outcome')).toEqual([]);
  });
});

const dinner = (w: Writer) =>
  w.create('calendar', { connected: true, events: [{ id: 'e1', calendar: 'g1', title: 'Quiz night', start: at('16:00'), end: at('16:30') }] }, 'calendar');

describe('a conflict with the calendar', () => {
  const day = async (w: Writer) => {
    await dinner(w);
    await task(w, 't1', 'Write the report');
    await block(w, 'b1', 't1', '16:00', '17:00');
    await w.create('task', { kind: 'one_off', title: 'Paint the fence' }, 't2');
    await block(w, 'b2', 't2', '17:00', '17:30');
  };

  it('previews shifting the rest of today, applies it, and undoes it', async () => {
    const t = await open(day);
    expect(await screen.findByText('Write the report conflicts with Quiz night.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Shift rest of today' }));
    const panel = screen.getByRole('region', { name: 'Shift rest of today' });
    const rows = within(panel).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['Write the report4pm to 5pm now 4:30pm to 5:30pm', 'Paint the fence5pm to 5:30pm now 5:30pm to 6pm']);
    expect((await getRecord(t.db, 'time_block', 'b1'))?.start).toBe(at('16:00'));
    await userEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Rest of today shifted. Time blocks calendar will update.')).toBeVisible();
    expect(await getRecord(t.db, 'time_block', 'b2')).toMatchObject({ start: at('17:30'), end: at('18:00') });
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b2'))?.start).toBe(at('17:00')));
  });

  it('labels the clash on the timeline, with the event drawn apart', async () => {
    await open(day);
    expect(await screen.findByRole('button', { name: 'Write the report, 4pm to 5pm, Project. Conflicts with Quiz night.' })).toBeVisible();
    expect(screen.getByText('Quiz night')).toBeVisible();
  });

  it('Edit opens this week ready to change', async () => {
    const t = await open(day);
    await userEvent.click(await screen.findByRole('button', { name: 'Shift rest of today' }));
    await userEvent.click(within(screen.getByRole('region', { name: 'Shift rest of today' })).getByRole('button', { name: 'Edit' }));
    expect(t.nav().route).toMatchObject({ area: 'week', params: { edit: 'this' } });
  });

  it('on phone is a warning with the same repair', async () => {
    await open(day, { layout: 'phone' });
    expect(await screen.findByText('Scheduling conflict')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Shift rest of today' }));
    expect(screen.getByRole('region', { name: 'Shift rest of today' })).toBeVisible();
  });
});

describe('Needs a new time', () => {
  const missed = (answered: string) => async (w: Writer) => {
    await task(w, 't3', 'Rake the leaves', { estimate_min: 60 });
    await w.create('time_block', { task_id: 't3', start: at('10:00', '2026-11-01'), end: at('11:00', '2026-11-01'), tz: ZONE }, 'old');
    await w.create('block_outcome', { result: 'not', answered_at: answered }, outcomeId('old'));
  };

  it('offers the best open time, and placing it clears the row', async () => {
    const t = await open(missed(at('09:00')));
    expect(await screen.findByText("1 task that didn't get done. Choose when it suits you.")).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Review' }));
    const panel = screen.getByRole('region', { name: 'Needs a new time' });
    expect(within(panel).getByText('Not done Nov 1')).toBeVisible();
    const place = await within(panel).findByRole('button', { name: /^Place Rake the leaves/ });
    await userEvent.click(place);
    expect(await screen.findByText(/^Placed Rake the leaves, /)).toBeVisible();
    const blocks = (await listRecords(t.db, 'time_block')).filter((b) => b.task_id === 't3' && b.id !== 'old');
    expect(blocks).toHaveLength(1);
    expect(await within(panel).findByText('Nothing needs a new time.')).toBeVisible();
  });

  it('placing raises an estimate the time no longer fits, as placing on Week does, and Undo takes both back', async () => {
    const t = await open(async (w) => {
      await missed(at('09:00'))(w);
      await w.set('task', 't3', { estimate_min: 30 });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    const panel = screen.getByRole('region', { name: 'Needs a new time' });
    await userEvent.click(await within(panel).findByRole('button', { name: /^Place Rake the leaves/ }));
    expect(await screen.findByText(/^Placed Rake the leaves, /)).toBeVisible();
    const placed = async () => (await listRecords(t.db, 'time_block')).filter((b) => b.task_id === 't3' && b.id !== 'old');
    expect(await placed()).toHaveLength(1);
    expect((await getRecord(t.db, 'task', 't3'))?.estimate_min).toBe(60);
    // The row and its button have gone, so focus goes to Undo rather than the page.
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await placed()).toEqual([]));
    expect((await getRecord(t.db, 'task', 't3'))?.estimate_min).toBe(30);
    expect(await within(panel).findByRole('button', { name: /^Place Rake the leaves/ })).toBeVisible();
  });

  it("offers a time before the task's milestone is due, not just the emptiest day", async () => {
    await open(async (w) => {
      await w.create('project', { title: 'Learn to bake bread', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p');
      await w.create('milestone', { project_id: 'p', title: 'A starter that rises', due: '2026-11-05' }, 'm');
      await missed(at('09:00'))(w);
      await w.set('task', 't3', { milestone_id: 'm' });
      // The days up to the due date are fuller, so the emptiest day is after it.
      for (const date of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']) {
        await w.create('time_block', { task_id: 't1', start: at('16:00', date), end: at('17:00', date), tz: ZONE });
      }
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    const panel = screen.getByRole('region', { name: 'Needs a new time' });
    expect(await within(panel).findByRole('button', { name: /^Place Rake the leaves, \w+ Nov [2-5],/ })).toBeVisible();
  });

  it('asks Still want this? about work passed over at the last planning, with no Someday', async () => {
    const t = await open(missed(at('10:00', '2026-11-01')));
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    const panel = screen.getByRole('region', { name: 'Needs a new time' });
    expect(within(panel).getByText('Still want this?')).toBeVisible();
    expect(within(panel).queryByRole('button', { name: /Someday/ })).toBeNull();
    await userEvent.click(within(panel).getByRole('button', { name: 'Keep Rake the leaves' }));
    expect(await within(panel).findByRole('button', { name: /^Place Rake the leaves/ })).toBeVisible();
    expect(screen.getByText('Kept Rake the leaves.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await within(panel).findByText('Still want this?')).toBeVisible();
    expect((await getRecord(t.db, 'block_outcome', outcomeId('old')))?.answered_at).toBe(at('10:00', '2026-11-01'));
    await userEvent.click(within(panel).getByRole('button', { name: 'Keep Rake the leaves' }));
    expect(await within(panel).findByRole('button', { name: /^Place Rake the leaves/ })).toBeVisible();
    await userEvent.click(within(panel).getByRole('button', { name: 'Delete Rake the leaves' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't3'))?.deleted_at).toBe(NOW));
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't3'))?.deleted_at).toBeNull());
  });

  const weekly = { type: 'recurring', every: 1, unit: 'week', anchor: '2026-10-05' } as const;
  const repeating = async (w: Writer) => {
    await w.create('task', { kind: 'one_off', title: 'Water the plants', estimate_min: 30, schedule: weekly, next_due: '2026-11-09' }, 'r');
    await w.create('time_block', { task_id: 'r', start: at('10:00', '2026-11-01'), end: at('10:30', '2026-11-01'), tz: ZONE }, 'missed');
    await w.create('block_outcome', { result: 'not', answered_at: at('09:00') }, outcomeId('missed'));
  };

  for (const layout of ['desktop', 'phone'] as const) {
    it(`on ${layout}, Delete on a repeating one off drops just this missed time, and Undo brings it back`, async () => {
      const t = await open(repeating, { layout });
      await userEvent.click(await screen.findByRole('button', { name: layout === 'phone' ? '1 task needs a new time Review' : 'Review' }));
      const panel = layout === 'phone' ? await dialog('Needs a new time') : screen.getByRole('region', { name: 'Needs a new time' });
      (await within(panel).findByRole('button', { name: 'Delete Water the plants' })).focus();
      await userEvent.keyboard('{Enter}');
      expect(await within(panel).findByText('Nothing needs a new time.')).toBeVisible();
      // The row and its button have gone, so focus goes to Undo rather than the page.
      expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
      const task = await getRecord(t.db, 'task', 'r');
      expect(task?.deleted_at).toBeUndefined();
      expect(task?.schedule).toEqual(weekly);
      expect(await getRecord(t.db, 'block_outcome', outcomeId('missed'))).toMatchObject({ result: 'not', answered_at: at('09:00') });

      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(await within(panel).findByRole('button', { name: 'Delete Water the plants' })).toBeVisible();
    });
  }
});

describe('when the week is not planned', () => {
  const unplanned = (seed: (w: Writer) => Promise<unknown>, options: HarnessOptions = {}) =>
    renderScreen('today', { now: NOW, zone: ZONE, ...options, seed });
  const work = async (w: Writer) => {
    await w.create('project', { title: 'Learn to bake bread', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p');
    await task(w, 't1', 'Write the report', { estimate_min: 60 });
    await w.create('task', { kind: 'one_off', title: 'Paint the fence', estimate_min: 30 }, 't2');
    await w.create('task', { kind: 'inbox', title: 'Rake the leaves' }, 't3');
  };

  it('opens on a prompt to plan, which opens the planning flow', async () => {
    const t = await unplanned(work);
    expect(await screen.findByRole('heading', { name: 'Plan your week' })).toBeVisible();
    expect(screen.getByText("This week isn't planned yet.")).toBeVisible();
    expect(screen.getByText(/1 in your Inbox/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Start planning' }));
    expect(t.nav().flow?.area).toBe('planning');
  });

  it('still asks about a block that has ended', async () => {
    await unplanned(async (w) => {
      await work(w);
      await block(w, 'b1', 't1', '12:00', '13:00');
    });
    expect(await screen.findByRole('heading', { name: 'Plan your week' })).toBeVisible();
    expect(await dialog('Block finished')).toBeVisible();
  });

  it('can be skipped, leaving a banner and what to do next, and Start puts it on the clock', async () => {
    const t = await unplanned(work);
    await userEvent.click(await screen.findByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByText("This week isn't planned")).toBeVisible();
    const next = screen.getByRole('region', { name: 'Next up' });
    expect(within(next).getByText('Paint the fence')).toBeVisible();
    await userEvent.click(within(next).getByRole('button', { name: 'Start Paint the fence' }));
    const now = await screen.findByRole('region', { name: 'Current block' });
    expect(await within(now).findByText('Now, 2pm to 2:30pm')).toBeVisible();
    expect((await listRecords(t.db, 'time_block'))[0]).toMatchObject({ task_id: 't2', start: NOW, started_at: NOW });
  });

  it('after time away, welcomes you back, returns missed blocks, and asks for one thing', async () => {
    const t = await unplanned(async (w) => {
      await work(w);
      await w.create('time_block', { task_id: 't1', start: at('10:00', '2026-10-22'), end: at('11:00', '2026-10-22'), tz: ZONE }, 'gone');
    });
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Return them and continue' }));
    expect(await screen.findByRole('heading', { name: 'Pick one thing for today' })).toBeVisible();
    expect((await getRecord(t.db, 'time_block', 'gone'))?.cancelled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: /^Write the report/ }));
    const next = await screen.findByRole('region', { name: 'Next up' });
    expect(within(next).getAllByText(/Write the report|Your pick for today/).map((e) => e.textContent)).toEqual(['Write the report', 'Your pick for today']);
  });

  const monthly = { plan_cadence: { every: 1, unit: 'months' as const, anchor: '2026-10-08' }, plan_stretch: { last_planned: '2026-10-08' } };

  it('offers to plan the next stretch when it is due', async () => {
    const t = await open(async (w) => {
      await w.create('settings', monthly, 'settings');
    });
    expect(await screen.findByText('Plan the next stretch. It starts Nov 8.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(t.nav().flow?.area).toBe('plan');
  });

  it.each(['desktop', 'phone'] as const)('never planned, offers a first plan from the first day, on %s', async (layout) => {
    await open(async () => undefined, { layout });
    expect(await screen.findByText('Plan your first stretch. It ends Dec 31.')).toBeVisible();
  });

  it.each(['desktop', 'phone'] as const)('never planned, offers a first plan of this stretch instead, on %s', async (layout) => {
    await open((w) => w.create('settings', { plan_cadence: monthly.plan_cadence }, 'settings'), { layout });
    expect(await screen.findByText('Plan your first stretch. It ends Nov 7.')).toBeVisible();
    expect(screen.queryByText(/Plan the next stretch/)).toBeNull();
  });

  it('keeps a first plan skipped the next day, though it would start from that day', async () => {
    const unplanned = (w: Writer) => w.create('settings', { plan_cadence: monthly.plan_cadence }, 'settings');
    await open(unplanned);
    await screen.findByText('Plan your first stretch. It ends Nov 7.');
    await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    cleanup();
    await open(unplanned, { now: at('14:00', '2026-11-03') });
    await screen.findByRole('heading', { level: 1, name: 'Today' });
    expect(screen.queryByText('Plan your first stretch. It ends Nov 7.')).toBeNull();
    localStorage.clear();
  });

  it('on phone, Start opens planning the stretch, and its × is named in full and puts it away', async () => {
    const t = await open(async () => undefined, { layout: 'phone' });
    const start = await screen.findByRole('button', { name: 'Plan your first stretch. It ends Dec 31. Start' });
    expect(within(start).getByText('Start')).toHaveClass('attngo');
    await userEvent.click(start);
    expect(t.nav().flow?.area).toBe('plan');
    await userEvent.click(screen.getByRole('button', { name: 'Skip for now: Plan your first stretch. It ends Dec 31.' }));
    await waitFor(() => expect(screen.queryByText('Plan your first stretch. It ends Dec 31.')).toBeNull());
    localStorage.clear();
  });

  it('lets the next stretch alert be skipped on desktop too', async () => {
    await open(async (w) => {
      await w.create('settings', monthly, 'settings');
    });
    expect(await screen.findByText('Plan the next stretch. It starts Nov 8.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(screen.queryByText('Plan the next stretch. It starts Nov 8.')).toBeNull());
  });
});

describe('Google Calendar', () => {
  const fakeSync = () =>
    ({
      signIn: vi.fn(async () => undefined),
      signOut: vi.fn(async () => undefined),
      syncNow: vi.fn(async () => undefined),
      connectCalendar: vi.fn(async () => undefined),
      refreshCalendar: vi.fn(async () => undefined),
      disconnectCalendar: vi.fn(async () => undefined),
      stop: vi.fn(),
      email: vi.fn(async () => null),
      eraseAndSignIn: vi.fn(async () => undefined),
    }) satisfies AppSync;
  const signIn = (t: Harness) =>
    act(async () => {
      await setMeta(t.db, META.lastSyncAt, NOW);
      t.db.notifyChanged({ source: 'remote' });
    });
  afterEach(() => localStorage.clear());

  it('on desktop, asks to connect it once signed in, and Connect opens Google', async () => {
    const sync = fakeSync();
    const t = await open(async () => undefined, { sync });
    await signIn(t);
    // After the first plan's alert.
    await userEvent.click(await screen.findByRole('button', { name: 'Show 1 more alert' }));
    expect(screen.getByText('Connect Google Calendar')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(sync.connectCalendar).toHaveBeenCalledOnce();
  });

  it('on phone, Connect opens Google, and × puts it away for the week', async () => {
    const sync = fakeSync();
    const t = await open(async () => undefined, { layout: 'phone', sync });
    await signIn(t);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Google Calendar Connect' }));
    expect(sync.connectCalendar).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Skip for now: Connect Google Calendar' }));
    await waitFor(() => expect(screen.queryByText('Connect Google Calendar')).toBeNull());
    cleanup();
    await signIn(await open(async () => undefined, { layout: 'phone', sync, now: at('14:00', '2026-11-04') }));
    await screen.findByRole('heading', { level: 1, name: 'Today' });
    expect(screen.queryByText('Connect Google Calendar')).toBeNull();
    cleanup();
    const next = '2026-11-09';
    const plannedNext = (w: Writer) => w.create('week_plan', { week_start: next, finished_at: at('08:00', next) }, weekPlanId(next));
    await signIn(await open(plannedNext, { layout: 'phone', sync, now: at('14:00', next) }));
    expect(await screen.findByText('Connect Google Calendar')).toBeVisible();
  });

  it('is not asked once connected, or before signing in', async () => {
    const sync = fakeSync();
    const t = await open((w) => w.create('calendar', { connected: true }, CALENDAR_ID), { layout: 'phone', sync });
    await signIn(t);
    await screen.findByRole('heading', { level: 1, name: 'Today' });
    expect(screen.queryByText('Connect Google Calendar')).toBeNull();
    cleanup();
    await open(async () => undefined, { layout: 'phone', sync });
    await screen.findByRole('heading', { level: 1, name: 'Today' });
    expect(screen.queryByText('Connect Google Calendar')).toBeNull();
  });
});

describe('one offs due today', () => {
  const dated = (w: Writer) => w.create('task', { kind: 'one_off', title: 'Paint the fence', schedule: { type: 'once', from: DAY }, next_due: DAY }, 't2');

  it('a tick takes it out of view with Undo; shown, it unticks in place', async () => {
    const t = await open(dated);
    const list = await screen.findByRole('region', { name: 'One offs today' });
    const fence = () => within(list).getByRole('checkbox', { name: 'Paint the fence done' });
    await userEvent.click(fence());
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't2'))?.done_at).toBe(NOW));
    expect(await screen.findByText('Completed Paint the fence.')).toBeVisible();
    // It was the only one, so focus moves to Show completed.
    await waitFor(() => expect(within(list).getByRole('button', { name: 'Show 1 completed in One offs today' })).toHaveFocus());
    expect(within(list).queryByRole('checkbox')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(fence()).toHaveFocus());
    expect(fence()).not.toBeChecked();
    expect((await getRecord(t.db, 'task', 't2'))?.done_at).toBeNull();

    await userEvent.click(fence());
    await userEvent.click(await within(list).findByRole('button', { name: 'Show 1 completed in One offs today' }));
    expect(fence()).toBeChecked();
    await userEvent.click(fence());
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't2'))?.done_at).toBeNull());
    expect(fence()).not.toBeChecked();
  });

  it('a row moved off today leaves focus on the next one, and on Undo once none are left', async () => {
    const t = await open(async (w) => {
      await dated(w);
      await w.create('task', { kind: 'one_off', title: 'Wash the car', schedule: { type: 'once', from: DAY }, next_due: DAY }, 't3');
    });
    const list = await screen.findByRole('region', { name: 'One offs today' });
    await userEvent.click(within(list).getByRole('button', { name: 'Change date for Paint the fence' }));
    fireEvent.change(within(list).getByLabelText('Date'), { target: { value: '2026-11-05' } });
    await userEvent.click(within(list).getByRole('button', { name: 'Set date' }));
    await waitFor(() => expect(within(list).queryByText('Paint the fence')).toBeNull());
    await waitFor(() => expect(within(list).getByRole('checkbox', { name: 'Wash the car done' })).toHaveFocus());

    await userEvent.click(within(list).getByRole('button', { name: 'Change date for Wash the car' }));
    fireEvent.change(within(list).getByLabelText('Date'), { target: { value: '2026-11-06' } });
    await userEvent.click(within(list).getByRole('button', { name: 'Set date' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'One offs today' })).toBeNull());
    expect(screen.getByText('Wash the car, Nov 6.')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't3'))?.schedule).toEqual({ type: 'once', from: DAY }));
  });

  it('Find a time opens Week to place it, and Change date moves it off today', async () => {
    const t = await open(dated);
    const list = await screen.findByRole('region', { name: 'One offs today' });
    const change = within(list).getByRole('button', { name: 'Change date for Paint the fence' });
    await userEvent.click(change);
    await userEvent.keyboard('{Escape}');
    expect(within(list).queryByLabelText('Date')).toBeNull();
    // Focus goes back to Change date rather than the page.
    expect(change).toHaveFocus();
    await userEvent.click(change);
    fireEvent.change(within(list).getByLabelText('Date'), { target: { value: '2026-11-05' } });
    await userEvent.click(within(list).getByRole('button', { name: 'Set date' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'One offs today' })).toBeNull());
    expect((await getRecord(t.db, 'task', 't2'))?.schedule).toEqual({ type: 'once', from: '2026-11-05', to: null });

    await act(() => t.write((w) => w.set('task', 't2', { schedule: { type: 'once', from: DAY }, next_due: DAY })));
    await userEvent.click(await screen.findByRole('button', { name: 'Find a time for Paint the fence' }));
    expect(t.nav().route).toMatchObject({ area: 'week', params: { place: 't2' } });
  });
});

describe('the timeline', () => {
  const day = async (w: Writer) => {
    await w.create('objective', { title: 'Write more', state: 'active' }, 'g');
    await w.create('project', { objective_id: 'g', title: 'Finish the essay', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p');
    await task(w, 't1', 'Write the report');
    await block(w, 'b1', 't1', '16:00', '17:00');
  };

  it('opens a block to show what it belongs to', async () => {
    await open(day);
    await userEvent.click(await screen.findByRole('button', { name: /^Write the report, 4pm to 5pm/ }));
    const detail = screen.getByRole('region', { name: 'Write the report' });
    expect(await within(detail).findByText('Write more > Finish the essay')).toBeVisible();
  });

  it('says what kind each block is, not only by its colour', async () => {
    await open(async (w) => {
      await day(w);
      await w.create('practice', { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' }, 'pr');
      await w.create('time_block', { practice_id: 'pr', start: at('18:00'), end: at('18:30'), tz: ZONE }, 'b2');
    });
    expect(await screen.findByRole('button', { name: 'Piano practice, 6pm to 6:30pm, Practice.' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Write the report, 4pm to 5pm, Project.' })).toBeVisible();
  });

  it('switches to a list and remembers it', async () => {
    await open(day);
    await userEvent.click(await screen.findByRole('button', { name: 'List' }));
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    const row = screen.getByRole('button', { name: /^4pm to 5pm/ });
    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(await within(row.parentElement!).findByText('Write more > Finish the essay')).toBeVisible();
    // Open task opens its popup.
    await userEvent.click(within(row.parentElement!).getByRole('button', { name: 'Open Write the report' }));
    expect(await screen.findByRole('dialog', { name: 'Write the report' })).toBeVisible();
  });

  it('zooms in and out', async () => {
    await open(day);
    const out = await screen.findByRole('button', { name: 'Zoom out' });
    expect(out).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(out).toBeEnabled();
  });

  it('on phone opens details in a sheet', async () => {
    await open(day, { layout: 'phone' });
    await userEvent.click(await screen.findByRole('slider', { name: /^Write the report, 4pm to 5pm/ }));
    const sheet = await dialog('Write the report');
    expect(await within(sheet).findByText('Write more > Finish the essay')).toBeVisible();
  });
});

describe('moving a block on the timeline', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const day = async (w: Writer) => {
    await task(w, 't1', 'Write the report');
    await block(w, 'b1', 't1', '16:00', '17:00');
  };
  const report = (name: RegExp = /^Write the report, /, role = 'button') => screen.findByRole(role, { name });
  const saved = (t: Harness, id = 'b1') => getRecord(t.db, 'time_block', id);
  // jsdom has no layout. The first zoom draws 30px an hour, so each pixel is two minutes.
  const press = async (el: Element, layout: Layout) => {
    fireEvent.pointerDown(el, { clientY: 300, button: 0 });
    // On phone a block moves once held, so a swipe still scrolls the page.
    if (layout === 'phone') await wait(450);
  };
  const drag = async (el: Element, dy: number, layout: Layout) => {
    await press(el, layout);
    fireEvent.pointerMove(window, { clientY: 300 + dy });
    fireEvent.pointerUp(window, { clientY: 300 + dy });
  };
  const edge = (el: Element, layout: Layout) => el.querySelector(layout === 'phone' ? '.rz' : '.evh')!;

  for (const layout of ['desktop', 'phone'] as const) {
    describe(`on ${layout}`, () => {
      // On phone a block still to come is a slider, as on Week, so VoiceOver's swipes move it.
      const movable = (name?: RegExp) => report(name, layout === 'phone' ? 'slider' : 'button');

      it('a drag moves it on a 15-minute grid without opening it, and Undo puts it back', async () => {
        const t = await open(day, { layout });
        const el = await movable();
        expect(el).toHaveAccessibleDescription(layout === 'phone' ? 'Hold it, then drag to move it, or hold its handle and drag to change its length.' : /arrow keys move it/);
        // 11px is 22 minutes, which lands on a quarter past.
        await drag(el, 11, layout);
        fireEvent.click(el);
        expect(await screen.findByText('Write the report is now 4:15pm to 5:15pm.')).toBeVisible();
        expect(await saved(t)).toMatchObject({ start: at('16:15'), end: at('17:15') });
        expect(await movable(/^Write the report, 4:15pm to 5:15pm/)).toBeVisible();
        expect(screen.queryByRole('dialog', { name: 'Write the report' })).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
        expect(await movable(/^Write the report, 4pm to 5pm/)).toBeVisible();
        expect(await saved(t)).toMatchObject({ start: at('16:00'), end: at('17:00') });
      });

      it("snaps to the day's suggested time, shown while dragging", async () => {
        const t = await open(day, { layout });
        // 25px is 50 minutes, 4:50pm, within 20 minutes of 5pm: the first open hour of a weekday evening.
        await press(await movable(), layout);
        fireEvent.pointerMove(window, { clientY: 325 });
        expect(await screen.findByText('Suggested 5pm')).toBeVisible();
        expect(await movable(/^Write the report, 5pm to 6pm/)).toHaveClass('lifted');
        fireEvent.pointerUp(window, { clientY: 325 });
        await waitFor(async () => expect(await saved(t)).toMatchObject({ start: at('17:00'), end: at('18:00') }));
        expect(screen.queryByText('Suggested 5pm')).toBeNull();
      });

      it('the bottom edge changes its length, and a time outside available hours says so', async () => {
        const t = await open(day, { layout });
        await drag(edge(await movable(), layout), 15, layout);
        expect(await screen.findByText('Write the report is now 4pm to 5:30pm.')).toBeVisible();
        expect(await saved(t)).toMatchObject({ start: at('16:00'), end: at('17:30') });
        // 165px is five and a half hours: 9:30pm, running past 10pm when the day closes.
        await drag(await movable(/^Write the report, 4pm to 5:30pm/), 165, layout);
        expect(await screen.findByText("Write the report is now 9:30pm to 11pm. That's outside your available hours.")).toBeVisible();
      });

      it('arrow keys move it, Shift and arrows change its length, and Undo takes the steps back together', async () => {
        const t = await open(async (w) => {
          await day(w);
          await w.create('task', { kind: 'one_off', title: 'Paint the fence' }, 't2');
          await block(w, 'b2', 't2', '16:15', '16:30');
        }, { layout });
        (await movable()).focus();
        await userEvent.keyboard('{ArrowDown}{ArrowDown}{Shift>}{ArrowDown}{/Shift}');
        expect(await screen.findByText('Write the report is now 4:30pm to 5:45pm.')).toBeVisible();
        expect(await saved(t)).toMatchObject({ start: at('16:30'), end: at('17:45') });
        // Now after Paint the fence, and still the one with focus.
        expect(await movable(/^Write the report, 4:30pm to 5:45pm/)).toHaveFocus();
        await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
        await waitFor(async () => expect(await saved(t)).toMatchObject({ start: at('16:00'), end: at('17:00') }));
      });

      it('a nudge after focus has left the block is a change of its own, with its own Undo', async () => {
        const t = await open(day, { layout });
        const el = await movable();
        el.focus();
        await userEvent.keyboard('{ArrowDown}');
        expect(await screen.findByText('Write the report is now 4:15pm to 5:15pm.')).toBeVisible();
        act(() => el.blur());
        el.focus();
        await userEvent.keyboard('{ArrowDown}');
        expect(await screen.findByText('Write the report is now 4:30pm to 5:30pm.')).toBeVisible();
        await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
        await waitFor(async () => expect(await saved(t)).toMatchObject({ start: at('16:15'), end: at('17:15') }));
      });

      it('a past block stays put', async () => {
        const t = await open(
          async (w) => {
            await task(w, 't3', 'Rake the leaves');
            await block(w, 'b3', 't3', '10:00', '11:00');
            await w.create('block_outcome', { result: 'done', answered_at: at('11:00') }, outcomeId('b3'));
          },
          { layout },
        );
        const el = await report(/^Rake the leaves, 10am to 11am/);
        expect(el).not.toHaveAccessibleDescription(/drag/i);
        expect(el.querySelector('.evh, .rz')).toBeNull();
        await drag(el, 30, layout);
        el.focus();
        await userEvent.keyboard('{ArrowDown}{Shift>}{ArrowDown}{/Shift}');
        expect(await saved(t, 'b3')).toMatchObject({ start: at('10:00'), end: at('11:00') });
        expect(screen.queryByText(/is now/)).toBeNull();
      });

      it('the block under way keeps its start, and its end still changes, though never to before now', async () => {
        const t = await open(
          async (w) => {
            await task(w, 't1', 'Write the report');
            await block(w, 'b1', 't1', '13:00', '15:00');
          },
          { layout },
        );
        const el = await report(/^Write the report, 1pm to 3pm/);
        expect(el).toHaveAccessibleDescription(layout === 'phone' ? 'Hold its handle and drag to change its length.' : 'Drag its bottom edge, or use Shift and the up and down arrow keys, to change its length.');
        await drag(el, 30, layout);
        el.focus();
        await userEvent.keyboard('{ArrowDown}');
        expect(await saved(t)).toMatchObject({ start: at('13:00'), end: at('15:00') });
        expect(screen.queryByText(/is now/)).toBeNull();

        await drag(edge(el, layout), 15, layout);
        expect(await screen.findByText('Write the report is now 1pm to 3:30pm.')).toBeVisible();
        expect(await saved(t)).toMatchObject({ start: at('13:00'), end: at('15:30') });
        const longer = await report(/^Write the report, 1pm to 3:30pm/);
        longer.focus();
        // Eight steps back from 3:30pm would be 1:30pm; it stops at 2pm, now.
        await userEvent.keyboard(`{Shift>}${'{ArrowUp}'.repeat(8)}{/Shift}`);
        await waitFor(async () => expect(await saved(t)).toMatchObject({ start: at('13:00'), end: at('14:00') }));
      });

      it('a block running past midnight stays put, since only today is drawn', async () => {
        const t = await open(
          async (w) => {
            await task(w, 't1', 'Write the report');
            await w.create('time_block', { task_id: 't1', start: at('23:30'), end: at('00:30', '2026-11-03'), tz: ZONE }, 'b1');
          },
          { layout },
        );
        const el = await report();
        expect(el.querySelector('.evh, .rz')).toBeNull();
        el.focus();
        await userEvent.keyboard('{ArrowUp}{Shift>}{ArrowUp}{/Shift}');
        expect(await saved(t)).toMatchObject({ start: at('23:30'), end: at('00:30', '2026-11-03') });
        expect(screen.queryByText(/is now/)).toBeNull();
      });
    });
  }

  it('on phone, a block still to come is a slider, as on Week, so VoiceOver can move it, and Enter or a tap opens it', async () => {
    const t = await open(day, { layout: 'phone' });
    const el = await report(/^Write the report, 4pm to 5pm/, 'slider');
    expect(el).toHaveAttribute('aria-orientation', 'vertical');
    expect(el).toHaveAttribute('aria-valuetext', '4pm to 5pm');
    const before = Number(el.getAttribute('aria-valuenow'));
    // VoiceOver's swipe up sends Up, which raises the value and moves the block earlier.
    el.focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(await screen.findByText('Write the report is now 3:45pm to 4:45pm.')).toBeVisible();
    expect(await saved(t)).toMatchObject({ start: at('15:45'), end: at('16:45') });
    const moved = await report(/^Write the report, 3:45pm to 4:45pm/, 'slider');
    expect(moved).toHaveAttribute('aria-valuetext', '3:45pm to 4:45pm');
    expect(Number(moved.getAttribute('aria-valuenow'))).toBe(before + 15);
    await userEvent.keyboard('{Enter}');
    await userEvent.click(within(await dialog('Write the report')).getByRole('button', { name: 'Close' }));
    await userEvent.click(moved);
    expect(await dialog('Write the report')).toBeVisible();
  });

  it('on phone, a finger that moves before the hold scrolls instead, and a hold let go in place opens nothing', async () => {
    const t = await open(day, { layout: 'phone' });
    const el = await report(undefined, 'slider');
    fireEvent.pointerDown(el, { clientY: 300, button: 0 });
    fireEvent.pointerMove(window, { clientY: 330 });
    await wait(450);
    expect(el).not.toHaveClass('lifted');
    fireEvent.pointerMove(window, { clientY: 360 });
    fireEvent.pointerUp(window, { clientY: 360 });
    expect(await saved(t)).toMatchObject({ start: at('16:00') });

    await press(el, 'phone');
    expect(el).toHaveClass('lifted');
    fireEvent.pointerUp(window, { clientY: 300 });
    fireEvent.click(el);
    expect(screen.queryByRole('dialog', { name: 'Write the report' })).toBeNull();
    expect(el).not.toHaveClass('lifted');
    // A tap a moment later opens it as before.
    await wait(450);
    await userEvent.click(el);
    expect(await dialog('Write the report')).toBeVisible();
  });
});

describe.each(['desktop', 'phone'] as const)('the Inbox, on %s', (layout) => {
  it("isn't asked about on Today: the tab shows its count, and planning asks", async () => {
    await open((w) => w.create('task', { kind: 'inbox', title: 'Rake the leaves' }), { layout });
    await screen.findByRole('heading', { name: 'Today' });
    expect(screen.queryByText(/to sort/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open Inbox' })).toBeNull();
  });
});

describe('To schedule on Today', () => {
  // Picked for 2h with nothing placed, a one off dated Wednesday, and one dated today.
  const picks = async (w: Writer) => {
    await w.create('project', { title: 'Report', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p');
    await task(w, 't1', 'Write the report', { estimate_min: 120 });
    await setWeekPick(w, DAY, 't1', 120);
    await w.create('task', { kind: 'one_off', title: 'Renew the passport', estimate_min: 30, schedule: { type: 'once', from: '2026-11-04' } }, 'o1');
    await w.create('task', { kind: 'one_off', title: 'Call the bank', estimate_min: 30, schedule: { type: 'once', from: DAY } }, 'o2');
  };
  const pointAt = (el: () => Element | null) => Object.defineProperty(document, 'elementFromPoint', { value: () => el(), configurable: true });
  afterEach(() => Reflect.deleteProperty(document, 'elementFromPoint'));
  const live = async (t: Harness, id: string) => (await listRecords(t.db, 'time_block')).filter((b) => b.task_id === id && !b.deleted_at);

  it('sits just above the day with work for today or any day, and a suggestion places it', async () => {
    const t = await open(picks);
    const lane = await screen.findByRole('region', { name: 'To schedule' });
    expect(within(lane).getByText('2 · 2h 30m')).toBeVisible();
    expect(within(lane).queryByRole('button', { name: /^Renew the passport/ })).toBeNull();
    // Right above the timeline.
    expect(lane.nextElementSibling?.querySelector('.day, .daywrap')).not.toBeNull();
    await userEvent.click(within(lane).getByRole('button', { name: /^Write the report, Project, 2h/ }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Write the report' })).getAllByRole('button', { name: /^Place Write the report, / })[0]!);
    await waitFor(async () => expect(await live(t, 't1')).toHaveLength(1));
    await waitFor(() => expect(within(lane).queryByRole('button', { name: /^Write the report, Project/ })).toBeNull());
  });

  it('a card dragged onto the day is placed where it is let go', async () => {
    const t = await open(picks);
    const card = await screen.findByRole('button', { name: /^Call the bank, One off/ });
    const day = document.querySelector('[data-drop-date="2026-11-02"]')!;
    // The day from 7am to 10pm drawn 450px tall, 30px an hour, so y 330 is 6pm.
    vi.spyOn(day, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 450, top: 0, left: 0, right: 300, bottom: 450, x: 0, y: 0, toJSON: () => ({}) });
    pointAt(() => day);
    fireEvent.pointerDown(card, { clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerMove(window, { clientX: 100, clientY: 330 });
    fireEvent.pointerUp(window, { clientX: 100, clientY: 330 });
    await waitFor(async () => expect((await live(t, 'o2')).map((b) => b.start)).toEqual([at('18:00')]));
  });

  it('on phone, a card is held before it drags, and a quick swipe leaves it be', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const t = await open(picks, { layout: 'phone' });
      const card = await screen.findByRole('button', { name: /^Call the bank, One off/ });
      const day = document.querySelector('[data-drop-date="2026-11-02"]')!;
      vi.spyOn(day, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 450, top: 0, left: 0, right: 300, bottom: 450, x: 0, y: 0, toJSON: () => ({}) });
      pointAt(() => day);
      const press = (holdMs: number) => {
        fireEvent.pointerDown(card, { clientX: 10, clientY: 10, button: 0, pointerType: 'touch' });
        act(() => void vi.advanceTimersByTime(holdMs));
        fireEvent.pointerMove(window, { clientX: 100, clientY: 330, pointerType: 'touch' });
        fireEvent.pointerUp(window, { clientX: 100, clientY: 330, pointerType: 'touch' });
      };
      press(100);
      expect(document.querySelector('.cardghost')).toBeNull();
      expect(await live(t, 'o2')).toEqual([]);
      press(450);
      await waitFor(async () => expect((await live(t, 'o2')).map((b) => b.start)).toEqual([at('18:00')]));
    } finally {
      vi.useRealTimers();
    }
  });
});
