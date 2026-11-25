import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localToInstant } from '../../../core/dates';
import { META, setMeta } from '../../../core/db';
import { CALENDAR_ID, getRecord, listRecords, outcomeId, setWeekPick, weekPickId, weekPlanId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import type { AppSync } from '../../../core/syncRunner';
import { EST_STEPS } from '../../components/EstimateSlider';
import type { Layout } from '../../app/registry';
import { requestPrompt } from '../../app/reminders';
import { holdDown, holdTimers, pass, renderApp, renderScreen } from '../../app/testing';
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
/**
 * jsdom has no layout, so the day's top is at 0. Desktop's day starts at 7am at its first zoom, 30px an hour. Phone's
 * opens an hour before now, at 1pm, with the morning folded into the Earlier row, at 72px an hour.
 */
const dayPx = (minutes: number, layout: Layout) => (layout === 'phone' ? (minutes * 72) / 60 : minutes / 2);
const dayY = (time: string, layout: Layout) => {
  const [h, m] = time.split(':').map(Number);
  return dayPx(h! * 60 + (m ?? 0) - (layout === 'phone' ? 780 : 420), layout);
};
/** Opens a block from the day: one tap on desktop; on phone the first tap selects it, and a second opens it. */
const openFromDay = async (el: HTMLElement, layout: Layout) => {
  await userEvent.click(el);
  if (layout === 'phone') {
    await waitFor(() => expect(el.getAttribute('aria-label')).toMatch(/Selected\.$/));
    await userEvent.click(el);
  }
};
/** On phone, the selected block raised out of its lane as a card, with what it can do now. */
const raisedCard = () =>
  waitFor(
    () => {
      const card = document.querySelector<HTMLElement>('.cev.raised:not(.settling)');
      expect(card).not.toBeNull();
      return card!;
    },
    // The first render in a run also loads the modules, so it gets longer.
    { timeout: 5000 },
  );
/** The phone's header menu, which holds the day's view and zoom. */
const phoneView = async (choice: string) => {
  await userEvent.click(await screen.findByRole('button', { name: 'View and week' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: choice }));
};

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
        // The block in progress, tapped to show its card.
        await userEvent.click(await raisedCard());
        await waitFor(() => expect(document.querySelector('.cev.raised:not(.settling)')).not.toHaveClass('inlane'));
        const now = await raisedCard();
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

  it('Start stops a block counting beside it, says so, and Undo puts both back', async () => {
    const t = await open(async (w) => {
      await day(w);
      await task(w, 't0', 'Rake the leaves');
      await block(w, 'b0', 't0', '13:30', '14:30', { started_at: at('13:30') });
    });
    const now = await screen.findByRole('region', { name: 'Current block' });
    await userEvent.click(within(now).getByRole('button', { name: 'Start' }));
    expect(await screen.findByText('Started Write the report. Stopped Rake the leaves at 2pm.')).toBeVisible();
    expect((await getRecord(t.db, 'time_block', 'b0'))?.ended_at).toBe(NOW);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b0'))?.ended_at).toBeNull());
    expect((await getRecord(t.db, 'time_block', 'b1'))?.started_at).toBeNull();
  });

  it('on phone, the block in progress keeps to its own times until a tap selects it; Mark done now and Stop for now appear once it is started', async () => {
    await open(day, { layout: 'phone' });
    let now = await raisedCard();
    // Not tapped: drawn exactly at its block's times, one line, with no actions, and not yet "Selected" to a screen reader.
    expect(now).toHaveClass('inlane');
    const block = await screen.findByRole('button', { name: /^Write the report, 1pm to 3pm, Project\. Now\./ });
    expect(block).not.toHaveAccessibleName(/Selected\./);
    expect(now.style.top).toBe(block.style.top);
    expect(now.style.height).toBe(block.style.height);
    expect(now).toHaveTextContent('Write the reportNot started');
    expect(screen.getByRole('heading', { name: 'Now: Write the report, not started' })).toBeInTheDocument();
    expect(within(now).queryByRole('button')).toBeNull();
    // Tapped, it's selected, and grows past its times with its actions.
    await userEvent.click(now);
    await waitFor(() => expect(document.querySelector('.cev.raised:not(.settling)')).not.toHaveClass('inlane'));
    now = await raisedCard();
    expect(block).toHaveAccessibleName(/Selected\./);
    expect(parseFloat(now.style.top)).toBeLessThan(parseFloat(block.style.top));
    expect(within(now).queryByRole('button', { name: 'Mark done now' })).toBeNull();
    expect(within(now).queryByRole('button', { name: 'Stop for now' })).toBeNull();
    await userEvent.click(within(now).getByRole('button', { name: 'Start' }));
    expect(await within(now).findByRole('button', { name: 'Mark done now' })).toBeVisible();
    expect(within(now).getByRole('button', { name: 'Stop for now' })).toBeVisible();
  });

  describe('Stop for now', () => {
    const running = async (w: Writer, extra: Record<string, unknown> = {}) => {
      await day(w);
      await w.set('time_block', 'b1', { started_at: at('13:00'), ...extra });
    };

    it('asks how much is left, from the estimate less the time spent, then ends the block with Partly; Undo puts both back', async () => {
      const t = await open(running);
      const now = await screen.findByRole('region', { name: 'Current block' });
      await userEvent.click(within(now).getByRole('button', { name: 'Stop for now' }));
      const prompt = await dialog('How much is left?');
      // 3h estimated, 1h spent.
      const slider = within(prompt).getByRole('slider', { name: 'Time left' });
      expect(slider).toHaveAttribute('aria-valuetext', '2h');
      expect(within(prompt).getByRole('button', { name: 'Not done' })).toBeVisible();
      // Nothing has changed until it's answered.
      expect((await getRecord(t.db, 'time_block', 'b1'))?.ended_at).toBeFalsy();
      slideTo(slider, 90);
      await userEvent.click(within(prompt).getByRole('button', { name: 'Save' }));

      expect(await screen.findByText('Stopped after 1h. Added to Needs a new time. No need to decide now.')).toBeVisible();
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      // The button that had focus is gone, so focus lands on Undo rather than the page.
      await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus());
      expect(await within(now).findByText('Free until 4pm')).toBeVisible();
      expect((await getRecord(t.db, 'time_block', 'b1'))?.ended_at).toBe(NOW);
      expect(await getRecord(t.db, 'block_outcome', outcomeId('b1'))).toMatchObject({ result: 'partly', remaining_min: 90 });
      const task = await getRecord(t.db, 'task', 't1');
      expect(task?.remaining_min).toBe(90);
      expect(task?.done_at).toBeFalsy();

      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(await within(now).findByText('Now, 1pm to 3pm')).toBeVisible();
      expect((await getRecord(t.db, 'time_block', 'b1'))?.ended_at).toBeNull();
      expect((await getRecord(t.db, 'block_outcome', outcomeId('b1')))?.deleted_at).toBe(NOW);
      expect((await getRecord(t.db, 'task', 't1'))?.remaining_min).toBeNull();
    });

    it('on a paused block counts the pause out, and Not done ends it too', async () => {
      const t = await open((w) => running(w, { paused_at: at('13:40') }));
      const now = await screen.findByRole('region', { name: 'Current block' });
      await userEvent.click(within(now).getByRole('button', { name: 'Stop for now' }));
      const prompt = await dialog('How much is left?');
      expect(within(prompt).getByRole('slider', { name: 'Time left' })).toHaveAttribute('aria-valuetext', '2h 20m');
      await userEvent.click(within(prompt).getByRole('button', { name: 'Not done' }));
      expect(await screen.findByText('Stopped after 40m. Added to Needs a new time. No need to decide now.')).toBeVisible();
      expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ ended_at: NOW, paused_at: null, paused_min: 20 });
      expect((await getRecord(t.db, 'block_outcome', outcomeId('b1')))?.result).toBe('not');
    });

    it('closed without an answer, leaves the block going', async () => {
      const t = await open(running);
      const now = await screen.findByRole('region', { name: 'Current block' });
      const stop = within(now).getByRole('button', { name: 'Stop for now' });
      await userEvent.click(stop);
      await dialog('How much is left?');
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(stop).toHaveFocus();
      expect(within(now).getByText('Now, 1pm to 3pm')).toBeVisible();
      expect((await getRecord(t.db, 'time_block', 'b1'))?.ended_at).toBeFalsy();
      expect(await getRecord(t.db, 'block_outcome', outcomeId('b1'))).toBeUndefined();
    });

    it('is not there before Start', async () => {
      await open(day);
      const now = await screen.findByRole('region', { name: 'Current block' });
      await within(now).findByRole('button', { name: 'Start' });
      expect(within(now).queryByRole('button', { name: 'Stop for now' })).toBeNull();
    });

    it("is not on a practice's block, whose Mark done now already logs just the time spent", async () => {
      await open(async (w) => {
        await w.create('practice', { title: 'Piano practice', target_min: 30, per: 'day', state: 'active' }, 'pr');
        await w.create('time_block', { practice_id: 'pr', start: at('13:30'), end: at('14:30'), tz: ZONE, started_at: at('13:30') }, 'b3');
      });
      const now = await screen.findByRole('region', { name: 'Current block' });
      await within(now).findByRole('button', { name: 'Mark done now' });
      expect(within(now).queryByRole('button', { name: 'Stop for now' })).toBeNull();
    });
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
    // Its name, which opens its popup, then three answers, as the missed blocks sheet and the notification give: no
    // slider until Partly.
    expect(within(prompt).getAllByRole('button').map((b) => b.textContent)).toEqual(['Piano practice', 'All 30m', 'Partly', 'Skipped']);
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

  it('on phone the block asks on itself, raised on the day, with no sheet opening by itself; Done answers it', async () => {
    const t = await open(ended, { layout: 'phone' });
    const card = await raisedCard();
    expect(card).toHaveTextContent('Ended at 1pm');
    expect(card).toHaveTextContent('How did it go?');
    expect(screen.getByRole('heading', { name: 'Write the report ended at 1pm. How did it go?' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'Done' }));
    await waitFor(async () => expect(await getRecord(t.db, 'block_outcome', outcomeId('b1'))).toMatchObject({ result: 'done' }));
  });

  it('on phone, a block that ended, tapped and answered, hands the selection back to the block in progress', async () => {
    const t = await open(
      async (w) => {
        await ended(w);
        await task(w, 't2', 'Paint the fence');
        await block(w, 'b2', 't2', '13:30', '15:00', { started_at: at('13:30') });
      },
      { layout: 'phone' },
    );
    // The block in progress, in its lane until tapped.
    expect(await raisedCard()).toHaveClass('inlane');
    await userEvent.click(screen.getByRole('button', { name: /^Write the report, 12pm to 1pm/ }));
    await waitFor(() => expect(document.querySelector('.cev.raised:not(.settling)')).toHaveTextContent('How did it go?'));
    await userEvent.click(within(await raisedCard()).getByRole('button', { name: 'Not done' }));
    await waitFor(async () => expect(await getRecord(t.db, 'block_outcome', outcomeId('b1'))).toMatchObject({ result: 'not' }));
    // Back to the block in progress, in its lane again.
    await waitFor(() => expect(document.querySelector('.cev.raised:not(.settling)')).toHaveTextContent('Paint the fence'));
    expect(await raisedCard()).toHaveClass('inlane');
  });

  it("on phone, Partly on the block asks how much is left in the sheet, and a notification's tap still opens it", async () => {
    await open(ended, { layout: 'phone' });
    await userEvent.click(within(await raisedCard()).getByRole('button', { name: 'Partly' }));
    expect(await dialog('How much is left?')).toHaveAttribute('aria-modal', 'true');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => requestPrompt('b1'));
    expect(await dialog('How much is left?')).toBeVisible();
    act(() => requestPrompt(null));
  });

  it('on phone, missed blocks from earlier days wait behind the waiting row, not a sheet of their own', async () => {
    await open(
      async (w) => {
        await task(w, 't1', 'Write the report');
        await block(w, 'b1', 't1', '12:00', '13:00', { start: at('12:00', '2026-10-30'), end: at('13:00', '2026-10-30') });
        await task(w, 't2', 'Paint the fence');
        await block(w, 'b2', 't2', '12:00', '13:00', { start: at('14:00', '2026-10-30'), end: at('15:00', '2026-10-30') });
      },
      { layout: 'phone' },
    );
    await userEvent.click(await screen.findByRole('button', { name: '2 missed blocks to check in on' }));
    expect(screen.queryByRole('dialog', { name: /missed/i })).toBeNull();
    const sheet = await dialog('To schedule');
    expect(within(sheet).getByText('Check in on 2 missed blocks')).toBeVisible();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Review' }));
    expect(await dialog('2 missed blocks')).toBeVisible();
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
    expect(prompt).toHaveTextContent('Have you started Write the report?');
    // Its name opens the task's popup, as it does anywhere.
    expect(within(prompt).getByRole('button', { name: 'Write the report' })).toHaveClass('taskname');
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
      // On phone it waits in the sheet the strip's footer opens, with what else is waiting for a time.
      await userEvent.click(await screen.findByRole('button', { name: layout === 'phone' ? /^\d+ to schedule/ : 'Review' }));
      const panel = layout === 'phone' ? within(await dialog('To schedule')).getByRole('region', { name: 'Needs a new time' }) : screen.getByRole('region', { name: 'Needs a new time' });
      (await within(panel).findByRole('button', { name: 'Delete Water the plants' })).focus();
      await userEvent.keyboard('{Enter}');
      // On phone the section goes from the sheet once nothing in it needs a new time.
      if (layout === 'phone') await waitFor(() => expect(screen.queryByRole('region', { name: 'Needs a new time' })).toBeNull());
      else expect(await within(panel).findByText('Nothing needs a new time.')).toBeVisible();
      // The row and its button have gone, so focus goes to Undo rather than the page.
      expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
      const task = await getRecord(t.db, 'task', 'r');
      expect(task?.deleted_at).toBeUndefined();
      expect(task?.schedule).toEqual(weekly);
      expect(await getRecord(t.db, 'block_outcome', outcomeId('missed'))).toMatchObject({ result: 'not', answered_at: at('09:00') });

      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(await screen.findByRole('button', { name: 'Delete Water the plants' })).toBeVisible();
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

  // The prompt shows on every tab, so one that comes back as planning is skipped takes the key or tap meant for another
  // screen: the deployed clean-up's Enter on a block's × on Week went to it.
  it('keeps a question put away for the session put away once planning is skipped', async () => {
    await unplanned(async (w) => {
      await work(w);
      await block(w, 'b1', 't1', '12:00', '13:00');
    });
    await userEvent.click(within(await dialog('Block finished')).getByRole('button', { name: 'Answer later' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Skip planning this week' }));
    expect(await screen.findByText("This week isn't planned")).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Still there to answer, from the day's Review row.
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
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
      settled: vi.fn(async () => undefined),
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

  it("on phone, it waits in the waiting row's sheet, where Connect opens Google, and × puts it away for the week", async () => {
    const sync = fakeSync();
    const t = await open(async () => undefined, { layout: 'phone', sync });
    await signIn(t);
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Google Calendar' }));
    const sheet = await dialog('To schedule');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Connect' }));
    expect(sync.connectCalendar).toHaveBeenCalledOnce();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Skip for now: Connect Google Calendar' }));
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

  describe('Start now while another block counts', () => {
    const counting = async (w: Writer) => {
      await day(w);
      await task(w, 't0', 'Paint the fence');
      await block(w, 'b0', 't0', '13:00', '15:00', { started_at: at('13:00') });
    };

    it("in a block's popup, stops that one at now and says so, and Undo puts both back", async () => {
      const t = await open(counting);
      await userEvent.click(await screen.findByRole('button', { name: /^Write the report, 4pm to 5pm/ }));
      const popup = await taskPopup('Write the report');
      await userEvent.click(within(popup).getByRole('button', { name: 'Start now' }));
      expect(await screen.findByText('Started Write the report. It now runs 2pm to 3pm. Stopped Paint the fence at 2pm.')).toBeVisible();
      await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.started_at).toBe(NOW));
      expect((await getRecord(t.db, 'time_block', 'b0'))?.ended_at).toBe(NOW);
      expect(await getRecord(t.db, 'block_outcome', outcomeId('b0'))).toBeUndefined();

      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b0'))?.ended_at).toBeNull());
      expect(await getRecord(t.db, 'time_block', 'b1')).toMatchObject({ started_at: null, start: at('16:00') });
    });

    it("in a block's popup, asks how the stopped one went once the popup closes, though nothing else changes then", async () => {
      await open(counting);
      await userEvent.click(await screen.findByRole('button', { name: /^Write the report, 4pm to 5pm/ }));
      const popup = await taskPopup('Write the report');
      await userEvent.click(within(popup).getByRole('button', { name: 'Start now' }));
      // Today has read the change: the Now card is on the new block, and the stopped one's question waits for the popup.
      const now = await screen.findByRole('region', { name: 'Current block' });
      expect(await within(now).findByRole('heading', { name: 'Write the report' })).toBeVisible();
      expect(screen.queryByRole('dialog', { name: 'Block finished' })).toBeNull();
      await userEvent.click(within(popup).getByRole('button', { name: 'Cancel' }));
      expect(within(await dialog('Block finished')).getByText('Paint the fence')).toBeVisible();
    });

    it('from the quick menu, then asks how the stopped one went, Partly starting from its estimate less the time spent', async () => {
      const t = await open(counting);
      fireEvent.contextMenu(await screen.findByRole('button', { name: /^Write the report, 4pm to 5pm/ }), { clientX: 200, clientY: 300 });
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Start now' }));
      expect(await screen.findByText('Started Write the report. It now runs 2pm to 3pm. Stopped Paint the fence at 2pm.')).toBeVisible();
      const prompt = await dialog('Block finished');
      expect(within(prompt).getByText('Paint the fence')).toBeVisible();
      expect(within(prompt).getByText('1h spent.')).toBeVisible();
      // It was stopped, so it isn't still going.
      expect(within(prompt).queryByRole('button', { name: /Still going/ })).toBeNull();
      await userEvent.click(within(prompt).getByRole('button', { name: 'Partly' }));
      // 3h estimated, 1h spent.
      expect(within(await dialog('How much is left?')).getByRole('slider', { name: 'Time left' })).toHaveAttribute('aria-valuetext', '2h');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('Added to Needs a new time. No need to decide now.')).toBeVisible();
      expect(await getRecord(t.db, 'block_outcome', outcomeId('b0'))).toMatchObject({ result: 'partly', remaining_min: 120 });
    });
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
    // On phone a block still to come is a slider, which a tap selects and a second opens.
    await openFromDay(await screen.findByRole(layout === 'phone' ? 'slider' : 'button', { name: /^Write the report, 4pm to 5pm/ }), layout);
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
    expect(await screen.findByText(`Took Write the report off the calendar. It's in ${layout === 'phone' ? 'To schedule' : 'To schedule on Week'}.`)).toBeVisible();
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBeNull());

    // By hand: the popup goes, and Week opens ready to edit, with the block where it was. On phone the block waits on
    // Today's own day, ready to drag or carry to another day on the strip, with Move here and Cancel.
    await pick('Choose a time…');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    if (layout === 'phone') {
      expect(t.nav().route).toMatchObject({ area: 'today' });
      expect(await screen.findByText('Moving Write the report, 1h, from Mon 4pm')).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByText(/^Moving Write the report/)).toBeNull());
    } else expect(t.nav().route).toMatchObject({ area: 'week', params: { edit: 'this' } });
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
    await openFromDay(await screen.findByRole(layout === 'phone' ? 'slider' : 'button', { name: /^Write the report, 4pm to 5pm/ }), layout);
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

  it("Mark done in a later block's popup finishes the task, and its blocks from then on come off the calendar, with Undo", async () => {
    const t = await open(async (w) => {
      await day(w);
      await block(w, 'b4', 't1', '18:00', '19:00');
    });
    await userEvent.click(await screen.findByRole('button', { name: /^Write the report, 4pm to 5pm/ }));
    const section = within(await taskPopup('Write the report')).getByRole('region', { name: 'Time block' });
    // Beside Start now, Move… and Remove from calendar, in the order they're read.
    expect(within(section).getAllByRole('button').map((b) => b.textContent)).toEqual(['Start now', 'Mark done', 'Move…', 'Remove from calendar']);
    await userEvent.click(within(section).getByRole('button', { name: 'Mark done' }));
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

  it("Mark done on a one off's later block ticks it off, as its row's box does", async () => {
    const t = await open(async (w) => {
      await w.create('task', { kind: 'one_off', title: 'Paint the fence' }, 't2');
      await block(w, 'b2', 't2', '16:00', '17:00');
    });
    await userEvent.click(await screen.findByRole('button', { name: /^Paint the fence, 4pm to 5pm/ }));
    await userEvent.click(within(await taskPopup('Paint the fence')).getByRole('button', { name: 'Mark done' }));
    expect(await screen.findByText('Marked Paint the fence done. Its 4pm block came off the calendar, so that time is free.')).toBeVisible();
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't2'))?.done_at).toBe(NOW));
    expect((await getRecord(t.db, 'time_block', 'b2'))?.cancelled).toBe(true);
    expect(await listRecords(t.db, 'task_completion')).toHaveLength(1);
  });

  it("Mark done in an answered block's popup still finishes its task, as from a list, with Undo", async () => {
    const t = await open(async (w) => {
      await day(w);
      await task(w, 't3', 'Read the brief');
      await block(w, 'b5', 't3', '11:00', '12:00');
      await w.create('block_outcome', { result: 'partly', answered_at: at('12:00') }, outcomeId('b5'));
    });
    await userEvent.click(await screen.findByRole('button', { name: /^Read the brief, 11am to 12pm/ }));
    const section = within(await taskPopup('Read the brief')).getByRole('region', { name: 'Time block' });
    expect(within(section).getAllByRole('button').map((b) => b.textContent)).toEqual(['Mark done']);
    await userEvent.click(within(section).getByRole('button', { name: 'Mark done' }));
    expect(await screen.findByText('Marked Read the brief done.')).toBeVisible();
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't3'))?.done_at).toBe(NOW));
    // Its answer stays as it was.
    expect((await getRecord(t.db, 'block_outcome', outcomeId('b5')))?.result).toBe('partly');
    await waitFor(() => expect(within(section).queryByRole('button', { name: 'Mark done' })).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't3'))?.done_at).toBeNull());
  });

  it("the block under way offers Mark done, which marks it done now, and Pause or Resume", async () => {
    const t = await open(async (w) => {
      await day(w);
      await task(w, 't3', 'Read the brief');
      await block(w, 'b0', 't3', '13:30', '15:00', { started_at: at('13:30') });
    });
    await userEvent.click(await screen.findByRole('button', { name: /^Read the brief, 1:30pm to 3pm/ }));
    const section = within(await taskPopup('Read the brief')).getByRole('region', { name: 'Time block' });
    expect(within(section).getAllByRole('button').map((b) => b.textContent)).toEqual(['Mark done', 'Pause']);
    await userEvent.click(within(section).getByRole('button', { name: 'Pause' }));
    expect(await screen.findByText('Paused Read the brief')).toBeVisible();
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b0'))?.paused_at).toBe(NOW));
    await userEvent.click(await within(section).findByRole('button', { name: 'Resume' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b0'))?.paused_at).toBeNull());
    expect(await screen.findByText('Resumed. It now ends at 3pm.')).toBeVisible();
    expect(await within(section).findByRole('button', { name: 'Pause' })).toBeVisible();
    // As Mark done now has it: the block ends now and says how long it took.
    await userEvent.click(within(section).getByRole('button', { name: 'Mark done' }));
    expect(await screen.findByText("Marked done after 30m. You're free until 4pm.")).toBeVisible();
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b0'))?.ended_at).toBe(NOW));
    expect((await getRecord(t.db, 'block_outcome', outcomeId('b0')))?.result).toBe('done');
    expect((await getRecord(t.db, 'task', 't3'))?.done_at).toBe(NOW);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b0'))?.ended_at).toBeNull());
  });

  it("the block under way, not yet started, offers Start, Mark done and Move…", async () => {
    await open(async (w) => {
      await day(w);
      await task(w, 't3', 'Read the brief');
      await block(w, 'b0', 't3', '13:30', '15:00');
    });
    await userEvent.click(await screen.findByRole('button', { name: /^Read the brief, 1:30pm to 3pm/ }));
    const section = within(await taskPopup('Read the brief')).getByRole('region', { name: 'Time block' });
    expect(within(section).getAllByRole('button').map((b) => b.textContent)).toEqual(['Start', 'Mark done', 'Move…', 'Remove from calendar']);
  });

  it("a practice's session and a planning block open their popups, as a task's block does", async () => {
    await open(async (w) => {
      await day(w);
      await w.create('practice', { title: 'Piano practice', objective_id: 'g', target_min: 30, per: 'day', state: 'active' }, 'pr');
      await w.create('time_block', { practice_id: 'pr', start: at('18:00'), end: at('18:30'), tz: ZONE }, 'b2');
      await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 9', plans: ['week:2026-11-09'] }, 'planning:week:2026-11-09');
      await block(w, 'b3', 'planning:week:2026-11-09', '19:00', '19:30');
    });
    const practice = await screen.findByRole('button', { name: /^Piano practice, 6pm to 6:30pm/ });
    expect(practice).toHaveAttribute('aria-haspopup', 'dialog');
    await userEvent.click(practice);
    const popup = await dialog('Piano practice');
    expect(await within(within(popup).getByRole('region', { name: 'Time block' })).findByText(/^Write more/)).toBeVisible();
    await userEvent.click(within(popup).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: /^Plan the week of Nov 9, 7pm to 7:30pm/ }));
    expect(within(await dialog('Plan the week of Nov 9')).getByRole('region', { name: 'Time block' })).toBeVisible();
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

  it("on phone, the zoom and the list are in Today's menu, so nothing sits over the day", async () => {
    await open(day, { layout: 'phone' });
    await screen.findByRole('slider', { name: /^Write the report, 4pm to 5pm/ });
    expect(screen.queryByRole('group', { name: 'Calendar zoom' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Timeline view' })).toBeNull();
    const height = () => parseFloat(screen.getByRole('slider', { name: /^Write the report/ }).style.height);
    // 72pt an hour opening: an hour's block is 71px, then 96pt.
    expect(height()).toBe(71);
    await phoneView('Zoom in');
    await waitFor(() => expect(height()).toBe(95));
    await userEvent.click(screen.getByRole('button', { name: 'View and week' }));
    expect(screen.queryByRole('menuitem', { name: 'Zoom in' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await phoneView('Show as a list');
    expect(await screen.findByRole('button', { name: /^Write the report, 4pm to 5pm/ })).toHaveClass('tlbtn');
    await phoneView('Show as a calendar');
    expect(await screen.findByRole('slider', { name: /^Write the report, 4pm to 5pm/ })).toBeVisible();
  });

  it('on desktop, the zoom buttons sit beside Calendar and List, out of the calendar, and only with it', async () => {
    const layout = 'desktop';
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

  it("on phone, a first tap selects a block, raising it with Move and Details; a second tap or Details opens it; a tap on empty time hands the selection back", async () => {
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
    expect(el).toHaveAccessibleDescription(/^Tap to select it, and again to open it\./);
    // Nothing is selected at 2pm: the next block starts in more than an hour.
    expect(document.querySelector('.cev.raised')).toBeNull();
    await userEvent.click(el);
    expect(el).toHaveAccessibleName('Write the report, 4pm to 5pm, Project. Selected.');
    // The next block, with nothing under way, offers Start early.
    const card = await raisedCard();
    expect(card).toHaveTextContent('Next in 2h, 4pm to 5pm');
    expect(within(card).getByRole('button', { name: 'Start early' })).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Its buttons follow the block, for screen readers.
    expect(el.compareDocumentPosition(within(card).getByRole('button', { name: 'Details' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: 'Details' }));
    await userEvent.click(within(await taskPopup('Write the report')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(el);
    await userEvent.click(within(await taskPopup('Write the report')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Another block takes the selection; empty time hands it back to none.
    const piano = screen.getByRole('slider', { name: /^Piano practice, 6pm to 6:30pm/ });
    await userEvent.click(piano);
    expect(piano).toHaveAccessibleName(/Selected\.$/);
    expect(el).toHaveAccessibleName('Write the report, 4pm to 5pm, Project.');
    // Any later block offers Move, its popup's own choices.
    const later = await raisedCard();
    expect(later).toHaveTextContent('6pm to 6:30pm, Practice');
    expect(within(later).getByRole('button', { name: 'Move' })).toHaveAttribute('aria-haspopup', 'menu');
    await userEvent.click(within(later).getByRole('button', { name: 'Move' }));
    expect(await screen.findByRole('menu', { name: 'Move Piano practice' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(document.querySelector<HTMLElement>('.day')!);
    await waitFor(() => expect(document.querySelector('.cev.raised:not(.settling)')).toBeNull());
    await openFromDay(piano, 'phone');
    const popup = await dialog('Piano practice');
    expect(popup).toHaveClass('taskpop');
    expect(await within(within(popup).getByRole('region', { name: 'Time block' })).findByText(/^Write more/)).toBeVisible();
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

  it('sit side by side on the calendar, each named with what it overlaps, and open their popups', async () => {
    await open(together, { layout });
    const report = await screen.findByRole(role, { name: 'Write the report, 4pm to 5pm, Project. Overlaps Piano practice.' });
    const piano = screen.getByRole(role, { name: 'Piano practice, 4pm to 4:30pm, Practice. Overlaps Write the report.' });
    sideBySide([report, piano]);
    // Read by start, then column: the longer one is first, on the left.
    expect(report.compareDocumentPosition(piano) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await openFromDay(piano, layout);
    expect(await dialog('Piano practice')).toHaveClass('taskpop');
  });

  it("a task's block beside another still opens the task's popup, with its own section", async () => {
    await open(together, { layout });
    await openFromDay(await screen.findByRole(role, { name: 'Write the report, 4pm to 5pm, Project. Overlaps Piano practice.' }), layout);
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
    if (layout === 'phone') await phoneView('Show as a list');
    else await userEvent.click(await screen.findByRole('button', { name: 'List' }));
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
      // A task's block in the list opens the task's popup, with its section.
      await userEvent.click(within(await dialog('Piano practice')).getByRole('button', { name: 'Cancel' }));
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
    // On phone the day opens an hour before the block still to answer, the earlier hours folded until opened.
    if (layout === 'phone') await userEvent.click(await screen.findByRole('button', { name: 'Earlier, 7am to 10am, 2 blocks', expanded: false }));
    // The block in its lane, not the raised card that repeats a selected block's name on phone.
    const drawn = async (title: string) => (await within(await timeline()).findAllByText(title)).map((el) => el.closest('.cev')!).find((el) => !el.classList.contains('raised'))!;
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
    if (layout === 'phone') await phoneView('Show as a list');
    else await userEvent.click(await within(await timeline()).findByRole('button', { name: 'List', hidden: true }));
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
    // The word goes on a second line, beside the title on desktop and under it on phone, whose day opens zoomed in to
    // fit it.
    expect(el).toHaveTextContent('Inbox, 5:45pm to 6:45pm');
    await openFromDay(el, layout);
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
  afterEach(() => void vi.useRealTimers());
  const day = async (w: Writer) => {
    await task(w, 't1', 'Write the report');
    await block(w, 'b1', 't1', '16:00', '17:00');
  };
  const report = (name: RegExp = /^Write the report, /, role = 'button') => screen.findByRole(role, { name });
  const saved = (t: Harness, id = 'b1') => getRecord(t.db, 'time_block', id);
  // A block moves once held, by mouse or finger, so a click stays a click and a swipe still scrolls the page. Each drag
  // is a number of minutes, drawn at the layout's zoom (dayPx).
  const press = (el: Element, layout: Layout) => holdDown(el, { clientY: 300, pointerType: layout === 'phone' ? 'touch' : 'mouse' });
  const drag = async (el: Element, minutes: number, layout: Layout) => {
    press(el, layout);
    fireEvent.pointerMove(window, { clientY: 300 + dayPx(minutes, layout) });
    fireEvent.pointerUp(window, { clientY: 300 + dayPx(minutes, layout) });
  };
  const edge = (el: Element, layout: Layout) => el.querySelector(layout === 'phone' ? '.rz' : '.evh')!;

  for (const layout of ['desktop', 'phone'] as const) {
    describe(`on ${layout}`, () => {
      // On phone a block still to come is a slider, as on Week, so VoiceOver's swipes move it.
      const movable = (name?: RegExp) => report(name, layout === 'phone' ? 'slider' : 'button');

      it('a drag moves it on a 15-minute grid without opening it, and Undo puts it back', async () => {
        const t = await open(day, { layout });
        const el = await movable();
        expect(el).toHaveAccessibleDescription(layout === 'phone' ? 'Tap to select it, and again to open it. Hold it, then drag to move it, or hold its handle and drag to change its length.' : /arrow keys move it/);
        // 22 minutes lands on a quarter past.
        await drag(el, 22, layout);
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
        await drag(el, 22, layout);
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
        // On phone the first Enter selects it, as a tap does.
        await userEvent.keyboard(layout === 'phone' ? '{Enter}{Enter}' : '{Enter}');
        await userEvent.click(within(await taskPopup('Write the report')).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        el.focus();
        await userEvent.keyboard('{ArrowDown}');
        expect(await screen.findByText('Write the report is now 4:15pm to 5:15pm.')).toBeVisible();
        expect(await saved(t)).toMatchObject({ start: at('16:15'), end: at('17:15') });
      });

      it("snaps to the day's suggested time, shown while dragging", async () => {
        const t = await open(day, { layout });
        // 50 minutes, 4:50pm, within 20 minutes of 5pm: the first open hour of a weekday evening.
        press(await movable(), layout);
        fireEvent.pointerMove(window, { clientY: 300 + dayPx(50, layout) });
        expect(await screen.findByText('Suggested 5pm')).toBeVisible();
        expect(await movable(/^Write the report, 5pm to 6pm/)).toHaveClass('lifted');
        fireEvent.pointerUp(window, { clientY: 300 + dayPx(50, layout) });
        // Put down at once, where it was let go, while its new time saves.
        expect(screen.getByRole(layout === 'phone' ? 'slider' : 'button', { name: /^Write the report, 5pm to 6pm/ })).not.toHaveClass('lifted');
        await waitFor(async () => expect(await saved(t)).toMatchObject({ start: at('17:00'), end: at('18:00') }));
        expect(screen.queryByText('Suggested 5pm')).toBeNull();
      });

      it('the bottom edge changes its length, and a time outside available hours says so', async () => {
        const t = await open(day, { layout });
        await drag(edge(await movable(), layout), 30, layout);
        expect(await screen.findByText('Write the report is now 4pm to 5:30pm.')).toBeVisible();
        expect(await saved(t)).toMatchObject({ start: at('16:00'), end: at('17:30') });
        // Five and a half hours: 9:30pm, running past 10pm when the day closes.
        await drag(await movable(/^Write the report, 4pm to 5:30pm/), 330, layout);
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
        await drag(el, 60, layout);
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
        await drag(el, 60, layout);
        el.focus();
        await userEvent.keyboard('{ArrowDown}');
        expect(await saved(t)).toMatchObject({ start: at('13:00'), end: at('15:00') });
        expect(screen.queryByText(/is now/)).toBeNull();

        await drag(edge(el, layout), 30, layout);
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

  it('on phone, a block still to come is a slider, as on Week, so VoiceOver can move it, and Enter or a tap selects it, then opens it', async () => {
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
    // A slider has no click of its own for a keyboard, so Enter and Space select it as a tap does, and then open it.
    moved.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(moved).toHaveAccessibleName(/Selected\.$/));
    expect(screen.queryByRole('dialog')).toBeNull();
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
    holdTimers();
    const t = await open(day, { layout: 'phone' });
    const el = await report(undefined, 'slider');
    fireEvent.pointerDown(el, { clientY: 300, button: 0, pointerType: 'touch' });
    fireEvent.pointerMove(window, { clientY: 330, pointerType: 'touch' });
    await pass(450);
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
    // Taps a moment later select it and open it, as before.
    await pass(450);
    await openFromDay(el, 'phone');
    await taskPopup('Write the report');
  });

  it('on phone, a short tap selects it and moves nothing, a second opens the task, and a hold lifts it with one light tap from the device', async () => {
    holdTimers();
    const t = await open(day, { layout: 'phone' });
    const el = await report(undefined, 'slider');
    fireEvent.pointerDown(el, { clientY: 300, button: 0 });
    await pass(100);
    fireEvent.pointerUp(window, { clientY: 300 });
    fireEvent.click(el);
    expect(await screen.findByRole('button', { name: 'Details' })).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(el);
    await taskPopup('Write the report');
    expect(el).not.toHaveClass('lifted');
    expect(t.platform.haptics).toEqual([]);
    await userEvent.click(within(await dialog('Write the report')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Held, then moved: it drags, and opens nothing. The tap comes from the platform, which on an iPhone is its
    // Taptic Engine, since iPhones ignore the browser's vibrate.
    await drag(el, 22, 'phone');
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
      // Half an hour: start and end both move.
      await drag(el, 30, 'desktop');
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
      expect(el).toHaveAccessibleDescription('Tap to select it, and again to open it. Hold it, then drag to move it.');
      await drag(el, 30, 'phone');
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
  beforeEach(holdTimers);
  afterEach(() => void vi.useRealTimers());
  const day = async (w: Writer) => {
    await task(w, 't1', 'Write the report');
    await block(w, 'b1', 't1', '16:00', '17:00');
  };
  const timeline = () => document.querySelector<HTMLElement>('.day')!;
  const draft = () => document.querySelector<HTMLElement>('.cev.holddraft');
  const y = (time: string, layout: Layout) => dayY(time, layout);
  const kind = (layout: Layout) => (layout === 'phone' ? 'touch' : 'mouse');
  // The first render in a run also loads the modules, so it gets longer.
  const ready = (layout: Layout) => screen.findByRole(layout === 'phone' ? 'slider' : 'button', { name: /^Write the report, 4pm to 5pm/ }, { timeout: 5000 });
  const press = (time: string, layout: Layout, pointerId = 1) =>
    fireEvent.pointerDown(timeline(), { clientX: 100, clientY: y(time, layout), button: 0, pointerType: kind(layout), pointerId });
  const hold = async (time: string, layout: Layout) => {
    await ready(layout);
    press(time, layout);
    await pass(450);
  };
  const letGo = (time: string, layout: Layout) => fireEvent.pointerUp(window, { clientX: 100, clientY: y(time, layout), pointerType: kind(layout), pointerId: 1 });

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
        const field = within(capture).getByRole('combobox', { name: 'Capture to Inbox' });
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

      it('Capture’s search lists To schedule, and picking a task there places it in the drafted time instead, with Undo', async () => {
        const t = await open(
          async (w) => {
            await day(w);
            await w.create('project', { title: 'Report', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p');
            await task(w, 't2', 'Draft the summary', { estimate_min: 30 });
            await setWeekPick(w, DAY, 't2', 30);
          },
          { layout },
        );
        // With work to schedule, the phone's blocks are buttons, so the day is ready once the block is drawn at all.
        await screen.findByLabelText(/^Write the report, 4pm to 5pm/, {}, { timeout: 5000 });
        press('17:46', layout);
        await pass(450);
        letGo('17:46', layout);
        const capture = await screen.findByRole('dialog', { name: 'Capture' });
        const option = await within(capture).findByRole('option', { name: 'Draft the summary, Project · 30m, Fits' });
        if (layout === 'desktop') {
          await userEvent.keyboard('{ArrowDown}');
          expect(option).toHaveAttribute('aria-selected', 'true');
          await userEvent.keyboard('{Enter}');
        } else await userEvent.click(option);
        expect(await screen.findByText(/^Placed Draft the summary, .*5:45pm$/)).toBeVisible();
        expect(draft()).toBeNull();
        expect(await screen.findByLabelText(/^Draft the summary, 5:45pm to 6:15pm/)).toBeVisible();
        expect((await listRecords(t.db, 'task')).filter((x) => x.kind === 'inbox')).toEqual([]);
        await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
        await waitFor(() => expect(screen.queryByLabelText(/^Draft the summary, 5:45pm/)).toBeNull());
      });

      it('a tap or a click on empty space drafts nothing', async () => {
        const t = await open(day, { layout });
        await ready(layout);
        press('18:00', layout);
        await pass(100);
        letGo('18:00', layout);
        await pass(400);
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
    fireEvent.pointerMove(window, { clientX: 100, clientY: y('17:46', 'phone') + 3, pointerType: 'touch', pointerId: 1 });
    expect(draft()).toHaveAttribute('title', '5:45pm to 6:45pm');
    fireEvent.pointerMove(window, { clientX: 100, clientY: y('17:46', 'phone') + dayPx(30, 'phone'), pointerType: 'touch', pointerId: 1 });
    await waitFor(() => expect(draft()).toHaveAttribute('title', '6:15pm to 7:15pm'));
    letGo('18:16', 'phone');
    expect(within(await screen.findByRole('dialog', { name: 'Capture' })).getByText('Today, 6:15pm to 7:15pm')).toBeVisible();
  });

  it('on phone, a finger that moves 8pt before the hold scrolls, and a second finger pinches: neither drafts anything', async () => {
    const t = await open(day, { layout: 'phone' });
    await ready('phone');
    press('18:00', 'phone');
    fireEvent.pointerMove(window, { clientX: 100, clientY: y('18:00', 'phone') + 9, pointerType: 'touch', pointerId: 1 });
    await pass(450);
    expect(draft()).toBeNull();
    letGo('18:00', 'phone');

    press('18:00', 'phone');
    press('19:00', 'phone', 2);
    await pass(450);
    expect(draft()).toBeNull();
    expect(t.platform.haptics).toEqual([]);
  });

  const moveTo = (time: string, x = 100) => fireEvent.pointerMove(window, { clientX: x, clientY: y(time, 'desktop'), pointerType: 'mouse', pointerId: 1 });

  it('on desktop, a mouse pressed on empty time and dragged down draws the draft at once, over the quarter hours from the press to the pointer, with no ring or tap; letting go opens Capture with that time, and Save keeps it', async () => {
    const t = await open(day);
    await ready('desktop');
    press('17:46', 'desktop');
    moveTo('17:58');
    await waitFor(() => expect(draft()).toHaveAttribute('title', '5:45pm to 6pm'));
    moveTo('18:20');
    await waitFor(() => expect(draft()).toHaveAttribute('title', '5:45pm to 6:30pm'));
    expect(draft()).toHaveTextContent('New task');
    expect(draft()).toHaveClass('blk', 's-placing');
    expect(draft()).not.toHaveClass('pop');
    expect(document.querySelector('.holdring')).toBeNull();
    await pass(450);
    expect(draft()).toHaveAttribute('title', '5:45pm to 6:30pm');
    letGo('18:20', 'desktop');
    const capture = await screen.findByRole('dialog', { name: 'Capture' });
    expect(within(capture).getByText('Today, 5:45pm to 6:30pm')).toBeVisible();
    await userEvent.type(within(capture).getByRole('combobox', { name: 'Capture to Inbox' }), 'Book dentist');
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText('Saved to Inbox, 5:45pm to 6:30pm')).toBeVisible();
    expect(await listRecords(t.db, 'task')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'inbox', title: 'Book dentist', estimate_min: 45 })]));
    expect(t.platform.haptics).toEqual([]);
  });

  it('on desktop, a mouse dragged up draws from the pointer to the press, and never into time gone by', async () => {
    await open(day);
    await ready('desktop');
    press('18:20', 'desktop');
    moveTo('17:50');
    await waitFor(() => expect(draft()).toHaveAttribute('title', '5:45pm to 6:30pm'));
    // It's 2pm.
    moveTo('12:00');
    await waitFor(() => expect(draft()).toHaveAttribute('title', '2pm to 6:30pm'));
    letGo('12:00', 'desktop');
    expect(within(await screen.findByRole('dialog', { name: 'Capture' })).getByText('Today, 2pm to 6:30pm')).toBeVisible();
  });

  it('on desktop, a mouse that moves 6px and no further draws the shortest block, a quarter hour, from where it was pressed', async () => {
    await open(day);
    await ready('desktop');
    press('18:00', 'desktop');
    moveTo('18:00', 106);
    await waitFor(() => expect(draft()).toHaveAttribute('title', '6pm to 6:15pm'));
    letGo('18:00', 'desktop');
    expect(within(await screen.findByRole('dialog', { name: 'Capture' })).getByText('Today, 6pm to 6:15pm')).toBeVisible();
  });

  it('on desktop, Esc while dragging takes the draft away, and letting go then opens nothing', async () => {
    await open(day);
    await ready('desktop');
    press('18:00', 'desktop');
    moveTo('19:00');
    await waitFor(() => expect(draft()).not.toBeNull());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(draft()).toBeNull());
    moveTo('19:30');
    letGo('19:30', 'desktop');
    await pass(100);
    expect(draft()).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Capture' })).toBeNull();
  });

  it('on desktop, a drag across a block draws over it, beside it, and Capture says by how much without asking', async () => {
    await open(day);
    await ready('desktop');
    press('15:30', 'desktop');
    moveTo('16:20');
    await waitFor(() => expect(draft()).toHaveAttribute('title', '3:30pm to 4:30pm'));
    expect(draft()!.style.left).toBe('50%');
    letGo('16:20', 'desktop');
    const capture = await screen.findByRole('dialog', { name: 'Capture' });
    expect(within(capture).getByText('Overlaps Write the report by 30m.')).toBeVisible();
    await userEvent.type(within(capture).getByRole('combobox', { name: 'Capture to Inbox' }), 'Call the bank{Enter}');
    expect(await screen.findByText('Saved to Inbox, 3:30pm to 4:30pm')).toBeVisible();
    expect(screen.queryByText('Schedule both at the same time?')).toBeNull();
  });

  it('on desktop, a drag wholly in time gone by draws nothing, and a toast says why', async () => {
    await open(day);
    await ready('desktop');
    press('12:00', 'desktop');
    moveTo('13:00');
    await pass(50);
    expect(draft()).toBeNull();
    letGo('13:00', 'desktop');
    expect(await screen.findByText('That time has gone by. Hold on a later time.')).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Capture' })).toBeNull();
  });

  it('on desktop, a drag while a block is open draws nothing', async () => {
    await open(day);
    await userEvent.click(await ready('desktop'));
    await taskPopup('Write the report');
    press('18:00', 'desktop');
    moveTo('19:00');
    await pass(50);
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
    await pass(450);
    expect(el).toHaveClass('lifted');
    press('19:00', 'phone', 2);
    await pass(450);
    expect(draft()).toBeNull();
    expect(t.platform.haptics).toEqual(['light']);
  });

  it('on desktop, a mouse held on a block lifts it to drag, as a hold now does, and drafts nothing; a click on it still opens it', async () => {
    await open(day);
    const el = await ready('desktop');
    fireEvent.pointerDown(el, { clientX: 100, clientY: y('16:30', 'desktop'), button: 0, pointerType: 'mouse', pointerId: 1 });
    await pass(450);
    expect(el).toHaveClass('lifted');
    expect(draft()).toBeNull();
    fireEvent.pointerUp(window, { clientX: 100, clientY: y('16:30', 'desktop'), pointerType: 'mouse', pointerId: 1 });
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
      fireEvent.pointerDown(el, { clientX: 100, clientY: y(time, 'phone'), button: 0, pointerType: 'touch', pointerId: 1 });
      await pass(450);
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
      const point = { clientX: 100, clientY: y(time, 'desktop'), button: 2, pointerType: 'mouse', pointerId: 1 };
      fireEvent.pointerDown(on, point);
      const shown = fireEvent.contextMenu(on, point);
      await pass(450);
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
    fireEvent.pointerDown(event, { clientX: 100, clientY: y('19:30', layout), button: 0, pointerType: kind(layout), pointerId: 1 });
    await pass(450);
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

  it.each(['desktop', 'phone'] as const)("on %s, a practice's suggested times have no numbers, and Choose a time opens its week to place its session by hand", async (layout) => {
    const run = (w: Writer) => w.create('practice', { title: 'Morning run', target_min: 30, per: 'day', days: [1, 4], preferred_times: [7 * 60 + 30], state: 'active' }, 'run');
    // Tuesday at 6am, before its 7:30 run.
    const t = await open(run, { layout, now: '2026-11-03T12:00:00Z' });
    // On phone, To schedule is in the sheet behind the strip footer's count, the week's: Tuesday's run and Friday's.
    if (layout === 'phone') await userEvent.click(await screen.findByRole('button', { name: '2 to schedule' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Morning run, Practice, 30 minutes on Tuesday around 7:30 AM, to schedule' }));
    const panel = layout === 'phone' ? await dialog('Morning run') : screen.getByRole('group', { name: 'Morning run' });
    const times = within(within(panel).getByRole('group', { name: 'Suggested times for Morning run' })).getAllByRole('button');
    expect(times[0]).toHaveTextContent(/^Tue 7:30am to 8am$/);
    for (const time of times) expect(time).toHaveTextContent(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d/);
    await userEvent.click(within(panel).getByRole('button', { name: 'Choose a time' }));
    // Week on desktop; on phone Week is Today's, which places it over its day (weekOnToday.test.tsx).
    expect(t.nav().route).toMatchObject({ area: layout === 'phone' ? 'today' : 'week', params: { place: 'run:2026-11-03' } });
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

  it("on phone, a card in the waiting sheet is held before it drags, with one light tap as it lifts, the sheet steps aside, and a quick swipe leaves it be", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const t = await open(picks, { layout: 'phone' });
      await userEvent.click(await screen.findByRole('button', { name: /^\d+ to schedule/ }));
      const sheet = await dialog('To schedule');
      const card = within(sheet).getByRole('button', { name: /^Call the bank, One off/ });
      // The phone's day opens at 1pm, so the 450px it's drawn runs from 1pm to 10pm, and y 250 is 6pm.
      const day = document.querySelector('[data-drop-date="2026-11-02"]')!;
      vi.spyOn(day, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 450, top: 0, left: 0, right: 300, bottom: 450, x: 0, y: 0, toJSON: () => ({}) });
      pointAt(() => day);
      const press = (holdMs: number) => {
        fireEvent.pointerDown(card, { clientX: 10, clientY: 10, button: 0, pointerType: 'touch' });
        act(() => void vi.advanceTimersByTime(holdMs));
        fireEvent.pointerMove(window, { clientX: 100, clientY: 250, pointerType: 'touch' });
        fireEvent.pointerUp(window, { clientX: 100, clientY: 250, pointerType: 'touch' });
      };
      press(100);
      expect(document.querySelector('.cardghost')).toBeNull();
      expect(await live(t, 'o2')).toEqual([]);
      expect(t.platform.haptics).toEqual([]);
      expect(sheet).not.toHaveClass('aside');
      fireEvent.pointerDown(card, { clientX: 10, clientY: 10, button: 0, pointerType: 'touch' });
      act(() => void vi.advanceTimersByTime(450));
      fireEvent.pointerMove(window, { clientX: 100, clientY: 250, pointerType: 'touch' });
      expect(sheet).toHaveClass('aside');
      fireEvent.pointerUp(window, { clientX: 100, clientY: 250, pointerType: 'touch' });
      await waitFor(async () => expect((await live(t, 'o2')).map((b) => b.start)).toEqual([at('18:00')]));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'To schedule' })).toBeNull());
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

  it('goes when the page scrolls, but not for a scroll from before it opened that the browser reports after', async () => {
    await open(day);
    rightClick(await report());
    expect(screen.getByRole('menu', { name: 'Write the report' })).toBeInTheDocument();
    // A scroll bringing the block into view just before the right-click is reported in the next frame.
    fireEvent.scroll(document);
    expect(screen.getByRole('menu', { name: 'Write the report' })).toBeInTheDocument();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    fireEvent.scroll(document);
    expect(screen.queryByRole('menu')).toBeNull();
  });

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
    expect(await menuOf(/^Piano practice, 6pm to 6:30pm/)).toEqual(['Did it', 'Start now', 'Move to', 'Open', '-', 'Take off calendar']);
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

  it("Take off calendar puts a practice's session in To schedule, saying where it was, with Undo", async () => {
    const t = await open(async (w) => {
      await day(w);
      await w.create('practice', { title: 'Piano practice', target_min: 30, per: 'day', preferred_times: [18 * 60], state: 'active' }, 'pr');
      await w.create('time_block', { practice_id: 'pr', start: at('18:00'), end: at('18:30'), tz: ZONE }, 'session:pr:2026-11-02');
    });
    rightClick(await screen.findByRole('button', { name: /^Piano practice, 6pm to 6:30pm/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Take off calendar' }));
    expect(await screen.findByText("Took Piano practice off Mon 6pm. It's in To schedule.")).toBeVisible();
    expect(await getRecord(t.db, 'time_block', 'session:pr:2026-11-02')).toMatchObject({ cancelled: true });
    // It waits in To schedule, with its set time first.
    const lane = await screen.findByRole('region', { name: 'To schedule' });
    expect(within(lane).getByText('30m · usually 6pm')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'session:pr:2026-11-02'))?.cancelled).toBeNull());
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

describe('Today on phone', () => {
  const day = async (w: Writer) => {
    await task(w, 't1', 'Write the report');
    await block(w, 'b1', 't1', '09:00', '10:00');
    await task(w, 't2', 'Paint the fence');
    await block(w, 'b2', 't2', '15:00', '16:00');
  };

  it('in the morning, selects the next block when it starts within the hour, so Start early shows without a popup', async () => {
    const t = await open(day, { layout: 'phone', now: at('08:20') });
    const card = await raisedCard();
    expect(card).toHaveTextContent('Next in 40 min, 9am to 10am');
    expect(screen.getByRole('heading', { name: 'Next: Write the report, at 9am' })).toBeInTheDocument();
    expect(screen.getByText('Free until 9am')).toBeVisible();
    await userEvent.click(within(card).getByRole('button', { name: 'Start early' }));
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'b1'))?.started_at).toBeTruthy());
  });

  it('two hours before the next block, nothing is selected, and the next block says Next on itself', async () => {
    await open(day, { layout: 'phone', now: at('07:00') });
    const next = await screen.findByRole('slider', { name: /^Write the report, 9am to 10am/ });
    expect(next).toHaveTextContent(/^Next/);
    expect(document.querySelector('.cev.raised')).toBeNull();
  });

  it('folds the hours before the day opens into one row that says what it holds; it stays open until Today is tapped again', async () => {
    const t = await open(
      async (w) => {
        await day(w);
        await task(w, 't3', 'Rake the leaves');
        await block(w, 'b3', 't3', '11:00', '12:00');
        await w.create('block_outcome', { result: 'done', answered_at: at('12:00') }, outcomeId('b3'));
      },
      { layout: 'phone' },
    );
    // At 2pm the 3pm block is selected, starting within the hour, so the day opens at 2pm; the 9am block, passed over
    // for a later answer, still asks.
    const earlier = await screen.findByRole('button', { name: 'Earlier, 7am to 2pm, 2 blocks, 1 to answer', expanded: false });
    expect(earlier).toHaveTextContent('Earlier, 7am to 2pm · 2 blocks · 1 to answer');
    expect(screen.queryByRole('button', { name: /^Write the report, 9am to 10am/ })).toBeNull();
    await userEvent.click(earlier);
    expect(earlier).toHaveAttribute('aria-expanded', 'true');
    const morning = await screen.findByRole('button', { name: /^Write the report, 9am to 10am/ });
    await userEvent.click(morning);
    expect(await raisedCard()).toHaveTextContent('How did it go?');
    // Tapping Today again goes back to where the day opens, folded, with the selection Today picks.
    act(() => t.nav().selectTab('today'));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Earlier, 7am to 2pm/ })).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.queryByRole('button', { name: /^Write the report, 9am to 10am/ })).toBeNull();
    expect(await raisedCard()).toHaveTextContent('Paint the fence');
  });

  it('a hold on the raised card lifts its block to move it, and letting go opens nothing', async () => {
    const t = await open(
      async (w) => {
        await day(w);
        await w.create('block_outcome', { result: 'done', answered_at: at('10:00') }, outcomeId('b1'));
      },
      { layout: 'phone', now: at('14:30') },
    );
    // The 3pm block, selected as it starts within the hour.
    const card = await raisedCard();
    holdDown(card, { clientY: 300, pointerType: 'touch' });
    fireEvent.pointerMove(window, { clientY: 300 + dayPx(30, 'phone') });
    fireEvent.pointerUp(window, { clientY: 300 + dayPx(30, 'phone') });
    // The click that comes with letting go lands on the block, which has moved under the finger.
    fireEvent.click(screen.getByRole('slider', { name: /^Paint the fence/ }));
    expect(await screen.findByText('Paint the fence is now 3:30pm to 4:30pm.')).toBeVisible();
    expect(await getRecord(t.db, 'time_block', 'b2')).toMatchObject({ start: at('15:30') });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("shows what's due as chips above the day, each opening its tick, Find a time and Change date; today's notes are a chip too", async () => {
    const t = await open(
      async (w) => {
        await w.create('task', { kind: 'one_off', title: 'Pay the electricity bill', estimate_min: 15, schedule: { type: 'once', from: DAY } }, 'o1');
        await w.create('memo', { title: 'Gate code 4417', saved_on: DAY, show_on: DAY }, 'note:n1');
      },
      { layout: 'phone' },
    );
    const due = await screen.findByRole('group', { name: 'Due today' });
    expect(screen.queryByRole('heading', { name: 'One offs today' })).toBeNull();
    await userEvent.click(within(due).getByRole('button', { name: 'Pay the electricity bill, one off due today' }));
    const sheet = await dialog('Pay the electricity bill');
    expect(within(sheet).getByRole('button', { name: 'Find a time for Pay the electricity bill' })).toBeVisible();
    expect(within(sheet).getByRole('button', { name: /^Change date/ })).toBeVisible();
    await userEvent.click(within(sheet).getByRole('checkbox'));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 'o1'))?.done_at).toBeTruthy());
    await userEvent.keyboard('{Escape}');
    await userEvent.click(await within(due).findByRole('button', { name: '1 note' }));
    expect(within(await dialog('Notes for today')).getByText('Gate code 4417')).toBeVisible();
  });

  it("in the evening of a planned day, with nothing left, the Done line leads; through the day it isn't there", async () => {
    const morning = async (w: Writer) => {
      await day(w);
      await w.create('block_outcome', { result: 'done', answered_at: at('10:00') }, outcomeId('b1'));
    };
    await open(morning, { layout: 'phone' });
    await screen.findByRole('region', { name: "Today's timeline" });
    expect(screen.queryByRole('button', { name: /^Done/ })).toBeNull();
    cleanup();
    const answered = async (w: Writer) => {
      await morning(w);
      await w.create('block_outcome', { result: 'done', answered_at: at('16:00') }, outcomeId('b2'));
    };
    await open(answered, { layout: 'phone', now: at('20:30') });
    expect(await screen.findByRole('button', { name: /^Done/ })).toHaveClass('doneline');
  });
});

describe("Today on phone, with the week's strip over the day", () => {
  const WED = '2026-11-04';
  const week = async (w: Writer) => {
    await w.create('project', { title: 'Finish the essay', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p');
    await task(w, 't1', 'Write the report');
    await block(w, 'b1', 't1', '16:00', '17:00');
    await task(w, 't2', 'Paint the fence');
    await w.create('time_block', { task_id: 't2', start: at('09:00', WED), end: at('10:00', WED), tz: ZONE }, 'b2');
  };
  const strip = () => screen.findByRole('group', { name: 'Choose a day' });
  const heading = (name: string) => screen.findByRole('heading', { level: 1, name });

  it('a day tapped on the strip shows under its name, the arrows go to other weeks, and Today comes back', async () => {
    await open(week, { layout: 'phone' });
    await heading('Today');
    expect(within(await strip()).getByRole('button', { name: /^Mon Nov 2/ })).toHaveAttribute('aria-pressed', 'true');
    // Under each day, its hours planned.
    expect(within(await strip()).getByRole('button', { name: /^Wed Nov 4.*1h planned/ })).toBeVisible();
    // Folded away only once the day scrolls: until then the seven days are what's reached, not the slim bar.
    expect(screen.queryByRole('button', { name: /Show the week$/ })).toBeNull();

    await userEvent.click(within(await strip()).getByRole('button', { name: /^Wed Nov 4/ }));
    expect((await heading('Wednesday')).nextElementSibling).toHaveTextContent('Nov 4');
    expect(await screen.findByRole('slider', { name: /^Paint the fence, 9am to 10am/ })).toBeVisible();
    // Today's own rows and its block stay with today.
    expect(screen.queryByRole('slider', { name: /^Write the report/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    await heading('Today');
    expect(await screen.findByRole('slider', { name: /^Write the report, 4pm to 5pm/ })).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Next week' }));
    await heading('Monday');
    expect(screen.getByText('Next week')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    await heading('Today');
    expect(screen.getByText('This week')).toBeVisible();
  });

  // The week's cards: one for any day, one dated Tuesday and one dated Thursday; and one not done this morning, which
  // needs a new time.
  const waiting = async (w: Writer) => {
    await week(w);
    await task(w, 't3', 'Read the notes', { estimate_min: 60 });
    await setWeekPick(w, DAY, 't3', 60);
    await w.create('task', { kind: 'one_off', title: 'Pay the bill', estimate_min: 15, schedule: { type: 'once', from: '2026-11-03' } }, 'o1');
    await w.create('task', { kind: 'one_off', title: 'Call the bank', estimate_min: 30, schedule: { type: 'once', from: '2026-11-05' } }, 'o2');
    await task(w, 't4', 'File the receipts', { estimate_min: 60 });
    await block(w, 'b4', 't4', '09:00', '10:00');
    await w.create('block_outcome', { result: 'not', answered_at: at('10:00') }, outcomeId('b4'));
  };

  it("the footer counts the week's To schedule, Needs a new time included, the same number as Plan's This week", async () => {
    await open(waiting, { layout: 'phone' });
    expect(await screen.findByRole('button', { name: '4 to schedule' })).toBeVisible();
    cleanup();
    await renderScreen('plan', { now: NOW, zone: ZONE, layout: 'phone', seed: async (w) => { await planned(w); await waiting(w); } });
    // The Plan page is a module of its own, loaded on its first render in a run.
    const card = await screen.findByRole('region', { name: 'This week' }, { timeout: 5000 });
    expect(within(card).getByText(/, 4 to schedule\.$/)).toBeVisible();
  });

  it("the footer's sheet lists the week's cards, the day shown first and then the other days in order, Needs a new time and all", async () => {
    await open(waiting, { layout: 'phone' });
    await userEvent.click(within(await strip()).getByRole('button', { name: /^Wed Nov 4/ }));
    await heading('Wednesday');
    await userEvent.click(await screen.findByRole('button', { name: '4 to schedule' }));
    const sheet = await dialog('To schedule');
    const sections = within(sheet).getAllByRole('region');
    expect(sections.map((s) => s.getAttribute('aria-label'))).toEqual(['Needs a new time', 'Waiting for Wednesday', 'Waiting for tomorrow', 'Waiting for Thursday']);
    expect(within(sections[0]!).getByText('File the receipts')).toBeVisible();
    expect(within(sections[1]!).getByRole('button', { name: /^Read the notes/ })).toBeVisible();
    expect(within(sections[2]!).getByRole('button', { name: /^Pay the bill/ })).toBeVisible();
    expect(within(sections[3]!).getByRole('button', { name: /^Call the bank/ })).toBeVisible();
  });

  it("another day's block is selected by a tap, and Choose a time… waits on the day, for the strip to carry to another day", async () => {
    const t = await open(week, { layout: 'phone' });
    await userEvent.click(within(await strip()).getByRole('button', { name: /^Wed Nov 4/ }));
    await userEvent.click(await screen.findByRole('slider', { name: /^Paint the fence, 9am to 10am/ }));
    await userEvent.click(await within(await raisedCard()).findByRole('button', { name: 'Move' }));
    await userEvent.click(within(await screen.findByRole('menu', { name: /^Move/ })).getByRole('menuitem', { name: 'Choose a time…' }));
    expect(await screen.findByText('Moving Paint the fence, 1h, from Wed 9am')).toBeVisible();
    await userEvent.click(within(await strip()).getByRole('button', { name: /^Thu Nov 5/ }));
    await heading('Thursday');
    await userEvent.click(screen.getByRole('button', { name: 'Move here' }));
    await waitFor(async () => expect(await getRecord(t.db, 'time_block', 'b2')).toMatchObject({ start: at('09:00', '2026-11-05'), end: at('10:00', '2026-11-05') }));
  });

  it("the footer's count opens one sheet of what's waiting for a time, with the week's cards for the day shown and Add a task", async () => {
    await open(
      async (w) => {
        await week(w);
        await task(w, 't3', 'Read the notes', { estimate_min: 60 });
        await setWeekPick(w, DAY, 't3', 60);
      },
      { layout: 'phone' },
    );
    await userEvent.click(await screen.findByRole('button', { name: '1 to schedule' }));
    const sheet = await dialog('To schedule');
    expect(within(within(sheet).getByRole('region', { name: 'Waiting for today' })).getByRole('button', { name: /^Read the notes/ })).toBeVisible();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Add a task' }));
    expect(await dialog('Add to this week')).toBeVisible();
  });

  it("the title's menu has the week's jobs: Edit this week's plan opens editing over the day, and analytics", async () => {
    const t = await open(week, { layout: 'phone' });
    await userEvent.click(await screen.findByRole('button', { name: 'View and week' }));
    const menu = await screen.findByRole('menu', { name: 'View and week' });
    expect(within(menu).getByRole('menuitem', { name: "See this week's analytics" })).toBeVisible();
    await userEvent.click(within(menu).getByRole('menuitem', { name: "Edit this week's plan" }));
    expect(await screen.findByRole('button', { name: 'Done editing' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'To schedule' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Done editing' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Done editing' })).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'View and week' }));
    await userEvent.click(within(await screen.findByRole('menu', { name: 'View and week' })).getByRole('menuitem', { name: "See this week's analytics" }));
    expect(t.nav().route).toMatchObject({ area: 'analytics', params: { week: DAY } });
  });

  it("in the evening, once the day's done and its open hours are over, it opens on tomorrow below Today's done", async () => {
    await open(
      async (w) => {
        await week(w);
        await w.create('block_outcome', { result: 'done', answered_at: at('17:00') }, outcomeId('b1'));
      },
      // Open hours run to 10pm unless changed.
      { layout: 'phone', now: at('22:15') },
    );
    await heading('Tomorrow');
    expect(screen.getByRole('button', { name: /^Done/ })).toHaveClass('doneline');
    expect(within(await strip()).getByRole('button', { name: /^Tue Nov 3/ })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Today' }));
    await heading('Today');
  });
});

describe("on phone, Week's tab is Today's strip, and Plan has the week's cards", () => {
  const week = async (w: Writer) => {
    await planned(w);
    await w.create('project', { title: 'Finish the essay', state: 'active', start: '2026-10-01', end: '2026-12-31' }, 'p');
    await task(w, 't1', 'Write the report');
    await block(w, 'b1', 't1', '16:00', '17:00');
    await task(w, 't3', 'Read the notes', { estimate_min: 60 });
    await setWeekPick(w, DAY, 't3', 60);
  };
  const main = () => screen.getByRole('navigation', { name: 'Main' });

  it("a link to Week opens Today on that week, with the same params: here, editing this week's plan", async () => {
    await renderApp({ layout: 'phone', now: NOW, zone: ZONE, seed: week, initial: { area: 'week', params: { edit: 'this' } } });
    expect(await screen.findByRole('button', { name: 'Done editing' })).toBeVisible();
    expect(within(main()).getByRole('button', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
    expect(within(main()).queryByRole('button', { name: 'Week' })).toBeNull();
  });

  it("Plan opens the Plan page with this week's and next week's cards, and Edit this week's plan goes to Today", async () => {
    await renderApp({ layout: 'phone', now: NOW, zone: ZONE, seed: week });
    await screen.findByRole('navigation', { name: 'Main' });
    await userEvent.click(within(main()).getByRole('button', { name: 'Plan' }));
    const thisWeek = await screen.findByRole('region', { name: 'This week' });
    expect(within(thisWeek).getByText('Nov 2 to Nov 8')).toBeVisible();
    expect(within(thisWeek).getByText('1h planned, 97h free, 1 to schedule.')).toBeVisible();
    expect(within(thisWeek).getByRole('button', { name: 'Schedule one at a time' })).toBeVisible();
    expect(within(thisWeek).getByRole('button', { name: "See this week's analytics" })).toBeVisible();
    expect(within(await screen.findByRole('region', { name: 'Next week' })).getByText('Not planned yet.')).toBeVisible();
    await userEvent.click(within(thisWeek).getByRole('button', { name: "Edit this week's plan" }));
    expect(await screen.findByRole('button', { name: 'Done editing' })).toBeVisible();
    expect(within(main()).getByRole('button', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
  });

  it('More no longer has a Plan row', async () => {
    await renderApp({ layout: 'phone', now: NOW, zone: ZONE, seed: week });
    await screen.findByRole('navigation', { name: 'Main' });
    await userEvent.click(within(main()).getByRole('button', { name: 'More' }));
    expect(await screen.findByRole('button', { name: /^Notes/ })).toBeVisible();
    expect(screen.queryAllByRole('button', { name: /^Plan\b/ }).filter((b) => !main().contains(b))).toEqual([]);
  });
});
