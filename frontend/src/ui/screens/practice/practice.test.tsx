import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { localToInstant } from '../../../core/dates';
import { getRecord, outcomeId, weekPlanId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { AREAS } from '../../app/registry';
import type { Layout } from '../../app/registry';
import { renderScreen } from '../../app/testing';
import type { Harness } from '../../app/testing';

// Loaded once up front, as the app preloads them, so no test waits on a screen's first import.
beforeAll(() => Promise.all((['today', 'week', 'done', 'practice'] as const).map((area) => AREAS[area].Screen.preload?.())));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

// Monday, Nov 2 in Chicago. The harness clock reads 2pm there.
const ZONE = 'America/Chicago';
const MON = '2026-11-02';
const WED = '2026-11-04';
const at = (time: string, date = MON) => {
  const [h, m] = time.split(':').map(Number);
  return localToInstant(date, h! * 60 + (m ?? 0), ZONE);
};
const NOW = at('14:00');

async function piano(w: Writer) {
  await w.create('week_plan', { week_start: MON, finished_at: at('08:00') }, weekPlanId(MON));
  await w.create('objective', { title: 'Play music', state: 'active' }, 'g');
  await w.create('objective', { title: 'Keep fit', state: 'active' }, 'g2');
  await w.create('practice', { title: 'Piano practice', objective_id: 'g', target_min: 30, per: 'day', state: 'active', preferred_times: [960] }, 'pr');
  await w.create('memo', { title: 'Hanon exercise 1 first', saved_on: MON, home: { type: 'practice', id: 'pr' } }, 'n1');
}
const session = (w: Writer, id: string, from: string, to: string, date = MON, extra: Record<string, unknown> = {}) =>
  w.create('time_block', { practice_id: 'pr', start: at(from, date), end: at(to, date), tz: ZONE, ...extra }, id);
/** Later today, 4pm to 4:30pm. */
const later = async (w: Writer) => {
  await piano(w);
  await session(w, 'bp', '16:00', '16:30');
};

const open = (area: 'today' | 'week' | 'done', seed: (w: Writer) => Promise<unknown>, layout: Layout = 'desktop', now = NOW) =>
  renderScreen(area, { now, zone: ZONE, layout, seed });

/** The popup's sections top to bottom, as its body lays them out. */
function sections(popup: HTMLElement): string[] {
  return [...popup.querySelector('.taskpopbody')!.children].flatMap((el) => {
    if (el.matches('.blocksec')) return ['Time block'];
    if (el.matches('.taskacts')) return ['Actions'];
    if (el.querySelector('select[aria-label="Goal"]')) return ['Goal'];
    if (el.matches('.schedfields')) return ['Schedule'];
    if (el.matches('.homenotes')) return ['Notes'];
    if (el.matches('p')) return [el.textContent!];
    return [];
  });
}
const FIELDS = ['Goal', 'Schedule', 'Notes'];
const buttonsIn = (el: HTMLElement) => within(el).getAllByRole('button').map((b) => b.textContent);
const bar = (popup: HTMLElement) => buttonsIn(popup.querySelector<HTMLElement>('.taskpopbar')!);
const popupOf = async (name: string) => {
  const popup = await screen.findByRole('dialog', { name });
  expect(popup).toHaveClass('taskpop');
  return popup;
};
const sectionOf = (popup: HTMLElement) => within(popup).getByRole('region', { name: 'Time block' });

describe("a practice's popup", () => {
  for (const layout of ['desktop', 'phone'] as const) {
    it(`opens from a session on Today's calendar in the task popup's frame, with the block's section, then the practice's fields (${layout})`, async () => {
      await open('today', later, layout);
      const session = await screen.findByRole(layout === 'phone' ? 'slider' : 'button', { name: /^Piano practice, 4pm to 4:30pm/ });
      await userEvent.click(session);
      // On phone the first tap selects it, and the second opens it.
      if (layout === 'phone') await userEvent.click(session);
      const popup = await popupOf('Piano practice');
      expect(popup).toHaveAttribute('aria-modal', 'true');
      await waitFor(() => expect(within(popup).getByRole('heading', { name: 'Piano practice' })).toHaveFocus());
      expect(sections(popup)).toEqual(['Time block', ...FIELDS]);
      expect(buttonsIn(sectionOf(popup))).toEqual(['Start now', 'Mark done', 'Move…', 'Take off calendar', 'Change its set times']);
      expect(within(sectionOf(popup)).getByText('Mon Nov 2, 4pm to 4:30pm')).toBeVisible();
      expect(within(popup).getByLabelText('Goal')).toHaveDisplayValue('Play music');
      expect(bar(popup)).toEqual(['End practice', 'Cancel', 'Save']);
      expect(within(popup).queryByRole('button', { name: 'Close' }) === null).toBe(layout === 'phone');
    });
  }

  it('Take off calendar says first what it does and for how long, and Change its set times goes to the schedule', async () => {
    const t = await open('today', later);
    await userEvent.click(await screen.findByRole('button', { name: /^Piano practice, 4pm to 4:30pm/ }));
    const popup = await popupOf('Piano practice');
    const section = sectionOf(popup);
    expect(within(section).getByText("Taken off, it waits in To schedule for another time today. Next Monday it's back at 4pm.")).toBeVisible();
    await userEvent.click(within(section).getByRole('button', { name: 'Change its set times' }));
    expect(popup.querySelector('.schedfields')).toContainElement(document.activeElement as HTMLElement);
    await userEvent.click(within(section).getByRole('button', { name: 'Take off calendar' }));
    expect(await screen.findByText("Took Piano practice off Mon 4pm. It's in To schedule.")).toBeVisible();
    await waitFor(async () => expect((await getRecord(t.db, 'time_block', 'bp'))?.cancelled).toBe(true));
  });

  it("opens the same from Today's list, rather than in place", async () => {
    await open('today', later);
    await userEvent.click(await screen.findByRole('button', { name: 'List' }));
    const row = screen.getByRole('button', { name: /^4pm to 4:30pm\s*Piano practice/ });
    expect(row).toHaveAttribute('aria-haspopup', 'dialog');
    await userEvent.click(row);
    const popup = await popupOf('Piano practice');
    expect(sections(popup)).toEqual(['Time block', ...FIELDS]);
  });

  it('opens the same from Week on desktop, and while editing too', async () => {
    await open('week', async (w) => {
      await piano(w);
      await session(w, 'bw', '07:00', '07:30', WED);
    });
    await userEvent.click(await screen.findByRole('button', { name: /^Piano practice, Wed Nov 4, 7am to 7:30am/ }));
    let popup = await popupOf('Piano practice');
    expect(sections(popup)).toEqual(['Time block', ...FIELDS]);
    expect(buttonsIn(sectionOf(popup))).toEqual(['Move…', 'Take off calendar', 'Change its set times']);
    await userEvent.click(within(popup).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await userEvent.click(screen.getByRole('button', { name: "Edit this week's plan" }));
    screen.getByRole('group', { name: /^Piano practice/ }).focus();
    await userEvent.keyboard('{Enter}');
    popup = await popupOf('Piano practice');
    expect(sections(popup)).toEqual(['Time block', ...FIELDS]);
  });

  it("opens the same from another day on phone's Today, where the block's section has its length", async () => {
    await open(
      'today',
      async (w) => {
        await piano(w);
        await session(w, 'bw', '07:00', '07:30', WED);
      },
      'phone',
    );
    await userEvent.click(within(await screen.findByRole('group', { name: 'Choose a day' }, { timeout: 5000 })).getAllByRole('button')[2]!);
    // A first tap selects it, and a second opens it.
    const block = await screen.findByRole('slider', { name: /^Piano practice, 7am to 7:30am/ });
    await userEvent.click(block);
    await userEvent.click(block);
    const popup = await popupOf('Piano practice');
    expect(sections(popup)).toEqual(['Time block', ...FIELDS]);
    expect(within(sectionOf(popup)).getByRole('slider', { name: 'Length' })).toHaveAttribute('aria-valuetext', '30m');
    expect(buttonsIn(sectionOf(popup))).toEqual(['Move…', 'Take off calendar', 'Change its set times']);
  });

  it('opens from its name on the Now card, with the session under way', async () => {
    await open('today', async (w) => {
      await piano(w);
      await session(w, 'bn', '13:45', '14:30');
    });
    const now = await screen.findByRole('region', { name: 'Current block' });
    await userEvent.click(within(now).getByRole('button', { name: 'Piano practice' }));
    const popup = await popupOf('Piano practice');
    expect(sections(popup)).toEqual(['Time block', ...FIELDS]);
    expect(buttonsIn(sectionOf(popup))).toEqual(['Start', 'Mark done']);
  });

  it('opens from its name in Done, with how the session went', async () => {
    await open(
      'done',
      async (w) => {
        await piano(w);
        await session(w, 'bd', '09:00', '09:30');
        await w.create('block_outcome', { result: 'done', logged_min: 30, answered_at: at('09:30') }, outcomeId('bd'));
      },
      'phone',
    );
    await userEvent.click(within(await screen.findByRole('region', { name: 'Time worked' })).getByRole('button', { name: 'Piano practice' }));
    const popup = await popupOf('Piano practice');
    expect(sections(popup)).toEqual(['Time block', ...FIELDS]);
    expect(within(sectionOf(popup)).getByText('Done')).toBeVisible();
  });

  it('opens from its name in To schedule with no block, where its actions are Pause practice, with Undo', async () => {
    const t = await open('today', piano);
    await userEvent.click(await screen.findByRole('button', { name: /^Piano practice, Practice, .*to schedule$/ }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Piano practice' })).getByRole('button', { name: 'Piano practice' }));
    const popup = await popupOf('Piano practice');
    expect(sections(popup)).toEqual(['Actions', ...FIELDS]);
    await userEvent.click(within(popup).getByRole('button', { name: 'Pause practice' }));
    expect(await screen.findByText('Paused Piano practice.')).toBeVisible();
    await waitFor(async () => expect((await getRecord(t.db, 'practice', 'pr'))?.state).toBe('paused'));
    expect(await within(popup).findByRole('button', { name: 'Resume practice' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'practice', 'pr'))?.state).toBe('active'));
  });

  it("opens from a session that ended, which asks on itself on phone, and its section asks how it went in a practice's words", async () => {
    const t = await open(
      'today',
      async (w) => {
        await piano(w);
        await session(w, 'bg', '13:00', '13:30');
      },
      'phone',
    );
    // Selected as Today opens, within its own times until a tap grows it with its three answers; a second tap on it
    // opens its popup.
    const ended = await screen.findByRole('button', { name: /^Piano practice, 1pm to 1:30pm, Practice\./ });
    expect(screen.queryByRole('dialog', { name: 'Block finished' })).toBeNull();
    await userEvent.click(ended);
    await waitFor(() => expect(ended).toHaveAccessibleName(/ Selected\.$/));
    await userEvent.click(ended);
    const popup = await popupOf('Piano practice');
    expect(sections(popup)).toEqual(['Time block', ...FIELDS]);
    const asks = within(popup).getByRole('group', { name: 'How did it go?' });
    expect(buttonsIn(asks)).toEqual(['Did it', 'Some', 'Skipped']);
    // Some asks how much was done, from half its length, as the prompt does.
    await userEvent.click(within(asks).getByRole('button', { name: 'Some' }));
    await userEvent.click(within(popup).getByRole('button', { name: 'Log 15m' }));
    // A practice logs the time it got, as the prompt's Partly does.
    await waitFor(async () => expect(await getRecord(t.db, 'block_outcome', outcomeId('bg'))).toMatchObject({ result: 'done', logged_min: 15 }));
    expect(await screen.findByText('Piano practice: logged 15m.')).toBeVisible();
  });

  it('saves its name, goal and schedule together, with Undo, and Cancel drops them', async () => {
    const t = await open('today', later);
    await userEvent.click(await screen.findByRole('button', { name: /^Piano practice, 4pm to 4:30pm/ }));
    let popup = await popupOf('Piano practice');
    await userEvent.click(within(popup).getByRole('button', { name: 'Rename Piano practice' }));
    await userEvent.clear(within(popup).getByLabelText('Name'));
    await userEvent.type(within(popup).getByLabelText('Name'), 'Scales');
    await userEvent.click(within(popup).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await getRecord(t.db, 'practice', 'pr'))?.title).toBe('Piano practice');

    await userEvent.click(screen.getByRole('button', { name: /^Piano practice, 4pm to 4:30pm/ }));
    popup = await popupOf('Piano practice');
    await userEvent.click(within(popup).getByRole('button', { name: 'Rename Piano practice' }));
    await userEvent.clear(within(popup).getByLabelText('Name'));
    await userEvent.type(within(popup).getByLabelText('Name'), 'Scales');
    await userEvent.selectOptions(within(popup).getByLabelText('Goal'), 'Keep fit');
    fireEvent.change(within(popup).getByRole('slider', { name: 'Each session' }), { target: { value: '45' } });
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await getRecord(t.db, 'practice', 'pr')).toMatchObject({ title: 'Scales', objective_id: 'g2', target_min: 45 });
    expect(screen.getByText(/^Saved Scales: /)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await getRecord(t.db, 'practice', 'pr')).toMatchObject({ title: 'Piano practice', objective_id: 'g', target_min: 30 }));
  });

  it('with changes, Esc keeps it open and says so', async () => {
    await open('today', later);
    await userEvent.click(await screen.findByRole('button', { name: /^Piano practice, 4pm to 4:30pm/ }));
    const popup = await popupOf('Piano practice');
    await userEvent.selectOptions(within(popup).getByLabelText('Goal'), 'Keep fit');
    await userEvent.keyboard('{Escape}');
    expect(within(popup).getByRole('alert')).toHaveTextContent("Your changes aren't saved. Save them, or Cancel to drop them.");
    expect(screen.getByRole('dialog', { name: 'Piano practice' })).toBeVisible();
  });

  it('End practice ends it, closing the popup, with Undo', async () => {
    const t: Harness = await open('today', later);
    await userEvent.click(await screen.findByRole('button', { name: /^Piano practice, 4pm to 4:30pm/ }));
    await userEvent.click(within(await popupOf('Piano practice')).getByRole('button', { name: 'End practice' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Piano practice ended. Its history stays.')).toBeVisible();
    expect((await getRecord(t.db, 'practice', 'pr'))?.state).toBe('ended');
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'practice', 'pr'))?.state).toBe('active'));
  });
});

