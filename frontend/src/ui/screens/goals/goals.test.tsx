import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { getRecord } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderScreen } from '../../app/testing';
import type { Harness } from '../../app/testing';
import { EST_STEPS } from '../../components/EstimateSlider';

afterEach(cleanup);

// The harness clock is Monday Nov 2, 2026, in Chicago. The cadence is calendar quarters: Oct 1 to Dec 31.
async function bread(w: Writer) {
  await w.create('objective', { title: 'Learn to bake bread', state: 'active' }, 'g1');
  await w.create('objective', { title: 'Run a 10k', state: 'active' }, 'g2');
  await w.create(
    'project',
    { objective_id: 'g1', title: 'Bake a sourdough loaf', state: 'active', start: '2026-10-01', end: '2026-12-15', weekly_aim: 240 },
    'p1',
  );
  await w.create('milestone', { project_id: 'p1', title: 'Buy flour', due: '2026-10-10', met_at: '2026-10-09T15:00:00Z' }, 'm0');
  await w.create('milestone', { project_id: 'p1', title: 'Make a starter', due: '2026-10-25' }, 'm1');
  await w.create('milestone', { project_id: 'p1', title: 'First loaf', due: '2026-11-20' }, 'm2');
  await w.create('milestone', { project_id: 'p1', title: 'Share a loaf', due: '2026-12-10' }, 'm3');
  const task = (id: string, milestone_id: string, title: string, estimate_min: number, extra = {}) =>
    w.create('task', { kind: 'project', project_id: 'p1', milestone_id, title, estimate_min, ...extra }, id);
  await task('t0', 'm0', 'Order flour', 30, { done_at: '2026-10-08T15:00:00Z' });
  await task('t1', 'm1', 'Mix flour and water', 60, { done_at: '2026-10-20T15:00:00Z' });
  await task('t2', 'm1', 'Feed the starter', 120);
  await task('t3', 'm2', 'Shape the dough', 240);
  await task('t4', 'm3', 'Invite friends', 60);
  await w.create('practice', { title: 'Stretch', target_min: 15, per: 'day', state: 'active', preferred_times: [420] }, 'pr1');
}

// Run a 10k last changed in July, on another device: more than a quarter ago, so it's asked whether it's still a goal.
async function quietRun(w: Writer) {
  await bread(w);
  const july = `${Date.parse('2026-07-01T12:00:00Z')}-000000-other`;
  const row = await w.sql.get<{ clocks: string }>("SELECT clocks FROM records WHERE id = 'g2'");
  const clocks = Object.fromEntries(Object.keys(JSON.parse(row!.clocks) as object).map((field) => [field, july]));
  await w.sql.run("UPDATE records SET clocks = :clocks WHERE id = 'g2'", { clocks: JSON.stringify(clocks) });
}

// One open milestone, so the project opens on it and Done starts folded.
async function oneMilestone(w: Writer) {
  await w.create('project', { title: 'Bake a sourdough loaf', state: 'active', start: '2026-10-01', end: '2026-12-15' }, 'p1');
  await w.create('milestone', { project_id: 'p1', title: 'Make a starter', due: '2026-11-20' }, 'm1');
}

// No milestones, so only its own dates hold Done in.
async function plain(w: Writer) {
  await w.create('project', { title: 'Write the report', state: 'active', start: '2026-10-01', end: '2026-12-15' }, 'p1');
}

const project = (layout: 'desktop' | 'phone' = 'desktop', seed = bread) =>
  renderScreen('goals', { layout, seed, params: { project: 'p1' } });

const group = (name: string) => screen.getByRole('group', { name: `Milestone: ${name}` });
const record = <T extends 'task' | 'milestone' | 'project' | 'objective' | 'practice'>(t: Harness, type: T, id: string) => getRecord(t.db, type, id);

