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
import { renderApp, renderScreen } from '../../app/testing';
import type { Harness, HarnessOptions } from '../../app/testing';
import { noFiles } from '../../../core/sync-testing';

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
// The task's own popup, to read and change it, rather than a block's details, which on phone is a sheet of the same name.
const taskPopup = async (name: string) => {
  const popup = await dialog(name);
  expect(within(popup).getByRole('button', { name: 'Delete task' })).toBeVisible();
  return popup;
};
const slideTo = (slider: HTMLElement, minutes: number) => fireEvent.change(slider, { target: { value: String(EST_STEPS.indexOf(minutes)) } });

describe('the Done today line', () => {
  it('ends Today, says nothing is finished until something is, and opens Done on today', async () => {
    const t = await open(async (w) => {
      await task(w, 't1', 'Write the report');
      await block(w, 'b1', 't1', '13:00', '15:00');
    });
    const empty = await screen.findByRole('button', { name: 'Done: nothing finished yet today' });
    expect(empty).toHaveTextContent('Nothing finished yet today›');
    expect(screen.getByRole('heading', { name: 'Timeline' }).compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Mark done now' }));
    const line = await screen.findByRole('button', { name: 'Done today: 1 finished, 1h worked' });
    expect(line).toHaveTextContent('Done today · 1 · 1h›');
    await userEvent.click(line);
    expect(t.nav().route).toMatchObject({ area: 'done', params: { day: DAY } });
  });
});

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
    const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 100)));

    it('shows the percent of the block spent once started, and tapping it pauses: the countdown stops and the card says when it ends', async () => {
      const t = await open(running);
      const now = await screen.findByRole('region', { name: 'Current block' });
      // The middle shows the percent; the name says both it and the time spent.
      const pause = within(now).getByRole('button', { name: 'Pause, 1 hour spent, 50% of the block' });
      expect(pause).toHaveTextContent(/^50%$/);
      await userEvent.click(pause);
      const ring = await within(now).findByRole('button', { name: 'Resume, 1 hour spent, 50% of the block' });
      // Focus stays on the ring, which now resumes, and a toast says what happened.
      expect(ring).toHaveFocus();
      expect(await screen.findByText('Paused Write the report')).toBeVisible();
      expect((await getRecord(t.db, 'time_block', 'b1'))?.paused_at).toBe(NOW);
      expect(within(now).getByText('Ends at 3pm unless you resume.')).toBeVisible();
      later(t, 9);
      expect(await within(now).findByText('Paused for 9 min', {}, { timeout: 2000 })).toBeVisible();
      expect(within(now).getByRole('timer')).toHaveTextContent('1:00:00');
    });

    it('Resume moves the end later by the pause and says the new end, and a tap on the ring within 30 seconds takes it back exactly', async () => {
      const t = await open(running);
      const now = await screen.findByRole('region', { name: 'Current block' });
      await userEvent.click(within(now).getByRole('button', { name: /^Pause, / }));
      await within(now).findByRole('button', { name: /^Resume, / });
      later(t, 9);
      await userEvent.click(within(now).getByRole('button', { name: /^Resume, / }));
      expect(await within(now).findByText('Now, 1pm to 3:09pm')).toBeVisible();
      expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ paused_at: null, paused_min: 9, end: at('15:09') });
      expect(await within(now).findByRole('button', { name: 'Pause, 1 hour spent, 50% of the block' }, { timeout: 2000 })).toBeVisible();
      // The toast says the new end, and leaves focus on the ring.
      expect(await screen.findByText('Resumed. It now ends at 3:09pm.')).toBeVisible();
      expect(within(now).getByRole('button', { name: /^Pause, / })).toHaveFocus();
      await userEvent.click(within(now).getByRole('button', { name: /^Pause, / }));
      await waitFor(async () => expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ paused_at: NOW, end: at('15:00') }));
      expect((await getRecord(t.db, 'time_block', 'b1'))?.paused_min ?? null).toBeNull();
      // That's a Pause too: its toast takes the place of Resume's, and its Undo puts the block back as Resume left it.
      expect(await screen.findByText('Paused Write the report')).toBeVisible();
      expect(screen.queryByText(/^Resumed/)).toBeNull();
      await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
      await waitFor(async () => expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ paused_at: null, paused_min: 9, end: at('15:09') }));
    });

    it("Undo on Pause's toast takes the pause away, with the end where it was", async () => {
      const t = await open(running);
      const now = await screen.findByRole('region', { name: 'Current block' });
      await userEvent.click(within(now).getByRole('button', { name: /^Pause, / }));
      await within(now).findByRole('button', { name: /^Resume, / });
      later(t, 9);
      await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
      expect(await within(now).findByRole('button', { name: /^Pause, / })).toBeVisible();
      const b1 = await getRecord(t.db, 'time_block', 'b1');
      expect(b1).toMatchObject({ paused_at: null, end: at('15:00') });
      expect(b1?.paused_min ?? null).toBeNull();
      expect(within(now).getByText('Now, 1pm to 3pm')).toBeVisible();
    });

    it("Undo on Resume's toast puts the pause back as it was: paused again, with its old end", async () => {
      const t = await open(running);
      const now = await screen.findByRole('region', { name: 'Current block' });
      await userEvent.click(within(now).getByRole('button', { name: /^Pause, / }));
      await within(now).findByRole('button', { name: /^Resume, / });
      later(t, 9);
      await userEvent.click(within(now).getByRole('button', { name: /^Resume, / }));
      expect(await screen.findByText('Resumed. It now ends at 3:09pm.')).toBeVisible();
      later(t, 10);
      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(await within(now).findByRole('button', { name: /^Resume, / })).toBeVisible();
      const b1 = await getRecord(t.db, 'time_block', 'b1');
      expect(b1).toMatchObject({ paused_at: NOW, end: at('15:00') });
      expect(b1?.paused_min ?? null).toBeNull();
      expect(within(now).getByText('Now, 1pm to 3pm')).toBeVisible();
      expect(await within(now).findByText('Paused for 10 min', {}, { timeout: 2000 })).toBeVisible();
      expect(screen.queryByText(/^Resumed/)).toBeNull();
    });

    it('a Resume another device got to first says nothing', async () => {
      const t = await open(running);
      const now = await screen.findByRole('region', { name: 'Current block' });
      await userEvent.click(within(now).getByRole('button', { name: /^Pause, / }));
      const ring = await within(now).findByRole('button', { name: /^Resume, / });
      later(t, 9);
      // Resumed elsewhere, synced in just before this tap, which then finds nothing to resume.
      const elsewhere = t.write((w) => w.set('time_block', 'b1', { paused_at: null, paused_min: 9, end: at('15:09') }));
      fireEvent.click(ring);
      await elsewhere;
      expect(await within(now).findByRole('button', { name: /^Pause, / })).toBeVisible();
      await settle();
      expect(screen.queryByText(/^Resumed/)).toBeNull();
      expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ paused_at: null, paused_min: 9, end: at('15:09') });
    });

    describe('the P key', () => {

      it('on desktop, pauses and resumes as the ring does, with the same toast and take-back', async () => {
        const t = await open(running);
        const now = await screen.findByRole('region', { name: 'Current block' });
        await within(now).findByRole('button', { name: /^Pause, / });
        await userEvent.keyboard('p');
        expect(await within(now).findByRole('button', { name: /^Resume, / })).toBeVisible();
        expect(await screen.findByText('Paused Write the report')).toBeVisible();
        expect((await getRecord(t.db, 'time_block', 'b1'))?.paused_at).toBe(NOW);
        later(t, 9);
        await userEvent.keyboard('p');
        await waitFor(async () => expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ paused_at: null, paused_min: 9, end: at('15:09') }));
        // With no tap to put Pause's toast away, Resume's takes its place.
        expect(await screen.findByText('Resumed. It now ends at 3:09pm.')).toBeVisible();
        expect(screen.queryByText('Paused Write the report')).toBeNull();
        // The ring says it's there, for screen readers.
        expect(within(now).getByRole('button', { name: /^Pause, / })).toHaveAttribute('aria-keyshortcuts', 'P');
        // P straight after takes the Resume back, and Pause's toast takes the place of Resume's.
        await userEvent.keyboard('p');
        await waitFor(async () => expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ paused_at: NOW, end: at('15:00') }));
        expect(await screen.findByText('Paused Write the report')).toBeVisible();
        expect(screen.queryByText(/^Resumed/)).toBeNull();
      });

      it('does nothing while typing, with a modifier held, or with a dialog open', async () => {
        const t = await open(running);
        const now = await screen.findByRole('region', { name: 'Current block' });
        await within(now).findByRole('button', { name: /^Pause, / });
        const editable = document.createElement('div');
        editable.setAttribute('contenteditable', 'true');
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.append(document.createElement('button'));
        for (const [holder, field] of [
          [document.createElement('input'), null],
          [document.createElement('textarea'), null],
          [editable, null],
          [dialog, dialog.firstElementChild],
        ] as const) {
          document.body.append(holder);
          const target = (field ?? holder) as HTMLElement;
          target.tabIndex = 0;
          target.focus();
          expect(target).toHaveFocus();
          await userEvent.keyboard('p');
          holder.remove();
        }
        for (const held of ['Meta', 'Control', 'Alt', 'Shift']) await userEvent.keyboard(`{${held}>}p{/${held}}`);
        await settle();
        expect(screen.queryByText('Paused Write the report')).toBeNull();
        expect((await getRecord(t.db, 'time_block', 'b1'))?.paused_at ?? null).toBeNull();
        // With focus back on the page, it pauses.
        await userEvent.keyboard('p');
        expect(await within(now).findByRole('button', { name: /^Resume, / })).toBeVisible();
      });

      it('does nothing while another tab is open, though Today stays behind it', async () => {
        const t = await renderApp({
          now: NOW,
          zone: ZONE,
          seed: async (w) => {
            await planned(w);
            await running(w);
          },
        });
        await screen.findByRole('button', { name: /^Pause, / });
        const tabs = screen.getByRole('navigation', { name: 'Main' });
        await userEvent.click(within(tabs).getByRole('button', { name: 'Week' }));
        // Hidden, so out of the accessibility tree, but still mounted.
        await waitFor(() => expect(screen.queryByRole('button', { name: /^Pause, / })).toBeNull());
        expect(document.querySelector('.spentring')).not.toBeNull();
        await userEvent.keyboard('p');
        await settle();
        expect((await getRecord(t.db, 'time_block', 'b1'))?.paused_at ?? null).toBeNull();
        await userEvent.click(within(tabs).getByRole('button', { name: 'Today' }));
        await screen.findByRole('button', { name: /^Pause, / });
        await userEvent.keyboard('p');
        expect(await screen.findByRole('button', { name: /^Resume, / })).toBeVisible();
      });

      it('does nothing on phone', async () => {
        const t = await open(running, { layout: 'phone' });
        const now = await screen.findByRole('region', { name: 'Current block' });
        const ring = await within(now).findByRole('button', { name: /^Pause, / });
        expect(ring).not.toHaveAttribute('aria-keyshortcuts');
        await userEvent.keyboard('p');
        await settle();
        expect((await getRecord(t.db, 'time_block', 'b1'))?.paused_at ?? null).toBeNull();
        expect(within(now).getByRole('button', { name: /^Pause, / })).toBeVisible();
      });
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

    it('a quick second tap leaves no trace, and its toast says the end is where it was', async () => {
      const t = await open(running);
      const now = await screen.findByRole('region', { name: 'Current block' });
      await userEvent.click(within(now).getByRole('button', { name: /^Pause, / }));
      await userEvent.click(await within(now).findByRole('button', { name: /^Resume, / }));
      await within(now).findByRole('button', { name: /^Pause, / });
      expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ paused_at: null, end: at('15:00') });
      expect(await screen.findByText('Resumed. It now ends at 3pm.')).toBeVisible();
      expect(screen.queryByText('Paused Write the report')).toBeNull();
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
      // On desktop it names the key that does the same.
      expect(within(key).getByText('Tap the ring or press P to pause the countdown')).toBeVisible();
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
    expect(await screen.findByText('Resumed. It now ends at 2:28pm.')).toBeVisible();
    // Pressed by mistake, a tap on the ring takes it back: paused from the same moment, and the block missed again.
    await userEvent.click(ring);
    await waitFor(async () => expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ paused_at: at('13:22'), end: at('13:50') }));
    expect(screen.queryByText(/^Resumed/)).toBeNull();
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
    expect(screen.getByText("This week isn't planned yet. About 30m.")).toBeVisible();
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
    await userEvent.click(await screen.findByRole('button', { name: 'Skip planning this week' }));
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

  // The stretch's planning row replaces the alert these asked with; planning-task.test.tsx in plan/ covers the row.
  it('offers to plan the next stretch when it is due, as a row with its dates', async () => {
    await open(async (w) => {
      await w.create('settings', monthly, 'settings');
    });
    const row = await screen.findByRole('region', { name: 'Plan the next stretch' });
    expect(within(row).getByText(/Nov 8 to Dec 7 · About 45m/)).toBeVisible();
  });

  it.each(['desktop', 'phone'] as const)('never planned, offers a first plan of the stretch under way, on %s', async (layout) => {
    await open(async () => undefined, { layout });
    expect(within(await screen.findByRole('region', { name: 'Plan your first stretch' })).getByText(/Ends Dec 31 · About 1h/)).toBeVisible();
  });

  it.each(['desktop', 'phone'] as const)('never planned, offers a first plan of this stretch instead, on %s', async (layout) => {
    await open((w) => w.create('settings', { plan_cadence: monthly.plan_cadence }, 'settings'), { layout });
    expect(within(await screen.findByRole('region', { name: 'Plan your first stretch' })).getByText('Ends Nov 7 · About 1h')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Plan the next stretch' })).toBeNull();
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
      files: noFiles(),
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
    expect(await screen.findByText('Connect Google Calendar')).toBeVisible();
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

  it("a click on a task's block opens the task, to read and change it", async () => {
    await open(day);
    const el = await screen.findByRole('button', { name: /^Write the report, 4pm to 5pm/ });
    expect(el).toHaveAttribute('aria-haspopup', 'dialog');
    await userEvent.click(el);
    await taskPopup('Write the report');
    expect(screen.queryByRole('region', { name: 'Write the report' })).toBeNull();
  });

  it("a practice's session and a planning block open their details, as before", async () => {
    await open(async (w) => {
      await day(w);
      await w.create('practice', { title: 'Piano practice', objective_id: 'g', target_min: 30, per: 'day', state: 'active' }, 'pr');
      await w.create('time_block', { practice_id: 'pr', start: at('18:00'), end: at('18:30'), tz: ZONE }, 'b2');
      await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 9', plans: ['week:2026-11-09'] }, 'planning:week:2026-11-09');
      await block(w, 'b3', 'planning:week:2026-11-09', '19:00', '19:30');
    });
    const practice = await screen.findByRole('button', { name: /^Piano practice, 6pm to 6:30pm/ });
    expect(practice).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(practice);
    expect(await within(screen.getByRole('region', { name: 'Piano practice' })).findByText(/^Write more/)).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Plan the week of Nov 9, 7pm to 7:30pm/ }));
    expect(screen.getByRole('region', { name: 'Plan the week of Nov 9' })).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
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
    // A row opens the task's popup, as its block on the calendar does.
    const row = screen.getByRole('button', { name: /^4pm to 5pm/ });
    expect(row).toHaveAttribute('aria-haspopup', 'dialog');
    await userEvent.click(row);
    await taskPopup('Write the report');
  });

  it('zooms in and out', async () => {
    await open(day);
    const out = await screen.findByRole('button', { name: 'Zoom out' });
    expect(out).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(out).toBeEnabled();
  });

  it("on phone, a tap on a task's block opens the task, and a practice's session opens its details in a sheet", async () => {
    await open(
      async (w) => {
        await day(w);
        await w.create('practice', { title: 'Piano practice', objective_id: 'g', target_min: 30, per: 'day', state: 'active' }, 'pr');
        await w.create('time_block', { practice_id: 'pr', start: at('18:00'), end: at('18:30'), tz: ZONE }, 'b2');
      },
      { layout: 'phone' },
    );
    const el = await screen.findByRole('slider', { name: /^Write the report, 4pm to 5pm/ });
    expect(el).toHaveAttribute('aria-haspopup', 'dialog');
    expect(el).toHaveAccessibleDescription(/^Tap to open it\./);
    await userEvent.click(el);
    await userEvent.click(within(await taskPopup('Write the report')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('slider', { name: /^Piano practice, 6pm to 6:30pm/ }));
    expect(await within(await dialog('Piano practice')).findByText(/^Write more/)).toBeVisible();
  });
});