describe("a planning block's popup", () => {
  it('has the same frame, with Start planning, Move… and Remove from calendar, no fields, and Close', async () => {
    const t = await open('today', async (w) => {
      await piano(w);
      await w.create('task', { kind: 'planning', title: 'Plan the week of Nov 9', plans: ['week:2026-11-09'] }, 'planning:week:2026-11-09');
      await w.create('time_block', { task_id: 'planning:week:2026-11-09', start: at('19:00'), end: at('19:30'), tz: ZONE }, 'bpl');
    });
    await userEvent.click(await screen.findByRole('button', { name: /^Plan the week of Nov 9, 7pm to 7:30pm/ }));
    const popup = await popupOf('Plan the week of Nov 9');
    expect(sections(popup)).toEqual(['Time block', 'Done once you finish planning the week of Nov 9.']);
    expect(buttonsIn(sectionOf(popup))).toEqual(['Start planning', 'Move…', 'Remove from calendar']);
    expect(bar(popup)).toEqual(['Close']);
    // It's the app's own task: its name is only the heading.
    expect(within(popup).queryByRole('button', { name: /^Rename/ })).toBeNull();
    await userEvent.click(within(sectionOf(popup)).getByRole('button', { name: 'Start planning' }));
    await waitFor(() => expect(t.nav().flow).toMatchObject({ area: 'planning', params: { week: '2026-11-09' } }));
    expect((await getRecord(t.db, 'time_block', 'bpl'))?.started_at).toBeTruthy();
  });
});
