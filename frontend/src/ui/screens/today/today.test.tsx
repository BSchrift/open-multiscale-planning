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
import { holdDown, renderApp, renderScreen } from '../../app/testing';
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
  it('ends Today, says nothing is finished until something is, and opens Done on today', { timeout: 15000 }, async () => {
    const t = await open(async (w) => {
      await task(w, 't1', 'Write the report');
      await block(w, 'b1', 't1', '13:00', '15:00');
    });
    // The first render in a run also loads the modules, so it gets longer.
    const empty = await screen.findByRole('button', { name: 'Done: nothing finished yet today' }, { timeout: 5000 });
    expect(empty).toHaveTextContent(/^Nothing finished yet today$/);
    expect(screen.getByRole('heading', { name: 'Timeline' }).compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Mark done now' }));
    const line = await screen.findByRole('button', { name: 'Done today: 1 finished, 1h worked' });
    expect(line).toHaveTextContent(/^Done today · 1 · 1h$/);
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

  it('asks Done, Partly or Not done, each after its icon, and only Done finishes the task, as of when its block ended', async () => {
    const t = await open(ended);
    const prompt = await dialog('Block finished');
    expect(within(prompt).getByText('Write the report')).toBeVisible();
    const answers = ['Done', 'Partly', 'Not done'].map((name) => within(prompt).getByRole('button', { name }));
    // The icons the missed blocks sheet answers with, hidden, so each button's name is its word alone. Done is filled.
    for (const b of answers) expect(b.firstElementChild).toMatchObject({ tagName: 'svg' });
    for (const b of answers) expect(b.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(answers.map((b) => b.classList.contains('pri'))).toEqual([true, false, false]);
    await userEvent.click(answers[0]!);
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
    // Three answers first, as the missed blocks sheet and the notification give: no slider until Partly.
    expect(within(prompt).getAllByRole('button').map((b) => b.textContent)).toEqual(['All 30m', 'Partly', 'Skipped']);
    expect(within(prompt).queryByRole('slider')).toBeNull();
    await userEvent.click(within(prompt).getByRole('button', { name: 'Partly' }));
    // From half the block, on the 5-minute steps.
    const slider = within(prompt).getByRole('slider', { name: 'How much did you do?' });
    expect(slider).toHaveFocus();
    expect(slider).toHaveAttribute('aria-valuetext', '15m');
    fireEvent.change(slider, { target: { value: '20' } });
    await userEvent.click(within(prompt).getByRole('button', { name: 'Log 20m' }));
    expect(await screen.findByText('Logged 20m')).toBeVisible();
    expect(await getRecord(t.db, 'block_outcome', outcomeId('pb'))).toMatchObject({ result: 'done', logged_min: 20 });
  });

  it('a practice logs all of its time from the first view, in one tap', async () => {
    const t = await open(async (w) => {
      await w.create('practice', { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' }, 'pr');
      await w.create('time_block', { practice_id: 'pr', start: at('13:00'), end: at('13:30'), tz: ZONE }, 'pb');
    });
    const prompt = await dialog('Block finished');
    await userEvent.click(within(prompt).getByRole('button', { name: 'All 30m' }));
    expect(await screen.findByText('Logged 30m')).toBeVisible();
    expect(await getRecord(t.db, 'block_outcome', outcomeId('pb'))).toMatchObject({ result: 'done', logged_min: 30 });
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

  it("a row's name opens the task's popup", async () => {
    await open(missed(at('09:00')));
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    await userEvent.click(within(screen.getByRole('region', { name: 'Needs a new time' })).getByRole('button', { name: 'Rake the leaves' }));
    await taskPopup('Rake the leaves');
  });

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

  it("Next up's task names open the task's popup", async () => {
    await unplanned(work);
    await userEvent.click(await screen.findByRole('button', { name: 'Skip planning this week' }));
    await userEvent.click(within(await screen.findByRole('region', { name: 'Next up' })).getByRole('button', { name: 'Paint the fence' }));
    await taskPopup('Paint the fence');
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
      signedInAt: vi.fn(async (): Promise<number | null> => null),
      exportData: vi.fn(async () => 'https://files.example.test/export.zip'),
      deletionTarget: vi.fn(async () => ({ sameAccount: true, email: 'reader@example.com' as string | null })),
      deleteAccount: vi.fn(async (): Promise<'deleted' | 'sign_in_again' | 'wrong_account'> => 'deleted'),
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

  it("its name opens the task's popup, and Esc brings focus back to it", async () => {
    await open(dated);
    const name = within(await screen.findByRole('region', { name: 'One offs today' })).getByRole('button', { name: 'Paint the fence' });
    await userEvent.click(name);
    await taskPopup('Paint the fence');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(name).toHaveFocus();
  });

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
    const popup = await taskPopup('Write the report');
    expect(screen.queryByRole('region', { name: 'Write the report' })).toBeNull();
    // The block's own time, what it belongs to and what can be done to it, above the task's fields.
    const section = within(popup).getByRole('region', { name: 'Time block' });
    expect(within(section).getByText('Mon Nov 2, 4pm to 5pm')).toBeVisible();
    expect(await within(section).findByText('Write more > Finish the essay')).toBeVisible();
    expect(within(section).getByRole('button', { name: 'Start now' })).toBeVisible();
    expect(within(section).getByRole('button', { name: 'Remove from calendar' })).toBeVisible();
    // Esc closes it, and focus goes back to the block.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: /^Write the report, 4pm to 5pm/ })).toHaveFocus();
  });

  it("Start now in a block's popup starts it now, keeping its length, with Undo", async () => {
    const t = await open(day);
    await userEvent.click(await screen.findByRole('button', { name: /^Write the report, 4pm to 5pm/ }));
    const popup = await taskPopup('Write the report');
    await userEvent.click(within(popup).getByRole('button', { name: 'Start now' }));
    expect(await screen.findByText('Started Write the report. It now runs 2pm to 3pm.')).toBeVisible();
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.started_at).toBe(NOW));
    expect((await getRecord(t.db, 'time_block', 'b1'))?.start).toBe(NOW);
    // Started, it has nothing left to start.
    await waitFor(() => expect(within(popup).queryByRole('button', { name: /^Start/ })).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.started_at).toBeNull());
    expect((await getRecord(t.db, 'time_block', 'b1'))?.start).toBe(at('16:00'));
  });

  it("a block gone by asks how it went in its popup: Partly takes the time left, and saves with Undo", async () => {
    const t = await open(async (w) => {
      await day(w);
      await block(w, 'b0', 't1', '11:00', '12:00');
    });
    await userEvent.click(await screen.findByRole('button', { name: /^Write the report, 11am to 12pm/ }));
    const popup = await taskPopup('Write the report');
    const asks = within(popup).getByRole('group', { name: 'How did it go?' });
    expect(within(popup).queryByRole('button', { name: /^Start/ })).toBeNull();
    // The end-of-block prompt's answers: each word after its icon, Done filled.
    const answers = ['Done', 'Partly', 'Not done'].map((name) => within(asks).getByRole('button', { name }));
    for (const b of answers) expect(b.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(answers.map((b) => b.classList.contains('pri'))).toEqual([true, false, false]);
    await userEvent.click(within(asks).getByRole('button', { name: 'Partly' }));
    // 3 hours estimated, an hour of it done.
    expect(within(asks).getByText('2h left')).toBeVisible();
    await userEvent.click(within(asks).getByRole('button', { name: 'More time left: Write the report' }));
    await userEvent.click(within(asks).getByRole('button', { name: 'Save Partly' }));
    expect(await screen.findByText('Write the report: partly, 2h 30m left.')).toBeVisible();
    await waitFor(async () => expect((await getRecord(t.db, 'block_outcome', outcomeId('b0')))?.result).toBe('partly'));
    expect((await getRecord(t.db, 'task', 't1'))?.remaining_min).toBe(150);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'block_outcome', outcomeId('b0')))?.deleted_at).toBeTruthy());
  });

  it("Remove from calendar in a block's popup takes it off and into To schedule, with Undo", async () => {
    const t = await open(day);
    await userEvent.click(await screen.findByRole('button', { name: /^Write the report, 4pm to 5pm/ }));
    await userEvent.click(within(await taskPopup('Write the report')).getByRole('button', { name: 'Remove from calendar' }));
    expect(await screen.findByText("Took Write the report off the calendar. It's in To schedule on Week.")).toBeVisible();
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBeNull());
  });

  it.each(['desktop', 'phone'] as const)("on %s, Move… in a later block's popup picks a new time as its quick menu's Move to does, each with Undo", async (layout) => {
    const t = await open(
      async (w) => {
        await day(w);
        await task(w, 't2', 'Paint the fence');
        await block(w, 'b2', 't2', '17:00', '18:00');
      },
      { layout },
    );
    // On phone a block still to come is a slider, which a tap opens.
    await userEvent.click(await screen.findByRole(layout === 'phone' ? 'slider' : 'button', { name: /^Write the report, 4pm to 5pm/ }));
    const popup = await taskPopup('Write the report');
    const section = within(popup).getByRole('region', { name: 'Time block' });
    const moveButton = within(section).getByRole('button', { name: 'Move…' });
    expect(moveButton).toHaveAttribute('aria-haspopup', 'menu');
    // Moved to tomorrow, or off the calendar, the block's section goes until Undo brings it back.
    const pick = async (name: string) => {
      await userEvent.click(await within(popup).findByRole('button', { name: 'Move…' }));
      await userEvent.click(within(await screen.findByRole('menu', { name: 'Move to' })).getByRole('menuitem', { name }));
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    };

    // The same four choices as the menu's Move to, the first one focused; Esc closes them and keeps the popup.
    await userEvent.click(moveButton);
    const menu = await screen.findByRole('menu', { name: 'Move to' });
    expect([...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((el) => (el.getAttribute('role') === 'separator' ? '-' : el.textContent))).toEqual([
      'Next free time, 6pm',
      'Tomorrow, 4pm',
      'Back to To schedule',
      '-',
      'Choose a time…',
    ]);
    expect(moveButton).toHaveAttribute('aria-expanded', 'true');
    expect(within(menu).getByRole('menuitem', { name: 'Next free time, 6pm' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(moveButton).toHaveFocus();
    expect(popup).toBeVisible();

    // 5pm is taken by the fence, so the next free time is after it. The popup stays, showing where it went.
    await pick('Next free time, 6pm');
    expect(await screen.findByText('Moved Write the report to 6pm.')).toBeVisible();
    expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ start: at('18:00'), end: at('19:00') });
    expect(await within(section).findByText('Mon Nov 2, 6pm to 7pm')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.start).toBe(at('16:00')));

    await pick('Tomorrow, 4pm');
    expect(await screen.findByText('Moved Write the report to tomorrow, 4pm.')).toBeVisible();
    expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ start: at('16:00', '2026-11-03'), end: at('17:00', '2026-11-03') });
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.start).toBe(at('16:00')));

    await pick('Back to To schedule');
    expect(await screen.findByText("Took Write the report off the calendar. It's in To schedule on Week.")).toBeVisible();
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBeNull());

    // By hand: the popup goes, and Week opens ready to edit, with the block where it was.
    await pick('Choose a time…');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(t.nav().route).toMatchObject({ area: 'week', params: { edit: 'this' } });
    expect((await getRecord(t.db, 'time_block', 'b1'))?.start).toBe(at('16:00'));
  });

  it.each(['desktop', 'phone'] as const)("on %s, Move…'s Tomorrow asks first when it lands on a block there, as the quick menu's does, and the popup stays", async (layout) => {
    const TOMORROW = '2026-11-03';
    const t = await open(
      async (w) => {
        await day(w);
        await task(w, 't2', 'Paint the fence');
        await block(w, 'b2', 't2', '16:30', '17:30', { start: at('16:30', TOMORROW), end: at('17:30', TOMORROW) });
      },
      { layout },
    );
    await userEvent.click(await screen.findByRole(layout === 'phone' ? 'slider' : 'button', { name: /^Write the report, 4pm to 5pm/ }));
    const popup = await taskPopup('Write the report');
    const tomorrow = async () => {
      await userEvent.click(within(popup).getByRole('button', { name: 'Move…' }));
      await userEvent.click(within(await screen.findByRole('menu', { name: 'Move to' })).getByRole('menuitem', { name: 'Tomorrow, 4pm' }));
      const ask = await screen.findByRole('dialog', { name: 'Schedule both at the same time?' });
      expect(ask).toHaveTextContent('Write the report overlaps Paint the fence.');
      await waitFor(() => expect(within(ask).getByRole('button', { name: 'Keep both' })).toHaveFocus());
      return ask;
    };
    // Cancel leaves both where they were, and the popup open.
    await userEvent.click(within(await tomorrow()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Schedule both at the same time?' })).toBeNull());
    expect(popup).toBeVisible();
    expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ start: at('16:00') });

    // Replace sends the fence back to To schedule, with one Undo for both.
    await userEvent.click(within(await tomorrow()).getByRole('button', { name: 'Replace' }));
    expect(await screen.findByText('Moved Write the report to tomorrow, 4pm. Took Paint the fence off the calendar.')).toBeVisible();
    expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ start: at('16:00', TOMORROW) });
    expect((await getRecord(t.db, 'time_block', 'b2'))?.cancelled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b2'))?.cancelled).toBeFalsy());
    expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ start: at('16:00') });
  });

  it("Move… shows while a block can still move: later today, and under way but not started, which can't be placed by hand", async () => {
    await open(async (w) => {
      await day(w);
      await task(w, 't3', 'Read the brief');
      await block(w, 'b3', 't3', '13:30', '14:30');
      await task(w, 't4', 'Plan the talk');
      await block(w, 'b4', 't4', '13:00', '15:00', { started_at: at('13:00') });
      await block(w, 'b5', 't4', '11:00', '12:00');
    });
    const sectionOf = async (name: RegExp, title: string) => {
      await userEvent.click(await screen.findByRole('button', { name }));
      return within(await taskPopup(title)).getByRole('region', { name: 'Time block' });
    };
    const close = async (title: string) => {
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog', { name: title })).toBeNull());
    };
    // Under way and not started: its time can still change, but Week keeps a block whose time has come where it is.
    const notStarted = await sectionOf(/^Read the brief, 1:30pm to 2:30pm/, 'Read the brief');
    await userEvent.click(within(notStarted).getByRole('button', { name: 'Move…' }));
    const menu = await screen.findByRole('menu', { name: 'Move to' });
    // Plan the talk runs to 3pm.
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent)).toEqual(['Next free time, 3pm', 'Tomorrow, 1:30pm', 'Back to To schedule']);
    await userEvent.keyboard('{Escape}');
    await close('Read the brief');
    // Started, or gone by, it stays where it is.
    expect(within(await sectionOf(/^Plan the talk, 1pm to 3pm/, 'Plan the talk')).queryByRole('button', { name: 'Move…' })).toBeNull();
    await close('Plan the talk');
    expect(within(await sectionOf(/^Plan the talk, 11am to 12pm/, 'Plan the talk')).queryByRole('button', { name: 'Move…' })).toBeNull();
  });

  it("Done in a later block's popup finishes the task, and its blocks from then on come off the calendar, with Undo", async () => {
    const t = await open(async (w) => {
      await day(w);
      await block(w, 'b4', 't1', '18:00', '19:00');
    });
    await userEvent.click(await screen.findByRole('button', { name: /^Write the report, 4pm to 5pm/ }));
    const section = within(await taskPopup('Write the report')).getByRole('region', { name: 'Time block' });
    // Beside Start now, Move… and Remove from calendar, in the order they're read.
    expect(within(section).getAllByRole('button').map((b) => b.textContent)).toEqual(['Start now', 'Done', 'Move…', 'Remove from calendar']);
    await userEvent.click(within(section).getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Marked Write the report done. Its 4pm block and 1 later one came off the calendar, so that time is free.')).toBeVisible();
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBe(NOW));
    expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBe(true);
    expect((await getRecord(t.db, 'time_block', 'b4'))?.cancelled).toBe(true);
    // Finished before it began, it has no answer of its own.
    expect(await getRecord(t.db, 'block_outcome', outcomeId('b1'))).toBeUndefined();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBeNull());
    expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBeNull();
  });

  it("Done on a one off's later block ticks it off, as its row's box does", async () => {
    const t = await open(async (w) => {
      await w.create('task', { kind: 'one_off', title: 'Paint the fence' }, 't2');
      await block(w, 'b2', 't2', '16:00', '17:00');
    });
    await userEvent.click(await screen.findByRole('button', { name: /^Paint the fence, 4pm to 5pm/ }));
    await userEvent.click(within(await taskPopup('Paint the fence')).getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Marked Paint the fence done. Its 4pm block came off the calendar, so that time is free.')).toBeVisible();
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't2'))?.done_at).toBe(NOW));
    expect((await getRecord(t.db, 'time_block', 'b2'))?.cancelled).toBe(true);
    expect(await listRecords(t.db, 'task_completion')).toHaveLength(1);
  });

  it("the block under way offers Done, which marks it done now, and Pause or Resume", async () => {
    const t = await open(async (w) => {
      await day(w);
      await task(w, 't3', 'Read the brief');
      await block(w, 'b0', 't3', '13:30', '15:00', { started_at: at('13:30') });
    });
    await userEvent.click(await screen.findByRole('button', { name: /^Read the brief, 1:30pm to 3pm/ }));
    const section = within(await taskPopup('Read the brief')).getByRole('region', { name: 'Time block' });
    expect(within(section).getAllByRole('button').map((b) => b.textContent)).toEqual(['Done', 'Pause']);
    await userEvent.click(within(section).getByRole('button', { name: 'Pause' }));
    expect(await screen.findByText('Paused Read the brief')).toBeVisible();
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b0'))?.paused_at).toBe(NOW));
    await userEvent.click(await within(section).findByRole('button', { name: 'Resume' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b0'))?.paused_at).toBeNull());
    expect(await screen.findByText('Resumed. It now ends at 3pm.')).toBeVisible();
    expect(await within(section).findByRole('button', { name: 'Pause' })).toBeVisible();
    // As Mark done now has it: the block ends now and says how long it took.
    await userEvent.click(within(section).getByRole('button', { name: 'Done' }));
    expect(await screen.findByText("Marked done after 30m. You're free until 4pm.")).toBeVisible();
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b0'))?.ended_at).toBe(NOW));
    expect((await getRecord(t.db, 'block_outcome', outcomeId('b0')))?.result).toBe('done');
    expect((await getRecord(t.db, 'task', 't3'))?.done_at).toBe(NOW);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b0'))?.ended_at).toBeNull());
  });

  it("the block under way, not yet started, offers Start, Done and Move…", async () => {
    await open(async (w) => {
      await day(w);
      await task(w, 't3', 'Read the brief');
      await block(w, 'b0', 't3', '13:30', '15:00');
    });
    await userEvent.click(await screen.findByRole('button', { name: /^Read the brief, 1:30pm to 3pm/ }));
    const section = within(await taskPopup('Read the brief')).getByRole('region', { name: 'Time block' });
    expect(within(section).getAllByRole('button').map((b) => b.textContent)).toEqual(['Start', 'Done', 'Move…', 'Remove from calendar']);
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

  it.each(['desktop', 'phone'] as const)('on %s, the zoom buttons sit beside Calendar and List, out of the calendar, and only with it', async (layout) => {
    await open(day, { layout });
    const zoom = await screen.findByRole('group', { name: 'Calendar zoom' });
    expect(within(zoom).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Zoom out', 'Zoom in']);
    // In the timeline's heading row with the view buttons, so they never cover a block.
    const view = screen.getByRole('group', { name: 'Timeline view' });
    expect(zoom.closest('.tlhead')).not.toBeNull();
    expect(zoom.closest('.tlhead')).toBe(view.closest('.tlhead'));
    expect(document.querySelector('.day')).not.toContainElement(zoom);
    await userEvent.click(within(view).getByRole('button', { name: 'List' }));
    expect(screen.queryByRole('group', { name: 'Calendar zoom' })).toBeNull();
    await userEvent.click(within(view).getByRole('button', { name: 'Calendar' }));
    expect(await screen.findByRole('group', { name: 'Calendar zoom' })).toBeInTheDocument();
  });

  it.each(['desktop', 'phone'] as const)('on %s, the current-time line is drawn before the blocks, so it passes behind the one under way', async (layout) => {
    await open(
      async (w) => {
        await day(w);
        await block(w, 'b0', 't1', '13:00', '15:00');
        await w.create('calendar', { connected: true, events: [{ id: 'e1', calendar: 'work', title: 'Team call', start: at('14:30'), end: at('15:30') }] }, CALENDAR_ID);
      },
      { layout },
    );
    const line = await screen.findByRole('img', { name: 'Current time' });
    await screen.findByText('Team call');
    const drawn = [...document.querySelectorAll('.day .cev')];
    expect(drawn.length).toBeGreaterThanOrEqual(3);
    for (const item of drawn) expect(line.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Its dot is the one part drawn in front of them (styles.test.ts).
    expect(line.querySelector('i')).not.toBeNull();
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

describe.each(['desktop', 'phone'] as const)('blocks at the same time on the timeline, on %s', (layout) => {
  afterEach(() => localStorage.clear());
  // On phone a block still to come is a slider, so VoiceOver's swipes move it.
  const role = layout === 'phone' ? 'slider' : 'button';
  const together = async (w: Writer) => {
    await w.create('project', { title: 'Finish the essay', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p');
    await task(w, 't1', 'Write the report');
    await block(w, 'b1', 't1', '16:00', '17:00');
    await w.create('practice', { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' }, 'pr');
    await w.create('time_block', { practice_id: 'pr', start: at('16:00'), end: at('16:30'), tz: ZONE }, 'b2');
  };
  const sideBySide = (els: HTMLElement[]) => {
    expect(new Set(els.map((e) => e.style.width)).size).toBe(1);
    expect(new Set(els.map((e) => e.style.left)).size).toBe(els.length);
  };

  it('sit side by side on the calendar, each named with what it overlaps, and open as they did', async () => {
    await open(together, { layout });
    const report = await screen.findByRole(role, { name: 'Write the report, 4pm to 5pm, Project. Overlaps Piano practice.' });
    const piano = screen.getByRole(role, { name: 'Piano practice, 4pm to 4:30pm, Practice. Overlaps Write the report.' });
    sideBySide([report, piano]);
    // Read by start, then column: the longer one is first, on the left.
    expect(report.compareDocumentPosition(piano) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(piano);
    if (layout === 'phone') expect(await dialog('Piano practice')).toBeVisible();
    else expect(await screen.findByRole('region', { name: 'Piano practice' })).toBeVisible();
  });

  it("a task's block beside another still opens the task's popup, with its own section", async () => {
    await open(together, { layout });
    await userEvent.click(await screen.findByRole(role, { name: 'Write the report, 4pm to 5pm, Project. Overlaps Piano practice.' }));
    const popup = await taskPopup('Write the report');
    expect(within(within(popup).getByRole('region', { name: 'Time block' })).getByText('Mon Nov 2, 4pm to 5pm')).toBeVisible();
  });

  it('beside a calendar event they overlap, share the room left of it', async () => {
    await open(async (w) => { await together(w); await dinner(w); }, { layout });
    const report = await screen.findByRole(role, { name: 'Write the report, 4pm to 5pm, Project. Conflicts with Quiz night. Overlaps Piano practice.' });
    const piano = screen.getByRole(role, { name: 'Piano practice, 4pm to 4:30pm, Practice. Conflicts with Quiz night. Overlaps Write the report.' });
    sideBySide([report, piano]);
    for (const el of [report, piano]) expect(el.style.width).toContain('40%');
    expect(screen.getByText('Quiz night').closest<HTMLElement>('.cev')!.style.left).toBe('62%');
  });

  it('in the list, each says what it overlaps', async () => {
    await open(together, { layout });
    await userEvent.click(await screen.findByRole('button', { name: 'List' }));
    if (layout === 'phone') {
      const piano = screen.getByRole('button', { name: 'Piano practice, 4pm to 4:30pm, Practice. Overlaps Write the report.' });
      expect(within(piano).getByText('Practice, Overlaps Write the report')).toBeVisible();
    } else {
      expect(screen.getByRole('button', { name: /^4pm to 4:30pm\s*Piano practice.*Overlaps Write the report$/ })).toBeVisible();
    }
  });

  it('with no room for all three, draw what fits and +N more lists them, each opening as it does', async () => {
    // A 320pt phone's day: one 96px column, beside the strip for +N more.
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 220, height: 600, top: 0, left: 0, right: 220, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    try {
      await open(async (w) => { await together(w); await task(w, 't3', 'Call the editor'); await block(w, 'b3', 't3', '16:15', '16:45'); }, { layout });
      expect(await screen.findByRole(role, { name: /^Write the report, 4pm to 5pm/ })).toBeVisible();
      expect(screen.queryByRole(role, { name: /^Piano practice/ })).toBeNull();
      const more = screen.getByRole('button', { name: '+2 more: Piano practice and Call the editor' });
      await userEvent.click(more);
      const list = await dialog('Blocks from 4pm to 5pm');
      await userEvent.click(within(list).getByRole('button', { name: /^Piano practice, 4pm to 4:30pm, Practice\. Overlaps Write the report and Call the editor\.$/ }));
      if (layout === 'phone') expect(await dialog('Piano practice')).toBeVisible();
      else expect(await screen.findByRole('region', { name: 'Piano practice' })).toBeVisible();
      // A task's block in the list opens the task's popup, with its section.
      if (layout === 'phone') await userEvent.click(within(await dialog('Piano practice')).getByRole('button', { name: 'Close' }));
      await userEvent.click(screen.getByRole('button', { name: '+2 more: Piano practice and Call the editor' }));
      await userEvent.click(within(await dialog('Blocks from 4pm to 5pm')).getByRole('button', { name: /^Call the editor, 4:15pm to 4:45pm/ }));
      const popup = await taskPopup('Call the editor');
      expect(within(within(popup).getByRole('region', { name: 'Time block' })).getByText('Mon Nov 2, 4:15pm to 4:45pm')).toBeVisible();
    } finally {
      measure.mockRestore();
    }
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
    expect(await drawn('Write the report')).toHaveClass('s-done');
    expect(await drawn('Read the notes')).toHaveClass('s-notdone');
    expect(await drawn('Read the notes')).not.toHaveClass('s-done');
    expect(within((await drawn('Read the notes')) as HTMLElement).getByText('Not done')).toBeVisible();
    expect(await drawn('Email the editor')).toHaveClass('s-partly');
    expect(await drawn('Email the editor')).not.toHaveClass('s-done');
    expect(within((await drawn('Email the editor')) as HTMLElement).getByText('Partly')).toBeVisible();
    // One with no answer yet is dashed, with an empty ring, as on Week.
    expect(await drawn('File the receipts')).toHaveClass('s-goneby');
    const badge = async (title: string) => ((await drawn(title)).querySelector('.ansbadge svg') as SVGElement | null)?.dataset.icon;
    expect([await badge('Write the report'), await badge('Read the notes'), await badge('Email the editor'), await badge('File the receipts')]).toEqual(['done', 'not-done', 'partly', 'no-answer']);
    expect(await drawn('File the receipts')).not.toHaveClass('s-done');
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
      expect(await title(name!)).not.toHaveClass('s-done');
      expect(within(await row(name!)).getByText(word!)).toHaveClass('outw');
    }
  });
});

describe.each(['desktop', 'phone'] as const)('an Inbox item’s block on the timeline, on %s', (layout) => {
  it('has no kind’s colour yet: Planning’s wash, a dashed edge, the inbox icon and the word Inbox, and it opens the item', async () => {
    await open(
      async (w) => {
        await w.create('task', { kind: 'inbox', title: 'Book dentist' }, 'i1');
        await block(w, 'b1', 'i1', '17:45', '18:45');
      },
      { layout },
    );
    const el = await screen.findByRole(layout === 'phone' ? 'slider' : 'button', { name: 'Book dentist, 5:45pm to 6:45pm, Inbox.' });
    expect(el).toHaveClass('blk', 'k-inbox', 's-planned');
    expect(el.querySelector('svg[data-icon="inbox"]')).not.toBeNull();
    // The word goes on a second line, beside the title on desktop and under it on phone once zoomed in to fit it.
    if (layout === 'phone') {
      expect(el).not.toHaveTextContent('Inbox');
      await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    }
    expect(el).toHaveTextContent('Inbox, 5:45pm to 6:45pm');
    await userEvent.click(el);
    await taskPopup('Book dentist');
  });
});

describe('a block landing on another on the timeline', () => {
  const day = async (w: Writer) => {
    await task(w, 't1', 'Write the report');
    await block(w, 'b1', 't1', '16:00', '17:00');
    await task(w, 't2', 'Paint the fence');
    await block(w, 'b2', 't2', '17:00', '17:30');
  };
  const step = async () => {
    const el = await screen.findByRole('button', { name: /^Write the report, 4pm to 5pm/ });
    el.focus();
    // A quarter hour later it runs into Paint the fence.
    await userEvent.keyboard('{ArrowDown}');
    return screen.findByRole('dialog', { name: 'Schedule both at the same time?' });
  };

  it('asks, and Replace sends the block landed on back to To schedule, with one Undo for both', async () => {
    const t = await open(day);
    await userEvent.click(within(await step()).getByRole('button', { name: 'Replace' }));
    expect(await screen.findByText(/^Write the report is now 4:15pm to 5:15pm\. Took Paint the fence off the calendar\./)).toBeVisible();
    expect((await getRecord(t.db, 'time_block', 'b2'))?.cancelled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b2'))?.cancelled).toBeFalsy());
    expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ start: at('16:00') });
  });

  it('Keep both keeps both, and Cancel leaves it where it was', async () => {
    const t = await open(day);
    await userEvent.click(within(await step()).getByRole('button', { name: 'Cancel' }));
    expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ start: at('16:00') });
    await userEvent.click(within(await step()).getByRole('button', { name: 'Keep both' }));
    await waitFor(async () => expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ start: at('16:15') }));
    expect((await getRecord(t.db, 'time_block', 'b2'))?.cancelled).toBeFalsy();
  });
});

describe("a task's block made shorter on the timeline", () => {
  it('asks what about the rest under the timeline; Change the estimate takes it off the task, and the block under way never asks', async () => {
    const t = await open(async (w) => {
      await task(w, 't1', 'Write the report');
      await block(w, 'b1', 't1', '16:00', '17:00');
      await task(w, 't2', 'Paint the fence');
      await block(w, 'b2', 't2', '13:30', '15:00', { started_at: at('13:30') });
    });
    const el = await screen.findByRole('button', { name: /^Write the report, 4pm to 5pm/ });
    el.focus();
    await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}');
    const ask = await screen.findByRole('group', { name: 'What about the other 15m?' });
    await userEvent.click(within(ask).getByRole('button', { name: 'Change the estimate' }));
    expect(await screen.findByText('Write the report is now 2h 45m. Its estimate was 3h.')).toBeVisible();
    await waitFor(async () => expect(await getRecord(t.db, 'task', 't1')).toMatchObject({ estimate_min: 165 }));

    const now = await screen.findByRole('button', { name: /^Paint the fence, 1:30pm to 3pm/ });
    now.focus();
    await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}');
    expect(await screen.findByText(/^Paint the fence is now 1:30pm to 2:45pm/)).toBeVisible();
    expect(screen.queryByRole('group', { name: /^What about the other/ })).toBeNull();
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
  // jsdom has no layout. The first zoom draws 30px an hour, so each pixel is two minutes. A block moves once held, by
  // mouse or finger, so a click stays a click and a swipe still scrolls the page.
  const press = (el: Element, layout: Layout) => holdDown(el, { clientY: 300, pointerType: layout === 'phone' ? 'touch' : 'mouse' });
  const drag = async (el: Element, dy: number, layout: Layout) => {
    press(el, layout);
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
        press(await movable(), layout);
        fireEvent.pointerMove(window, { clientY: 325 });
        expect(await screen.findByText('Suggested 5pm')).toBeVisible();
        expect(await movable(/^Write the report, 5pm to 6pm/)).toHaveClass('lifted');
        fireEvent.pointerUp(window, { clientY: 325 });
        // Put down at once, where it was let go, while its new time saves.
        expect(screen.getByRole(layout === 'phone' ? 'slider' : 'button', { name: /^Write the report, 5pm to 6pm/ })).not.toHaveClass('lifted');
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
        expect(el).toHaveAccessibleDescription(layout === 'phone' ? 'Hold its handle and drag to change its length.' : 'Hold its bottom edge and drag, or use Shift and the up and down arrow keys, to change its length.');
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

  it('on phone, a finger that moves before the hold scrolls instead, and a hold let go in place opens its menu, not the task', async () => {
    const t = await open(day, { layout: 'phone' });
    const el = await report(undefined, 'slider');
    fireEvent.pointerDown(el, { clientY: 300, button: 0, pointerType: 'touch' });
    fireEvent.pointerMove(window, { clientY: 330, pointerType: 'touch' });
    await wait(450);
    expect(el).not.toHaveClass('lifted');
    fireEvent.pointerMove(window, { clientY: 360, pointerType: 'touch' });
    fireEvent.pointerUp(window, { clientY: 360, pointerType: 'touch' });
    expect(await saved(t)).toMatchObject({ start: at('16:00') });
    expect(screen.queryByRole('dialog')).toBeNull();

    press(el, 'phone');
    fireEvent.pointerMove(window, { clientY: 302 });
    expect(el).toHaveClass('lifted');
    fireEvent.pointerUp(window, { clientY: 302 });
    fireEvent.click(el);
    expect(screen.queryByRole('dialog', { name: 'Write the report' })).toBeNull();
    expect(el).not.toHaveClass('lifted');
    expect(await screen.findByRole('menu', { name: 'Write the report' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    // A tap a moment later opens it as before.
    await wait(450);
    await userEvent.click(el);
    await taskPopup('Write the report');
  });

  it('on phone, a short tap opens the task and moves nothing, and a hold lifts it with one light tap from the device', async () => {
    const t = await open(day, { layout: 'phone' });
    const el = await report(undefined, 'slider');
    fireEvent.pointerDown(el, { clientY: 300, button: 0 });
    await wait(100);
    fireEvent.pointerUp(window, { clientY: 300 });
    fireEvent.click(el);
    await taskPopup('Write the report');
    expect(el).not.toHaveClass('lifted');
    expect(t.platform.haptics).toEqual([]);
    await userEvent.click(within(await dialog('Write the report')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Held, then moved: it drags, and opens nothing. The tap comes from the platform, which on an iPhone is its
    // Taptic Engine, since iPhones ignore the browser's vibrate.
    await drag(el, 11, 'phone');
    fireEvent.click(el);
    expect(t.platform.haptics).toEqual(['light']);
    expect(await screen.findByText('Write the report is now 4:15pm to 5:15pm.')).toBeVisible();
    expect(await saved(t)).toMatchObject({ start: at('16:15'), end: at('17:15') });
    expect(screen.queryByRole('dialog')).toBeNull();
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
      expect(el).toHaveAccessibleDescription('Hold it, then drag to move it. Up and down arrow keys move it, and Shift and arrows change its length.');
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

    it('a press that moves further before the hold is still a click; held, it lifts, and opens nothing let go where it started', async () => {
      const t = await open(day);
      const el = await report();
      // 12px would be 24 minutes, were it a drag.
      fireEvent.pointerDown(el, { clientX: 100, clientY: 300, button: 0 });
      fireEvent.pointerMove(window, { clientX: 108, clientY: 312 });
      expect(el).not.toHaveClass('lifted');
      fireEvent.pointerUp(window, { clientX: 108, clientY: 312 });
      fireEvent.click(el);
      await userEvent.click(within(await taskPopup('Write the report')).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

      holdDown(el, { clientX: 100, clientY: 300 });
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

describe('hold to create on the timeline', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const day = async (w: Writer) => {
    await task(w, 't1', 'Write the report');
    await block(w, 'b1', 't1', '16:00', '17:00');
  };
  const timeline = () => document.querySelector<HTMLElement>('.day')!;
  const draft = () => document.querySelector<HTMLElement>('.cev.holddraft');
  // jsdom has no layout: the day starts at 7am at the top, and the first zoom draws 30px an hour, two minutes a pixel.
  const y = (time: string) => {
    const [h, m] = time.split(':').map(Number);
    return (h! * 60 + (m ?? 0) - 420) / 2;
  };
  const kind = (layout: Layout) => (layout === 'phone' ? 'touch' : 'mouse');
  // The first render in a run also loads the modules, so it gets longer.
  const ready = (layout: Layout) => screen.findByRole(layout === 'phone' ? 'slider' : 'button', { name: /^Write the report, 4pm to 5pm/ }, { timeout: 5000 });
  const press = (time: string, layout: Layout, pointerId = 1) =>
    fireEvent.pointerDown(timeline(), { clientX: 100, clientY: y(time), button: 0, pointerType: kind(layout), pointerId });
  const hold = async (time: string, layout: Layout) => {
    await ready(layout);
    press(time, layout);
    await wait(450);
  };
  const letGo = (time: string, layout: Layout) => fireEvent.pointerUp(window, { clientX: 100, clientY: y(time), pointerType: kind(layout), pointerId: 1 });

  for (const layout of ['desktop', 'phone'] as const) {
    describe(`on ${layout}`, () => {
      it('a hold on empty space drafts an hour from the quarter hour under it, with one light tap, and letting go opens Capture there; Save puts an Inbox item and its block there', async () => {
        const t = await open(day, { layout });
        await hold('17:46', layout);
        await waitFor(() => expect(draft()).toHaveClass('blk', 's-placing', 'pop'));
        expect(draft()).toHaveTextContent('New task');
        expect(draft()).toHaveAttribute('title', '5:45pm to 6:45pm');
        expect(document.querySelector('.holdring')).not.toBeNull();
        expect(t.platform.haptics).toEqual(['light']);
        letGo('17:46', layout);
        const capture = await screen.findByRole('dialog', { name: 'Capture' });
        expect(within(capture).getByText('Today, 5:45pm to 6:45pm')).toBeVisible();
        const field = within(capture).getByRole('textbox', { name: 'Capture to Inbox' });
        await waitFor(() => expect(field).toHaveFocus());
        await userEvent.type(field, 'Book dentist');
        expect(draft()).toHaveTextContent('Book dentist');
        await userEvent.keyboard('{Enter}');
        expect(await screen.findByText('Saved to Inbox, 5:45pm to 6:45pm')).toBeVisible();
        expect(draft()).toBeNull();
        const saved = await screen.findByRole(layout === 'phone' ? 'slider' : 'button', { name: 'Book dentist, 5:45pm to 6:45pm, Inbox.' });
        expect(saved).toHaveClass('k-inbox');
        expect(await listRecords(t.db, 'task')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'inbox', title: 'Book dentist', estimate_min: 60 })]));
      });

      it('a hold on time gone by drafts nothing, with no tap, and a toast says why', async () => {
        const t = await open(day, { layout });
        await hold('13:00', layout);
        expect(draft()).toBeNull();
        expect(await screen.findByText('That time has gone by. Hold on a later time.')).toBeVisible();
        expect(t.platform.haptics).toEqual([]);
      });

      it('a draft that overlaps a block keeps its hour, sits beside it, and Capture says by how much; Cancel takes it away, saving nothing', async () => {
        const t = await open(day, { layout });
        await hold('15:30', layout);
        await waitFor(() => expect(draft()).toHaveAttribute('title', '3:30pm to 4:30pm'));
        expect(draft()!.style.left).toBe('50%');
        letGo('15:30', layout);
        const capture = await screen.findByRole('dialog', { name: 'Capture' });
        expect(within(capture).getByText('Overlaps Write the report by 30m.')).toBeVisible();
        await userEvent.click(within(capture).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Capture' })).toBeNull());
        expect(draft()).toBeNull();
        expect((await listRecords(t.db, 'task')).filter((x) => x.kind === 'inbox')).toEqual([]);
      });

      it('a tap or a click on empty space drafts nothing', async () => {
        const t = await open(day, { layout });
        await ready(layout);
        press('18:00', layout);
        await wait(100);
        letGo('18:00', layout);
        await wait(400);
        expect(draft()).toBeNull();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(t.platform.haptics).toEqual([]);
      });
    });
  }

  it('on phone, a press let go after the hold drafts there and opens Capture, though a busy page hasn’t run the hold’s timer yet', async () => {
    await open(day, { layout: 'phone' });
    await ready('phone');
    // The timer stands still while the clock moves on, as on a page too busy to run it: the release's own time says it
    // was held long enough.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      press('17:46', 'phone');
      vi.setSystemTime(Date.now() + 500);
      letGo('17:46', 'phone');
    } finally {
      vi.useRealTimers();
    }
    expect(within(await screen.findByRole('dialog', { name: 'Capture' })).getByText('Today, 5:45pm to 6:45pm')).toBeVisible();
  });

  it('on phone, the draft follows the finger in quarter hours after the tap, and keeps its hour', async () => {
    await open(day, { layout: 'phone' });
    await hold('17:46', 'phone');
    await waitFor(() => expect(draft()).not.toBeNull());
    fireEvent.pointerMove(window, { clientX: 100, clientY: y('17:46') + 3, pointerType: 'touch', pointerId: 1 });
    expect(draft()).toHaveAttribute('title', '5:45pm to 6:45pm');
    fireEvent.pointerMove(window, { clientX: 100, clientY: y('17:46') + 15, pointerType: 'touch', pointerId: 1 });
    await waitFor(() => expect(draft()).toHaveAttribute('title', '6:15pm to 7:15pm'));
    letGo('18:16', 'phone');
    expect(within(await screen.findByRole('dialog', { name: 'Capture' })).getByText('Today, 6:15pm to 7:15pm')).toBeVisible();
  });

  it('on phone, a finger that moves 8pt before the hold scrolls, and a second finger pinches: neither drafts anything', async () => {
    const t = await open(day, { layout: 'phone' });
    await ready('phone');
    press('18:00', 'phone');
    fireEvent.pointerMove(window, { clientX: 100, clientY: y('18:00') + 9, pointerType: 'touch', pointerId: 1 });
    await wait(450);
    expect(draft()).toBeNull();
    letGo('18:00', 'phone');

    press('18:00', 'phone');
    press('19:00', 'phone', 2);
    await wait(450);
    expect(draft()).toBeNull();
    expect(t.platform.haptics).toEqual([]);
  });

  it('on desktop, a mouse that moves 6px before the hold drafts nothing', async () => {
    await open(day);
    await ready('desktop');
    press('18:00', 'desktop');
    fireEvent.pointerMove(window, { clientX: 106, clientY: y('18:00'), pointerType: 'mouse', pointerId: 1 });
    await wait(450);
    expect(draft()).toBeNull();
  });

  it('on desktop, Esc in Capture takes the draft away', async () => {
    await open(day);
    await hold('18:00', 'desktop');
    await waitFor(() => expect(draft()).not.toBeNull());
    letGo('18:00', 'desktop');
    await screen.findByRole('dialog', { name: 'Capture' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(draft()).toBeNull());
  });

  it('on phone, a hold on a block still lifts the block to move it, and drafts nothing; nor does a hold while it moves', async () => {
    const t = await open(day, { layout: 'phone' });
    const el = await ready('phone');
    fireEvent.pointerDown(el, { clientY: 300, button: 0, pointerType: 'touch', pointerId: 1 });
    await wait(450);
    expect(el).toHaveClass('lifted');
    press('19:00', 'phone', 2);
    await wait(450);
    expect(draft()).toBeNull();
    expect(t.platform.haptics).toEqual(['light']);
  });

  it('on desktop, a mouse held on a block lifts it to drag, as a hold now does, and drafts nothing; a click on it still opens it', async () => {
    await open(day);
    const el = await ready('desktop');
    fireEvent.pointerDown(el, { clientX: 100, clientY: y('16:30'), button: 0, pointerType: 'mouse', pointerId: 1 });
    await wait(450);
    expect(el).toHaveClass('lifted');
    expect(draft()).toBeNull();
    fireEvent.pointerUp(window, { clientX: 100, clientY: y('16:30'), pointerType: 'mouse', pointerId: 1 });
    await waitFor(() => expect(el).not.toHaveClass('lifted'));
    expect(screen.queryByRole('dialog', { name: 'Capture' })).toBeNull();
    await userEvent.click(el);
    await taskPopup('Write the report');
    expect(draft()).toBeNull();
  });

  // A hold on a block is the block's own: it moves it, or opens its menu, and never drafts, even on one that doesn't
  // move or whose time has gone by.
  it('on phone, a hold let go in place on a block opens its menu and drafts nothing, on a block that moves and one gone by', async () => {
    const t = await open(
      async (w) => {
        await day(w);
        await block(w, 'b0', 't1', '11:00', '12:00');
      },
      { layout: 'phone' },
    );
    const holdOn = async (el: HTMLElement, time: string) => {
      fireEvent.pointerDown(el, { clientX: 100, clientY: y(time), button: 0, pointerType: 'touch', pointerId: 1 });
      await wait(450);
      expect(el).toHaveClass('lifted');
      letGo(time, 'phone');
      fireEvent.click(el);
      expect(await screen.findByRole('menu', { name: 'Write the report' })).toBeVisible();
      expect(draft()).toBeNull();
      expect(screen.queryByRole('dialog', { name: 'Capture' })).toBeNull();
      expect(screen.queryByRole('dialog', { name: 'Write the report' })).toBeNull();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    };
    await holdOn(await ready('phone'), '16:30');
    await holdOn(await screen.findByRole('button', { name: /^Write the report, 11am to 12pm/ }), '11:30');
    expect(screen.queryByText('That time has gone by. Hold on a later time.')).toBeNull();
    expect(t.platform.haptics).toEqual(['light', 'light']);
  });

  it('on desktop, a right-click on empty time does nothing new, and one on a block opens its menu and drafts nothing', async () => {
    await open(day);
    const el = await ready('desktop');
    const rightClick = async (on: HTMLElement, time: string) => {
      const point = { clientX: 100, clientY: y(time), button: 2, pointerType: 'mouse', pointerId: 1 };
      fireEvent.pointerDown(on, point);
      const shown = fireEvent.contextMenu(on, point);
      await wait(450);
      fireEvent.pointerUp(window, point);
      return shown;
    };
    // The browser's own menu stays.
    expect(await rightClick(timeline(), '18:00')).toBe(true);
    expect(draft()).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();

    expect(await rightClick(el, '16:30')).toBe(false);
    expect(await screen.findByRole('menu', { name: 'Write the report' })).toBeVisible();
    expect(el).not.toHaveClass('lifted');
    expect(draft()).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each(['desktop', 'phone'] as const)('on %s, a hold on another calendar’s event drafts nothing, as before', async (layout) => {
    const t = await open(
      async (w) => {
        await day(w);
        await w.create('calendar', { connected: true, events: [{ id: 'e1', calendar: 'g1', title: 'Quiz night', start: at('19:00'), end: at('20:00') }] }, 'calendar');
      },
      { layout },
    );
    await ready(layout);
    const event = [...document.querySelectorAll<HTMLElement>('.cev')].find((el) => el.textContent?.includes('Quiz night'))!;
    fireEvent.pointerDown(event, { clientX: 100, clientY: y('19:30'), button: 0, pointerType: kind(layout), pointerId: 1 });
    await wait(450);
    letGo('19:30', layout);
    expect(draft()).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Capture' })).toBeNull();
    expect(t.platform.haptics).toEqual([]);
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

  it.each(['desktop', 'phone'] as const)("on %s, a practice's suggested times have no numbers, and Choose a time opens Week to place its session by hand", async (layout) => {
    const run = (w: Writer) => w.create('practice', { title: 'Morning run', target_min: 30, per: 'day', days: [1, 4], preferred_times: [7 * 60 + 30], state: 'active' }, 'run');
    // Tuesday at 6am, before its 7:30 run.
    const t = await open(run, { layout, now: '2026-11-03T12:00:00Z' });
    await userEvent.click(await screen.findByRole('button', { name: 'Morning run, Practice, 30 minutes on Tuesday around 7:30 AM, to schedule' }));
    const panel = layout === 'phone' ? screen.getByRole('dialog', { name: 'Morning run' }) : screen.getByRole('group', { name: 'Morning run' });
    const times = within(within(panel).getByRole('group', { name: 'Suggested times for Morning run' })).getAllByRole('button');
    expect(times[0]).toHaveTextContent(/^Tue 7:30am to 8am$/);
    for (const time of times) expect(time).toHaveTextContent(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d/);
    await userEvent.click(within(panel).getByRole('button', { name: 'Choose a time' }));
    expect(t.nav().route).toMatchObject({ area: 'week', params: { place: 'run:2026-11-03' } });
  });

  it('a card dragged onto the day is placed where it is let go', async () => {
    const t = await open(picks);
    const card = await screen.findByRole('button', { name: /^Call the bank, One off/ });
    const day = document.querySelector('[data-drop-date="2026-11-02"]')!;
    // The day from 7am to 10pm drawn 450px tall, 30px an hour, so y 330 is 6pm.
    vi.spyOn(day, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 450, top: 0, left: 0, right: 300, bottom: 450, x: 0, y: 0, toJSON: () => ({}) });
    pointAt(() => day);
    holdDown(card, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 100, clientY: 330 });
    fireEvent.pointerUp(window, { clientX: 100, clientY: 330 });
    await waitFor(async () => expect((await live(t, 'o2')).map((b) => b.start)).toEqual([at('18:00')]));
  });

  it('on phone, a card is held before it drags, with one light tap as it lifts, and a quick swipe leaves it be', async () => {
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
      expect(t.platform.haptics).toEqual([]);
      press(450);
      await waitFor(async () => expect((await live(t, 'o2')).map((b) => b.start)).toEqual([at('18:00')]));
      expect(t.platform.haptics).toEqual(['light']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a block's quick menu", () => {
  const day = async (w: Writer) => {
    await w.create('objective', { title: 'Write more', state: 'active' }, 'g');
    await w.create('project', { objective_id: 'g', title: 'Finish the essay', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p');
    await task(w, 't1', 'Write the report');
    await block(w, 'b1', 't1', '16:00', '17:00');
  };
  const report = () => screen.findByRole('button', { name: /^Write the report, 4pm to 5pm/ });
  /** A menu's items in order, a separator as '-', leaving out any submenu inside it. */
  const entries = (menu: HTMLElement) =>
    [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')]
      .filter((el) => el.closest('[role="menu"]') === menu)
      .map((el) => (el.getAttribute('role') === 'separator' ? '-' : el.textContent));
  const rightClick = (el: Element) => fireEvent.contextMenu(el, { clientX: 200, clientY: 300 });

  it('a right-click on a block later today opens what can be done to it, and Done finishes the task', async () => {
    const t = await open(day);
    const el = await report();
    // The browser's own menu stays away.
    expect(rightClick(el)).toBe(false);
    const menu = await screen.findByRole('menu', { name: 'Write the report' });
    expect(entries(menu)).toEqual(['Done', 'Start now', 'Move to', 'Open', '-', 'Remove from calendar', 'Delete task…']);
    expect(within(menu).getByRole('menuitem', { name: 'Done' })).toHaveFocus();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Done' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(await screen.findByText('Marked Write the report done. Its 4pm block came off the calendar, so that time is free.')).toBeVisible();
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBe(NOW));
  });

  it('offers what each block can do: under way, gone by, answered, a practice, and nothing for an event', async () => {
    await open(async (w) => {
      await day(w);
      await dinner(w);
      await task(w, 't3', 'Read the brief');
      await block(w, 'b3', 't3', '13:30', '15:00', { started_at: at('13:30') });
      await task(w, 't6', 'Call the bank');
      await block(w, 'b8', 't6', '13:45', '14:30');
      await task(w, 't4', 'Plan the talk');
      await block(w, 'b4', 't4', '11:00', '12:00');
      await task(w, 't5', 'Email Sam');
      await block(w, 'b5', 't5', '09:00', '09:30');
      await w.create('block_outcome', { result: 'done', answered_at: at('09:30') }, outcomeId('b5'));
      await w.create('practice', { title: 'Piano practice', objective_id: 'g', target_min: 30, per: 'day', state: 'active' }, 'pr');
      await w.create('time_block', { practice_id: 'pr', start: at('18:00'), end: at('18:30'), tz: ZONE }, 'b6');
      await w.create('time_block', { practice_id: 'pr', start: at('12:00'), end: at('12:30'), tz: ZONE }, 'b7');
    });
    const menuOf = async (name: RegExp) => {
      rightClick(await screen.findByRole('button', { name }));
      const menu = await screen.findByRole('menu');
      const said = entries(menu);
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
      return said;
    };
    expect(await menuOf(/^Read the brief, 1:30pm to 3pm/)).toEqual(['Done', 'Pause', 'Open', '-', 'Delete task…']);
    // Under way but not started, it can still have a new time, as its popup's Move… gives it.
    expect(await menuOf(/^Call the bank, 1:45pm to 2:30pm/)).toEqual(['Done', 'Start', 'Move to', 'Open', '-', 'Remove from calendar', 'Delete task…']);
    expect(await menuOf(/^Plan the talk, 11am to 12pm/)).toEqual(['Done', 'Partly…', 'Not done', '-', 'Open', 'Delete task…']);
    expect(await menuOf(/^Email Sam, 9am to 9:30am/)).toEqual(['Open', '-', 'Delete task…']);
    expect(await menuOf(/^Piano practice, 6pm to 6:30pm/)).toEqual(['Did it', 'Start now', 'Move to', 'Open', '-', 'Skip this session']);
    expect(await menuOf(/^Piano practice, 12pm to 12:30pm/)).toEqual(['Did it', 'Some…', 'Skipped', '-', 'Open']);
    // Another calendar's event has no menu: the browser's own stays.
    const event = within(screen.getByRole('region', { name: "Today's timeline" })).getByText('Quiz night');
    expect(rightClick(event)).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('on desktop, Shift-F10 or the menu key opens it on a focused block; arrows move, Move to opens beside it, and Esc goes back', async () => {
    await open(day);
    const el = await report();
    el.focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    const menu = await screen.findByRole('menu', { name: 'Write the report' });
    expect(within(menu).getByRole('menuitem', { name: 'Done' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    const move = within(menu).getByRole('menuitem', { name: 'Move to' });
    expect(move).toHaveFocus();
    expect(move).toHaveAttribute('aria-haspopup', 'menu');
    await userEvent.keyboard('{ArrowRight}');
    const sub = await screen.findByRole('menu', { name: 'Move to' });
    expect(move).toHaveAttribute('aria-expanded', 'true');
    // The next free time after it, tomorrow at the same time, or back to To schedule; or Week, to place it by hand.
    expect(entries(sub)).toEqual(['Next free time, 5pm', 'Tomorrow, 4pm', 'Back to To schedule', '-', 'Choose a time…']);
    expect(within(sub).getByRole('menuitem', { name: 'Next free time, 5pm' })).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.queryByRole('menu', { name: 'Move to' })).toBeNull();
    expect(move).toHaveFocus();
    // Up from the top comes round to the bottom.
    await userEvent.keyboard('{Home}{ArrowUp}');
    expect(within(menu).getByRole('menuitem', { name: 'Delete task…' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(el).toHaveFocus();
    fireEvent.keyDown(el, { key: 'ContextMenu' });
    expect(await screen.findByRole('menu', { name: 'Write the report' })).toBeVisible();
  });

  it('Move to moves it to the next free time or tomorrow, each with Undo, and Choose a time opens Week to place it', async () => {
    const t = await open(async (w) => {
      await day(w);
      await task(w, 't2', 'Paint the fence');
      await block(w, 'b2', 't2', '17:00', '18:00');
    });
    const choose = async (path: string[]) => {
      rightClick(await report());
      for (const name of path) await userEvent.click(await screen.findByRole('menuitem', { name }));
    };
    // 5pm is taken by the fence, so the next free time is after it.
    await choose(['Move to', 'Next free time, 6pm']);
    expect(await screen.findByText('Moved Write the report to 6pm.')).toBeVisible();
    expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ start: at('18:00'), end: at('19:00') });
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.start).toBe(at('16:00')));

    await choose(['Move to', 'Tomorrow, 4pm']);
    expect(await screen.findByText('Moved Write the report to tomorrow, 4pm.')).toBeVisible();
    expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ start: at('16:00', '2026-11-03'), end: at('17:00', '2026-11-03') });
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.start).toBe(at('16:00')));

    await choose(['Move to', 'Back to To schedule']);
    expect(await screen.findByText("Took Write the report off the calendar. It's in To schedule on Week.")).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBeNull());

    await choose(['Move to', 'Choose a time…']);
    expect(t.nav().tab).toBe('week');
  });

  it("Tomorrow asks first when it lands on a block there, though Today doesn't draw tomorrow", async () => {
    const TOMORROW = '2026-11-03';
    const t = await open(async (w) => {
      await day(w);
      await task(w, 't2', 'Paint the fence');
      await block(w, 'b2', 't2', '16:30', '17:30', { start: at('16:30', TOMORROW), end: at('17:30', TOMORROW) });
    });
    const tomorrow = async () => {
      rightClick(await report());
      for (const name of ['Move to', 'Tomorrow, 4pm']) await userEvent.click(await screen.findByRole('menuitem', { name }));
      return screen.findByRole('dialog', { name: 'Schedule both at the same time?' });
    };
    // Cancel leaves both where they were.
    await userEvent.click(within(await tomorrow()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ start: at('16:00') });

    // Replace sends the fence back to To schedule, with one Undo for both.
    await userEvent.click(within(await tomorrow()).getByRole('button', { name: 'Replace' }));
    expect(await screen.findByText('Moved Write the report to tomorrow, 4pm. Took Paint the fence off the calendar.')).toBeVisible();
    expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ start: at('16:00', TOMORROW) });
    expect((await getRecord(t.db, 'time_block', 'b2'))?.cancelled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b2'))?.cancelled).toBeFalsy());
    expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ start: at('16:00') });

    // Keep both keeps both.
    await userEvent.click(within(await tomorrow()).getByRole('button', { name: 'Keep both' }));
    expect(await screen.findByText('Moved Write the report to tomorrow, 4pm.')).toBeVisible();
    expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ start: at('16:00', TOMORROW) });
    expect((await getRecord(t.db, 'time_block', 'b2'))?.cancelled).toBeFalsy();
  });

  it('Start now, Open, Remove from calendar and Delete task do what the popup does; Delete asks first', async () => {
    const t = await open(day);
    rightClick(await report());
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Open' }));
    await taskPopup('Write the report');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    rightClick(await report());
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete task…' }));
    const ask = await screen.findByRole('dialog', { name: 'Delete Write the report?' });
    expect(within(ask).getByText('Its blocks come off the calendar. You can undo this.')).toBeVisible();
    await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect((await getRecord(t.db, 'task', 't1'))?.deleted_at).toBeFalsy();
    rightClick(await report());
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete task…' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Delete Write the report?' })).getByRole('button', { name: 'Delete task' }));
    expect(await screen.findByText('Deleted Write the report.')).toBeVisible();
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.deleted_at).toBe(NOW));
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.deleted_at).toBeFalsy());

    rightClick(await report());
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Start now' }));
    expect(await screen.findByText('Started Write the report. It now runs 2pm to 3pm.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.started_at).toBeNull());

    rightClick(await report());
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove from calendar' }));
    expect(await screen.findByText("Took Write the report off the calendar. It's in To schedule on Week.")).toBeVisible();
  });

  it('Partly on a block gone by asks for the time left, as the end of a block does', async () => {
    await open(async (w) => {
      await day(w);
      await block(w, 'b0', 't1', '11:00', '12:00');
    });
    rightClick(await screen.findByRole('button', { name: /^Write the report, 11am to 12pm/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Partly…' }));
    expect(await screen.findByLabelText('Time left')).toBeVisible();
  });

  it('in the Mac app, macOS draws the menu, and the item chosen there acts', async () => {
    const shown: unknown[] = [];
    const t = await open(day, {
      showMenu: async (items) => {
        shown.push(items);
        return 'done';
      },
    });
    rightClick(await report());
    expect(await screen.findByText('Marked Write the report done. Its 4pm block came off the calendar, so that time is free.')).toBeVisible();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(shown).toEqual([
      [
        { id: 'done', label: 'Done' },
        { id: 'start', label: 'Start now' },
        {
          id: 'move',
          label: 'Move to',
          submenu: [
            { id: 'move:next', label: 'Next free time, 5pm' },
            { id: 'move:tomorrow', label: 'Tomorrow, 4pm' },
            { id: 'move:back', label: 'Back to To schedule' },
            { type: 'separator' },
            { id: 'move:choose', label: 'Choose a time…' },
          ],
        },
        { id: 'open', label: 'Open' },
        { type: 'separator' },
        { id: 'remove', label: 'Remove from calendar' },
        { id: 'delete', label: 'Delete task…' },
      ],
    ]);
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBe(NOW));
  });

  it('on phone, a hold let go without moving opens it, on a block that moves and one that does not', async () => {
    await open(
      async (w) => {
        await day(w);
        await block(w, 'b0', 't1', '11:00', '12:00');
      },
      { layout: 'phone' },
    );
    const later = await screen.findByRole('slider', { name: /^Write the report, 4pm to 5pm/ });
    holdDown(later, { clientY: 300, pointerType: 'touch' });
    fireEvent.pointerMove(window, { clientY: 302, pointerType: 'touch' });
    fireEvent.pointerUp(window, { clientY: 302, pointerType: 'touch' });
    fireEvent.click(later);
    const menu = await screen.findByRole('menu', { name: 'Write the report' });
    expect(screen.queryByRole('dialog', { name: 'Write the report' })).toBeNull();
    for (const item of within(menu).getAllByRole('menuitem')) expect(item.closest('.imenu')).not.toBeNull();
    // Move to opens in its place, with a way back.
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }));
    expect(entries(await screen.findByRole('menu', { name: 'Move to' }))).toEqual(['Back', 'Next free time, 5pm', 'Tomorrow, 4pm', 'Back to To schedule', '-', 'Choose a time…']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Back' }));
    expect(screen.getByRole('menuitem', { name: 'Move to' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    const gone = await screen.findByRole('button', { name: /^Write the report, 11am to 12pm/ });
    holdDown(gone, { clientY: 300, pointerType: 'touch' });
    fireEvent.pointerMove(window, { clientY: 301, pointerType: 'touch' });
    fireEvent.pointerUp(window, { clientY: 301, pointerType: 'touch' });
    fireEvent.click(gone);
    expect(entries(await screen.findByRole('menu', { name: 'Write the report' }))).toEqual(['Done', 'Partly…', 'Not done', '-', 'Open', 'Delete task…']);
  });
});
