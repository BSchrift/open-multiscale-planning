import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRecord, getSettings, outcomeId, transact, updateSettings } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderApp, renderScreen } from '../../app/testing';
import type { Harness } from '../../app/testing';
import { EST_STEPS } from '../../components/EstimateSlider';
import { goToStep, readFlow, writeFlow } from './flowState';
import type { StepKey } from './flowState';
import { moreLine } from './moreLine';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// The harness clock is Monday Nov 2, 2026, 2pm in Chicago. Calendar quarters: this stretch is Oct 1 to Dec 31, the
// next Jan 1 to Mar 31. seed has planned this stretch; unplanned never has.
async function seed(w: Writer) {
  await unplanned(w);
  await updateSettings(w, { plan_stretch: { last_planned: '2026-10-01' } });
}

async function unplanned(w: Writer) {
  await w.create('objective', { title: 'Learn to bake bread', state: 'active' }, 'g1');
  await w.create('objective', { title: 'Run a 10k', state: 'active' }, 'g2');
  await w.create('objective', { title: 'Paint the house', state: 'active' }, 'g3');
  await w.create('project', { objective_id: 'g1', title: 'Bake a sourdough loaf', state: 'active', start: '2026-10-01', end: '2027-06-30' }, 'p1');
  await w.create('milestone', { project_id: 'p1', title: 'Make a starter', due: '2026-10-25' }, 'm1');
  await w.create('milestone', { project_id: 'p1', title: 'First loaf', due: '2027-01-20' }, 'm2');
  await w.create('milestone', { project_id: 'p1', title: 'Share a loaf', due: '2027-05-01' }, 'm3');
  const task = (id: string, project_id: string, milestone_id: string | null, title: string, estimate_min: number) =>
    w.create('task', { kind: 'project', project_id, milestone_id, title, estimate_min }, id);
  await task('t1', 'p1', 'm1', 'Feed the starter', 60);
  await task('t2', 'p1', 'm2', 'Shape the dough', 120);
  await task('t3', 'p1', 'm3', 'Invite friends', 60);
  await w.create('project', { objective_id: 'g2', title: 'Train for the race', state: 'active', start: '2026-09-01', end: '2026-10-20' }, 'p2');
  await task('t4', 'p2', null, 'Run three times a week', 180);
  await w.create('project', { objective_id: 'g2', title: 'Fix the bike', state: 'paused', start: '2026-09-01', end: '2027-06-30' }, 'p3');
  await w.create('task', { kind: 'one_off', title: 'Clean the windows', schedule: { type: 'once', from: '2027-01-10' }, next_due: '2027-01-10' }, 'o1');
  await w.create('task', { kind: 'one_off', title: 'Fix the gate', schedule: { type: 'once' } }, 'o2');
  await w.create('practice', { title: 'Stretch', target_min: 15, per: 'day', state: 'active', preferred_times: [420] }, 'pr1');
  // Two hours on the project last week: a recent pace of 30m a week.
  await w.create('time_block', { task_id: 't1', start: '2026-10-27T15:00:00.000Z', end: '2026-10-27T17:00:00.000Z', tz: 'America/Chicago' }, 'b1');
  await w.create('block_outcome', { result: 'done', answered_at: '2026-10-27T17:00:00.000Z' }, outcomeId('b1'));
}

const record = <T extends 'task' | 'milestone' | 'project' | 'practice'>(t: Harness, type: T, id: string) => getRecord(t.db, type, id);

const page = (layout: 'desktop' | 'phone', options: Parameters<typeof renderScreen>[1] = {}) =>
  renderScreen('plan', { layout, seed, ...options });

// Each step as a released app numbers it, so the key and the number agree, as the flow writes them.
const OLD: Record<StepKey, number> = { start: 0, goals: 0, practices: 1, projects: 2, inbox: 2, finish: 4 };

async function flow(layout: 'desktop' | 'phone', step: StepKey = 'goals', options: Parameters<typeof renderScreen>[1] = {}) {
  writeFlow({ begun: true, step: OLD[step], stepKey: step });
  const close = vi.fn();
  const t = await renderScreen('plan', { layout, seed, presentation: 'flow', close, ...options });
  return { t, close };
}

async function withInbox(w: Writer) {
  await seed(w);
  await w.create('task', { kind: 'inbox', title: 'Book flights to Osaka', estimate_min: 60 }, 'i1');
  await w.create('task', { kind: 'inbox', title: 'Call the tiler' }, 'i2');
}

const next = (layout: 'desktop' | 'phone', name = 'Continue') =>
  layout === 'phone' ? within(document.querySelector('.flowbot') as HTMLElement).getByRole('button', { name }) : screen.getByRole('button', { name });
const nextAsync = (layout: 'desktop' | 'phone', name: string) => waitFor(() => next(layout, name));
/** A step's tab, whatever done mark or count it carries. */
const tab = (name: string) =>
  within(screen.getByRole('navigation', { name: 'Planning steps' })).getByRole('button', { name: new RegExp(`^(\\d\\. )?${name}(,|$)`) });
const fitBar = () => screen.getByRole('region', { name: 'Does it fit?' });
const undoButton = (text: string) => screen.getByRole('button', { name: `Undo: ${text}` });
const finishButton = (layout: 'desktop' | 'phone') =>
  layout === 'phone' ? within(document.querySelector('.flowdock:not(.plundo)') as HTMLElement).getByRole('button', { name: 'Finish' }) : screen.getByRole('button', { name: 'Finish' });

describe('Plan page', () => {
  describe.each(['desktop', 'phone'] as const)('on %s', (layout) => {
    it('shows the cadence, this stretch and the plan for it', async () => {
      await page(layout);
      expect(await screen.findByRole('heading', { level: 1, name: 'Plan' })).toBeVisible();
      expect(screen.getByRole('heading', { name: 'Calendar quarters' })).toBeVisible();
      expect(screen.getByText('Plan the next stretch. Projects keep their own dates.')).toBeVisible();
      expect(screen.getByText('This stretch: Oct 1 to Dec 31. Next planning: Dec 24.')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Plan now' })).toBeVisible();
      const current = await screen.findByRole('region', { name: 'Current plan, Oct 1 to Dec 31' });
      expect(within(current).getByText('0 of 2 planned milestones met, 2 still open.')).toBeVisible();
      expect(within(current).getByText('Make a starter')).toBeVisible();
      expect(within(current).getByText('Was due Oct 25')).toBeVisible();
      expect(within(current).getByText('Was due Oct 20')).toBeVisible();
    });

    it('says when planning is due and opens the flow', async () => {
      const t = await page(layout, { now: '2026-12-26T18:00:00Z' });
      expect(await screen.findByText('This stretch: Oct 1 to Dec 31. Time to plan the next stretch.')).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Plan the next stretch' }));
      expect(t.nav().flow?.area).toBe('plan');
    });

    it('asks for a cadence when there is none, and Start planning sets one', async () => {
      const t = await page(layout, { seed: async (w) => (await seed(w), updateSettings(w, { plan_cadence: null })) });
      expect(await screen.findByRole('heading', { name: 'Set your planning cadence' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Plan without a cadence' })).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Start planning' }));
      await waitFor(async () => expect((await getSettings(t.db)).plan_cadence).toEqual({ every: 1, unit: 'quarters', anchor: '2026-11-03' }));
      expect(t.nav().flow?.area).toBe('plan');
    });

    it('changes cadence in place, from when this plan ends', async () => {
      const t = await page(layout);
      await userEvent.click(await screen.findByRole('button', { name: 'Change planning cadence' }));
      const editor = screen.getByRole('group', { name: 'Change planning cadence' });
      expect(within(editor).getByRole('radio', { name: 'When this plan ends, Dec 31' })).toBeChecked();
      await userEvent.selectOptions(within(editor).getByRole('combobox', { name: 'How often' }), 'every');
      fireEvent.change(within(editor).getByRole('slider', { name: 'Every' }), { target: { value: '6' } });
      await userEvent.selectOptions(within(editor).getByRole('combobox', { name: 'In' }), 'weeks');
      expect(within(editor).getByText('Next stretch: Jan 1 to Feb 11')).toBeVisible();
      await userEvent.click(within(editor).getByRole('button', { name: 'Save' }));
      expect(await screen.findByRole('heading', { name: 'Every 6 weeks' })).toBeVisible();
      expect(await screen.findByText('Your new cadence starts Jan 1.')).toBeVisible();
      const settings = await getSettings(t.db);
      expect(settings.plan_cadence).toEqual({ every: 6, unit: 'weeks', anchor: '2027-01-01' });
      expect(settings.plan_stretch.one_offs).toEqual([{ start: '2026-10-01', end: '2026-12-31' }]);
      expect(screen.getByText('This stretch: Oct 1 to Dec 31. Next planning: Dec 24.')).toBeVisible();
    });

    it('ends this plan now and starts again, straight into planning', async () => {
      const t = await page(layout);
      await userEvent.click(await screen.findByRole('button', { name: 'Change planning cadence' }));
      await userEvent.click(screen.getByRole('radio', { name: 'End this plan now and start again' }));
      expect(screen.getByText('New stretch: Nov 3 to Dec 31')).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'End this plan and start again' }));
      await waitFor(async () => expect((await getSettings(t.db)).plan_cadence?.anchor).toBe('2026-11-03'));
      expect(t.nav().flow?.area).toBe('plan');
    });

    it('turns the schedule off', async () => {
      const t = await page(layout, { params: { cadence: 'edit' } });
      await userEvent.click(await screen.findByRole('checkbox', { name: 'Remind me to plan on a schedule' }));
      expect(screen.getByText('No stretches or reminders. You can still plan whenever you like.')).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByRole('heading', { name: 'Set your planning cadence' })).toBeVisible();
      expect((await getSettings(t.db)).plan_cadence).toBeNull();
    });

    it('offers Continue planning once planning is under way', async () => {
      writeFlow({ begun: true, step: 2 });
      await page(layout);
      expect(await screen.findByRole('button', { name: 'Continue planning' })).toBeVisible();
    });

    it('never planned, asks at once for a first plan of this stretch from today', async () => {
      const t = await page(layout, { seed: unplanned });
      expect(await screen.findByText('This stretch: Nov 2 to Dec 31. Time to plan your first stretch.')).toBeVisible();
      expect(screen.getByText('Plan your first stretch. Projects keep their own dates.')).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Plan your first stretch' }));
      expect(t.nav().flow?.area).toBe('plan');
    });
  });
});

