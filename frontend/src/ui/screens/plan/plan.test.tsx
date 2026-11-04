import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRecord, getSettings, outcomeId, transact, updateSettings } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderScreen } from '../../app/testing';
import type { Harness } from '../../app/testing';
import { EST_STEPS } from '../../components/EstimateSlider';
import { readFlow, writeFlow } from './flowState';
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

async function flow(layout: 'desktop' | 'phone', step = 0, options: Parameters<typeof renderScreen>[1] = {}) {
  writeFlow({ begun: true, step });
  const close = vi.fn();
  const t = await renderScreen('plan', { layout, seed, presentation: 'flow', close, ...options });
  return { t, close };
}

const next = (layout: 'desktop' | 'phone', name = 'Continue') =>
  layout === 'phone' ? within(document.querySelector('.flowbot') as HTMLElement).getByRole('button', { name }) : screen.getByRole('button', { name });

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
      const { t, close } = await flow(layout, 0, {
        seed: async (w) => (await unplanned(w), w.set('milestone', 'm3', { due: null, stretch: '2026-10-01' })),
      });
      expect(await screen.findByRole('heading', { level: 1, name: 'Plan your first stretch' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'How have the last few weeks gone?' })).toBeVisible();
      expect(await screen.findByText('Your first stretch: Nov 2 to Dec 31')).toBeVisible();
      expect(readFlow().begunOn).toBe('2026-11-02');
      await userEvent.click(screen.getByRole('button', { name: layout === 'phone' ? 'Projects' : '3. Projects' }));
      expect(await screen.findByRole('button', { name: 'Take milestone Share a loaf out of this plan' })).toBeVisible();
      // Opening it writes nothing, so a device behind on sync can't undo a plan finished on another.
      expect((await getSettings(t.db)).plan_stretch).toEqual({});
      expect((await record(t, 'milestone', 'm3'))?.stretch).toBe('2026-10-01');

      await userEvent.click(screen.getByRole('button', { name: layout === 'phone' ? 'Finish' : '5. Finish' }));
      await userEvent.click(layout === 'phone' ? within(document.querySelector('.flowdock') as HTMLElement).getByRole('button', { name: 'Finish' }) : await screen.findByRole('button', { name: 'Finish' }));
      await waitFor(() => expect(close).toHaveBeenCalled());
      expect((await getSettings(t.db)).plan_stretch).toMatchObject({ last_planned: '2026-11-02', one_offs: [{ start: '2026-11-02', end: '2026-12-31' }] });
      expect((await record(t, 'milestone', 'm3'))?.stretch).toBe('2026-11-02');
    });

    it('continued on a later day, still starts the day planning began', async () => {
      writeFlow({ begunOn: '2026-10-30' });
      await flow(layout, 0, { seed: unplanned });
      expect(await screen.findByText('Your first stretch: Oct 30 to Dec 31')).toBeVisible();
      cleanup();
      // Begun on the stretch's own first day, it's that whole stretch.
      writeFlow({ begunOn: '2026-10-01' });
      await flow(layout, 0, { seed: unplanned });
      expect(await screen.findByText('Your first stretch: Oct 1 to Dec 31')).toBeVisible();
    });

    it('started late, is short, and planning the one after waits until the next day', async () => {
      const { t, close } = await flow(layout, 4, { seed: unplanned, now: '2026-12-26T18:00:00Z' });
      expect(await screen.findByRole('heading', { name: 'Ready for Dec 26 to Dec 31' })).toBeVisible();
      expect(screen.getByText('Next planning: Dec 27.')).toBeVisible();
      await userEvent.click(layout === 'phone' ? within(document.querySelector('.flowdock') as HTMLElement).getByRole('button', { name: 'Finish' }) : screen.getByRole('button', { name: 'Finish' }));
      await waitFor(() => expect(close).toHaveBeenCalled());
      expect(await moreLine(t.db, t.clock)).toBe('Next planning: Dec 27');
    });

    it('changes its dates with the same control, keeping today in it, and saves them with what was in this stretch', async () => {
      const { t } = await flow(layout, 0, {
        seed: async (w) => (await unplanned(w), w.set('milestone', 'm3', { due: null, stretch: '2026-10-01' })),
      });
      await userEvent.click(await screen.findByRole('button', { name: 'Change' }));
      fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-11-10' } });
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
      const { t, close } = await flow(layout, 2, { seed: unplanned });
      expect(await screen.findByRole('heading', { name: 'What will you reach by Dec 31?' })).toBeVisible();
      expect(screen.getByText('About 0h planned, about 4h at your recent pace.')).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Add milestone Share a loaf to this plan' }));
      expect(await screen.findByText('Added Share a loaf to this plan, by Dec 31.', { selector: ':not(.sr)' })).toBeVisible();
      expect(await record(t, 'milestone', 'm3')).toMatchObject({ due: null, stretch: '2026-11-02' });
      await userEvent.click(screen.getByRole('button', { name: layout === 'phone' ? 'Finish' : '5. Finish' }));
      expect(await screen.findByRole('heading', { name: 'Ready for Nov 2 to Dec 31' })).toBeVisible();
      expect(screen.getByText('Next planning: Dec 24.')).toBeVisible();
      await userEvent.click(layout === 'phone' ? within(document.querySelector('.flowdock') as HTMLElement).getByRole('button', { name: 'Finish' }) : screen.getByRole('button', { name: 'Finish' }));
      await waitFor(() => expect(close).toHaveBeenCalled());
      expect((await getSettings(t.db)).plan_stretch).toMatchObject({ last_planned: '2026-11-02', one_offs: [{ start: '2026-11-02', end: '2026-12-31' }] });
      expect(await screen.findByText('Your plan for Nov 2 to Dec 31 is set.')).toBeVisible();
    });
  });
});