describe.each(['desktop', 'phone'] as const)('blocks gone by on the timeline, on %s', (layout) => {
  afterEach(() => localStorage.clear());
  // A block's end prompt can be open over the timeline, so it's found whether or not a dialog hides it.
  const timeline = () => screen.findByRole('region', { name: "Today's timeline", hidden: true });
  // This morning: one done, one not done, one partly done and one with no answer yet.
  const morning = async (w: Writer) => {
    await w.create('project', { title: 'Finish the essay', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p');
    const answers = [
      ['Write the report', 'done'],
      ['Read the notes', 'not'],
      ['Email the editor', 'partly'],
      ['File the receipts', null],
    ] as const;
    for (const [i, [title, result]] of answers.entries()) {
      await task(w, `t${i}`, title);
      await block(w, `b${i}`, `t${i}`, `${8 + i}:00`, `${9 + i}:00`);
      if (result) await w.create('block_outcome', { result, answered_at: at(`${9 + i}:00`) }, outcomeId(`b${i}`));
    }
  };

  it('on the calendar, strikes through only what was done; Partly and Not done say so in words instead', async () => {
    await open(morning, { layout });
    const drawn = async (title: string) => (await within(await timeline()).findByText(title)).closest('.cev')!;
    const ended = layout === 'phone' ? 'c-ended' : 'ended';
    expect(await drawn('Write the report')).toHaveClass(ended, 'done');
    expect(await drawn('Read the notes')).toHaveClass(ended, 'notdone');
    expect(await drawn('Read the notes')).not.toHaveClass('done');
    expect(within((await drawn('Read the notes')) as HTMLElement).getByText('Not done')).toBeVisible();
    expect(await drawn('Email the editor')).toHaveClass(ended, 'partly');
    expect(await drawn('Email the editor')).not.toHaveClass('done');
    expect(within((await drawn('Email the editor')) as HTMLElement).getByText('Partly')).toBeVisible();
    // One with no answer yet is only muted, as on Week.
    expect(await drawn('File the receipts')).toHaveClass(ended);
    expect(await drawn('File the receipts')).not.toHaveClass('done');
    expect(await drawn('File the receipts')).toHaveTextContent(/^File the receipts/);
    expect(await drawn('Read the notes')).toHaveAccessibleName('Read the notes, 9am to 10am, Project. Not done.');
  });

  it('in the list, strikes through only what was done; Partly and Not done say so in words instead', async () => {
    await open(morning, { layout });
    await userEvent.click(await within(await timeline()).findByRole('button', { name: 'List', hidden: true }));
    const title = async (name: string) => within(await timeline()).findByText(name);
    const row = async (name: string) => (await title(name)).closest('.tlbtn') as HTMLElement;
    expect(await title('Write the report')).toHaveClass('done');
    for (const [name, word] of [
      ['Read the notes', 'Not done'],
      ['Email the editor', 'Partly'],
    ]) {
      expect(await title(name!)).not.toHaveClass('done');
      expect(within(await row(name!)).getByText(word!)).toHaveClass('outw');
    }
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
        expect(el).toHaveAccessibleDescription(layout === 'phone' ? 'Tap to open it. Hold it, then drag to move it, or hold its handle and drag to change its length.' : /arrow keys move it/);
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

      it("the click that comes with letting go doesn't open it, however long the drop takes to draw", async () => {
        await open(day, { layout });
        const el = await movable();
        await drag(el, 11, layout);
        // A busy device draws the drop between the release and its click, for longer than a hold.
        const later = Date.now() + 1000;
        const now = vi.spyOn(Date, 'now').mockReturnValue(later);
        fireEvent.click(el);
        now.mockRestore();
        expect(await screen.findByText('Write the report is now 4:15pm to 5:15pm.')).toBeVisible();
        expect(screen.queryByRole('dialog')).toBeNull();
      });

      it('Undo straight after arrow steps, before the day has drawn them, shows the block back where it was', async () => {
        const t = await open(day, { layout });
        const el = await movable();
        el.focus();
        // The day reads slowly, as the web app's database does on a busy device, so it doesn't redraw between the steps
        // and Undo: its next drawing has the block where it started.
        const all = t.db.all.bind(t.db);
        let slow = true;
        vi.spyOn(t.db, 'all').mockImplementation(async (sql, params) => {
          if (slow) await wait(150);
          return all(sql, params);
        });
        await userEvent.keyboard('{ArrowDown}{ArrowDown}');
        expect(await screen.findByText('Write the report is now 4:30pm to 5:30pm.')).toBeVisible();
        await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
        await waitFor(async () => expect(await saved(t)).toMatchObject({ start: at('16:00'), end: at('17:00') }));
        slow = false;
        expect(await movable(/^Write the report, 4pm to 5pm/)).toBeVisible();
      });

      it('Enter opens the task, and arrow keys still move it', async () => {
        const t = await open(day, { layout });
        const el = await movable();
        el.focus();
        await userEvent.keyboard('{Enter}');
        await userEvent.click(within(await taskPopup('Write the report')).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        el.focus();
        await userEvent.keyboard('{ArrowDown}');
        expect(await screen.findByText('Write the report is now 4:15pm to 5:15pm.')).toBeVisible();
        expect(await saved(t)).toMatchObject({ start: at('16:15'), end: at('17:15') });
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

      it('a step pressed while the one before is still saving counts on from it, and Undo takes them all back', async () => {
        const t = await open(day, { layout });
        const el = await movable();
        el.focus();
        // The second step's save waits, as on a slow device, so the first step's position shows while it does.
        const transaction = t.db.transaction.bind(t.db);
        let writes = 0;
        let release = () => undefined as void;
        vi.spyOn(t.db, 'transaction').mockImplementation(async (fn) => {
          if (++writes === 2) await new Promise<void>((r) => (release = r));
          return transaction(fn);
        });
        fireEvent.keyDown(el, { key: 'ArrowDown' });
        fireEvent.keyDown(el, { key: 'ArrowDown' });
        expect(await movable(/^Write the report, 4:15pm to 5:15pm/)).toBe(el);
        fireEvent.keyDown(el, { key: 'ArrowDown' });
        release();
        expect(await screen.findByText('Write the report is now 4:45pm to 5:45pm.')).toBeVisible();
        expect(await saved(t)).toMatchObject({ start: at('16:45'), end: at('17:45') });
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
    // A slider has no click of its own for a keyboard, so Enter and Space open it as a tap does.
    for (const key of ['{Enter}', ' ']) {
      moved.focus();
      await userEvent.keyboard(key);
      await userEvent.click(within(await taskPopup('Write the report')).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    await userEvent.click(moved);
    await taskPopup('Write the report');
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
    expect(screen.queryByRole('dialog')).toBeNull();

    await press(el, 'phone');
    expect(el).toHaveClass('lifted');
    fireEvent.pointerUp(window, { clientY: 300 });
    fireEvent.click(el);
    expect(screen.queryByRole('dialog', { name: 'Write the report' })).toBeNull();
    expect(el).not.toHaveClass('lifted');
    // A tap a moment later opens it as before.
    await wait(450);
    await userEvent.click(el);
    await taskPopup('Write the report');
  });

  it('on phone, a short tap opens the task and moves nothing, and a hold lifts it with a buzz where the phone has one', async () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    try {
      const t = await open(day, { layout: 'phone' });
      const el = await report(undefined, 'slider');
      fireEvent.pointerDown(el, { clientY: 300, button: 0 });
      await wait(100);
      fireEvent.pointerUp(window, { clientY: 300 });
      fireEvent.click(el);
      await taskPopup('Write the report');
      expect(el).not.toHaveClass('lifted');
      expect(vibrate).not.toHaveBeenCalled();
      await userEvent.click(within(await dialog('Write the report')).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

      // Held, then moved: it drags, and opens nothing.
      await drag(el, 11, 'phone');
      fireEvent.click(el);
      expect(vibrate).toHaveBeenCalledOnce();
      expect(await screen.findByText('Write the report is now 4:15pm to 5:15pm.')).toBeVisible();
      expect(await saved(t)).toMatchObject({ start: at('16:15'), end: at('17:15') });
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      Reflect.deleteProperty(navigator, 'vibrate');
    }
  });

  describe('a 15-minute block, drawn too short for an edge to drag', () => {
    const short = async (w: Writer) => {
      await task(w, 't1', 'Write the report');
      await block(w, 'b1', 't1', '16:00', '16:15');
    };

    it('on desktop moves from wherever it is pressed, and Shift and arrows change its length', async () => {
      const t = await open(short);
      const el = await report();
      expect(el).toHaveClass('compact');
      expect(el.querySelector('.evh')).toBeNull();
      expect(el).toHaveAccessibleDescription('Drag to move it. Up and down arrow keys move it, and Shift and arrows change its length.');
      // 15px is half an hour: start and end both move.
      await drag(el, 15, 'desktop');
      expect(await screen.findByText('Write the report is now 4:30pm to 4:45pm.')).toBeVisible();
      expect(await saved(t)).toMatchObject({ start: at('16:30'), end: at('16:45') });
      const moved = await report(/^Write the report, 4:30pm to 4:45pm/);
      moved.focus();
      await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');
      expect(await screen.findByText('Write the report is now 4:30pm to 5pm.')).toBeVisible();
    });

    it('under way on desktop, says Shift and arrows change its length', async () => {
      await open(async (w) => {
        await task(w, 't1', 'Write the report');
        await block(w, 'b1', 't1', '13:45', '14:15');
      });
      const el = await report(/^Write the report, 1:45pm to 2:15pm/);
      expect(el.querySelector('.evh')).toBeNull();
      expect(el).toHaveAccessibleDescription('Use Shift and the up and down arrow keys to change its length.');
    });

    it('on phone is held, then dragged, as a taller one is', async () => {
      const t = await open(short, { layout: 'phone' });
      const el = await report(undefined, 'slider');
      expect(el.querySelector('.rz')).toBeNull();
      expect(el).toHaveAccessibleDescription('Tap to open it. Hold it, then drag to move it.');
      await drag(el, 15, 'phone');
      expect(await screen.findByText('Write the report is now 4:30pm to 4:45pm.')).toBeVisible();
      expect(await saved(t)).toMatchObject({ start: at('16:30'), end: at('16:45') });
    });
  });

  describe('on desktop', () => {
    it('a press that moves less than a few pixels is still a click: it opens the task, and nothing moves', async () => {
      const t = await open(day);
      const el = await report();
      // 4px is 8 minutes at this zoom, which would round to a quarter hour if it counted as a drag.
      fireEvent.pointerDown(el, { clientX: 100, clientY: 300, button: 0 });
      fireEvent.pointerMove(window, { clientX: 102, clientY: 304 });
      expect(el).not.toHaveClass('lifted');
      fireEvent.pointerUp(window, { clientX: 102, clientY: 304 });
      fireEvent.click(el);
      await taskPopup('Write the report');
      expect(await saved(t)).toMatchObject({ start: at('16:00'), end: at('17:00') });
      expect(screen.queryByText(/^Write the report is now/)).toBeNull();
    });

    it('a press that moves past the threshold drags, and opens nothing even let go where it started', async () => {
      const t = await open(day);
      const el = await report();
      fireEvent.pointerDown(el, { clientX: 100, clientY: 300, button: 0 });
      fireEvent.pointerMove(window, { clientX: 108, clientY: 300 });
      expect(el).toHaveClass('lifted');
      fireEvent.pointerMove(window, { clientX: 100, clientY: 300 });
      fireEvent.pointerUp(window, { clientX: 100, clientY: 300 });
      fireEvent.click(el);
      expect(el).not.toHaveClass('lifted');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(await saved(t)).toMatchObject({ start: at('16:00'), end: at('17:00') });
    });
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
    await userEvent.click(within(screen.getByRole('group', { name: 'Suggested times for Write the report' })).getAllByRole('button')[0]!);
    await waitFor(async () => expect(await live(t, 't1')).toHaveLength(1));
    await waitFor(() => expect(within(lane).queryByRole('button', { name: /^Write the report, Project/ })).toBeNull());
  });

  it('shows a set-day practice only on its days, and a count on days without one of its sessions', async () => {
    const days = (w: Writer) => w.create('practice', { title: 'Morning run', target_min: 30, per: 'day', days: [1, 4], preferred_times: [7 * 60 + 30], state: 'active' }, 'run');
    // Today is Monday: Tuesday's and Friday's runs wait above their own days, not today's.
    await open(days);
    const lane = await screen.findByRole('region', { name: 'To schedule' });
    expect(within(lane).queryByRole('button', { name: /^Morning run/ })).toBeNull();
    cleanup();
    await open(days, { now: '2026-11-03T12:00:00Z' });
    const tuesday = await screen.findByRole('region', { name: 'To schedule' });
    expect(within(tuesday).getByRole('button', { name: 'Morning run, Practice, 30 minutes on Tuesday around 7:30 AM, to schedule' })).toBeVisible();
    cleanup();
    const count = async (w: Writer) => {
      await w.create('practice', { title: 'Climbing', target_min: 120, per: 'week', sessions: 2, preferred_times: [18 * 60], state: 'active' }, 'climb');
      await w.create('time_block', { practice_id: 'climb', start: '2026-11-03T00:00:00Z', end: '2026-11-03T01:00:00Z', tz: 'America/Chicago' }, 'session:climb:2026-11-02');
    };
    await open(count, { now: '2026-11-02T20:00:00Z' });
    expect(within(await screen.findByRole('region', { name: 'To schedule' })).queryByRole('button', { name: /^Climbing/ })).toBeNull();
    cleanup();
    await open(count, { now: '2026-11-03T20:00:00Z' });
    expect(within(await screen.findByRole('region', { name: 'To schedule' })).getByRole('button', { name: 'Climbing, Practice, 1 more this week, 1h each, to schedule' })).toBeVisible();
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