describe('the More line', () => {
  it('says what planning needs next', async () => {
    const t = await renderScreen('settings', { seed });
    expect(await moreLine(t.db, t.clock)).toBe('Next planning: Dec 24');
    t.clock.set('2026-12-26T18:00:00Z');
    expect(await moreLine(t.db, t.clock)).toBe('Time to plan the next stretch');
    writeFlow({ begun: true });
    expect(await moreLine(t.db, t.clock)).toBe('Planning under way');
    writeFlow({ begun: false });
    await transact(t.db, t.clock, (w) => updateSettings(w, { plan_cadence: null }));
    expect(await moreLine(t.db, t.clock)).toBe('Set your planning cadence');
  });

  it('asks for a first plan when never planned', async () => {
    const t = await renderScreen('settings', { seed: unplanned });
    expect(await moreLine(t.db, t.clock)).toBe('Time to plan your first stretch');
  });
});

describe('A first plan', () => {
  describe.each(['desktop', 'phone'] as const)('on %s', (layout) => {
    it('is for this stretch from today, with what was already in it, and only Finish saves its dates', async () => {
      const { t, close } = await flow(layout, 'goals', {
        seed: async (w) => (await unplanned(w), w.set('milestone', 'm3', { due: null, stretch: '2026-10-01' })),
      });
      expect(await screen.findByRole('heading', { level: 1, name: 'Plan your first stretch' })).toBeInTheDocument();
      // A first plan has no stretch behind it to look back on.
      expect(screen.getByRole('heading', { name: 'Step 1 of 5, Goals. Are these still your goals?' })).toBeVisible();
      expect(screen.queryByText(/milestones due in this time/)).toBeNull();
      expect(await screen.findByText('Your first stretch: Nov 2 to Dec 31')).toBeVisible();
      expect(readFlow().begunOn).toBe('2026-11-02');
      await userEvent.click(tab('Projects'));
      expect(await screen.findByRole('button', { name: 'Take milestone Share a loaf out of this plan' })).toBeVisible();
      // Opening it writes nothing, so a device behind on sync can't undo a plan finished on another.
      expect((await getSettings(t.db)).plan_stretch).toEqual({});
      expect((await record(t, 'milestone', 'm3'))?.stretch).toBe('2026-10-01');

      await userEvent.click(tab('Finish'));
      await userEvent.click(finishButton(layout));
      await waitFor(() => expect(close).toHaveBeenCalled());
      expect((await getSettings(t.db)).plan_stretch).toMatchObject({ last_planned: '2026-11-02', one_offs: [{ start: '2026-11-02', end: '2026-12-31' }] });
      expect((await record(t, 'milestone', 'm3'))?.stretch).toBe('2026-11-02');
    });

    it('continued on a later day, still starts the day planning began', async () => {
      writeFlow({ begunOn: '2026-10-30' });
      await flow(layout, 'goals', { seed: unplanned });
      expect(await screen.findByText('Your first stretch: Oct 30 to Dec 31')).toBeVisible();
      cleanup();
      // Begun on the stretch's own first day, it's that whole stretch.
      writeFlow({ begunOn: '2026-10-01' });
      await flow(layout, 'goals', { seed: unplanned });
      expect(await screen.findByText('Your first stretch: Oct 1 to Dec 31')).toBeVisible();
    });

    it('started late, is short, and planning the one after waits until the next day', async () => {
      const { t, close } = await flow(layout, 'finish', { seed: unplanned, now: '2026-12-26T18:00:00Z' });
      expect(await screen.findByRole('heading', { name: 'Step 5 of 5, Finish. Ready for Dec 26 to Dec 31' })).toBeVisible();
      expect(screen.getByText('Next planning: Dec 27.')).toBeVisible();
      await userEvent.click(finishButton(layout));
      await waitFor(() => expect(close).toHaveBeenCalled());
      expect(await moreLine(t.db, t.clock)).toBe('Next planning: Dec 27');
    });

    it('changes its dates with the same control, keeping today in it, and saves them with what was in this stretch', async () => {
      const { t } = await flow(layout, 'goals', {
        seed: async (w) => (await unplanned(w), w.set('milestone', 'm3', { due: null, stretch: '2026-10-01' })),
      });
      await userEvent.click(await screen.findByRole('button', { name: 'Change' }));
      fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-11-10' } });
      if (layout === 'phone') {
        // Its sheet keeps dates typed but not set.
        await userEvent.keyboard('{Escape}');
        expect(screen.getByRole('alert')).toHaveTextContent("These dates aren't set yet. Set them, or Cancel to drop them.");
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByLabelText('Starts')).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Change' }));
        fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-11-10' } });
      }
      await userEvent.click(screen.getByRole('button', { name: 'Set dates' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Start today or earlier.');
      fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-11-02' } });
      fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2027-03-31' } });
      await userEvent.click(screen.getByRole('button', { name: 'Set dates' }));
      expect(await screen.findByText('Your first stretch: Nov 2 to Mar 31')).toBeVisible();
      expect((await getSettings(t.db)).plan_stretch.one_offs).toEqual([{ start: '2026-11-02', end: '2027-03-31' }]);
      expect((await record(t, 'milestone', 'm3'))?.stretch).toBe('2026-11-02');
    });

    it('plans milestones and pace against it, then saves like any other', async () => {
      const { t, close } = await flow(layout, 'projects', { seed: unplanned });
      expect(await screen.findByRole('heading', { name: 'Step 3 of 5, Projects. What will you reach by Dec 31?' })).toBeVisible();
      expect(fitBar()).toHaveTextContent('About 0h planned, about 4h at your recent pace.');
      await userEvent.click(screen.getByRole('button', { name: 'Add milestone Share a loaf to this plan' }));
      expect(await screen.findByText('Added Share a loaf to this plan, by Dec 31.', { selector: ':not(.sr)' })).toBeVisible();
      expect(await record(t, 'milestone', 'm3')).toMatchObject({ due: null, stretch: '2026-11-02' });
      await userEvent.click(tab('Finish'));
      expect(await screen.findByRole('heading', { name: 'Step 5 of 5, Finish. Ready for Nov 2 to Dec 31' })).toBeVisible();
      expect(screen.getByText('Next planning: Dec 24.')).toBeVisible();
      await userEvent.click(finishButton(layout));
      await waitFor(() => expect(close).toHaveBeenCalled());
      expect((await getSettings(t.db)).plan_stretch).toMatchObject({ last_planned: '2026-11-02', one_offs: [{ start: '2026-11-02', end: '2026-12-31' }] });
      expect(await screen.findByText('Your plan for Nov 2 to Dec 31 is set.')).toBeVisible();
    });
  });
});

describe('Planning ahead', () => {
  describe.each(['desktop', 'phone'] as const)('on %s', (layout) => {
    it('has five steps, Goals to Finish, each heading saying where it is and each Continue what it means', async () => {
      await flow(layout);
      const steps = await screen.findByRole('navigation', { name: 'Planning steps' });
      const names = within(steps)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label'));
      expect(names).toEqual(
        layout === 'phone'
          ? ['Goals', 'Practices', 'Projects, 2 overdue', 'Inbox', 'Finish']
          : ['1. Goals', '2. Practices', '3. Projects, 2 overdue', '4. Inbox', '5. Finish'],
      );
      expect(within(steps).getByRole('button', { name: /Goals/ })).toHaveAttribute('aria-current', 'step');
      const walk = [
        ['Step 1 of 5, Goals. Are these still your goals?', 'Goals look right'],
        ['Step 2 of 5, Practices. Your practices', 'Practices look right'],
        ['Step 3 of 5, Projects. What will you reach by Mar 31?', 'Continue with 1 milestone'],
        ['Step 4 of 5, Inbox. Give each item a home', 'Continue to Finish'],
      ];
      for (const [heading, label] of walk) {
        await waitFor(() => expect(screen.getByRole('heading', { name: heading })).toHaveFocus());
        await userEvent.click(next(layout, label));
      }
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Step 5 of 5, Finish. Ready for Jan 1 to Mar 31' })).toHaveFocus());
      expect(next(layout, 'Finish and plan the week')).toBeVisible();
      expect(within(steps).getByRole('button', { name: layout === 'phone' ? 'Projects, done, 2 overdue' : '3. Projects, done, 2 overdue' })).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Edit goals' })).toBeNull();
    });

    it('marks a step done only once you continue from it, not when you open it', async () => {
      await flow(layout);
      const steps = await screen.findByRole('navigation', { name: 'Planning steps' });
      await userEvent.click(tab('Practices'));
      await userEvent.click(tab('Goals'));
      expect(within(steps).getByRole('button', { name: /Practices/ })).not.toHaveAccessibleName(/done/);
      await userEvent.click(next(layout, 'Goals look right'));
      expect(within(steps).getByRole('button', { name: /Goals/ })).toHaveAccessibleName(/^(1\. )?Goals, done$/);
      expect(within(steps).getByRole('button', { name: /Practices/ })).not.toHaveAccessibleName(/done/);
      expect(readFlow()).toMatchObject({ stepKey: 'practices', step: 1, done: ['goals'] });
    });

    it('puts each goal on a card with what it got this stretch, and a summary of how the stretch is going', async () => {
      await flow(layout, 'goals', { seed: async (w) => (await seed(w), updateSettings(w, { plan_stretch: { last_planned: '2026-10-01', last_note: 'Bake on Sundays' } })) });
      expect(await screen.findByText('Last time you wrote: Bake on Sundays')).toBeVisible();
      expect(await screen.findByText('0 of 1 milestones due in this time were met.')).toBeVisible();
      expect(screen.getByText('About 30m a week went to your goals.')).toBeVisible();
      const bread = screen.getByRole('region', { name: 'Learn to bake bread' });
      expect(within(bread).getByText('2h this stretch')).toBeVisible();
      expect(within(bread).getByText('Projects: Bake a sourdough loaf')).toBeVisible();
      expect(within(bread).getByText('1 project late')).toBeVisible();
      expect(within(bread).getByRole('button', { name: 'Add project to Learn to bake bread' })).toBeVisible();
      expect(within(bread).getByRole('button', { name: 'Add practice to Learn to bake bread' })).toBeVisible();
      expect(within(screen.getByRole('region', { name: 'Paint the house' })).getByText('No practices or projects')).toBeVisible();
      const loose = screen.getByRole('region', { name: 'No goal' });
      expect(within(loose).getByText('Stretch')).toBeVisible();
      expect(next(layout, 'Goals look right')).toBeVisible();
    });

    it.each([
      ['none was due yet', 'm1', '2026-12-20', 'No milestones were due in this time, but 1 was met early.'],
      ['some were due', 'm2', '2027-01-20', '0 of 1 milestones due in this time were met, and 1 more was met early.'],
    ])('counts a milestone met before its date when %s', async (_, id, due, line) => {
      await flow(layout, 'goals', { seed: async (w) => (await seed(w), w.set('milestone', id, { due, met_at: '2026-10-30T15:00:00.000Z' })) });
      expect(await screen.findByText(line)).toBeVisible();
    });

    it('adds and renames goals, puts one off until after this plan and archives another, each with Undo', async () => {
      const { t } = await flow(layout);
      await userEvent.click(await screen.findByRole('button', { name: '+ New goal' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'New goal' }), 'Bake for friends{Enter}');
      expect(await screen.findByRole('region', { name: 'Bake for friends' })).toBeVisible();
      expect(undoButton('Added goal Bake for friends.')).toBeVisible();

      await userEvent.click(screen.getByRole('button', { name: 'Rename Learn to bake bread' }));
      const name = screen.getByRole('textbox', { name: 'Goal name' });
      await userEvent.clear(name);
      await userEvent.type(name, 'Bake good bread{Enter}');
      expect(await screen.findByRole('region', { name: 'Bake good bread' })).toBeVisible();
      await userEvent.click(undoButton('Renamed Learn to bake bread to Bake good bread.'));
      expect(await screen.findByRole('region', { name: 'Learn to bake bread' })).toBeVisible();

      // Only a goal with nothing active under it can wait or go, as on the Goals page.
      expect(screen.queryByRole('button', { name: 'More for Learn to bake bread: Not now, Archive' })).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'More for Paint the house: Not now, Archive' }));
      await userEvent.click(within(screen.getByRole('dialog', { name: 'Paint the house' })).getByRole('button', { name: 'Not now, ask again Apr 1' }));
      await waitFor(async () => expect(await getRecord(t.db, 'objective', 'g3')).toMatchObject({ state: 'not_now', not_now_until: '2027-04-01' }));
      expect(screen.queryByRole('region', { name: 'Paint the house' })).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Not now (1)' }));
      await userEvent.click(screen.getByRole('button', { name: 'Restore Paint the house' }));
      expect(await screen.findByRole('region', { name: 'Paint the house' })).toBeVisible();
      expect((await getRecord(t.db, 'objective', 'g3'))?.state).toBe('active');

      await userEvent.click(screen.getByRole('button', { name: 'More for Paint the house: Not now, Archive' }));
      await userEvent.click(within(screen.getByRole('dialog', { name: 'Paint the house' })).getByRole('button', { name: 'Archive' }));
      await waitFor(async () => expect((await getRecord(t.db, 'objective', 'g3'))?.state).toBe('archived'));
      await userEvent.click(undoButton('Archived Paint the house.'));
      await waitFor(async () => expect((await getRecord(t.db, 'objective', 'g3'))?.state).toBe('active'));
    });

    it('asks what are your goals with none yet, with the field open, and Continue goes on without', async () => {
      const { t } = await flow(layout, 'goals', {
        seed: async (w) => {
          await updateSettings(w, { plan_stretch: { last_planned: '2026-10-01' } });
          await w.create('practice', { title: 'Stretch', target_min: 15, per: 'day', state: 'active' }, 'pr1');
        },
      });
      expect(await screen.findByRole('heading', { name: 'Step 1 of 5, Goals. What are your goals?' })).toBeVisible();
      expect(screen.getByText(/^A goal is something you want for years/)).toBeVisible();
      await userEvent.type(screen.getByRole('textbox', { name: 'New goal' }), 'Keep fit');
      await userEvent.click(screen.getByRole('button', { name: 'Add goal' }));
      expect(await screen.findByRole('region', { name: 'Keep fit' })).toBeVisible();
      // Linking the loose practice is one change, with Undo.
      await userEvent.click(screen.getByRole('button', { name: 'Give Stretch a goal' }));
      await userEvent.click(within(screen.getByRole('dialog', { name: 'Goal for Stretch' })).getByRole('button', { name: 'Keep fit' }));
      await waitFor(async () => expect((await record(t, 'practice', 'pr1'))?.objective_id).toBeTruthy());
      expect(undoButton('Stretch now under Keep fit.')).toBeVisible();
      // Its row has gone, and focus with it, so focus moves on to + New goal.
      await waitFor(() => expect(screen.getByRole('button', { name: '+ New goal' })).toHaveFocus());
      cleanup();
      await flow(layout, 'goals', { seed: (w) => updateSettings(w, { plan_stretch: { last_planned: '2026-10-01' } }) });
      expect(await screen.findByRole('textbox', { name: 'New goal' })).toBeVisible();
      expect(next(layout, 'Continue without goals')).toBeVisible();
    });

    it('adds a project under a goal from its card, ending with the stretch being planned, with Undo', async () => {
      const { t } = await flow(layout);
      await userEvent.click(await screen.findByRole('button', { name: 'Add project to Run a 10k' }));
      const form = screen.getByRole('form', { name: 'Add project' });
      expect(within(form).getByLabelText('Ends')).toHaveValue('2027-03-31');
      await userEvent.type(within(form).getByRole('textbox', { name: 'Name' }), 'Run a trail');
      await userEvent.click(within(form).getByRole('button', { name: 'Add project' }));
      const undo = await screen.findByRole('button', { name: 'Undo: Added project Run a trail, Nov 2 to Mar 31.' });
      const rows = await t.db.all<{ id: string }>("SELECT id FROM records WHERE type = 'project' AND json_extract(data, '$.title') = 'Run a trail'");
      expect(await record(t, 'project', rows[0]!.id)).toMatchObject({ objective_id: 'g2', end: '2027-03-31' });
      await userEvent.click(undo);
      await waitFor(async () => expect((await record(t, 'project', rows[0]!.id))?.deleted_at).toBeTruthy());
    });

    it('keeps a note on Finish and sets the next stretch dates from the top', async () => {
      const { t } = await flow(layout, 'finish');
      expect(await screen.findByText('Next stretch: Jan 1 to Mar 31')).toBeVisible();
      await userEvent.type(screen.getByRole('textbox', { name: 'Anything to do differently this stretch? (optional)' }), 'Fewer projects');
      await userEvent.click(screen.getByRole('button', { name: 'Change' }));
      fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2027-02-15' } });
      await userEvent.click(screen.getByRole('button', { name: 'Set dates' }));
      expect(await screen.findByText('Next stretch: Jan 1 to Feb 15')).toBeVisible();
      expect((await getSettings(t.db)).plan_stretch.one_offs).toEqual([{ start: '2027-01-01', end: '2027-02-15' }]);
      await userEvent.click(tab('Goals'));
      await userEvent.click(tab('Finish'));
      expect(await screen.findByRole('textbox', { name: 'Anything to do differently this stretch? (optional)' })).toHaveValue('Fewer projects');
    });

    it('shows each practice as a summary, and Edit opens its fields in place until Save or Cancel', async () => {
      const { t } = await flow(layout, 'practices');
      expect(await screen.findByRole('heading', { name: 'Step 2 of 5, Practices. Your practices' })).toBeVisible();
      expect(screen.getByText('Stretch')).toBeVisible();
      expect(screen.getByText('15m every day, around 7am')).toBeVisible();
      expect(screen.getByText('No goal')).toBeVisible();
      expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();

      await userEvent.click(screen.getByRole('button', { name: 'Edit Stretch' }));
      const editor = screen.getByRole('group', { name: 'Edit Stretch' });
      expect(editor).toHaveFocus();
      const name = within(editor).getByRole('textbox', { name: 'Name' });
      await userEvent.clear(name);
      await userEvent.type(name, 'Stretch and breathe');
      await userEvent.selectOptions(within(editor).getByRole('combobox', { name: 'Goal for Stretch' }), 'Run a 10k');
      // Pause acts at once; the fields wait for Save.
      await userEvent.click(within(editor).getByRole('button', { name: 'Pause' }));
      await waitFor(async () => expect((await record(t, 'practice', 'pr1'))?.state).toBe('paused'));
      expect(await record(t, 'practice', 'pr1')).toMatchObject({ title: 'Stretch' });
      expect((await record(t, 'practice', 'pr1'))?.objective_id ?? null).toBeNull();
      await userEvent.click(within(editor).getByRole('button', { name: 'Save' }));

      expect(await screen.findByText('Saved Stretch and breathe.', { selector: ':not(.sr)' })).toBeVisible();
      expect(await record(t, 'practice', 'pr1')).toMatchObject({ title: 'Stretch and breathe', objective_id: 'g2' });
      expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
      expect(screen.getByText('Stretch and breathe')).toBeVisible();
      expect(screen.getByText('Goal: Run a 10k')).toBeVisible();
      expect(screen.getByText('Paused')).toBeVisible();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Edit Stretch and breathe' })).toHaveFocus());

      // Esc closes it with nothing changed; with changes it stays open and says so, and Cancel drops them.
      await userEvent.click(screen.getByRole('button', { name: 'Edit Stretch and breathe' }));
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('group', { name: 'Edit Stretch and breathe' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Edit Stretch and breathe' })).toHaveFocus();
      await userEvent.click(screen.getByRole('button', { name: 'Edit Stretch and breathe' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), ' slowly{Escape}');
      expect(screen.getByRole('alert')).toHaveTextContent("Your changes aren't saved. Save them, or Cancel to drop them.");
      expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('group', { name: 'Edit Stretch and breathe' })).toBeNull();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Edit Stretch and breathe' })).toHaveFocus());
      expect((await record(t, 'practice', 'pr1'))?.title).toBe('Stretch and breathe');

      // The save has its Undo with the rest of planning's changes.
      await userEvent.click(undoButton('Saved Stretch and breathe.'));
      await waitFor(async () => expect((await record(t, 'practice', 'pr1'))?.title).toBe('Stretch'));
      expect((await record(t, 'practice', 'pr1'))?.objective_id ?? null).toBeNull();
    });

    it('with one practice open and changed, Edit on another keeps it open and says so', async () => {
      await flow(layout, 'practices', {
        seed: async (w) => {
          await seed(w);
          await w.create('practice', { title: 'Read', target_min: 20, per: 'day', state: 'active' }, 'pr2');
        },
      });
      await userEvent.click(await screen.findByRole('button', { name: 'Edit Stretch' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), ' daily');
      await userEvent.click(screen.getByRole('button', { name: 'Edit Read' }));
      expect(screen.getByRole('group', { name: 'Edit Stretch' })).toBeVisible();
      expect(screen.getByRole('alert')).toHaveTextContent("Your changes aren't saved.");
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await userEvent.click(screen.getByRole('button', { name: 'Edit Read' }));
      expect(screen.getByRole('group', { name: 'Edit Read' })).toHaveFocus();
    });

    it('makes a new goal beside a practice’s goal and links it in one write, with Undo', async () => {
      const { t } = await flow(layout, 'practices');
      await userEvent.click(await screen.findByRole('button', { name: 'Edit Stretch' }));
      const editor = screen.getByRole('group', { name: 'Edit Stretch' });
      await userEvent.click(within(editor).getByRole('button', { name: 'New goal for Stretch' }));
      await userEvent.type(within(editor).getByRole('textbox', { name: 'New goal name' }), 'Keep fit{Enter}');
      expect(await screen.findByText('Added goal Keep fit and linked Stretch.', { selector: ':not(.sr)' })).toBeVisible();
      const goal = (await record(t, 'practice', 'pr1'))?.objective_id;
      expect(await getRecord(t.db, 'objective', goal!)).toMatchObject({ title: 'Keep fit', state: 'active' });
      expect(within(editor).getByRole('combobox', { name: 'Goal for Stretch' })).toHaveValue(goal);
      await userEvent.click(undoButton('Added goal Keep fit and linked Stretch.'));
      await waitFor(async () => expect((await record(t, 'practice', 'pr1'))?.objective_id).toBeNull());
      expect((await getRecord(t.db, 'objective', goal!))?.deleted_at).toBeTruthy();
    });

    it('a new schedule shows in its summary on Save, and Cancel drops it', async () => {
      const { t } = await flow(layout, 'practices');
      await userEvent.click(await screen.findByRole('button', { name: 'Edit Stretch' }));
      let editor = screen.getByRole('group', { name: 'Edit Stretch' });
      await userEvent.click(within(editor).getByRole('button', { name: 'Weekdays' }));
      fireEvent.change(within(editor).getByLabelText('Usual time'), { target: { value: '18:30' } });
      await userEvent.click(within(editor).getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('15m every weekday, around 6:30pm', { selector: ':not(.sr)' })).toBeVisible();
      expect(await record(t, 'practice', 'pr1')).toMatchObject({ days: [0, 1, 2, 3, 4], preferred_times: [1110] });

      await userEvent.click(screen.getByRole('button', { name: 'Edit Stretch' }));
      editor = screen.getByRole('group', { name: 'Edit Stretch' });
      await userEvent.click(within(editor).getByRole('button', { name: 'Weekends' }));
      await userEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
      expect(screen.getByText('15m every weekday, around 6:30pm', { selector: ':not(.sr)' })).toBeVisible();
      expect((await record(t, 'practice', 'pr1'))?.days).toEqual([0, 1, 2, 3, 4]);
    });

    it('ending a practice in its editor takes it off the list, with focus on Add practice', async () => {
      const { t } = await flow(layout, 'practices');
      await userEvent.click(await screen.findByRole('button', { name: 'Edit Stretch' }));
      await userEvent.click(screen.getByRole('button', { name: 'End practice' }));
      await waitFor(async () => expect((await record(t, 'practice', 'pr1'))?.state).toBe('ended'));
      expect(await screen.findByText('No practices yet.')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Add practice' })).toHaveFocus();
    });

    it('Add practice closes the form and shows the new practice as a summary, with focus on its Edit', async () => {
      await flow(layout, 'practices');
      const add = await screen.findByRole('button', { name: 'Add practice' });
      await userEvent.click(add);
      expect(screen.getByRole('form', { name: 'Add practice' })).toBeVisible();
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('form', { name: 'Add practice' })).toBeNull();
      expect(add).toHaveFocus();

      await userEvent.click(add);
      const form = screen.getByRole('form', { name: 'Add practice' });
      await userEvent.type(within(form).getByRole('textbox', { name: 'Name' }), 'Read about baking');
      await userEvent.click(within(form).getByRole('button', { name: 'Add practice' }));
      await waitFor(() => expect(screen.queryByRole('form', { name: 'Add practice' })).toBeNull());
      expect(await screen.findByText('Read about baking')).toBeVisible();
      expect(screen.getByText('30m every day, around 7am')).toBeVisible();
      expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Edit Read about baking' })).toHaveFocus());
      expect(undoButton('Added practice Read about baking.')).toBeVisible();
    });

    it('shows every project on one timeline, with what is overdue first', async () => {
      await flow(layout, 'projects');
      expect(await screen.findByRole('heading', { name: 'Step 3 of 5, Projects. What will you reach by Mar 31?' })).toBeVisible();
      expect(fitBar()).toHaveTextContent('About 2h planned, about 6h at your recent pace.');
      const overdue = screen.getByRole('region', { name: 'Overdue (2)' });
      expect(within(overdue).getByRole('heading', { name: 'Overdue (2)' })).toBeVisible();
      expect(within(overdue).getByText('Project ended Oct 20, 3h left.')).toBeVisible();
      expect(within(overdue).getByText("Bake a sourdough loaf. Was due Oct 25 and isn't marked done.")).toBeVisible();
      expect(screen.queryByRole('region', { name: 'Needs a call' })).toBeNull();
      const projects = screen.getByRole('region', { name: 'Projects in this plan' });
      expect(within(projects).getByRole('button', { name: 'Bake a sourdough loaf: Pause, Finish, Drop' })).toBeVisible();
      expect(within(projects).queryByRole('button', { name: 'Train for the race: Pause, Finish, Drop' })).toBeNull();
      expect(within(projects).getByRole('button', { name: 'Take milestone First loaf out of this plan' })).toHaveAttribute('aria-pressed', 'true');
      expect(within(projects).getByRole('button', { name: 'Add milestone Share a loaf to this plan' })).toHaveAttribute('aria-pressed', 'false');
      expect(within(projects).getByRole('button', { name: 'Milestone: First loaf, Jan 20, in this plan. Change its date' })).toBeVisible();
      expect(within(projects).getByRole('button', { name: 'Paused or starting later (1)' })).toHaveAttribute('aria-expanded', 'false');
      expect(within(projects).getByRole('button', { name: 'Goal for Bake a sourdough loaf: Learn to bake bread. Change' })).toBeVisible();
      expect(next(layout, 'Continue with 1 milestone')).toBeVisible();
      const oneOffs = screen.getByRole('region', { name: 'One offs in this plan' });
      expect(within(oneOffs).getByRole('button', { name: 'One off: Clean the windows, Jan 10. Change its date' })).toBeVisible();
      expect(within(oneOffs).getByRole('button', { name: 'No date yet (1)' })).toBeVisible();
    });

    it("changes a project's goal from the timeline, or makes a new goal for it, each with Undo", async () => {
      const { t } = await flow(layout, 'projects');
      await userEvent.click(await screen.findByRole('button', { name: 'Goal for Bake a sourdough loaf: Learn to bake bread. Change' }));
      let picker = screen.getByRole('dialog', { name: 'Goal for Bake a sourdough loaf' });
      expect(within(picker).getByRole('button', { name: 'Learn to bake bread' })).toHaveAttribute('aria-pressed', 'true');
      await userEvent.click(within(picker).getByRole('button', { name: 'No goal' }));
      await waitFor(async () => expect((await record(t, 'project', 'p1'))?.objective_id).toBeNull());
      expect(await screen.findByRole('button', { name: 'Goal for Bake a sourdough loaf: No goal. Change' })).toBeVisible();
      await userEvent.click(undoButton('Bake a sourdough loaf has no goal now.'));
      await waitFor(async () => expect((await record(t, 'project', 'p1'))?.objective_id).toBe('g1'));

      await userEvent.click(await screen.findByRole('button', { name: 'Goal for Bake a sourdough loaf: Learn to bake bread. Change' }));
      picker = screen.getByRole('dialog', { name: 'Goal for Bake a sourdough loaf' });
      await userEvent.click(within(picker).getByRole('button', { name: '+ New goal' }));
      await userEvent.type(within(picker).getByRole('textbox', { name: 'New goal name' }), 'Feed friends');
      await userEvent.click(within(picker).getByRole('button', { name: 'Add and link' }));
      expect(await screen.findByRole('button', { name: 'Goal for Bake a sourdough loaf: Feed friends. Change' })).toBeVisible();
      await userEvent.click(undoButton('Added goal Feed friends and linked Bake a sourdough loaf.'));
      await waitFor(async () => expect((await record(t, 'project', 'p1'))?.objective_id).toBe('g1'));
    });

    it('adds a project at the end of the list, ending with the stretch being planned', async () => {
      const { t } = await flow(layout, 'projects');
      await userEvent.click(await screen.findByRole('button', { name: '+ Add project' }));
      const form = screen.getByRole('form', { name: 'Add project' });
      expect(within(form).getByLabelText('Ends')).toHaveValue('2027-03-31');
      await userEvent.type(within(form).getByRole('textbox', { name: 'Name' }), 'Bake rye');
      await userEvent.click(within(form).getByRole('button', { name: 'Add project' }));
      expect(await screen.findByRole('button', { name: 'Bake rye: Pause, Finish, Drop' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Goal for Bake rye: No goal. Change' })).toBeVisible();
      expect(undoButton('Added project Bake rye, Nov 2 to Mar 31.')).toBeVisible();
      const rows = await t.db.all<{ id: string }>("SELECT id FROM records WHERE type = 'project' AND json_extract(data, '$.title') = 'Bake rye'");
      expect(await record(t, 'project', rows[0]!.id)).toMatchObject({ start: '2026-11-02', end: '2027-03-31', objective_id: null });
    });

    it("changes a one off's date in place, refusing an end before its start, with Undo", async () => {
      const { t } = await flow(layout, 'projects');
      const oneOffs = await screen.findByRole('region', { name: 'One offs in this plan' });
      const date = within(oneOffs).getByRole('button', { name: 'Change date for Clean the windows, Jan 10' });
      await userEvent.click(date);
      expect(screen.getByLabelText('Date')).toHaveValue('2027-01-10');
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('form', { name: 'Dates for Clean the windows' })).toBeNull();
      await waitFor(() => expect(date).toHaveFocus());

      await userEvent.click(date);
      const form = screen.getByRole('form', { name: 'Dates for Clean the windows' });
      fireEvent.change(within(form).getByLabelText('Date'), { target: { value: '2027-01-12' } });
      await userEvent.click(within(form).getByRole('button', { name: '+ End date' }));
      fireEvent.change(within(form).getByLabelText('End date'), { target: { value: '2027-01-11' } });
      await userEvent.click(within(form).getByRole('button', { name: 'Set date' }));
      expect(within(form).getByRole('alert')).toHaveTextContent('The end date is before the start date.');
      fireEvent.change(within(form).getByLabelText('End date'), { target: { value: '2027-01-14' } });
      await userEvent.click(within(form).getByRole('button', { name: 'Set date' }));
      expect(await screen.findByText('Clean the windows, Jan 12 to Jan 14.', { selector: ':not(.sr)' })).toBeVisible();
      expect((await record(t, 'task', 'o1'))?.schedule).toEqual({ type: 'once', from: '2027-01-12', to: '2027-01-14' });
      await userEvent.click(undoButton('Clean the windows, Jan 12 to Jan 14.'));
      await waitFor(async () => expect((await record(t, 'task', 'o1'))?.schedule).toMatchObject({ type: 'once', from: '2027-01-10' }));
    });

    it('a one off given its first date leaves focus on the next with no date, then on the One offs heading', async () => {
      await flow(layout, 'projects', {
        seed: async (w) => {
          await seed(w);
          await w.create('task', { kind: 'one_off', title: 'Tidy the shed', schedule: { type: 'once' } }, 'o3');
        },
      });
      const oneOffs = await screen.findByRole('region', { name: 'One offs in this plan' });
      await userEvent.click(within(oneOffs).getByRole('button', { name: 'No date yet (2)' }));
      const date = async (title: string, day: string) => {
        await userEvent.click(within(oneOffs).getByRole('button', { name: `Add date for ${title}` }));
        fireEvent.change(screen.getByLabelText('Date'), { target: { value: day } });
        await userEvent.click(screen.getByRole('button', { name: 'Set date' }));
        await waitFor(() => expect(within(oneOffs).queryByRole('button', { name: `Add date for ${title}` })).toBeNull());
      };
      // The row that had focus goes each time: focus moves to the next with no date, then, with none left, to the list.
      await date('Fix the gate', '2027-02-01');
      await waitFor(() => expect(within(oneOffs).getByRole('button', { name: 'Add date for Tidy the shed' })).toHaveFocus());
      await date('Tidy the shed', '2027-02-02');
      await waitFor(() => expect(within(oneOffs).getByRole('heading', { name: 'One offs' })).toHaveFocus());
    });

    it('adds and takes out milestones by name, each with Undo, newest first', async () => {
      const { t } = await flow(layout, 'projects');
      await userEvent.click(await screen.findByRole('button', { name: 'Add milestone Share a loaf to this plan' }));
      expect(await screen.findByText('Added Share a loaf to this plan, by Mar 31.', { selector: ':not(.sr)' })).toBeVisible();
      expect(await record(t, 'milestone', 'm3')).toMatchObject({ due: null, stretch: '2027-01-01' });
      expect(next(layout, 'Continue with 2 milestones')).toBeVisible();

      await userEvent.click(screen.getByRole('button', { name: 'Take milestone First loaf out of this plan' }));
      expect(await screen.findByText('Took First loaf out of this plan and cleared its date.', { selector: ':not(.sr)' })).toBeVisible();
      expect(await record(t, 'milestone', 'm2')).toMatchObject({ due: null, stretch: null });

      await userEvent.click(undoButton('Took First loaf out of this plan and cleared its date.'));
      await waitFor(async () => expect((await record(t, 'milestone', 'm2'))?.due).toBe('2027-01-20'));
      await userEvent.click(await screen.findByRole('button', { name: 'Undo: Added Share a loaf to this plan, by Mar 31.' }));
      await waitFor(async () => expect(await record(t, 'milestone', 'm3')).toMatchObject({ due: '2027-05-01', stretch: null }));
      expect(screen.queryByRole('button', { name: /^Undo/ })).toBeNull();
    });

    it('types a date, refusing a past one, and keeps Done last', async () => {
      const { t } = await flow(layout, 'projects');
      await userEvent.click(await screen.findByRole('button', { name: 'Change the date of First loaf, Jan 20' }));
      let form = screen.getByRole('form', { name: 'Date for First loaf' });
      // A date typed but not set stays on Esc, and Cancel drops it.
      fireEvent.change(within(form).getByLabelText('Date for First loaf'), { target: { value: '2027-02-01' } });
      within(form).getByLabelText('Date for First loaf').focus();
      await userEvent.keyboard('{Escape}');
      expect(within(form).getByRole('alert')).toHaveTextContent("This date isn't set yet. Set it, or Cancel to drop it.");
      await userEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('form', { name: 'Date for First loaf' })).toBeNull();
      expect((await record(t, 'milestone', 'm2'))?.due).toBe('2027-01-20');
      await userEvent.click(screen.getByRole('button', { name: 'Change the date of First loaf, Jan 20' }));
      form = screen.getByRole('form', { name: 'Date for First loaf' });
      fireEvent.change(within(form).getByLabelText('Date for First loaf'), { target: { value: '2026-10-01' } });
      await userEvent.click(within(form).getByRole('button', { name: 'Set date' }));
      expect(within(form).getByRole('alert')).toHaveTextContent('Pick today or a later date.');
      fireEvent.change(within(form).getByLabelText('Date for First loaf'), { target: { value: '2027-03-10' } });
      await userEvent.click(within(form).getByRole('button', { name: 'Set date' }));
      expect(await screen.findByText('First loaf, Mar 10.', { selector: ':not(.sr)' })).toBeVisible();
      expect((await record(t, 'milestone', 'm2'))?.due).toBe('2027-03-10');

      await userEvent.click(screen.getByRole('button', { name: 'Done, not in this plan. Change the end date' }));
      const done = screen.getByRole('form', { name: 'Done date' });
      fireEvent.change(within(done).getByLabelText('Done date'), { target: { value: '2027-04-01' } });
      await userEvent.click(within(done).getByRole('button', { name: 'Set date' }));
      expect(within(done).getByRole('alert')).toHaveTextContent('Done stays last. Pick May 1 or later.');
      fireEvent.change(within(done).getByLabelText('Done date'), { target: { value: '2027-07-15' } });
      await userEvent.click(within(done).getByRole('button', { name: 'Set date' }));
      expect(await screen.findByText('Done moved to Jul 15.', { selector: ':not(.sr)' })).toBeVisible();
      expect((await record(t, 'project', 'p1'))?.end).toBe('2027-07-15');
    });

    it('adds a milestone by name, in the plan by its end', async () => {
      const { t } = await flow(layout, 'projects');
      await userEvent.click(await screen.findByRole('button', { name: 'Add a milestone to Bake a sourdough loaf' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Milestone name' }), 'Bake for friends{Enter}');
      expect(await screen.findByText('Added Bake for friends to this plan, by Mar 31.', { selector: ':not(.sr)' })).toBeVisible();
      const rows = await t.db.all<{ id: string }>("SELECT id FROM milestone WHERE title = 'Bake for friends'");
      expect(await record(t, 'milestone', rows[0]!.id)).toMatchObject({ stretch: '2027-01-01', added_on: '2026-11-02' });
      await userEvent.click(undoButton('Added Bake for friends to this plan, by Mar 31.'));
      await waitFor(async () => expect((await record(t, 'milestone', rows[0]!.id))?.deleted_at).toBeTruthy());
    });

    it('answers an overdue milestone: Already done, Keep in plan with a date in this stretch, or Drop, each with Undo', async () => {
      const { t } = await flow(layout, 'projects');
      const overdue = await screen.findByRole('region', { name: 'Overdue (2)' });
      expect(within(overdue).queryByRole('button', { name: /^Bring in Make a starter/ })).toBeNull();

      await userEvent.click(within(overdue).getByRole('button', { name: 'Already done: Make a starter' }));
      await waitFor(async () => expect((await record(t, 'milestone', 'm1'))?.met_at).toBeTruthy());
      expect((await record(t, 'task', 't1'))?.done_at).toBeTruthy();
      expect(await screen.findByRole('region', { name: 'Overdue (1)' })).toBeVisible();
      await userEvent.click(undoButton('Marked Make a starter done.'));
      await waitFor(async () => expect((await record(t, 'milestone', 'm1'))?.met_at).toBeNull());
      expect((await record(t, 'task', 't1'))?.done_at).toBeNull();

      await userEvent.click(await screen.findByRole('button', { name: 'Keep in plan: Make a starter' }));
      const form = screen.getByRole('form', { name: 'Date for Make a starter' });
      const field = within(form).getByLabelText('Date for Make a starter');
      expect(field).toHaveValue('2027-03-31');
      fireEvent.change(field, { target: { value: '2027-04-10' } });
      await userEvent.click(within(form).getByRole('button', { name: 'Set date' }));
      expect(within(form).getByRole('alert')).toHaveTextContent('Pick a date from Jan 1 to Mar 31.');
      fireEvent.change(field, { target: { value: '2027-02-14' } });
      await userEvent.click(within(form).getByRole('button', { name: 'Set date' }));
      await waitFor(async () => expect(await record(t, 'milestone', 'm1')).toMatchObject({ due: '2027-02-14' }));
      expect(screen.getByRole('button', { name: 'Take milestone Make a starter out of this plan' })).toHaveAttribute('aria-pressed', 'true');
      await userEvent.click(undoButton('Kept Make a starter in this plan, Feb 14.'));
      await waitFor(async () => expect((await record(t, 'milestone', 'm1'))?.due).toBe('2026-10-25'));

      await userEvent.click(await screen.findByRole('button', { name: 'Drop Make a starter' }));
      expect(await screen.findByText('Dropped Make a starter.', { selector: ':not(.sr)' })).toBeVisible();
      expect((await record(t, 'task', 't1'))?.milestone_id).toBe('m2');
      await userEvent.click(undoButton('Dropped Make a starter.'));
      await waitFor(async () => expect((await record(t, 'task', 't1'))?.milestone_id).toBe('m1'));
    });

    it('answers a project past its end as before: Bring in, Drop, and Finish after asking', async () => {
      const { t } = await flow(layout, 'projects');
      const overdue = await screen.findByRole('region', { name: 'Overdue (2)' });
      // Finishing or dropping a project is red; dropping a milestone isn't.
      const finish = within(overdue).getByRole('button', { name: 'Finish Train for the race' });
      expect(finish).toHaveClass('danger');
      expect(within(overdue).getByRole('button', { name: 'Drop Train for the race' })).toHaveClass('danger');
      expect(within(overdue).getByRole('button', { name: 'Drop Make a starter' })).not.toHaveClass('danger');
      expect(within(overdue).getByRole('button', { name: 'Bring in Train for the race' })).toBeVisible();
      await userEvent.click(finish);
      expect((await record(t, 'project', 'p2'))?.state).toBe('active');
      expect(within(overdue).getByText('Finishing cancels the 3h left.')).toBeVisible();
      expect(within(overdue).getByRole('button', { name: 'Yes, finish' })).toHaveClass('pri', 'danger');
      await userEvent.click(within(overdue).getByRole('button', { name: 'Yes, finish' }));
      expect(await screen.findByText('Finished Train for the race.', { selector: ':not(.sr)' })).toBeVisible();
      expect(await record(t, 'project', 'p2')).toMatchObject({ state: 'finished' });
      expect((await record(t, 'task', 't4'))?.cancelled_at).toBeTruthy();
      await userEvent.click(undoButton('Finished Train for the race.'));
      await waitFor(async () => expect((await record(t, 'project', 'p2'))?.state).toBe('active'));
      expect((await record(t, 'task', 't4'))?.cancelled_at).toBeNull();
    });

    it('Finish and Drop ask in place, with focus in the question, and Cancel or Esc back on the button that asked', async () => {
      await flow(layout, 'projects');
      await userEvent.click(await screen.findByRole('button', { name: 'Bake a sourdough loaf: Pause, Finish, Drop' }));
      const menu = screen.getByRole('dialog', { name: 'Bake a sourdough loaf' });
      within(menu).getByRole('button', { name: 'Finish' }).focus();
      await userEvent.keyboard('{Enter}');
      expect(within(menu).getByRole('button', { name: 'Cancel finishing' })).toHaveFocus();
      await userEvent.keyboard('{Escape}');
      expect(screen.getByRole('dialog', { name: 'Bake a sourdough loaf' })).toBeVisible();
      expect(within(menu).getByRole('button', { name: 'Finish' })).toHaveFocus();
      await userEvent.click(within(menu).getByRole('button', { name: 'Drop' }));
      await userEvent.click(within(menu).getByRole('button', { name: 'Cancel dropping' }));
      expect(within(menu).getByRole('button', { name: 'Drop' })).toHaveFocus();
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();

      const overdue = screen.getByRole('region', { name: 'Overdue (2)' });
      await userEvent.click(within(overdue).getByRole('button', { name: 'Finish Train for the race' }));
      expect(within(overdue).getByRole('button', { name: 'Cancel finishing' })).toHaveFocus();
      await userEvent.click(within(overdue).getByRole('button', { name: 'Cancel finishing' }));
      expect(within(overdue).getByRole('button', { name: 'Finish Train for the race' })).toHaveFocus();
    });

    it('a project’s start date waits for Save, with Undo; with a change, Esc keeps it open and Cancel drops it', async () => {
      const { t } = await flow(layout, 'projects');
      const opener = await screen.findByRole('button', { name: 'Bake a sourdough loaf: Pause, Finish, Drop' });
      await userEvent.click(opener);
      let menu = screen.getByRole('dialog', { name: 'Bake a sourdough loaf' });
      fireEvent.change(within(menu).getByLabelText('Start date'), { target: { value: '2026-10-05' } });
      expect((await record(t, 'project', 'p1'))?.start).toBe('2026-10-01');
      await userEvent.keyboard('{Escape}');
      expect(within(menu).getByRole('alert')).toHaveTextContent("Your changes aren't saved. Save them, or Cancel to drop them.");
      expect(within(menu).getByRole('button', { name: 'Save' })).toHaveFocus();
      await userEvent.click(within(menu).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect((await record(t, 'project', 'p1'))?.start).toBe('2026-10-01');

      await userEvent.click(opener);
      menu = screen.getByRole('dialog', { name: 'Bake a sourdough loaf' });
      expect(within(menu).getByLabelText('Start date')).toHaveValue('2026-10-01');
      fireEvent.change(within(menu).getByLabelText('Start date'), { target: { value: '2026-10-05' } });
      await userEvent.click(within(menu).getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('Bake a sourdough loaf starts Oct 5.', { selector: ':not(.sr)' })).toBeVisible();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect((await record(t, 'project', 'p1'))?.start).toBe('2026-10-05');
      await userEvent.click(undoButton('Bake a sourdough loaf starts Oct 5.'));
      await waitFor(async () => expect((await record(t, 'project', 'p1'))?.start).toBe('2026-10-01'));
    });

    it('pauses a project from its title, which moves it to the later group', async () => {
      const { t } = await flow(layout, 'projects');
      await userEvent.click(await screen.findByRole('button', { name: 'Bake a sourdough loaf: Pause, Finish, Drop' }));
      const menu = screen.getByRole('dialog', { name: 'Bake a sourdough loaf' });
      expect(within(menu).getByRole('button', { name: 'Finish' })).toHaveClass('danger');
      expect(within(menu).getByRole('button', { name: 'Drop' })).toHaveClass('danger');
      await userEvent.click(within(menu).getByRole('button', { name: 'Pause' }));
      expect(await screen.findByText('Paused Bake a sourdough loaf.', { selector: ':not(.sr)' })).toBeVisible();
      expect((await record(t, 'project', 'p1'))?.state).toBe('paused');
      expect(screen.getByRole('button', { name: 'Paused or starting later (2)' })).toBeVisible();
      expect(next(layout, 'Continue with no milestones')).toBeVisible();
      await userEvent.click(undoButton('Paused Bake a sourdough loaf.'));
      await waitFor(async () => expect((await record(t, 'project', 'p1'))?.state).toBe('active'));
    });

    it('keeps Does it fit in view on every step but Finish, as the plan changes', async () => {
      const { t } = await flow(layout, 'goals', { seed: withInbox });
      await screen.findByRole('navigation', { name: 'Planning steps' });
      for (const step of ['Goals', 'Practices', 'Projects', 'Inbox']) {
        await userEvent.click(tab(step));
        expect(fitBar()).toHaveTextContent('About 2h planned, about 6h at your recent pace.');
      }
      // An Inbox item filed under a planned milestone adds its time at once.
      await t.write((w) => w.set('task', 'i1', { kind: 'project', project_id: 'p1', milestone_id: 'm2' }));
      await waitFor(() => expect(fitBar()).toHaveTextContent('About 3h planned, about 6h at your recent pace.'));
      await t.write((w) => w.set('task', 'i2', { kind: 'project', project_id: 'p1', milestone_id: 'm2', estimate_min: 360 }));
      await waitFor(() => expect(fitBar()).toHaveTextContent('About 9h planned, about 6h at your recent pace. More than your recent pace. Something may slip.'));
      await userEvent.click(tab('Finish'));
      expect(screen.queryByRole('region', { name: 'Does it fit?' })).toBeNull();
    });

    it('lists the whole Inbox to process, counting down in the steps, and says what was sorted', async () => {
      const { t } = await flow(layout, 'inbox', { seed: withInbox });
      expect(await screen.findByRole('heading', { name: 'Step 4 of 5, Inbox. Give each item a home' })).toBeVisible();
      expect(screen.getByText('2 items. If one needs a new project, practice or goal, make it from its card.')).toBeVisible();
      expect(tab('Inbox')).toHaveAccessibleName(layout === 'phone' ? 'Inbox, 2 items' : '4. Inbox, 2 items');
      expect(screen.getByText('Book flights to Osaka')).toBeVisible();
      expect(screen.getByText('Call the tiler')).toBeVisible();
      expect(screen.queryByRole('button', { name: /more$/ })).toBeNull();
      await userEvent.click(layout === 'phone' ? next(layout, 'Process 2 items') : screen.getByRole('button', { name: 'Process 2 items' }));
      expect(t.nav().overlay).toEqual({ area: 'process', params: { stretchStart: '2027-01-01', stretchEnd: '2027-03-31' } });

      await t.write((w) => w.set('task', 'i1', { kind: 'project', project_id: 'p1', milestone_id: 'm2' }));
      act(() => t.nav().closeOverlay());
      const summary = await screen.findByText('1 sorted. 1 still in your Inbox.');
      await waitFor(() => expect(summary).toHaveFocus());
      expect(tab('Inbox')).toHaveAccessibleName(layout === 'phone' ? 'Inbox, 1 item' : '4. Inbox, 1 item');
      expect(screen.queryByRole('button', { name: 'Skip the Inbox this time' })).toBeNull();
      await userEvent.click(next(layout, 'Continue to Finish'));
      expect(await screen.findByRole('heading', { name: 'Step 5 of 5, Finish. Ready for Jan 1 to Mar 31' })).toBeVisible();
      expect(readFlow()).toMatchObject({ done: ['inbox'], inbox: ['i2'] });
    });

    it('skips the Inbox this time, or goes on from an empty one', async () => {
      await flow(layout, 'inbox', { seed: withInbox });
      await userEvent.click(await screen.findByRole('button', { name: 'Skip the Inbox this time' }));
      expect(await screen.findByRole('heading', { name: 'Step 5 of 5, Finish. Ready for Jan 1 to Mar 31' })).toBeVisible();
      // Skipped, its items wait for weekly planning's Inbox.
      expect(readFlow()).toMatchObject({ done: ['inbox'], inbox: null });
      cleanup();
      localStorage.clear();
      await flow(layout, 'inbox');
      expect(await screen.findByText('Your Inbox is empty. Anything you capture lands here.')).toBeVisible();
      expect(screen.queryByRole('button', { name: /^Process/ })).toBeNull();
      expect(tab('Inbox')).toHaveAccessibleName(layout === 'phone' ? 'Inbox' : '4. Inbox');
      expect(next(layout, 'Continue to Finish')).toBeVisible();
    });

    it('finishes with the fit, what is overdue, what changed and the note saved', async () => {
      writeFlow({ note: 'Fewer projects' });
      const { t, close } = await flow(layout, 'finish');
      expect(await screen.findByRole('heading', { name: 'Step 5 of 5, Finish. Ready for Jan 1 to Mar 31' })).toBeVisible();
      expect(screen.getByText(/about 2h planned, about 6h at your recent pace\.$/)).toHaveTextContent('Fits: about 2h planned, about 6h at your recent pace.');
      const plan = screen.getByRole('region', { name: 'The plan' });
      expect(within(plan).getByText('First loaf, Jan 20', { exact: false })).toBeVisible();
      expect(within(plan).getByText('Clean the windows, Jan 10', { exact: false })).toBeVisible();
      expect(within(screen.getByRole('region', { name: 'What changed' })).getByText('You kept everything as it was.')).toBeVisible();
      const overdue = screen.getByRole('region', { name: 'Projects · 2 overdue' });
      expect(within(overdue).getByText('Train for the race. Project ended Oct 20, 3h left.')).toBeVisible();
      expect(within(overdue).getByText("Make a starter. Bake a sourdough loaf. Was due Oct 25 and isn't marked done.")).toBeVisible();
      expect(screen.queryByText(/needs a call/i)).toBeNull();
      expect(screen.getByText('Nothing planned for Run a 10k, Paint the house.')).toBeVisible();
      expect(screen.getByText('Next planning: Mar 24.')).toBeVisible();
      await userEvent.click(finishButton(layout));
      await waitFor(() => expect(close).toHaveBeenCalled());
      const settings = await getSettings(t.db);
      expect(settings.plan_stretch).toMatchObject({ last_planned: '2027-01-01', last_note: 'Fewer projects' });
      expect(await screen.findByText('Your plan for Jan 1 to Mar 31 is set.')).toBeVisible();
    });

    it('names the steps never looked at, and Look now goes to the first', async () => {
      await flow(layout, 'goals');
      await userEvent.click(await screen.findByRole('button', { name: /Projects/ }));
      await userEvent.click(tab('Finish'));
      expect(await screen.findByText('Not looked at: Practices and Inbox.')).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Look now' }));
      expect(await screen.findByRole('heading', { name: 'Step 2 of 5, Practices. Your practices' })).toBeVisible();
    });

    it('says when the plan is more than your recent pace, with Back to Projects, and sets weekly aims', async () => {
      const { t } = await flow(layout, 'finish', { seed: async (w) => (await seed(w), w.set('task', 't2', { estimate_min: 600 })) });
      expect(await screen.findByText('About 10h planned, about 6h at your recent pace.')).toBeVisible();
      expect(screen.getByText('Take something out of the plan, or expect to fall short.')).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Set weekly aims' }));
      expect(screen.getByRole('button', { name: 'Hide weekly aims' })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('10h planned')).toBeVisible();
      fireEvent.change(screen.getByRole('slider', { name: 'Weekly aim for Bake a sourdough loaf' }), { target: { value: String(EST_STEPS.indexOf(120)) } });
      await waitFor(async () => expect((await record(t, 'project', 'p1'))?.weekly_aim).toBe(120));
      const changed = screen.getByRole('region', { name: 'What changed' });
      expect(await within(changed).findByText('Weekly aim changed: Bake a sourdough loaf')).toBeVisible();
      await userEvent.click(within(changed).getByRole('button', { name: 'Undo: Weekly aim changed: Bake a sourdough loaf' }));
      await waitFor(async () => expect((await record(t, 'project', 'p1'))?.weekly_aim ?? null).toBeNull());
      await userEvent.click(screen.getByRole('button', { name: 'Back to Projects' }));
      expect(await screen.findByRole('heading', { name: 'Step 3 of 5, Projects. What will you reach by Mar 31?' })).toBeVisible();
    });

    it('keeps each change’s Undo on What changed after Save and exit, and welcomes you back where you were', async () => {
      writeFlow({ begun: true });
      goToStep('projects');
      writeFlow({ done: ['goals', 'practices'] });
      const t = await renderApp({ layout, seed, initial: { area: 'plan', params: {} } });
      await userEvent.click(await screen.findByRole('button', { name: 'Continue planning' }));
      expect(await screen.findByText('Welcome back. Goals and Practices are done. You were on Projects.', { selector: ':not(.sr)' })).toBeVisible();
      await userEvent.click(await screen.findByRole('button', { name: 'Add milestone Share a loaf to this plan' }));
      await waitFor(async () => expect((await getRecord(t.db, 'milestone', 'm3'))?.stretch).toBe('2027-01-01'));
      await userEvent.click(screen.getByRole('button', { name: 'Save and exit' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Continue planning' }));
      expect(await screen.findByText('Welcome back. Goals and Practices are done. You were on Projects.', { selector: ':not(.sr)' })).toBeVisible();
      // The pinned line is for changes made since opening; What changed keeps every one.
      expect(screen.queryByRole('button', { name: /^Undo:/ })).toBeNull();
      await userEvent.click(tab('Finish'));
      const changed = await screen.findByRole('region', { name: 'What changed' });
      await userEvent.click(within(changed).getByRole('button', { name: 'Undo: Added Share a loaf to this plan, by Mar 31.' }));
      await waitFor(async () => expect(await getRecord(t.db, 'milestone', 'm3')).toMatchObject({ due: '2027-05-01', stretch: null }));
      expect(await within(changed).findByText('You kept everything as it was.')).toBeVisible();
    });

    it('adds a goal, practice, project or Inbox task from Add, with the step’s own kind first', async () => {
      const { t } = await flow(layout, 'projects');
      const open = () =>
        userEvent.click(screen.getByRole('button', layout === 'phone' ? { name: 'Add a goal, practice, project or Inbox task' } : { name: '+ Add' }));
      await screen.findByRole('heading', { name: /^Step 3 of 5/ });
      await open();
      let menu = screen.getByRole('dialog', { name: 'Add' });
      expect(within(menu).getAllByRole('button', { name: /^(Goal|Practice|Project|Task to Inbox)$/ }).map((b) => b.textContent)).toEqual(['Project', 'Task to Inbox', 'Practice', 'Goal']);
      await userEvent.click(within(menu).getByRole('button', { name: 'Goal' }));
      const form = screen.getByRole('form', { name: 'Add goal' });
      await userEvent.type(within(form).getByRole('textbox', { name: 'New goal' }), 'Keep fit');
      await userEvent.click(within(form).getByRole('button', { name: 'Add goal' }));
      await waitFor(() => expect(screen.queryByRole('form', { name: 'Add goal' })).toBeNull());
      expect(undoButton('Added goal Keep fit.')).toBeVisible();
      expect((await t.db.all("SELECT id FROM records WHERE type = 'objective' AND json_extract(data, '$.title') = 'Keep fit'")).length).toBe(1);

      await userEvent.click(tab('Goals'));
      await open();
      menu = screen.getByRole('dialog', { name: 'Add' });
      expect(within(menu).getAllByRole('button', { name: /^(Goal|Practice|Project|Task to Inbox)$/ }).map((b) => b.textContent)).toEqual(['Goal', 'Task to Inbox', 'Project', 'Practice']);
      await userEvent.click(within(menu).getByRole('button', { name: 'Task to Inbox' }));
      expect(t.nav().overlay?.area).toBe('capture');
    });

    it('with weekly planning next, opens it on Pick tasks while nothing new has reached the Inbox', async () => {
      const { t, close } = await flow(layout, 'inbox', { seed: withInbox });
      await userEvent.click(await screen.findByRole('button', { name: 'Skip the Inbox this time' }));
      await userEvent.click(await nextAsync(layout, 'Finish and plan the week'));
      await waitFor(() => expect(close).toHaveBeenCalled());
      expect(t.nav().flow).toEqual({ area: 'planning', params: {} });
      cleanup();

      const again = await flow(layout, 'inbox', { seed: withInbox });
      await userEvent.click(await nextAsync(layout, layout === 'phone' ? 'Process 2 items' : 'Continue to Finish'));
      if (layout === 'phone') {
        act(() => again.t.nav().closeOverlay());
        await userEvent.click(await nextAsync(layout, 'Continue to Finish'));
      }
      await userEvent.click(await nextAsync(layout, 'Finish and plan the week'));
      await waitFor(() => expect(again.close).toHaveBeenCalled());
      expect(again.t.nav().flow).toEqual({ area: 'planning', params: { step: 'pick' } });
      cleanup();

      const later = await flow(layout, 'finish', { seed: withInbox });
      writeFlow({ done: ['inbox'], inbox: ['i1'] });
      await userEvent.click(await nextAsync(layout, 'Finish and plan the week'));
      await waitFor(() => expect(later.close).toHaveBeenCalled());
      // i2 came in since the Inbox step, so weekly planning starts with it.
      expect(later.t.nav().flow).toEqual({ area: 'planning', params: {} });
    });
  });

  it('asks how often to plan first when the first stretch has yet to start', async () => {
    const { t } = await flow('desktop', 'start', {
      seed: async (w) => (await seed(w), updateSettings(w, { plan_cadence: { every: 1, unit: 'quarters', anchor: '2026-11-03' } })),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Plan your first stretch' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Step 1 of 6, Start. How often do you want to plan?' })).toBeVisible();
    const steps = screen.getByRole('navigation', { name: 'Planning steps' });
    expect(within(steps).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      '1. Start',
      '2. Goals',
      '3. Practices',
      '4. Projects, 2 overdue',
      '5. Inbox',
      '6. Finish',
    ]);
    expect(screen.getByText('Your first stretch: Nov 3 to Dec 31')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit goals' })).toBeNull();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'How often' }), 'every');
    await act(async () => fireEvent.change(screen.getByRole('slider', { name: 'Every' }), { target: { value: '2' } }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'In' }), 'weeks');
    expect(await screen.findByText('Your first stretch: Nov 3 to Nov 16')).toBeVisible();
    expect((await getSettings(t.db)).plan_cadence).toEqual({ every: 2, unit: 'weeks', anchor: '2026-11-03' });
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: /^Step 2 of 6, Goals\./ })).toBeVisible();
  });

  it('with no cadence, Finish keeps the planned stretch, so its plan holds on the days after', async () => {
    const { t, close } = await flow('desktop', 'finish', { seed: async (w) => (await seed(w), updateSettings(w, { plan_cadence: null })) });
    expect(await screen.findByRole('heading', { name: 'Step 5 of 5, Finish. Ready for Nov 5 to Feb 5' })).toBeVisible();
    expect(screen.getByText('Planning for: Nov 5 to Feb 5')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    const { plan_stretch } = await getSettings(t.db);
    expect(plan_stretch).toMatchObject({ last_planned: '2026-11-05', one_offs: [{ start: '2026-11-05', end: '2027-02-05' }] });
  });
});

describe('Planning ahead, shared with your other devices', () => {
  const elsewhere = { for: '2027-01-01', step: 'projects', done: ['goals', 'practices'], seen: ['goals', 'practices', 'projects'], note: 'Fewer projects', at: '2026-11-02T19:00:00.000Z' };
  const begunElsewhere = async (w: Writer) => (await seed(w), updateSettings(w, { plan_progress: elsewhere }));

  describe.each(['desktop', 'phone'] as const)('on %s', (layout) => {
    it('offers to continue planning begun on another device, and opens where it was left', async () => {
      const t = await page(layout, { seed: begunElsewhere });
      await userEvent.click(await screen.findByRole('button', { name: 'Continue planning' }));
      expect(t.nav().flow?.area).toBe('plan');
      expect(readFlow()).toMatchObject({ begun: true, stepKey: 'projects', step: 2, done: ['goals', 'practices'], note: 'Fewer projects' });
      cleanup();
      localStorage.clear();
      await renderScreen('plan', { layout, seed: begunElsewhere, presentation: 'flow' });
      expect(await screen.findByRole('heading', { name: 'Step 3 of 5, Projects. What will you reach by Mar 31?' })).toBeVisible();
      expect(screen.getByText('Welcome back. Goals and Practices are done. You were on Projects.', { selector: ':not(.sr)' })).toBeVisible();
      expect(tab('Practices')).toHaveAccessibleName(layout === 'phone' ? 'Practices, done' : '2. Practices, done');
    });

    it('shares each step and done mark as it changes, the note as you leave it, and Finish ends it everywhere', async () => {
      const { t, close } = await flow(layout);
      await waitFor(async () => expect((await getSettings(t.db)).plan_progress).toMatchObject({ for: '2027-01-01', step: 'goals', done: [] }));
      await userEvent.click(next(layout, 'Goals look right'));
      await waitFor(async () => expect((await getSettings(t.db)).plan_progress).toMatchObject({ step: 'practices', done: ['goals'], seen: ['goals', 'practices'] }));
      await userEvent.click(tab('Finish'));
      const note = await screen.findByRole('textbox', { name: 'Anything to do differently this stretch? (optional)' });
      await userEvent.type(note, 'Fewer projects');
      await userEvent.tab();
      await waitFor(async () => expect((await getSettings(t.db)).plan_progress).toMatchObject({ step: 'finish', note: 'Fewer projects' }));
      await userEvent.click(layout === 'phone' ? within(document.querySelector('.flowdock:not(.plundo)') as HTMLElement).getByRole('button', { name: 'Finish' }) : screen.getByRole('button', { name: 'Finish' }));
      await waitFor(() => expect(close).toHaveBeenCalled());
      expect((await getSettings(t.db)).plan_progress).toBeNull();
    });

    it('goes on from another device’s progress even when that device’s clock is ahead of this one', async () => {
      // Written with a clock well ahead of this device's.
      const ahead = { ...elsewhere, at: '2099-01-01T00:00:00.000Z' };
      await renderScreen('plan', { layout, presentation: 'flow', seed: async (w) => (await seed(w), updateSettings(w, { plan_progress: ahead })) });
      expect(await screen.findByRole('heading', { name: /^Step 3 of 5, Projects\./ })).toBeVisible();
      await userEvent.click(next(layout, 'Continue with 1 milestone'));
      expect(await screen.findByRole('heading', { name: /^Step 4 of 5, Inbox\./ })).toBeVisible();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.getByRole('heading', { name: /^Step 4 of 5, Inbox\./ })).toBeVisible();
      expect(readFlow()).toMatchObject({ stepKey: 'inbox', done: ['goals', 'practices', 'projects'] });
    });

    it('once another device has planned the stretch, has nothing here to continue', async () => {
      writeFlow({ begun: true, for: '2027-01-01', stepKey: 'projects', step: 2, at: '2026-11-02T19:00:00.000Z' });
      await page(layout, { seed: async (w) => (await seed(w), updateSettings(w, { plan_stretch: { last_planned: '2027-01-01' }, plan_progress: elsewhere })) });
      expect(await screen.findByRole('heading', { name: 'Calendar quarters' })).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Continue planning' })).toBeNull();
    });
  });
});