describe('Goals', () => {
  describe.each(['desktop', 'phone'] as const)('on %s', (layout) => {
    it('shows each goal with its worst project, and asks about one with nothing active for a cadence', async () => {
      await renderScreen('goals', { layout, seed: quietRun });
      expect(await screen.findByRole('heading', { level: 1, name: 'Goals' })).toBeVisible();
      const bake = screen.getByRole('button', { name: /Learn to bake bread/ });
      expect(within(bake).getByText('Overdue')).toBeVisible();
      expect(within(bake).getByText('Bake a sourdough loaf')).toBeVisible();
      expect(within(screen.getByRole('button', { name: /Run a 10k/ })).getByText('Nothing active. Still a goal?')).toBeVisible();
    });

    it('only says so for a goal with nothing active that changed lately, and asks again once Not now runs out', async () => {
      const t = await renderScreen('goals', { layout, seed: bread });
      const run = await screen.findByRole('button', { name: /^Run a 10k/ });
      if (layout === 'desktop') expect(within(run).getByText('Nothing active.')).toBeVisible();
      expect(within(run).queryByText(/Still a goal/)).toBeNull();
      await userEvent.click(run);
      expect(screen.queryByText('Still a goal?')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Yes, not now' })).toBeNull();

      await t.write((w) => w.set('objective', 'g2', { state: 'not_now', not_now_until: '2026-11-01' }));
      expect(await screen.findByRole('button', { name: 'Yes, not now' })).toBeVisible();
    });

    it('asks Still a goal: not now with Undo, then archive and restore', async () => {
      const t = await renderScreen('goals', { layout, seed: quietRun });
      await userEvent.click(await screen.findByRole('button', { name: /Run a 10k/ }));
      await userEvent.click(screen.getByRole('button', { name: 'Yes, not now' }));
      expect(await screen.findByText('Not now. Asking again Jan 1.')).toBeVisible();
      expect(await record(t, 'objective', 'g2')).toMatchObject({ state: 'not_now', not_now_until: '2027-01-01' });
      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await waitFor(async () => expect((await record(t, 'objective', 'g2'))?.state).toBe('active'));

      await userEvent.click(await screen.findByRole('button', { name: 'No, archive it' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Archived (1)' }));
      expect(screen.queryByRole('button', { name: /^Run a 10k/ })).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Restore Run a 10k' }));
      expect(await screen.findByRole('button', { name: /^Run a 10k/ })).toBeVisible();
      expect((await record(t, 'objective', 'g2'))?.state).toBe('active');
    });

    it('Still a goal keeps keyboard focus: not now on the goal, archive on Archived', async () => {
      await renderScreen('goals', { layout, seed: quietRun });
      const run = await screen.findByRole('button', { name: /Run a 10k/ });
      await userEvent.click(run);
      screen.getByRole('button', { name: 'Yes, not now' }).focus();
      await userEvent.keyboard('{Enter}');
      expect(await screen.findByText('Not now. Asking again Jan 1.')).toBeVisible();
      await waitFor(() => expect(run).toHaveFocus());
      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      (await screen.findByRole('button', { name: 'No, archive it' })).focus();
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(screen.getByRole('button', { name: 'Archived (1)' })).toHaveFocus());
    });

    it('renames a goal from the pen in its title: Cancel and Esc keep the name, a blank one is refused, Enter saves', async () => {
      const t = await renderScreen('goals', { layout, seed: bread });
      const title = async () => (await record(t, 'objective', 'g1'))?.title;
      expect(await screen.findByRole('button', { name: /^Learn to bake bread/ })).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Rename Learn to bake bread' })).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: /^Learn to bake bread/ }));
      const pen = screen.getByRole('button', { name: 'Rename Learn to bake bread' });

      await userEvent.click(pen);
      const name = screen.getByRole('textbox', { name: 'Goal name' });
      expect(name).toHaveValue('Learn to bake bread');
      expect(name).toHaveFocus();
      expect(screen.getByRole('button', { name: 'Delete goal' })).toBeVisible();
      await userEvent.type(name, ' twice');
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('textbox', { name: 'Goal name' })).toBeNull();
      expect(await title()).toBe('Learn to bake bread');
      await waitFor(() => expect(screen.getByRole('button', { name: 'Rename Learn to bake bread' })).toHaveFocus());

      await userEvent.keyboard('{Enter}');
      await userEvent.type(screen.getByRole('textbox', { name: 'Goal name' }), ' twice{Escape}');
      expect(screen.queryByRole('textbox', { name: 'Goal name' })).toBeNull();
      expect(await title()).toBe('Learn to bake bread');
      await waitFor(() => expect(screen.getByRole('button', { name: 'Rename Learn to bake bread' })).toHaveFocus());

      await userEvent.click(screen.getByRole('button', { name: 'Rename Learn to bake bread' }));
      await userEvent.clear(screen.getByRole('textbox', { name: 'Goal name' }));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Give it a name.');
      expect(await title()).toBe('Learn to bake bread');
      await userEvent.type(screen.getByRole('textbox', { name: 'Goal name' }), 'Bake good bread{Enter}');
      await waitFor(async () => expect(await title()).toBe('Bake good bread'));
      expect(await screen.findByRole('button', { name: /^Bake good bread/ })).toBeVisible();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Rename Bake good bread' })).toHaveFocus());
    });

    it('deletes a goal after a warning listing what goes with it, and Undo brings it all back', async () => {
      const t = await renderScreen('goals', {
        layout,
        seed: async (w) => {
          await bread(w);
          await w.set('practice', 'pr1', { objective_id: 'g1' });
          await w.create('time_block', { task_id: 't3', start: '2026-11-04T15:00:00Z', end: '2026-11-04T17:00:00Z', tz: 'America/Chicago' }, 'b3');
        },
      });
      await userEvent.click(await screen.findByRole('button', { name: /^Learn to bake bread/ }));
      await userEvent.click(screen.getByRole('button', { name: 'Rename Learn to bake bread' }));
      await userEvent.click(screen.getByRole('button', { name: 'Delete goal' }));
      const ask = await screen.findByRole('dialog', { name: 'Delete Learn to bake bread?' });
      expect(ask).toHaveTextContent('1 project: Bake a sourdough loaf, with 4 milestones and 5 tasks');
      expect(ask).toHaveTextContent('1 practice: Stretch');
      await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect((await record(t, 'objective', 'g1'))?.deleted_at).toBeUndefined();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Delete goal' })).toHaveFocus());

      await userEvent.click(screen.getByRole('button', { name: 'Delete goal' }));
      await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Yes, delete' }));
      expect(await screen.findByText('Deleted Learn to bake bread.')).toBeVisible();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByRole('button', { name: /^Learn to bake bread/ })).toBeNull();
      expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
      for (const [type, id] of [['objective', 'g1'], ['project', 'p1'], ['milestone', 'm2'], ['task', 't3'], ['practice', 'pr1']] as const) {
        expect((await record(t, type, id))?.deleted_at, id).toBeTruthy();
      }
      expect((await getRecord(t.db, 'time_block', 'b3'))?.cancelled).toBe(true);

      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(await screen.findByRole('button', { name: /^Learn to bake bread/ })).toBeVisible();
      for (const [type, id] of [['objective', 'g1'], ['project', 'p1'], ['milestone', 'm2'], ['task', 't3'], ['practice', 'pr1']] as const) {
        await waitFor(async () => expect((await record(t, type, id))?.deleted_at, id).toBeNull());
      }
      expect((await getRecord(t.db, 'time_block', 'b3'))?.cancelled).toBeNull();
    });

    it('deletes an archived goal from Archived, with Undo', async () => {
      const t = await renderScreen('goals', {
        layout,
        seed: async (w) => {
          await bread(w);
          await w.create('objective', { title: 'Learn to knit', state: 'archived' }, 'g3');
        },
      });
      await userEvent.click(await screen.findByRole('button', { name: 'Archived (1)' }));
      await userEvent.click(screen.getByRole('button', { name: 'Delete Learn to knit' }));
      const ask = await screen.findByRole('dialog', { name: 'Delete Learn to knit?' });
      expect(ask).toHaveTextContent('Nothing else is under it.');
      await userEvent.click(within(ask).getByRole('button', { name: 'Yes, delete' }));
      expect(await screen.findByText('Deleted Learn to knit.')).toBeVisible();
      expect(screen.queryByRole('button', { name: /^Archived/ })).toBeNull();
      expect((await record(t, 'objective', 'g3'))?.deleted_at).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(await screen.findByRole('button', { name: 'Archived (1)' })).toBeVisible();
    });

    it('moves a project to another goal from Project settings', async () => {
      const t = layout === 'phone' ? await project('phone') : await renderScreen('goals', { seed: bread });
      if (layout === 'desktop') {
        await userEvent.click(await screen.findByRole('button', { name: /Learn to bake bread/ }));
        await userEvent.click(screen.getByRole('button', { name: /^Bake a sourdough loaf/ }));
      }
      await userEvent.click(await screen.findByRole('button', { name: 'Project settings' }));
      const goal = screen.getByRole('combobox', { name: 'Goal' });
      expect(goal).toHaveValue('g1');
      await userEvent.selectOptions(goal, 'Run a 10k');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(async () => expect((await record(t, 'project', 'p1'))?.objective_id).toBe('g2'));
      if (layout === 'desktop') {
        // The row moves under its new goal, which opens, and focus follows it there.
        const row = await screen.findByRole('button', { name: /^Bake a sourdough loaf/ });
        expect(screen.getByRole('button', { name: /^Run a 10k/ })).toHaveAttribute('aria-expanded', 'true');
        await waitFor(() => expect(row).toHaveFocus());
      }
      await userEvent.click(screen.getByRole('button', { name: 'Project settings' }));
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Goal' }), 'No goal');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(async () => expect((await record(t, 'project', 'p1'))?.objective_id).toBeNull());
    });

    it('opens Project settings as a dialog: Save applies, Cancel and Esc discard, and focus comes back', async () => {
      const t = await project(layout);
      const open = await screen.findByRole('button', { name: 'Project settings' });
      await userEvent.click(open);
      let dialog = screen.getByRole('dialog', { name: 'Project settings' });
      // Its Ends field moves the end date, so there's no Change end date here.
      expect(within(dialog).queryByRole('button', { name: 'Change end date' })).toBeNull();
      expect(within(dialog).getByRole('button', { name: 'Finish' })).toBeVisible();
      expect(within(dialog).getByRole('button', { name: 'Drop' })).toBeVisible();

      await userEvent.type(within(dialog).getByLabelText('Name'), ' twice');
      fireEvent.change(within(dialog).getByLabelText('Ends'), { target: { value: '2027-01-15' } });
      expect((await record(t, 'project', 'p1'))?.title).toBe('Bake a sourdough loaf');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      await waitFor(() => expect(open).toHaveFocus());
      expect(await record(t, 'project', 'p1')).toMatchObject({ title: 'Bake a sourdough loaf', end: '2026-12-15' });

      await userEvent.click(open);
      dialog = screen.getByRole('dialog', { name: 'Project settings' });
      expect(within(dialog).getByLabelText('Ends')).toHaveValue('2026-12-15');
      await userEvent.type(within(dialog).getByLabelText('Name'), ' twice{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      await waitFor(() => expect(open).toHaveFocus());
      expect((await record(t, 'project', 'p1'))?.title).toBe('Bake a sourdough loaf');

      await userEvent.click(open);
      dialog = screen.getByRole('dialog', { name: 'Project settings' });
      const name = within(dialog).getByLabelText('Name');
      expect(name).toHaveValue('Bake a sourdough loaf');
      await userEvent.clear(name);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Give it a name.');
      await userEvent.type(name, 'Bake two loaves');
      fireEvent.change(within(dialog).getByLabelText('Ends'), { target: { value: '2026-12-01' } });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Done stays last. Pick Dec 10 or later.');
      expect((await record(t, 'project', 'p1'))?.title).toBe('Bake a sourdough loaf');

      await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'Goal' }), 'Run a 10k');
      fireEvent.change(within(dialog).getByLabelText('Starts'), { target: { value: '2026-10-05' } });
      fireEvent.change(within(dialog).getByLabelText('Ends'), { target: { value: '2027-01-15' } });
      fireEvent.change(within(dialog).getByRole('slider', { name: 'Weekly aim' }), { target: { value: String(EST_STEPS.indexOf(120)) } });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      await waitFor(async () =>
        expect(await record(t, 'project', 'p1')).toMatchObject({ title: 'Bake two loaves', objective_id: 'g2', start: '2026-10-05', end: '2027-01-15', weekly_aim: 120 }),
      );
      // The end date's move is logged, with Undo, as moving it anywhere else is.
      expect(await screen.findByText('Nov 2: Done moved to Jan 15.')).toBeVisible();
      await waitFor(() => expect(open).toHaveFocus());
    });

    it('Project settings shows and checks the project as it is now, after a sync while it is open', async () => {
      const t = await project(layout, plain);
      const open = await screen.findByRole('button', { name: 'Project settings' });
      await userEvent.click(open);
      let dialog = screen.getByRole('dialog', { name: 'Project settings' });
      // Another device moves the end earlier.
      await t.write((w) => w.set('project', 'p1', { end: '2026-11-10' }));
      await waitFor(() => expect(within(dialog).getByLabelText('Ends')).toHaveValue('2026-11-10'));
      fireEvent.change(within(dialog).getByLabelText('Starts'), { target: { value: '2026-11-20' } });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Pick an end date on or after the start.');
      expect(await record(t, 'project', 'p1')).toMatchObject({ start: '2026-10-01', end: '2026-11-10' });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      // And the start later, with an earlier end typed after it.
      await userEvent.click(open);
      dialog = screen.getByRole('dialog', { name: 'Project settings' });
      await t.write((w) => w.set('project', 'p1', { start: '2026-12-01', end: '2026-12-15' }));
      fireEvent.change(within(dialog).getByLabelText('Ends'), { target: { value: '2026-11-15' } });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(within(dialog).getByRole('alert')).toHaveTextContent(/Pick (an end date on or after the start|Dec 1 or later)\./);
      expect(await record(t, 'project', 'p1')).toMatchObject({ start: '2026-12-01', end: '2026-12-15' });
    });

    it('after Resume in Project settings, Ends shows the moved end, and picking the old one again saves it', async () => {
      const t = await project(layout, async (w) => {
        await w.create(
          'project',
          {
            title: 'Write the report',
            state: 'paused',
            start: '2026-10-01',
            end: '2026-12-15',
            slip_log: [{ at: '2026-10-23T15:00:00Z', kind: 'pause', text: 'Oct 23: Paused.', undo: [] }],
          },
          'p1',
        );
      });
      await userEvent.click(await screen.findByRole('button', { name: 'Project settings' }));
      const dialog = screen.getByRole('dialog', { name: 'Project settings' });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Resume' }));
      // Paused for 10 days, so the end moves from Dec 15 to Dec 25.
      await waitFor(async () => expect(await record(t, 'project', 'p1')).toMatchObject({ state: 'active', end: '2026-12-25' }));
      await waitFor(() => expect(within(dialog).getByLabelText('Ends')).toHaveValue('2026-12-25'));
      fireEvent.change(within(dialog).getByLabelText('Ends'), { target: { value: '2026-12-20' } });
      fireEvent.change(within(dialog).getByLabelText('Ends'), { target: { value: '2026-12-15' } });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      await waitFor(async () => expect((await record(t, 'project', 'p1'))?.end).toBe('2026-12-15'));
    });

    it('Undo after a Save that moved the start and the end takes both back', async () => {
      const t = await project(layout, plain);
      await userEvent.click(await screen.findByRole('button', { name: 'Project settings' }));
      const dialog = screen.getByRole('dialog', { name: 'Project settings' });
      fireEvent.change(within(dialog).getByLabelText('Starts'), { target: { value: '2027-01-04' } });
      fireEvent.change(within(dialog).getByLabelText('Ends'), { target: { value: '2027-02-15' } });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(async () => expect(await record(t, 'project', 'p1')).toMatchObject({ start: '2027-01-04', end: '2027-02-15' }));
      const change = screen.getByText('Nov 2: Done moved to Feb 15.').closest('[role="status"]') as HTMLElement;
      await userEvent.click(within(change).getByRole('button', { name: 'Undo' }));
      await waitFor(async () => expect(await record(t, 'project', 'p1')).toMatchObject({ start: '2026-10-01', end: '2026-12-15' }));
    });

    it('Finish and Drop in Project settings are red and still ask first', async () => {
      const t = await project(layout);
      await userEvent.click(await screen.findByRole('button', { name: 'Project settings' }));
      const dialog = screen.getByRole('dialog', { name: 'Project settings' });
      expect(within(dialog).getByRole('button', { name: 'Finish' })).toHaveClass('btn', 'danger');
      expect(within(dialog).getByRole('button', { name: 'Drop' })).toHaveClass('btn', 'danger');

      await userEvent.type(within(dialog).getByLabelText('Name'), ' twice');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Drop' }));
      let ask = within(dialog).getByRole('alert');
      expect(ask).toHaveTextContent('Drop this project?');
      expect(within(ask).getByRole('button', { name: 'Yes, drop' })).toHaveClass('pri', 'danger');
      // The question takes the place of the buttons, so focus moves into it and back, staying in the dialog. Its
      // Cancel says what it backs out of, beside the dialog's own.
      expect(within(ask).getByRole('button', { name: 'Cancel dropping' })).toHaveFocus();
      expect(within(dialog).getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
      await userEvent.click(within(ask).getByRole('button', { name: 'Cancel dropping' }));
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Drop' })).toHaveFocus());
      expect((await record(t, 'project', 'p1'))?.state).toBe('active');

      // Esc backs out of just the question, keeping what was typed.
      await userEvent.click(within(dialog).getByRole('button', { name: 'Drop' }));
      await userEvent.keyboard('{Escape}');
      expect(within(dialog).queryByRole('alert')).toBeNull();
      expect(screen.getByRole('dialog', { name: 'Project settings' })).toBeVisible();
      expect(within(dialog).getByLabelText('Name')).toHaveValue('Bake a sourdough loaf twice');
      expect(within(dialog).getByRole('button', { name: 'Drop' })).toHaveFocus();

      // A tap on WebKit focuses the dialog rather than the button tapped; focus still goes back to Drop.
      await userEvent.click(within(dialog).getByRole('button', { name: 'Drop' }));
      dialog.focus();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel dropping' }));
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Drop' })).toHaveFocus());

      await userEvent.click(within(dialog).getByRole('button', { name: 'Finish' }));
      ask = within(dialog).getByRole('alert');
      expect(ask).toHaveTextContent('Finish this project?');
      expect(within(ask).getByRole('button', { name: 'Yes, finish' })).toHaveClass('pri', 'danger');
      await userEvent.click(within(ask).getByRole('button', { name: 'Yes, finish' }));
      expect(await screen.findByText('Finished. Open tasks cancelled.')).toBeVisible();
      expect((await record(t, 'project', 'p1'))?.state).toBe('finished');
    });

    it('adds a goal, then a project that needs a name and an end date', async () => {
      const t = await renderScreen('goals', { layout, seed: bread });
      await screen.findByRole('heading', { level: 1, name: 'Goals' });
      if (layout === 'phone') await userEvent.click(screen.getByRole('button', { name: '+ New goal' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'New goal' }), '   {Enter}');
      expect((await t.db.all('SELECT id FROM objective')).length).toBe(2);
      await userEvent.clear(screen.getByRole('textbox', { name: 'New goal' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'New goal' }), 'Write a book{Enter}');
      await userEvent.click(await screen.findByRole('button', { name: /Write a book/ }));

      await userEvent.click(screen.getByRole('button', { name: layout === 'phone' ? '+ Project' : 'Add project' }));
      const form = screen.getByRole('form', { name: 'Add project' });
      await userEvent.click(within(form).getByRole('button', { name: 'Add project' }));
      expect(within(form).getByRole('alert')).toHaveTextContent('Give it a name.');
      await userEvent.type(within(form).getByLabelText('Name'), 'Draft chapters');
      fireEvent.change(within(form).getByLabelText('Ends'), { target: { value: '' } });
      await userEvent.click(within(form).getByRole('button', { name: 'Add project' }));
      expect(within(form).getByRole('alert')).toHaveTextContent('Pick an end date on or after the start.');
      fireEvent.change(within(form).getByLabelText('Ends'), { target: { value: '2027-02-01' } });
      await userEvent.click(within(form).getByRole('button', { name: 'Add project' }));

      expect(await screen.findByText('Project added, Nov 2 to Feb 1.')).toBeVisible();
      expect(screen.queryByRole('form', { name: 'Add project' })).toBeNull();
      expect(await screen.findByText('Draft chapters')).toBeVisible();
      const rows = await t.db.all<{ title: string; end: string }>("SELECT title, end FROM project WHERE title = 'Draft chapters'");
      expect(rows).toEqual([{ title: 'Draft chapters', end: '2027-02-01' }]);
    });

    it('asks the overdue question: Move date previews the status, logs the change with Undo and a badge', async () => {
      const t = await project(layout);
      const fix = await screen.findByRole('group', { name: 'Make a starter was due Oct 25' });
      expect(within(fix).getByText('1 of 2 tasks done, 2h left.')).toBeVisible();
      await userEvent.click(within(fix).getByRole('button', { name: 'Move date' }));
      expect(within(fix).getByLabelText('New due date')).toHaveValue('2026-11-09');
      expect(within(fix).getByText('Project goes from Overdue to Behind.')).toBeVisible();
      fireEvent.change(within(fix).getByLabelText('New due date'), { target: { value: '' } });
      expect(within(fix).getByText('Pick a date after Nov 2.')).toBeVisible();
      expect(within(fix).getByRole('button', { name: 'Move date' })).toBeDisabled();
      fireEvent.change(within(fix).getByLabelText('New due date'), { target: { value: '2026-11-09' } });
      await userEvent.click(within(fix).getByRole('button', { name: 'Move to Nov 9' }));

      expect(await screen.findByText('Nov 2: Moved Make a starter from Oct 25 to Nov 9. Project went from Overdue to Behind.')).toBeVisible();
      expect(screen.getByText('Replanned: 15 days later')).toBeVisible();
      expect(screen.queryByRole('group', { name: /was due/ })).toBeNull();
      expect((await record(t, 'milestone', 'm1'))).toMatchObject({ due: '2026-11-09' });

      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(await screen.findByRole('group', { name: 'Make a starter was due Oct 25' })).toBeVisible();
      expect(screen.queryByText(/Replanned/)).toBeNull();
    });
  });

  it('drops an overdue milestone, moving its open task to the next one, and undoes', async () => {
    const t = await project();
    const fix = await screen.findByRole('group', { name: 'Make a starter was due Oct 25' });
    await userEvent.click(within(fix).getByRole('button', { name: 'Drop milestone' }));
    expect(within(fix).getByText('Drop Make a starter?')).toBeVisible();
    expect(within(fix).getByText('Its 1 done task stays on record.')).toBeVisible();
    expect(within(fix).getByRole('radio', { name: 'Move to First loaf, due Nov 20' })).toBeChecked();
    await userEvent.click(within(fix).getByRole('button', { name: 'Drop milestone' }));

    expect(await screen.findByText('Nov 2: Dropped Make a starter. Moved 1 task to First loaf. Project went from Overdue to Behind.')).toBeVisible();
    expect(screen.getByText('Replanned: 1 milestone dropped')).toBeVisible();
    expect(await record(t, 'task', 't2')).toMatchObject({ milestone_id: 'm2', moved_from: 'm1' });
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await record(t, 'task', 't2'))?.milestone_id).toBe('m1'));
  });

  it('cancels a dropped milestone\'s open task when asked, freeing its time', async () => {
    const t = await project('desktop', async (w) => {
      await bread(w);
      await w.create('time_block', { task_id: 't2', start: '2026-11-03T15:00:00Z', end: '2026-11-03T17:00:00Z', tz: 'America/Chicago' }, 'b1');
    });
    const fix = await screen.findByRole('group', { name: 'Make a starter was due Oct 25' });
    await userEvent.click(within(fix).getByRole('button', { name: 'Drop milestone' }));
    await userEvent.click(within(fix).getByRole('radio', { name: 'Cancel it, 2h off the project' }));
    await userEvent.click(within(fix).getByRole('button', { name: 'Drop milestone' }));
    expect(await screen.findByText(/Cancelled 1 task/)).toBeVisible();
    expect((await record(t, 'task', 't2'))?.cancelled_at).toBeTruthy();
    expect((await getRecord(t.db, 'time_block', 'b1'))?.cancelled).toBe(true);
  });

  it('marks an overdue milestone\'s open tasks done, and unticking brings the question back', async () => {
    const t = await project();
    const fix = await screen.findByRole('group', { name: 'Make a starter was due Oct 25' });
    await userEvent.click(within(fix).getByRole('button', { name: 'Mark 1 task done' }));
    expect(await screen.findByText(/Marked Make a starter done, and ticked 1 task/)).toBeVisible();
    expect(screen.queryByRole('group', { name: /was due/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));

    await userEvent.click(await within(group('Make a starter')).findByRole('checkbox', { name: 'Feed the starter done' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: /was due/ })).toBeNull());
    expect((await record(t, 'task', 't2'))?.done_at).toBeTruthy();
    await userEvent.click(within(group('Make a starter')).getByRole('button', { name: 'Show 2 completed in Make a starter' }));
    await userEvent.click(within(group('Make a starter')).getByRole('checkbox', { name: 'Feed the starter done' }));
    expect(await screen.findByRole('group', { name: 'Make a starter was due Oct 25' })).toBeVisible();
  });

  it('folds milestones: the next open one starts open, met ones folded, progress always on the row', async () => {
    await project();
    const fold = (name: string) => screen.findByRole('button', { name: `${name} tasks` });
    expect(await fold('Make a starter')).toHaveAttribute('aria-expanded', 'true');
    expect(await fold('Buy flour')).toHaveAttribute('aria-expanded', 'false');
    expect(await fold('First loaf')).toHaveAttribute('aria-expanded', 'false');
    expect(within(group('Make a starter')).getByText('1 of 2 done, due Oct 25')).toBeVisible();
    expect(within(group('Buy flour')).getByText('Met Oct 9')).toBeVisible();
    expect(within(group('First loaf')).getByText('0 of 1 done, due Nov 20')).toBeVisible();
    expect(within(group('First loaf')).queryByText('Shape the dough')).toBeNull();
    await userEvent.click(await fold('First loaf'));
    expect(within(group('First loaf')).getByText('Shape the dough')).toBeVisible();
    expect(within(group('Make a starter')).getByText('Milestone: Make a starter')).toHaveClass('latetext');
  });

  it('ends with the implicit Done at the project end, holding the tasks with no milestone, in the list and on the timeline', async () => {
    await project('desktop', async (w) => {
      await bread(w);
      await w.create('task', { kind: 'project', project_id: 'p1', title: 'Clean the oven', estimate_min: 30 }, 't5');
    });
    const done = await screen.findByRole('group', { name: 'Done, due Dec 15' });
    const groups = screen.getAllByRole('group').filter((g) => g.classList.contains('msgroup'));
    expect(groups.at(-1)).toBe(done);
    expect(within(done).getByText('Done')).toBeVisible();
    expect(done.querySelector('.msdia.done.on')).not.toBeNull();
    await userEvent.click(within(done).getByRole('button', { name: 'Done tasks' }));
    expect(within(done).getByText('Clean the oven')).toBeVisible();
    expect(screen.queryByText('Tasks with no milestone')).toBeNull();
    expect(screen.getByRole('img', { name: /Milestone Share a loaf, due Dec 10, in the plan\. Milestone Done, due Dec 15, in the plan\.$/ })).toBeInTheDocument();
  });

  it('task rows show the same Edit cue as milestone rows', async () => {
    await project();
    expect(within(await screen.findByRole('button', { name: 'Edit task Feed the starter, 2h' })).getByText('Edit')).toHaveClass('editcue');
  });

  it('opens the first milestone added to a project that had none, ready for its tasks', async () => {
    await project('desktop', async (w) => {
      await w.create('project', { title: 'Paint the fence', state: 'active', start: '2026-11-02', end: '2026-12-15' }, 'p1');
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Add milestone' }));
    const editor = screen.getByRole('dialog', { name: 'Add milestone' });
    await userEvent.type(within(editor).getByLabelText('Name'), 'Buy the paint');
    fireEvent.change(within(editor).getByLabelText('Due date'), { target: { value: '2026-11-20' } });
    await userEvent.click(within(editor).getByRole('button', { name: 'Add' }));
    await userEvent.click(await within(editor).findByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('button', { name: 'Buy the paint tasks' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Add task to Buy the paint' })).toBeVisible();
  });

  describe.each(['desktop', 'phone'] as const)('tasks on %s', (layout) => {
    it('adds tasks with the estimate slider, staying open; edits move them; delete has Undo', async () => {
      const t = await project(layout);
      await userEvent.click(await screen.findByRole('button', { name: 'Add task to Make a starter' }));
      let editor = screen.getByRole('dialog', { name: 'Add task' });
      expect(within(editor).getByLabelText('Milestone')).toHaveValue('m1');
      await userEvent.click(within(editor).getByRole('button', { name: 'Add' }));
      expect(within(editor).getByRole('alert')).toHaveTextContent('Give it a title.');
      await userEvent.type(within(editor).getByLabelText('Title'), 'Proof the dough');
      fireEvent.change(within(editor).getByRole('slider', { name: 'Time estimate' }), { target: { value: String(EST_STEPS.indexOf(45)) } });
      await userEvent.click(within(editor).getByRole('button', { name: 'Add' }));
      expect(await within(editor).findByText('Added Proof the dough.')).toBeVisible();
      expect(within(editor).getByLabelText('Title')).toHaveValue('');
      await userEvent.click(within(editor).getByRole('button', { name: 'Done' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      const added = await t.db.all<{ milestone_id: string; estimate_min: number }>(
        "SELECT milestone_id, estimate_min FROM task WHERE title = 'Proof the dough'",
      );
      expect(added).toEqual([{ milestone_id: 'm1', estimate_min: 45 }]);

      await userEvent.click(await screen.findByRole('button', { name: 'Edit task Feed the starter, 2h' }));
      editor = screen.getByRole('dialog', { name: 'Edit task' });
      expect(within(editor).getByRole('slider', { name: 'Time estimate' })).toHaveAttribute('aria-valuetext', '2h');
      await userEvent.selectOptions(within(editor).getByLabelText('Milestone'), 'First loaf');
      await userEvent.click(within(editor).getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('Moved Feed the starter to First loaf.')).toBeVisible();
      expect((await record(t, 'task', 't2'))?.milestone_id).toBe('m2');
      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await waitFor(async () => expect((await record(t, 'task', 't2'))?.milestone_id).toBe('m1'));

      await userEvent.click(await screen.findByRole('button', { name: 'Edit task Feed the starter, 2h' }));
      await userEvent.click(within(screen.getByRole('dialog', { name: 'Edit task' })).getByRole('button', { name: 'Delete task' }));
      expect(await screen.findByText('Deleted Feed the starter.')).toBeVisible();
      expect((await record(t, 'task', 't2'))?.deleted_at).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(await screen.findByRole('button', { name: 'Edit task Feed the starter, 2h' })).toBeVisible();
    });

    const addOutsideMilestones = async (title: string) => {
      await userEvent.click(await screen.findByRole('button', { name: layout === 'phone' ? '+ Task' : 'Add task' }));
      const editor = screen.getByRole('dialog', { name: 'Add task' });
      expect(within(editor).getByLabelText('Milestone')).toHaveValue('');
      await userEvent.type(within(editor).getByLabelText('Title'), title);
      await userEvent.click(within(editor).getByRole('button', { name: 'Add' }));
      await userEvent.click(await within(editor).findByRole('button', { name: 'Done' }));
    };

    it('a task added outside a milestone shows under Done, opening it, and stays there as the data reloads', async () => {
      const t = await project(layout, oneMilestone);
      await addOutsideMilestones('Buy flour');

      const done = screen.getByRole('group', { name: 'Done, due Dec 15' });
      expect(within(done).getByRole('button', { name: 'Done tasks' })).toHaveAttribute('aria-expanded', 'true');
      expect(await within(done).findByText('Buy flour')).toBeVisible();
      expect(screen.getAllByText('Buy flour')).toHaveLength(1);

      // A write from elsewhere, as a sync makes, reloads the project.
      await t.write((w) => w.create('task', { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Feed the starter', estimate_min: 30 }));
      expect(await within(group('Make a starter')).findByText('Feed the starter')).toBeVisible();
      expect(within(screen.getByRole('group', { name: 'Done, due Dec 15' })).getByText('Buy flour')).toBeVisible();
      expect(screen.getAllByText('Buy flour')).toHaveLength(1);
    });

    it('with no milestones, Add task still puts the task under Done', async () => {
      const t = await project(layout, async (w) => {
        await w.create('project', { title: 'Bake a sourdough loaf', state: 'active', start: '2026-10-01', end: '2026-12-15' }, 'p1');
      });
      await addOutsideMilestones('Buy flour');
      expect(await within(screen.getByRole('group', { name: 'Done, due Dec 15' })).findByText('Buy flour')).toBeVisible();
      expect(await t.db.all("SELECT milestone_id FROM task WHERE title = 'Buy flour'")).toEqual([{ milestone_id: null }]);
    });

    it('Done is the project end, not a stored milestone: nothing edits, drops or deletes it', async () => {
      await project(layout, async (w) => {
        await oneMilestone(w);
        await w.create('task', { kind: 'project', project_id: 'p1', title: 'Buy flour', estimate_min: 30 }, 't1');
      });
      const done = await screen.findByRole('group', { name: 'Done, due Dec 15' });
      const head = done.querySelector<HTMLElement>('.mshead')!;
      // Its head only folds: no Edit cue, and pressing or holding it opens nothing and lifts nothing.
      expect(within(head).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Done tasks']);
      expect(head.querySelector('.editcue')).toBeNull();
      await userEvent.click(within(head).getByText('Done'));
      fireEvent.pointerDown(within(head).getByText('Done'), { clientX: 50, clientY: 300, button: 0 });
      await new Promise((r) => setTimeout(r, 450));
      fireEvent.pointerUp(window, { clientX: 50, clientY: 300 });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.querySelector('.taskghost')).toBeNull();
      expect(screen.queryByRole('button', { name: /milestone Done/ })).toBeNull();
      expect(within(done).queryByRole('button', { name: /Drop|Delete/ })).toBeNull();
      // A task's editor offers Done, where tasks with no milestone sit, then the real milestones.
      await userEvent.click(within(head).getByRole('button', { name: 'Done tasks' }));
      await userEvent.click(within(done).getByRole('button', { name: /^Edit task Buy flour/ }));
      let editor = screen.getByRole('dialog', { name: 'Edit task' });
      expect(within(editor).getAllByRole('option').map((o) => o.textContent)).toEqual(['Done', 'Make a starter']);
      await userEvent.selectOptions(within(editor).getByLabelText('Milestone'), 'Make a starter');
      await userEvent.click(within(editor).getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('Moved Buy flour to Make a starter.')).toBeVisible();
      await userEvent.click(await within(group('Make a starter')).findByRole('button', { name: /^Edit task Buy flour/ }));
      editor = screen.getByRole('dialog', { name: 'Edit task' });
      await userEvent.selectOptions(within(editor).getByLabelText('Milestone'), 'Done');
      await userEvent.click(within(editor).getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('Moved Buy flour to Done.')).toBeVisible();
    });
  });

  // Completed tasks wait behind Show N completed: one choice, kept on this device, for every list.
  describe.each(['desktop', 'phone'] as const)('completed tasks on %s', (layout) => {
    // A tap on phone WebKit doesn't focus what it presses but the page around it, as the app's pane.
    const press = async (el: HTMLElement) => {
      if (layout === 'desktop') return userEvent.click(el);
      const page = el.closest<HTMLElement>('[data-layout]')!;
      page.tabIndex = -1;
      page.focus();
      fireEvent.click(el);
    };
    const more = async (w: Writer) => {
      await bread(w);
      const task = (id: string, title: string, extra = {}) =>
        w.create('task', { kind: 'project', project_id: 'p1', milestone_id: 'm1', title, estimate_min: 15, ...extra }, id);
      await task('t5', 'Buy a jar', { cancelled_at: '2026-10-15T15:00:00Z' });
      await task('t6', 'Warm the water');
      await task('t7', 'Wash the bowl', { milestone_id: null, done_at: '2026-10-21T15:00:00Z' });
      await w.create('milestone', { project_id: 'p1', title: 'Old idea', due: '2026-11-20', dropped_at: '2026-10-20T15:00:00Z' }, 'm9');
      await task('t9', 'Try rye', { milestone_id: 'm9', cancelled_at: '2026-10-20T15:00:00Z' });
    };
    const starter = () => screen.findByRole('group', { name: 'Milestone: Make a starter' });

    it('hides them by default, still counted, and Show completed shows them in every group until Hide completed', async () => {
      await project(layout, more);
      const ms = await starter();
      expect(within(ms).getByText('Feed the starter')).toBeVisible();
      expect(within(ms).queryByText('Mix flour and water')).toBeNull();
      // Cancelled isn't completed: it stays in view and out of the count, as in the progress.
      expect(within(ms).getByText('Buy a jar')).toHaveClass('done');
      expect(within(ms).getByText('1 of 3 done, due Oct 25')).toBeVisible();
      // Named for its group, since every group can have one.
      const show = within(ms).getByRole('button', { name: 'Show 1 completed in Make a starter' });
      expect(show).toHaveTextContent(/^Show 1 completed$/);
      expect(show).toHaveAttribute('aria-expanded', 'false');
      await userEvent.click(screen.getByRole('button', { name: 'Old idea tasks' }));
      expect(within(group('Old idea')).getByText('Try rye')).toBeVisible();
      expect(within(group('Old idea')).queryByRole('button', { name: /completed/ })).toBeNull();

      await userEvent.click(show);
      expect(within(ms).getByText('Mix flour and water')).toHaveClass('done');
      expect(show).toHaveTextContent(/^Hide completed$/);
      expect(show).toHaveAccessibleName('Hide completed in Make a starter');
      expect(show).toHaveAttribute('aria-expanded', 'true');
      expect(show).toHaveFocus();
      expect(localStorage.getItem('multiscale.showCompleted')).toBe('true');
      // A folded group opens with its completed tasks showing too.
      await userEvent.click(screen.getByRole('button', { name: 'Buy flour tasks' }));
      expect(within(group('Buy flour')).getByText('Order flour')).toBeVisible();
      expect(within(group('Buy flour')).getByRole('button', { name: 'Hide completed in Buy flour' })).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Done tasks' }));
      expect(screen.getByRole('button', { name: 'Hide completed in Done' })).toBeVisible();

      await userEvent.click(show);
      expect(within(ms).queryByText('Mix flour and water')).toBeNull();
      expect(within(group('Buy flour')).queryByText('Order flour')).toBeNull();
      expect(within(group('Buy flour')).getByRole('button', { name: 'Show 1 completed in Buy flour' })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('Wash the bowl')).toBeNull();
    });

    it('ticking one while they are hidden takes it out of view with Undo, and focus moves to the next task, else to Show completed', async () => {
      const t = await project(layout, more);
      const ms = await starter();
      await press(within(ms).getByRole('checkbox', { name: 'Feed the starter done' }));
      expect(await screen.findByText('Completed Feed the starter.')).toBeVisible();
      await waitFor(() => expect(within(ms).queryByText('Feed the starter')).toBeNull());
      expect(within(ms).getByRole('checkbox', { name: 'Warm the water done' })).toHaveFocus();
      expect(within(ms).getByRole('button', { name: 'Show 2 completed in Make a starter' })).toBeVisible();
      expect(within(ms).getByText('2 of 3 done, due Oct 25')).toBeVisible();

      // First loaf has nothing completed yet, so its Show completed arrives with the tick.
      await press(screen.getByRole('button', { name: 'First loaf tasks' }));
      const loaf = group('First loaf');
      expect(within(loaf).queryByRole('button', { name: /completed/ })).toBeNull();
      await press(within(loaf).getByRole('checkbox', { name: 'Shape the dough done' }));
      expect(await screen.findByText('Completed Shape the dough.')).toBeVisible();
      await waitFor(() => expect(within(loaf).getByRole('button', { name: 'Show 1 completed in First loaf' })).toHaveFocus());

      // Undo goes with its toast, so focus lands back on the task.
      await press(screen.getByRole('button', { name: 'Undo' }));
      const back = await within(loaf).findByRole('checkbox', { name: 'Shape the dough done' });
      expect(back).not.toBeChecked();
      await waitFor(() => expect(back).toHaveFocus());
      expect((await record(t, 'task', 't3'))?.done_at).toBeNull();
    });

    it('a task completed elsewhere while its editor is open stays until the editor closes, keeping what was typed', async () => {
      const t = await project(layout, more);
      const ms = await starter();
      await userEvent.click(within(ms).getByRole('button', { name: /^Edit task Feed the starter/ }));
      const title = within(await screen.findByRole('dialog', { name: 'Edit task' })).getByRole('textbox', { name: 'Title' });
      await userEvent.clear(title);
      await userEvent.type(title, 'Feed the starter twice');
      await t.write((w) => w.set('task', 't2', { done_at: '2026-11-02T20:00:00Z' }));
      await waitFor(() => expect(within(ms).getByRole('checkbox', { name: 'Feed the starter done' })).toBeChecked());
      expect(screen.getByRole('dialog', { name: 'Edit task' })).toBeVisible();
      expect(title).toHaveValue('Feed the starter twice');

      await userEvent.click(within(screen.getByRole('dialog', { name: 'Edit task' })).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(within(ms).queryByText('Feed the starter')).toBeNull());
      await userEvent.click(within(ms).getByRole('button', { name: 'Show 2 completed in Make a starter' }));
      expect(screen.queryByRole('dialog', { name: 'Edit task' })).toBeNull();
    });

    it('shown, as kept from before, a completed task unticks and ticks again in place', async () => {
      localStorage.setItem('multiscale.showCompleted', 'true');
      const t = await project(layout, more);
      const ms = await starter();
      const mix = within(ms).getByRole('checkbox', { name: 'Mix flour and water done' });
      expect(mix).toBeChecked();
      await userEvent.click(mix);
      await waitFor(async () => expect((await record(t, 'task', 't1'))?.done_at).toBeNull());
      expect(await within(ms).findByRole('button', { name: /^Edit task Mix flour and water/ })).toBeVisible();
      expect(mix).toHaveFocus();
      await userEvent.click(mix);
      await waitFor(() => expect(within(ms).getByText('Mix flour and water')).toHaveClass('done'));
      expect(mix).toBeChecked();
      expect(screen.queryByText(/^Completed /)).toBeNull();
    });
  });

  describe('moving tasks by holding them on phone', () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const point = (el: Element | null) => {
      document.elementFromPoint = () => el;
    };
    afterEach(() => {
      // jsdom has no layout, so each test says what is under the finger.
      document.elementFromPoint = () => null;
    });

    it('lifts a held task onto another milestone, lights the target, and the release does not open it', async () => {
      const t = await project('phone');
      const row = await screen.findByRole('button', { name: 'Edit task Feed the starter, 2h' });
      fireEvent.pointerDown(row, { clientX: 50, clientY: 300, button: 0 });
      await wait(450);
      expect(row.closest('.taskline')).toHaveClass('lifted');
      point(within(group('First loaf')).getByText('Milestone: First loaf'));
      fireEvent.pointerMove(window, { clientX: 50, clientY: 400 });
      expect(group('First loaf')).toHaveClass('dropon');
      fireEvent.pointerUp(window, { clientX: 50, clientY: 400 });
      fireEvent.click(row);
      expect(screen.queryByRole('dialog', { name: 'Edit task' })).toBeNull();
      await waitFor(async () => expect((await record(t, 'task', 't2'))?.milestone_id).toBe('m2'));
      expect(await screen.findByText('Moved Feed the starter to First loaf.')).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await waitFor(async () => expect((await record(t, 'task', 't2'))?.milestone_id).toBe('m1'));
    });

    it('scrolls instead when the finger moves before the hold, puts it down on cancel, and keeps it on a drop over nothing', async () => {
      const t = await project('phone');
      const row = await screen.findByRole('button', { name: 'Edit task Feed the starter, 2h' });
      fireEvent.pointerDown(row, { clientX: 50, clientY: 300, button: 0 });
      fireEvent.pointerMove(window, { clientX: 50, clientY: 330 });
      await wait(450);
      expect(row.closest('.taskline')).not.toHaveClass('lifted');

      fireEvent.pointerDown(row, { clientX: 50, clientY: 300, button: 0 });
      await wait(450);
      fireEvent.pointerCancel(window);
      expect(row.closest('.taskline')).not.toHaveClass('lifted');

      fireEvent.pointerDown(row, { clientX: 50, clientY: 300, button: 0 });
      await wait(450);
      fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
      expect(row.closest('.taskline')).not.toHaveClass('lifted');
      expect((await record(t, 'task', 't2'))?.milestone_id).toBe('m1');
    });

    it('holds a new task with no milestone out of Done onto a milestone', async () => {
      const t = await project('phone');
      await userEvent.click(await screen.findByRole('button', { name: '+ Task' }));
      const editor = screen.getByRole('dialog', { name: 'Add task' });
      await userEvent.type(within(editor).getByLabelText('Title'), 'Buy a proofing basket');
      await userEvent.click(within(editor).getByRole('button', { name: 'Add' }));
      await userEvent.click(await within(editor).findByRole('button', { name: 'Done' }));
      const done = screen.getByRole('group', { name: 'Done, due Dec 15' });
      const row = within(done).getByRole('button', { name: /^Edit task Buy a proofing basket/ });

      fireEvent.pointerDown(row, { clientX: 50, clientY: 300, button: 0 });
      await wait(450);
      point(group('Make a starter'));
      fireEvent.pointerMove(window, { clientX: 50, clientY: 200 });
      fireEvent.pointerUp(window, { clientX: 50, clientY: 200 });
      expect(await within(group('Make a starter')).findByText('Buy a proofing basket')).toBeVisible();
      expect(within(done).queryByText('Buy a proofing basket')).toBeNull();
      const [added] = await t.db.all<{ milestone_id: string }>("SELECT milestone_id FROM task WHERE title = 'Buy a proofing basket'");
      expect(added?.milestone_id).toBe('m1');
    });
  });

  it('on desktop, the inline add forms give focus back to their button on Esc and on save', async () => {
    await renderScreen('goals', { seed: bread });
    await userEvent.click(await screen.findByRole('button', { name: /Learn to bake bread/ }));
    const addProject = screen.getByRole('button', { name: 'Add project' });
    await userEvent.click(addProject);
    expect(within(screen.getByRole('form', { name: 'Add project' })).getByLabelText('Name')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('form', { name: 'Add project' })).toBeNull();
    expect(addProject).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('Draft chapters{Enter}');
    expect(await screen.findByText(/^Project added/)).toBeVisible();
    await waitFor(() => expect(addProject).toHaveFocus());

    const addPractice = screen.getByRole('button', { name: 'Add practice' });
    await userEvent.click(addPractice);
    await userEvent.keyboard('{Escape}');
    expect(addPractice).toHaveFocus();
  });

  it('closes an editor with Esc and puts focus back on its row', async () => {
    await project();
    const row = await screen.findByRole('button', { name: 'Edit task Feed the starter, 2h' });
    await userEvent.click(row);
    expect(screen.getByRole('dialog', { name: 'Edit task' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(row).toHaveFocus();
  });

  it('adds milestones with date rules, stays open, and pushes the end when it has to', async () => {
    const t = await project();
    await userEvent.click(await screen.findByRole('button', { name: 'Add milestone' }));
    const editor = screen.getByRole('dialog', { name: 'Add milestone' });
    await userEvent.click(within(editor).getByRole('button', { name: 'Add' }));
    expect(within(editor).getByRole('alert')).toHaveTextContent('Give it a name.');
    await userEvent.type(within(editor).getByLabelText('Name'), 'Bake for a party');
    fireEvent.change(within(editor).getByLabelText('Due date'), { target: { value: '2026-10-01' } });
    await userEvent.click(within(editor).getByRole('button', { name: 'Add' }));
    expect(within(editor).getByRole('alert')).toHaveTextContent('Pick today or a later date.');
    fireEvent.change(within(editor).getByLabelText('Due date'), { target: { value: '2027-01-05' } });
    expect(within(editor).getByText("That moves the project's end to Jan 5.")).toBeVisible();
    await userEvent.click(within(editor).getByRole('button', { name: 'Add' }));
    expect(await within(editor).findByText('Added Bake for a party.')).toBeVisible();
    expect(within(editor).getByLabelText('Name')).toHaveValue('');
    expect((await record(t, 'project', 'p1'))).toMatchObject({ end: '2027-01-05' });
    const added = await t.db.all<{ added_on: string; due: string }>("SELECT added_on, due FROM milestone WHERE title = 'Bake for a party'");
    expect(added).toEqual([{ added_on: '2026-11-02', due: '2027-01-05' }]);
  });

  it('edits a milestone: a rename logs nothing, a later date is slip, met and not met, plan toggle', async () => {
    const t = await project('desktop', async (w) => {
      await bread(w);
      await w.create('milestone', { project_id: 'p1', title: 'Write the recipe', due: '2026-12-01' }, 'm4');
    });
    await userEvent.click(await screen.findByRole('button', { name: /^Edit milestone First loaf/ }));
    let editor = screen.getByRole('dialog', { name: 'Edit milestone' });
    await userEvent.clear(within(editor).getByLabelText('Name'));
    await userEvent.type(within(editor).getByLabelText('Name'), 'First good loaf');
    await userEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await record(t, 'milestone', 'm2'))?.title).toBe('First good loaf'));
    expect(screen.queryByText(/Nov 2: /)).toBeNull();

    await userEvent.click(await screen.findByRole('button', { name: /^Edit milestone First good loaf/ }));
    editor = screen.getByRole('dialog', { name: 'Edit milestone' });
    fireEvent.change(within(editor).getByLabelText('Due date'), { target: { value: '2026-12-05' } });
    expect(within(editor).getByText('This puts it after Write the recipe.')).toBeVisible();
    await userEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Nov 2: Moved First good loaf from Nov 20 to Dec 5\./)).toBeVisible();

    await userEvent.click(await screen.findByRole('button', { name: /^Edit milestone Write the recipe/ }));
    editor = screen.getByRole('dialog', { name: 'Edit milestone' });
    expect(within(editor).getByRole('checkbox', { name: 'In this plan, Oct 1 to Dec 31' })).toBeChecked();
    expect(within(editor).queryByRole('button', { name: 'Not met' })).toBeNull();
    await userEvent.click(within(editor).getByRole('button', { name: 'Mark met' }));
    expect(await screen.findByText(/Nov 2: Marked Write the recipe done\./)).toBeVisible();
    expect((await record(t, 'milestone', 'm4'))?.met_at).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: /^Edit milestone Write the recipe/ }));
    editor = screen.getByRole('dialog', { name: 'Edit milestone' });
    expect(within(editor).queryByLabelText('Due date')).toBeNull();
    await userEvent.click(within(editor).getByRole('button', { name: 'Not met' }));
    await waitFor(async () => expect((await record(t, 'milestone', 'm4'))?.met_at).toBeNull());
  });

  it('drops a milestone from its editor, and one added today leaves no trace', async () => {
    const t = await project();
    await userEvent.click(await screen.findByRole('button', { name: 'Add milestone' }));
    const add = screen.getByRole('dialog', { name: 'Add milestone' });
    await userEvent.type(within(add).getByLabelText('Name'), 'Try rye');
    fireEvent.change(within(add).getByLabelText('Due date'), { target: { value: '2026-11-30' } });
    await userEvent.click(within(add).getByRole('button', { name: 'Add' }));
    await within(add).findByText('Added Try rye.');
    await userEvent.click(within(add).getByRole('button', { name: 'Done' }));

    await userEvent.click(await screen.findByRole('button', { name: /^Edit milestone Try rye/ }));
    const editor = screen.getByRole('dialog', { name: 'Edit milestone' });
    await userEvent.click(within(editor).getByRole('button', { name: 'Drop milestone' }));
    expect(within(editor).getByText('Drop Try rye?')).toBeVisible();
    await userEvent.click(within(editor).getByRole('button', { name: 'Back' }));
    await userEvent.click(within(editor).getByRole('button', { name: 'Drop milestone' }));
    await userEvent.click(within(editor).getByRole('button', { name: 'Drop milestone' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Milestone: Try rye' })).toBeNull());
    expect(screen.queryByText(/Replanned/)).toBeNull();
    const rows = await t.db.all<{ deleted_at: string | null }>("SELECT deleted_at FROM milestone WHERE title = 'Try rye'");
    expect(rows[0]?.deleted_at).toBeTruthy();
  });

  it('pauses and resumes from Project settings', async () => {
    const t = await project();
    await userEvent.click(await screen.findByRole('button', { name: 'Project settings' }));
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByText('Nov 2: Paused.')).toBeVisible();
    expect((await record(t, 'project', 'p1'))?.state).toBe('paused');
    expect(screen.getAllByText('Paused').some((el) => el.classList.contains('pill'))).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByText('Nov 2: Resumed.')).toBeVisible();
    expect((await record(t, 'project', 'p1'))?.state).toBe('active');
  });

  it('finishing asks first, moves the project to Archived, and Restore brings it back with its tasks', async () => {
    const t = await renderScreen('goals', { seed: bread });
    await userEvent.click(await screen.findByRole('button', { name: /Learn to bake bread/ }));
    await userEvent.click(screen.getByRole('button', { name: /^Bake a sourdough loaf/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Project settings' }));
    expect(screen.getByText('Finishing cancels the 7h left.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Finish' }));
    expect(screen.getByText('Finish this project?')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel finishing' }));
    expect((await record(t, 'project', 'p1'))?.state).toBe('active');
    await userEvent.click(screen.getByRole('button', { name: 'Finish' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, finish' }));

    expect(await screen.findByText('Finished. Open tasks cancelled.')).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Bake a sourdough loaf/ })).toBeNull());
    expect((await record(t, 'task', 't2'))?.cancelled_at).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Archived (1)' }));
    expect(screen.getByText('Finished')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Restore Bake a sourdough loaf' }));
    expect(await screen.findByRole('button', { name: /^Bake a sourdough loaf/ })).toBeVisible();
    expect((await record(t, 'project', 'p1'))?.state).toBe('active');
    expect((await record(t, 'task', 't2'))?.cancelled_at).toBeNull();
  });

  it.each(['desktop', 'phone'] as const)('on %s, a project past its end asks up front, in red, and Change end date offers shortcuts', async (layout) => {
    const t = await renderScreen('goals', {
      layout,
      params: { project: 'p2' },
      seed: async (w) => {
        await w.create('project', { title: 'Fix the gate', state: 'active', start: '2026-09-01', end: '2026-10-20' }, 'p2');
        await w.create('task', { kind: 'project', project_id: 'p2', title: 'Buy hinges', estimate_min: 60 }, 'x1');
      },
    });
    expect(await screen.findByText('Past end date')).toBeVisible();
    expect(screen.getByText('Finishing cancels the 1h left.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Finish' })).toHaveClass('danger');
    expect(screen.getByRole('button', { name: 'Drop' })).toHaveClass('danger');
    expect(screen.getByRole('button', { name: 'Change end date' })).not.toHaveClass('danger');
    await userEvent.click(screen.getByRole('button', { name: 'Change end date' }));
    expect(screen.getByRole('button', { name: 'Change end date to Dec 2' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '2 weeks' }));
    await userEvent.click(screen.getByRole('button', { name: 'Change end date to Nov 16' }));
    expect(await screen.findByText('Nov 2: Done moved to Nov 16.')).toBeVisible();
    expect((await record(t, 'project', 'p2'))?.end).toBe('2026-11-16');
    expect(screen.queryByText('Past end date')).toBeNull();
  });

  describe('practices', () => {
    it('on desktop: no goal section, link to a goal, target slider, pause, end', async () => {
      const t = await renderScreen('goals', { seed: bread });
      await userEvent.click(await screen.findByRole('button', { name: /Practices with no goal/ }));
      await userEvent.click(screen.getByRole('button', { name: /^Stretch/ }));
      expect(screen.getByText(/0m of 1h 45m this week/)).toBeVisible();
      fireEvent.change(screen.getByRole('slider', { name: 'Target' }), { target: { value: '30' } });
      await waitFor(async () => expect((await record(t, 'practice', 'pr1'))?.target_min).toBe(30));
      await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
      await waitFor(async () => expect((await record(t, 'practice', 'pr1'))?.state).toBe('paused'));
      await userEvent.selectOptions(screen.getByLabelText('Goal'), 'Run a 10k');
      await waitFor(async () => expect((await record(t, 'practice', 'pr1'))?.objective_id).toBe('g2'));
      expect(within(screen.getByRole('button', { name: /Run a 10k/ })).queryByText(/Still a goal/)).toBeNull();
    });

    it('on phone: tapping opens its editor; add one with no goal; End practice', async () => {
      const t = await renderScreen('goals', { layout: 'phone', seed: bread });
      await userEvent.click(await screen.findByRole('button', { name: /Practices with no goal/ }));
      await userEvent.click(screen.getByRole('button', { name: /^Stretch/ }));
      const sheet = screen.getByRole('dialog', { name: 'Edit practice' });
      await userEvent.clear(within(sheet).getByLabelText('Name'));
      expect((await record(t, 'practice', 'pr1'))?.title).toBe('Stretch');
      await userEvent.type(within(sheet).getByLabelText('Name'), 'Stretch daily');
      await waitFor(async () => expect((await record(t, 'practice', 'pr1'))?.title).toBe('Stretch daily'));
      fireEvent.change(within(sheet).getByLabelText('New preferred time'), { target: { value: '18:30' } });
      await userEvent.click(within(sheet).getByRole('button', { name: 'Add time' }));
      await waitFor(async () => expect((await record(t, 'practice', 'pr1'))?.preferred_times).toEqual([420, 1110]));
      await userEvent.click(within(sheet).getByRole('button', { name: 'Remove 7am' }));
      await waitFor(async () => expect((await record(t, 'practice', 'pr1'))?.preferred_times).toEqual([1110]));
      await userEvent.click(within(sheet).getByRole('button', { name: 'End practice' }));
      expect(await screen.findByText('Stretch daily ended. Its history stays.')).toBeVisible();
      expect((await record(t, 'practice', 'pr1'))?.state).toBe('ended');

      await userEvent.click(screen.getByRole('button', { name: '+ Practice' }));
      const form = screen.getByRole('form', { name: 'Add practice' });
      await userEvent.click(within(form).getByRole('button', { name: 'Add practice' }));
      expect(within(form).getByRole('alert')).toHaveTextContent('Give it a name.');
      await userEvent.type(within(form).getByLabelText('Name'), 'Juggling');
      await userEvent.click(within(form).getByRole('button', { name: 'Add practice' }));
      expect(await screen.findByText('Practice added. Planning will place it from your next plan.')).toBeVisible();
      const rows = await t.db.all<{ objective_id: string | null; target_min: number }>("SELECT objective_id, target_min FROM practice WHERE title = 'Juggling'");
      expect(rows).toEqual([{ objective_id: null, target_min: 30 }]);
    });
  });

  it('on phone, offers planning when it is due', async () => {
    const planned = async (w: Writer) => (await bread(w), w.create('settings', { plan_stretch: { last_planned: '2026-10-01' } }, 'settings'));
    const t = await renderScreen('goals', { layout: 'phone', seed: planned, now: '2026-12-26T18:00:00Z' });
    await userEvent.click(await screen.findByRole('button', { name: 'Time to plan the next stretch' }));
    expect(t.nav().flow?.area).toBe('plan');
    cleanup();
    // Never planned, a first plan is due from the first day.
    await renderScreen('goals', { layout: 'phone', seed: bread });
    expect(await screen.findByRole('button', { name: 'Time to plan your first stretch' })).toBeVisible();
    cleanup();
    await renderScreen('goals', { layout: 'phone', seed: planned });
    await screen.findByRole('heading', { level: 1, name: 'Goals' });
    expect(screen.queryByRole('button', { name: /Time to plan/ })).toBeNull();
  });

  it('on phone, a project row opens its page', async () => {
    const t = await renderScreen('goals', { layout: 'phone', seed: bread });
    await userEvent.click(await screen.findByRole('button', { name: /Learn to bake bread/ }));
    await userEvent.click(screen.getByRole('button', { name: /^Bake a sourdough loaf/ }));
    expect(t.nav().route.params).toEqual({ project: 'p1' });
  });
});