describe('Planning ahead', () => {
  describe.each(['desktop', 'phone'] as const)('on %s', (layout) => {
    it('has five steps, starting by looking back', async () => {
      await flow(layout);
      const steps = await screen.findByRole('navigation', { name: 'Planning steps' });
      const labels = within(steps).getAllByRole('button').map((b) => b.textContent);
      expect(labels).toEqual(
        layout === 'phone' ? ['Look back', 'Practices', 'Projects', 'Time', 'Finish'] : ['1. Look back', '2. Practices', '3. Projects', '4. Time', '5. Finish'],
      );
      expect(await screen.findByRole('heading', { name: 'How is Oct 1 to Dec 31 going?' })).toBeVisible();
      expect(await screen.findByText('0 of 1 milestones due in this time were met.')).toBeVisible();
      expect(screen.getByText('About 30m a week went to your goals.')).toBeVisible();
      const time = screen.getByRole('region', { name: 'Time by goal, and One offs' });
      expect(within(time).getByText('Learn to bake bread').parentElement).toHaveTextContent('2h');
      expect(within(time).getByText('One offs')).toBeVisible();
    });

    it('keeps a note and sets the next stretch dates', async () => {
      const { t } = await flow(layout);
      expect(await screen.findByText('Next stretch: Jan 1 to Mar 31')).toBeVisible();
      await userEvent.type(screen.getByRole('textbox', { name: 'Anything to do differently? (optional)' }), 'Fewer projects');
      await userEvent.click(screen.getByRole('button', { name: 'Change' }));
      fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2027-02-15' } });
      await userEvent.click(screen.getByRole('button', { name: 'Set dates' }));
      expect(await screen.findByText('Next stretch: Jan 1 to Feb 15')).toBeVisible();
      expect((await getSettings(t.db)).plan_stretch.one_offs).toEqual([{ start: '2027-01-01', end: '2027-02-15' }]);
      await userEvent.click(next(layout));
      expect(await screen.findByRole('heading', { name: 'Your practices' })).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: layout === 'phone' ? 'Look back' : '1. Look back' }));
      expect(await screen.findByRole('textbox', { name: 'Anything to do differently? (optional)' })).toHaveValue('Fewer projects');
    });

    it('shows each practice as a summary, and Edit opens its fields in place until Done', async () => {
      const { t } = await flow(layout, 1);
      expect(await screen.findByRole('heading', { name: 'Your practices' })).toBeVisible();
      expect(screen.getByText('Stretch')).toBeVisible();
      expect(screen.getByText('15m a day, every day, around 7am')).toBeVisible();
      expect(screen.getByText('No goal')).toBeVisible();
      expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();

      await userEvent.click(screen.getByRole('button', { name: 'Edit Stretch' }));
      const editor = screen.getByRole('group', { name: 'Edit Stretch' });
      expect(within(editor).getByRole('button', { name: 'Done' })).toHaveFocus();
      const name = within(editor).getByRole('textbox', { name: 'Name' });
      await userEvent.clear(name);
      await userEvent.type(name, 'Stretch and breathe');
      await waitFor(async () => expect((await record(t, 'practice', 'pr1'))?.title).toBe('Stretch and breathe'));
      await userEvent.selectOptions(within(editor).getByRole('combobox', { name: 'Goal' }), 'Run a 10k');
      await userEvent.click(within(editor).getByRole('button', { name: 'Pause' }));
      await waitFor(async () => expect((await record(t, 'practice', 'pr1'))?.state).toBe('paused'));
      await userEvent.click(within(editor).getByRole('button', { name: 'Done' }));

      expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
      expect(screen.getByText('Stretch and breathe')).toBeVisible();
      expect(screen.getByText('Goal: Run a 10k')).toBeVisible();
      expect(screen.getByText('Paused')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Edit Stretch and breathe' })).toHaveFocus();

      // Esc closes it too.
      await userEvent.click(screen.getByRole('button', { name: 'Edit Stretch and breathe' }));
      await userEvent.keyboard('{Escape}');
      expect(screen.queryByRole('group', { name: 'Edit Stretch and breathe' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Edit Stretch and breathe' })).toHaveFocus();
    });

    it('a preferred time typed but not added is kept when Done or Esc closes the editor', async () => {
      const { t } = await flow(layout, 1);
      await userEvent.click(await screen.findByRole('button', { name: 'Edit Stretch' }));
      let editor = screen.getByRole('group', { name: 'Edit Stretch' });
      fireEvent.change(within(editor).getByLabelText('New preferred time'), { target: { value: '18:30' } });
      await userEvent.click(within(editor).getByRole('button', { name: 'Done' }));
      expect(await screen.findByText('15m a day, every day, around 7am or 6:30pm')).toBeVisible();
      expect((await record(t, 'practice', 'pr1'))?.preferred_times).toEqual([420, 1110]);

      await userEvent.click(screen.getByRole('button', { name: 'Edit Stretch' }));
      editor = screen.getByRole('group', { name: 'Edit Stretch' });
      fireEvent.change(within(editor).getByLabelText('New preferred time'), { target: { value: '06:00' } });
      await userEvent.keyboard('{Escape}');
      expect(await screen.findByText('15m a day, every day, around 6am or 7am or 6:30pm')).toBeVisible();
    });

    it('ending a practice in its editor takes it off the list, with focus on Add practice', async () => {
      const { t } = await flow(layout, 1);
      await userEvent.click(await screen.findByRole('button', { name: 'Edit Stretch' }));
      await userEvent.click(screen.getByRole('button', { name: 'End practice' }));
      await waitFor(async () => expect((await record(t, 'practice', 'pr1'))?.state).toBe('ended'));
      expect(await screen.findByText('No practices yet.')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Add practice' })).toHaveFocus();
    });

    it('Add practice closes the form and shows the new practice as a summary, with focus on its Edit', async () => {
      await flow(layout, 1);
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
      expect(screen.getByText('30m a day, every day, around 7am')).toBeVisible();
      expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Edit Read about baking' })).toHaveFocus());
    });

    it('shows every project on one timeline, with what needs a call first', async () => {
      await flow(layout, 2);
      expect(await screen.findByRole('heading', { name: 'What will you reach by Mar 31?' })).toBeVisible();
      expect(screen.getByText('About 2h planned, about 6h at your recent pace.')).toBeVisible();
      const calls = screen.getByRole('region', { name: 'Needs a call' });
      expect(within(calls).getByText('Project ended Oct 20, 3h left.')).toBeVisible();
      expect(within(calls).getByText('Bake a sourdough loaf. Was due Oct 25.')).toBeVisible();
      const projects = screen.getByRole('region', { name: 'Projects in this plan' });
      expect(within(projects).getByRole('button', { name: 'Bake a sourdough loaf: Pause, Finish, Drop' })).toBeVisible();
      expect(within(projects).queryByRole('button', { name: 'Train for the race: Pause, Finish, Drop' })).toBeNull();
      expect(within(projects).getByRole('button', { name: 'Take milestone First loaf out of this plan' })).toHaveAttribute('aria-pressed', 'true');
      expect(within(projects).getByRole('button', { name: 'Add milestone Share a loaf to this plan' })).toHaveAttribute('aria-pressed', 'false');
      expect(within(projects).getByRole('button', { name: 'Milestone: First loaf, Jan 20, in this plan. Change its date' })).toBeVisible();
      expect(within(projects).getByRole('button', { name: 'Paused or starting later (1)' })).toHaveAttribute('aria-expanded', 'false');
      expect(next(layout, 'Continue with 1 milestone')).toBeVisible();
      const oneOffs = screen.getByRole('region', { name: 'One offs in this plan' });
      expect(within(oneOffs).getByRole('button', { name: 'One off: Clean the windows, Jan 10. Change its date' })).toBeVisible();
      expect(within(oneOffs).getByRole('button', { name: 'No date yet (1)' })).toBeVisible();
    });

    it('adds and takes out milestones by name, each with Undo, newest first', async () => {
      const { t } = await flow(layout, 2);
      await userEvent.click(await screen.findByRole('button', { name: 'Add milestone Share a loaf to this plan' }));
      expect(await screen.findByText('Added Share a loaf to this plan, by Mar 31.', { selector: ':not(.sr)' })).toBeVisible();
      expect(await record(t, 'milestone', 'm3')).toMatchObject({ due: null, stretch: '2027-01-01' });
      expect(next(layout, 'Continue with 2 milestones')).toBeVisible();

      await userEvent.click(screen.getByRole('button', { name: 'Take milestone First loaf out of this plan' }));
      expect(await screen.findByText('Took First loaf out of this plan and cleared its date.', { selector: ':not(.sr)' })).toBeVisible();
      expect(await record(t, 'milestone', 'm2')).toMatchObject({ due: null, stretch: null });

      await userEvent.click(screen.getByRole('button', { name: 'Undo: Took First loaf out of this plan and cleared its date.' }));
      await waitFor(async () => expect((await record(t, 'milestone', 'm2'))?.due).toBe('2027-01-20'));
      await userEvent.click(await screen.findByRole('button', { name: 'Undo: Added Share a loaf to this plan, by Mar 31.' }));
      await waitFor(async () => expect(await record(t, 'milestone', 'm3')).toMatchObject({ due: '2027-05-01', stretch: null }));
      expect(screen.queryByRole('button', { name: /^Undo/ })).toBeNull();
    });

    it('types a date, refusing a past one, and keeps Done last', async () => {
      const { t } = await flow(layout, 2);
      await userEvent.click(await screen.findByRole('button', { name: 'Change the date of First loaf, Jan 20' }));
      const form = screen.getByRole('form', { name: 'Date for First loaf' });
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
      const { t } = await flow(layout, 2);
      await userEvent.click(await screen.findByRole('button', { name: 'Add a milestone to Bake a sourdough loaf' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Milestone name' }), 'Bake for friends{Enter}');
      expect(await screen.findByText('Added Bake for friends to this plan, by Mar 31.', { selector: ':not(.sr)' })).toBeVisible();
      const rows = await t.db.all<{ id: string }>("SELECT id FROM milestone WHERE title = 'Bake for friends'");
      expect(await record(t, 'milestone', rows[0]!.id)).toMatchObject({ stretch: '2027-01-01', added_on: '2026-11-02' });
      await userEvent.click(screen.getByRole('button', { name: 'Undo: Added Bake for friends to this plan, by Mar 31.' }));
      await waitFor(async () => expect((await record(t, 'milestone', rows[0]!.id))?.deleted_at).toBeTruthy());
    });

    it('answers what needs a call: Bring in, Drop, and Finish after asking', async () => {
      const { t } = await flow(layout, 2);
      const calls = await screen.findByRole('region', { name: 'Needs a call' });
      await userEvent.click(within(calls).getByRole('button', { name: 'Bring in Make a starter' }));
      await waitFor(async () => expect(await record(t, 'milestone', 'm1')).toMatchObject({ due: null, stretch: '2027-01-01' }));
      expect(within(calls).queryByText('Make a starter')).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: /^Undo: / }));
      await waitFor(async () => expect((await record(t, 'milestone', 'm1'))?.due).toBe('2026-10-25'));

      await userEvent.click(await within(calls).findByRole('button', { name: 'Drop Make a starter' }));
      expect(await screen.findByText('Dropped Make a starter.', { selector: ':not(.sr)' })).toBeVisible();
      expect((await record(t, 'task', 't1'))?.milestone_id).toBe('m2');
      await userEvent.click(screen.getByRole('button', { name: 'Undo: Dropped Make a starter.' }));
      await waitFor(async () => expect((await record(t, 'task', 't1'))?.milestone_id).toBe('m1'));

      // Finishing or dropping a project is red; dropping a milestone isn't.
      const finish = await within(calls).findByRole('button', { name: 'Finish Train for the race' });
      expect(finish).toHaveClass('danger');
      expect(within(calls).getByRole('button', { name: 'Drop Train for the race' })).toHaveClass('danger');
      expect(await within(calls).findByRole('button', { name: 'Drop Make a starter' })).not.toHaveClass('danger');
      await userEvent.click(finish);
      expect((await record(t, 'project', 'p2'))?.state).toBe('active');
      expect(within(calls).getByText('Finishing cancels the 3h left.')).toBeVisible();
      expect(within(calls).getByRole('button', { name: 'Yes, finish' })).toHaveClass('pri', 'danger');
      await userEvent.click(within(calls).getByRole('button', { name: 'Yes, finish' }));
      expect(await screen.findByText('Finished Train for the race.', { selector: ':not(.sr)' })).toBeVisible();
      expect(await record(t, 'project', 'p2')).toMatchObject({ state: 'finished' });
      expect((await record(t, 'task', 't4'))?.cancelled_at).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Undo: Finished Train for the race.' }));
      await waitFor(async () => expect((await record(t, 'project', 'p2'))?.state).toBe('active'));
      expect((await record(t, 'task', 't4'))?.cancelled_at).toBeNull();
    });

    it('Finish and Drop ask in place, with focus in the question, and Cancel or Esc back on the button that asked', async () => {
      await flow(layout, 2);
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

      const calls = screen.getByRole('region', { name: 'Needs a call' });
      await userEvent.click(within(calls).getByRole('button', { name: 'Finish Train for the race' }));
      expect(within(calls).getByRole('button', { name: 'Cancel finishing' })).toHaveFocus();
      await userEvent.click(within(calls).getByRole('button', { name: 'Cancel finishing' }));
      expect(within(calls).getByRole('button', { name: 'Finish Train for the race' })).toHaveFocus();
    });

    it('pauses a project from its title, which moves it to the later group', async () => {
      const { t } = await flow(layout, 2);
      await userEvent.click(await screen.findByRole('button', { name: 'Bake a sourdough loaf: Pause, Finish, Drop' }));
      const menu = screen.getByRole('dialog', { name: 'Bake a sourdough loaf' });
      expect(within(menu).getByRole('button', { name: 'Finish' })).toHaveClass('danger');
      expect(within(menu).getByRole('button', { name: 'Drop' })).toHaveClass('danger');
      await userEvent.click(within(menu).getByRole('button', { name: 'Pause' }));
      expect(await screen.findByText('Paused Bake a sourdough loaf.', { selector: ':not(.sr)' })).toBeVisible();
      expect((await record(t, 'project', 'p1'))?.state).toBe('paused');
      expect(screen.getByRole('button', { name: 'Paused or starting later (2)' })).toBeVisible();
      expect(next(layout, 'Continue with no milestones')).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Undo: Paused Bake a sourdough loaf.' }));
      await waitFor(async () => expect((await record(t, 'project', 'p1'))?.state).toBe('active'));
    });

    it('checks the time against recent pace, with a weekly aim slider', async () => {
      const { t } = await flow(layout, 3);
      expect(await screen.findByRole('heading', { name: 'Does it fit?' })).toBeVisible();
      expect(
        screen.getByText("About 2h of open tasks sit under your planned milestones. At your recent pace of 30m a week, you'd do about 6h."),
      ).toBeVisible();
      expect(screen.getByText('2h planned')).toBeVisible();
      fireEvent.change(screen.getByRole('slider', { name: 'Weekly aim for Bake a sourdough loaf' }), { target: { value: String(EST_STEPS.indexOf(120)) } });
      await waitFor(async () => expect((await record(t, 'project', 'p1'))?.weekly_aim).toBe(120));
      await userEvent.click(screen.getByRole('button', { name: layout === 'phone' ? 'Finish' : '5. Finish' }));
      expect(await screen.findByText('Weekly aim changed: Bake a sourdough loaf')).toBeVisible();
    });

    it('finishes with the plan, what still needs a call, and the note saved', async () => {
      writeFlow({ note: 'Fewer projects' });
      const { t, close } = await flow(layout, 4);
      expect(await screen.findByRole('heading', { name: 'Ready for Jan 1 to Mar 31' })).toBeVisible();
      const plan = screen.getByRole('region', { name: 'The plan' });
      expect(within(plan).getByText('First loaf, Jan 20', { exact: false })).toBeVisible();
      expect(within(plan).getByText('Clean the windows, Jan 10', { exact: false })).toBeVisible();
      expect(within(screen.getByRole('region', { name: 'What changed' })).getByText('You kept everything as it was.')).toBeVisible();
      expect(within(screen.getByRole('region', { name: 'Still needs a call' })).getByText('Train for the race. Project ended Oct 20, 3h left.')).toBeVisible();
      expect(screen.getByText('Nothing planned for Run a 10k, Paint the house.')).toBeVisible();
      expect(screen.getByText('Next planning: Mar 24.')).toBeVisible();
      await userEvent.click(layout === 'phone' ? within(document.querySelector('.flowdock') as HTMLElement).getByRole('button', { name: 'Finish' }) : screen.getByRole('button', { name: 'Finish' }));
      await waitFor(() => expect(close).toHaveBeenCalled());
      const settings = await getSettings(t.db);
      expect(settings.plan_stretch).toMatchObject({ last_planned: '2027-01-01', last_note: 'Fewer projects' });
      expect(await screen.findByText('Your plan for Jan 1 to Mar 31 is set.')).toBeVisible();
    });

    it('saves and exits, and Edit goals leaves for Goals', async () => {
      const { t, close } = await flow(layout, 1);
      await userEvent.click(await screen.findByRole('button', { name: 'Save and exit' }));
      expect(close).toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: 'Edit goals' }));
      expect(t.nav().route.area).toBe('goals');
      expect(await screen.findByText(layout === 'phone' ? 'Your planning is saved. Continue from Plan in More.' : 'Your planning is saved. Continue from the Plan tab.')).toBeVisible();
    });
  });

  it('asks how often to plan first when the first stretch has yet to start', async () => {
    const { t } = await flow('desktop', 0, {
      seed: async (w) => (await seed(w), updateSettings(w, { plan_cadence: { every: 1, unit: 'quarters', anchor: '2026-11-03' } })),
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Plan your first stretch' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'How often do you want to plan?' })).toBeVisible();
    expect(screen.getByText('Your first stretch: Nov 3 to Dec 31')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit goals' })).toBeNull();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'How often' }), 'every');
    await act(async () => fireEvent.change(screen.getByRole('slider', { name: 'Every' }), { target: { value: '2' } }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'In' }), 'weeks');
    expect(await screen.findByText('Your first stretch: Nov 3 to Nov 16')).toBeVisible();
    expect((await getSettings(t.db)).plan_cadence).toEqual({ every: 2, unit: 'weeks', anchor: '2026-11-03' });
  });

  it('with no cadence, Finish keeps the planned stretch, so its plan holds on the days after', async () => {
    const { t, close } = await flow('desktop', 4, { seed: async (w) => (await seed(w), updateSettings(w, { plan_cadence: null })) });
    expect(await screen.findByRole('heading', { name: 'Ready for Nov 5 to Feb 5' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    const { plan_stretch } = await getSettings(t.db);
    expect(plan_stretch).toMatchObject({ last_planned: '2026-11-05', one_offs: [{ start: '2026-11-05', end: '2027-02-05' }] });
  });
});
