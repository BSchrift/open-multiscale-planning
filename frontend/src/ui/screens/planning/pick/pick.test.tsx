import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { localToInstant } from '../../../../core/dates';
import { getRecord, listRecords, outcomeId, setWeekPick, weekPickId, weekPlanId } from '../../../../core/records';
import type { Writer } from '../../../../core/records';
import { EST_STEPS } from '../../../components/EstimateSlider';
import { openPlanning, seedWeek } from '../testing';

afterEach(cleanup);

const WEEK = '2026-11-02';
const pick = (t: { db: Parameters<typeof getRecord>[0] }, task: string) => getRecord(t.db, 'week_pick', weekPickId(WEEK, task));
const minutesOf = async (t: { db: Parameters<typeof getRecord>[0] }, task: string) => {
  const p = await pick(t, task);
  return p && !p.deleted_at ? p.minutes : null;
};

async function seedPastEnd(w: Writer) {
  await seedWeek(w);
  await w.create('project', { title: 'Sort the photos', state: 'active', start: '2026-08-01', end: '2026-10-25' }, 'photos');
  await w.create('task', { kind: 'project', project_id: 'photos', title: 'Pick the best ones', estimate_min: 180 }, 'p1');
}

async function seedUnestimated(w: Writer) {
  await seedWeek(w);
  await w.create('task', { kind: 'project', project_id: 'report', milestone_id: 'm2', title: 'Outline chapter two' }, 't3');
  await w.create('task', { kind: 'one_off', title: 'Call the plumber', schedule: { type: 'once' } }, 'o3');
}

const rename = async (field: HTMLElement, name: string) => {
  await userEvent.clear(field);
  await userEvent.type(field, name);
};
/** A task's popup, opened from its title: focus starts on its name, read as the heading. */
const popupOf = async (title: string) => {
  const popup = await screen.findByRole('dialog', { name: title });
  await waitFor(() => expect(within(popup).getByRole('heading', { name: title })).toHaveFocus());
  return popup;
};
/** Renames a task in its popup, whose name opens a field. */
const renameIn = async (popup: HTMLElement, from: string, to: string) => {
  await userEvent.click(within(popup).getByRole('button', { name: `Rename ${from}` }));
  await rename(within(popup).getByRole('textbox', { name: 'Name' }), to);
};
const setEstimate = (slider: HTMLElement, minutes: number) => fireEvent.change(slider, { target: { value: String(EST_STEPS.indexOf(minutes)) } });
/** What Pick's live region last said. */
const said = () => document.querySelector('.planning .sr[role=status]')?.textContent ?? '';
/** A task's row, found by its done circle. */
const rowOf = (title: string) => screen.getByRole('checkbox', { name: `Already done: ${title}` }).closest('li')!;

/** Waits for a project's tasks, which are always listed under its name. */
const openCard = (name: string) => screen.findByRole('region', { name });
const cardOf = (name: string) => screen.getByRole('region', { name });
// Measure the flour, under Learn to bake bread, wasn't done in its block last week, so it needs a new time.
async function seedCarried(w: Writer) {
  await seedWeek(w);
  await w.create('task', { kind: 'project', project_id: 'bread', milestone_id: 'm3', title: 'Measure the flour', estimate_min: 60 }, 't5');
  await w.create('time_block', { task_id: 't5', start: '2026-10-29T23:00:00Z', end: '2026-10-30T00:00:00Z', tz: 'America/Chicago' }, 'tb5');
  await w.create('block_outcome', { result: 'not', answered_at: '2026-10-30T00:05:00Z' }, outcomeId('tb5'));
}

describe('Pick tasks: one list', () => {
  it("lists every project's tasks in one list, soonest first, under its name, with no pill, aim or timeline, then One offs, then a line for paused ones", async () => {
    await openPlanning({ step: 1, seed: seedWeek });
    await screen.findByRole('region', { name: 'Write the report' });
    const list = document.querySelector('.plist')!;
    expect([...list.querySelectorAll(':scope > section')].map((c) => c.getAttribute('aria-label'))).toEqual(['Write the report', 'Learn to bake bread', 'One offs', 'Plan the garden']);
    const report = cardOf('Write the report');
    expect(within(report).getByRole('heading', { level: 3 })).toHaveTextContent(/^Write the report$/);
    expect(within(report).queryByText('Overdue')).toBeNull();
    expect(within(report).queryByRole('img')).toBeNull();
    // Aims are in This week.
    expect(within(screen.getByRole('region', { name: 'This week' })).getByRole('img', { name: 'Weekly aim 4h, 0m planned, 4h short' })).toBeInTheDocument();
    expect(within(cardOf('Plan the garden')).getByText("0 open tasks. Can't be planned while paused.")).toBeInTheDocument();
  });

  it("walk case 8: a project is a heading, not a button, so it can't be closed and hide its tasks", async () => {
    await openPlanning({ step: 1, seed: seedWeek });
    const report = await screen.findByRole('region', { name: 'Write the report' });
    expect(within(report).queryByRole('button', { name: /^Write the report/ })).toBeNull();
    expect(report.querySelector('h3 button, [aria-expanded]:not(.btn)')).toBeNull();
    expect(within(report).getByRole('button', { name: 'Add 2h to this week: Collect the sources' })).toBeVisible();
  });

  it("puts a card's tasks under their milestones, with those under no milestone last, under Done", async () => {
    const t = await openPlanning({
      step: 1,
      seed: async (w) => {
        await seedWeek(w);
        await w.create('task', { kind: 'project', project_id: 'report', title: 'Print a copy', estimate_min: 30 }, 't9');
      },
    });
    const tasks = await screen.findByRole('region', { name: 'Write the report' });
    const heads = within(tasks).getAllByRole('heading', { level: 4 }).map((h) => h.getAttribute('aria-label'));
    expect(heads[0]).toMatch(/^Milestone: Gather notes, overdue since Oct 18/);
    expect(heads.at(-1)).toMatch(/^Done, by Dec 15/);
    expect(within(rowOf('Collect the sources')).getByText(/milestone overdue/)).toBeInTheDocument();
    expect(within(rowOf('Write chapter one')).getByText(/due Nov 9/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add 2h to this week: Collect the sources' }));
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBe(120));
    expect(await within(screen.getByRole('region', { name: 'This week' })).findByRole('img', { name: 'Weekly aim 4h, 2h planned, 2h short' })).toBeInTheDocument();
  });

  it('with no projects, a dashed card says so, and One offs shows', async () => {
    await openPlanning({ step: 1, seed: async (w) => void (await w.create('task', { kind: 'one_off', title: 'Fix the gate', estimate_min: 60, schedule: { type: 'once' } }, 'o2')) });
    expect(await screen.findByText('No projects to plan from yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to Goals' })).toBeInTheDocument();
    expect(within(cardOf('One offs')).getByRole('button', { name: 'Add 1h to this week: Fix the gate' })).toBeInTheDocument();
  });

  it('a project past its end asks to finish, change the end date or drop it', async () => {
    const t = await openPlanning({ step: 1, seed: seedPastEnd });
    expect(await screen.findByText('Finishing cancels the 3h left.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Change end date' }));
    await userEvent.click(screen.getByRole('button', { name: '2 weeks' }));
    await userEvent.click(screen.getByRole('button', { name: 'Change end date to Nov 16' }));
    await waitFor(async () => expect((await getRecord(t.db, 'project', 'photos'))?.end).toBe('2026-11-16'));
    cleanup();

    const u = await openPlanning({ step: 1, seed: seedPastEnd });
    expect(await screen.findByRole('button', { name: 'Finish' })).toHaveClass('danger');
    expect(screen.getByRole('button', { name: 'Drop' })).toHaveClass('danger');
    await userEvent.click(screen.getByRole('button', { name: 'Finish' }));
    expect(screen.getByRole('button', { name: 'Yes, finish' })).toHaveClass('danger');
    await userEvent.click(screen.getByRole('button', { name: 'Yes, finish' }));
    await waitFor(async () => expect((await getRecord(u.db, 'project', 'photos'))?.state).toBe('finished'));
    expect((await getRecord(u.db, 'task', 'p1'))?.cancelled_at).toBe('2026-11-02T20:00:00Z');
    cleanup();

    const v = await openPlanning({ step: 1, seed: seedPastEnd });
    await userEvent.click(await screen.findByRole('button', { name: 'Skip for now' }));
    await waitFor(async () => expect((await getRecord(v.db, 'week_plan', weekPlanId(WEEK)))?.skipped_past_end).toEqual(['photos']));
  });

  it("a task's title opens its popup, which renames it and gives focus back, and its time button still adds it", async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit task Collect the sources' }));
    const popup = await popupOf('Collect the sources');
    await renameIn(popup, 'Collect the sources', 'Collect the papers');
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.title).toBe('Collect the papers'));
    expect(screen.queryByRole('dialog', { name: /Collect the/ })).toBeNull();
    const renamed = await screen.findByRole('button', { name: 'Edit task Collect the papers' });
    await waitFor(() => expect(renamed).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Add 2h to this week: Collect the papers' }));
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBe(120));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sets an estimate on a task with none, which Pick then shows and its time button adds', async () => {
    const t = await openPlanning({ step: 1, seed: seedUnestimated });
    const open = await screen.findByRole('button', { name: 'Edit task Outline chapter two' });
    const row = open.closest<HTMLElement>('li')!;
    expect(within(row).getByText('No estimate')).toBeInTheDocument();
    await userEvent.click(open);
    const popup = await popupOf('Outline chapter two');
    expect(within(popup).getByRole('slider', { name: 'Time estimate' })).toHaveAttribute('aria-valuetext', 'No estimate');
    setEstimate(within(popup).getByRole('slider', { name: 'Time estimate' }), 90);
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't3'))?.estimate_min).toBe(90));
    await userEvent.click(await within(row).findByRole('button', { name: 'Add 1h 30m to this week: Outline chapter two' }));
    await waitFor(async () => expect(await minutesOf(t, 't3')).toBe(90));
  });

  it("One offs is a purple card, whose task's title opens its popup to rename it and set its time", async () => {
    const t = await openPlanning({ step: 1, seed: seedUnestimated });
    const oneOffs = await screen.findByRole('region', { name: 'One offs' });
    expect(oneOffs).toHaveClass('oo');
    await userEvent.click(within(oneOffs).getByRole('button', { name: 'Edit task Call the plumber' }));
    const popup = await popupOf('Call the plumber');
    await renameIn(popup, 'Call the plumber', 'Call the electrician');
    setEstimate(within(popup).getByRole('slider', { name: 'Time estimate' }), 30);
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect(await getRecord(t.db, 'task', 'o3')).toMatchObject({ title: 'Call the electrician', estimate_min: 30 }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await within(oneOffs).findByRole('button', { name: 'Add 30m to this week: Call the electrician' })).toBeInTheDocument();
    await waitFor(() => expect(within(oneOffs).getByRole('button', { name: 'Edit task Call the electrician' })).toHaveFocus());
  });
});

describe('Pick tasks: overdue where it is', () => {
  it('asks about an overdue milestone on its own line, over its tasks, and the overdue link jumps there', async () => {
    await openPlanning({ step: 1, seed: seedWeek });
    const report = await screen.findByRole('region', { name: 'Write the report' });
    const ask = within(report).getByRole('group', { name: 'Milestone: Gather notes, overdue since Oct 18' });
    expect(ask).toHaveTextContent('Gather notes, overdue since Oct 180 of 1 task done, 2h left.');
    for (const name of ['Already done: Gather notes', 'Keep Gather notes in the plan', 'Drop Gather notes']) expect(within(ask).getByRole('button', { name })).toBeInTheDocument();
    expect(ask.nextElementSibling).toContainElement(rowOf('Collect the sources'));
    await userEvent.click(screen.getByRole('button', { name: '1 overdue' }));
    expect(ask).toHaveFocus();
  });

  it('Keep in plan moves the date, with a separate tick to add its open tasks, as one change with Undo', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: 'Keep Gather notes in the plan' }));
    const form = screen.getByRole('form', { name: 'Keep Gather notes in the plan' });
    // Any date will do; it starts at the end of the week.
    expect(within(form).getByLabelText('New due date for Gather notes')).toHaveValue('2026-11-08');
    const tick = within(form).getByRole('checkbox', { name: 'Add its open task, Collect the sources (2h), to this week' });
    expect(tick).toBeChecked();
    expect(within(screen.getByRole('region', { name: 'Does it fit?' })).getByText('+2h on Save')).toBeInTheDocument();
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Kept Gather notes, due Nov 8. Added 2h.')).toBeInTheDocument();
    expect((await getRecord(t.db, 'milestone', 'm1'))?.due).toBe('2026-11-08');
    expect(await minutesOf(t, 't1')).toBe(120);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'milestone', 'm1'))?.due).toBe('2026-10-18'));
    expect(await minutesOf(t, 't1')).toBeNull();

    await userEvent.click(await screen.findByRole('button', { name: 'Keep Gather notes in the plan' }));
    const again = screen.getByRole('form', { name: 'Keep Gather notes in the plan' });
    await userEvent.click(within(again).getByRole('checkbox', { name: /^Add its open task/ }));
    fireEvent.change(within(again).getByLabelText('New due date for Gather notes'), { target: { value: '2026-11-20' } });
    await userEvent.click(within(again).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Kept Gather notes, due Nov 20.')).toBeInTheDocument();
    expect(await minutesOf(t, 't1')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Keep Gather notes in the plan' }));
    await userEvent.click(within(screen.getByRole('form', { name: 'Keep Gather notes in the plan' })).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Keep Gather notes in the plan' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Keep Gather notes in the plan' })).toHaveFocus();

    // Esc is Cancel too, and gives focus back the same way.
    await userEvent.click(screen.getByRole('button', { name: 'Keep Gather notes in the plan' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('form', { name: 'Keep Gather notes in the plan' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Keep Gather notes in the plan' })).toHaveFocus();
  });

  it('Already done ticks the milestone and its tasks, and Drop drops it, each with Undo', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: 'Already done: Gather notes' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBe('2026-11-02T20:00:00Z'));
    expect(await screen.findByText('Marked Gather notes done, and ticked 1 task.')).toBeInTheDocument();
    // The question has gone, so Undo takes focus.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBeNull());

    await userEvent.click(await screen.findByRole('button', { name: 'Drop Gather notes' }));
    await waitFor(async () => expect((await getRecord(t.db, 'milestone', 'm1'))?.dropped_at).toBeTruthy());
    expect(await screen.findByText('Dropped Gather notes.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'milestone', 'm1'))?.dropped_at).toBeFalsy());
  });

  it('with every task of the milestone in the week, it asks only about the date', async () => {
    await openPlanning({ step: 1, seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: 'Add 2h to this week: Collect the sources' }));
    expect(await screen.findByText('Its task is in this week. Still due Oct 18.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Move date: Gather notes' }));
    const form = screen.getByRole('form', { name: 'Keep Gather notes in the plan' });
    expect(within(form).queryByRole('checkbox')).toBeNull();
  });

  it('walk case 5: a task that needs a new time asks on its row: Keep in plan adds it at its estimate, and Drop cancels it', async () => {
    const t = await openPlanning({ step: 1, seed: seedCarried });
    const keep = await screen.findByRole('button', { name: 'Keep Measure the flour in the plan' });
    const row = keep.closest('li')!;
    expect(cardOf('Learn to bake bread')).toContainElement(row);
    expect(row).toHaveTextContent('Measure the flourNeeds a new time: not done Oct 29, 1h');
    expect(within(row).queryByRole('button', { name: /to this week/ })).toBeNull();
    expect(screen.getByRole('button', { name: '2 overdue' })).toBeInTheDocument();
    await userEvent.click(keep);
    await waitFor(async () => expect(await minutesOf(t, 't5')).toBe(60));
    expect(await screen.findByText('Added Measure the flour to this week, 1h.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep Measure the flour in the plan' })).toBeNull();
    expect(await screen.findByRole('button', { name: /^1h this week: Measure the flour/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await minutesOf(t, 't5')).toBeNull());

    await userEvent.click(await screen.findByRole('button', { name: 'Drop Measure the flour' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't5'))?.cancelled_at).toBeTruthy());
    expect(await screen.findByText('Dropped Measure the flour.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't5'))?.cancelled_at).toBeFalsy());
    expect(await screen.findByRole('button', { name: 'Keep Measure the flour in the plan' })).toBeInTheDocument();
  });
});

describe('Pick tasks: the week beside', () => {
  const week = () => screen.getByRole('region', { name: 'This week' });

  it("shows the week's shape, projects, One offs and practices against open time, and each project against its aim", async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await waitFor(() => expect(week()).toHaveTextContent('1h 30m of 98h, 96h 30m free'));
    expect(within(week()).getByText('Projects 0m')).toBeInTheDocument();
    expect(within(week()).getByText('One offs 1h 30m')).toBeInTheDocument();
    expect(within(week()).getByText('Practices and repeating work 0m')).toBeInTheDocument();
    expect(within(week()).getByRole('img', { name: 'Weekly aim 4h, 0m planned, 4h short' })).toBeInTheDocument();
    expect(within(week()).getByText('0m of 4h')).toBeInTheDocument();
    expect(within(week()).getByText('1h 30m, no aim')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add 2h to this week: Collect the sources' }));
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBe(120));
    expect(await within(week()).findByText('Projects 2h')).toBeInTheDocument();
    expect(within(week()).getByRole('button', { name: 'Continue to scheduling' })).toBeInTheDocument();
  });

  it('says over capacity as a number, and in the announcement when adding', async () => {
    const big = async (w: Writer) => {
      await seedWeek(w);
      await w.create('task', { kind: 'one_off', title: 'Paint the house', estimate_min: 6000, schedule: { type: 'once' } }, 'o9');
    };
    await openPlanning({ step: 1, seed: big });
    await userEvent.click(await within(await screen.findByRole('region', { name: 'One offs' })).findByRole('button', { name: 'Add 100h to this week: Paint the house' }));
    expect(await within(week()).findByText('101h 30m of 98h, 3h 30m over')).toHaveClass('overtext');
    await waitFor(() => expect(said()).toBe('Paint the house added. 101h 30m of 98h, 3h 30m over.'));
  });

  it('Add suggested previews each task, ticked, and adds those left ticked with one toast and Undo', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await screen.findByRole('region', { name: 'This week' });
    await userEvent.click(await within(week()).findByRole('button', { name: 'Add suggested 8h' }));
    const pop = screen.getByRole('dialog', { name: 'Add suggested' });
    expect(pop).toHaveTextContent('3 tasks, 8h. Untick any you don’t want.');
    expect(within(pop).getAllByRole('checkbox').every((b) => (b as HTMLInputElement).checked)).toBe(true);
    await userEvent.click(within(pop).getByRole('checkbox', { name: /^Write chapter one/ }));
    await userEvent.click(within(pop).getByRole('button', { name: 'Add 4h' }));
    expect(await screen.findByText('Added 2 tasks, 4h.')).toBeInTheDocument();
    expect(await minutesOf(t, 't1')).toBe(120);
    expect(await minutesOf(t, 'b1')).toBe(120);
    expect(await minutesOf(t, 't2')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBeNull());
    expect(await minutesOf(t, 'b1')).toBeNull();
    expect(await minutesOf(t, 'o1')).toBe(90);

    await userEvent.click(await within(week()).findByRole('button', { name: 'Add suggested 8h' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Add suggested' })).getByRole('button', { name: 'Cancel' }));
    expect(await minutesOf(t, 't1')).toBeNull();
  });

  it('Change aims opens a popover that Save writes for this week only, with Undo, and Cancel drops', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await screen.findByRole('region', { name: 'This week' });
    const plan = async () => getRecord(t.db, 'week_plan', weekPlanId(WEEK));
    await userEvent.click(await within(week()).findByRole('button', { name: 'Change aims for this week' }));
    let pop = screen.getByRole('dialog', { name: 'Aims for this week' });
    fireEvent.change(within(pop).getByLabelText('Aim for Write the report this week'), { target: { value: '4' } });
    await userEvent.click(within(pop).getByRole('button', { name: "Skip this week's aim, Learn to bake bread" }));
    expect((await plan())?.aims).toBeUndefined();
    await userEvent.click(within(pop).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Changed the aims for this week.')).toBeInTheDocument();
    expect((await plan())?.aims).toEqual({ report: 60 });
    expect((await plan())?.skipped_aims).toEqual(['bread']);
    expect((await getRecord(t.db, 'project', 'report'))?.weekly_aim).toBe(240);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await plan())?.aims).toEqual({}));
    expect((await plan())?.skipped_aims).toEqual([]);

    await userEvent.click(within(week()).getByRole('button', { name: 'Change aims for this week' }));
    pop = screen.getByRole('dialog', { name: 'Aims for this week' });
    fireEvent.change(within(pop).getByLabelText('Aim for Write the report this week'), { target: { value: '4' } });
    await userEvent.click(within(pop).getByRole('button', { name: 'Cancel' }));
    expect((await plan())?.aims).toEqual({});
  });
});

describe('Pick tasks: select mode', () => {
  const select = () => screen.getByRole('button', { name: 'Select', pressed: false });
  const bar = () => screen.getByRole('region', { name: 'Selected tasks' });

  it('ticks rows to add together, previewing the fit, with one toast and Undo', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
    expect(screen.getByRole('button', { name: 'Select', pressed: true })).toBeInTheDocument();
    const boxes = screen.getAllByRole('checkbox', { name: /^Select / });
    await waitFor(() => expect(boxes[0]).toHaveFocus());
    expect(screen.queryByRole('checkbox', { name: /^Already done:/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /to this week: / })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Select Paint the fence, in this week' }).closest('li')).toHaveTextContent('In this week · 1h 30m');

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Collect the sources' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Bake a test loaf' }));
    expect(bar()).toHaveTextContent('2 selected · 4h');
    expect(within(screen.getByRole('region', { name: 'Does it fit?' })).getByText('+4h if added: 5h 30m of 98h')).toBeInTheDocument();
    expect(within(bar()).getByRole('button', { name: 'Remove from week' })).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(within(bar()).getByRole('button', { name: 'Remove from week' }));
    expect(await minutesOf(t, 'o1')).toBe(90);
    await userEvent.click(within(bar()).getByRole('button', { name: 'Add to this week' }));
    expect(await screen.findByText('Added 2 tasks, 4h.')).toBeInTheDocument();
    expect(await minutesOf(t, 't1')).toBe(120);
    expect(await minutesOf(t, 'b1')).toBe(120);
    expect(select()).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBeNull());
    expect(await minutesOf(t, 'b1')).toBeNull();
  });

  it('removes from the week and finishes together, and Cancel puts focus back on Select', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Paint the fence, in this week' }));
    await userEvent.click(within(bar()).getByRole('button', { name: 'Remove from week' }));
    expect(await screen.findByText('Removed Paint the fence from this week.')).toBeInTheDocument();
    expect(await minutesOf(t, 'o1')).toBeNull();

    await userEvent.click(select());
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Write chapter one' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Collect the sources' }));
    await userEvent.click(within(bar()).getByRole('button', { name: 'Already done' }));
    expect(await screen.findByText('2 tasks done.')).toBeInTheDocument();
    expect((await getRecord(t.db, 'task', 't2'))?.done_at).toBeTruthy();
    expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't2'))?.done_at).toBeFalsy());

    await userEvent.click(select());
    await userEvent.click(within(bar()).getByRole('button', { name: 'Select all' }));
    expect(bar()).toHaveTextContent(/^\d+ selected/);
    await userEvent.click(within(bar()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'Selected tasks' })).toBeNull();
    expect(select()).toHaveFocus();
  });
});

describe('Pick tasks on phone', () => {
  it('shows cards under tabs, Projects and This week, and Does it fit shows This week', async () => {
    const t = await openPlanning({ step: 1, layout: 'phone', seed: seedWeek });
    const projects = await screen.findByRole('button', { name: 'Projects', pressed: true });
    const thisWeek = screen.getByRole('button', { name: 'This week, 1 task' });
    expect(thisWeek).toHaveTextContent('This week · 1');
    expect(projects).toBeInTheDocument();
    const report = cardOf('Write the report');
    await userEvent.click(within(report).getByRole('button', { name: 'Add 2h to this week: Collect the sources' }));
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBe(120));
    expect(screen.getByText('Collect the sources added. 3h 30m of 98h.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Does it fit? 3h 30m of 98h, 94h 30m free. Show This week' }));
    expect(screen.getByRole('button', { name: 'This week, 2 tasks', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'This week' })).toHaveTextContent('3h 30m of 98h, 94h 30m free');
    expect(screen.queryByRole('region', { name: 'Write the report' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Change time: Paint the fence, 1h 30m' }));
    expect(screen.getByRole('dialog', { name: 'Paint the fence' })).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Paint the fence' })).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove Paint the fence from this week' }));
    await waitFor(async () => expect(await minutesOf(t, 'o1')).toBeNull());
    expect(await screen.findByText('Removed Paint the fence from this week.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus());
  });

  it('asks about overdue work on one line, where Answer opens the three choices in place, then the form', async () => {
    await openPlanning({ step: 1, layout: 'phone', seed: seedWeek });
    const ask = await screen.findByRole('group', { name: 'Milestone: Gather notes, overdue since Oct 18' });
    expect(cardOf('Write the report')).toContainElement(ask);
    expect(within(ask).getByRole('heading')).toHaveTextContent(/^Gather notes, overdue$/);
    const answer = within(ask).getByRole('button', { name: 'Answer: Gather notes, overdue since Oct 18' });
    expect(answer).toHaveAttribute('aria-expanded', 'false');
    expect(within(ask).queryByRole('button', { name: 'Keep Gather notes in the plan' })).toBeNull();
    await userEvent.click(answer);
    expect(answer).toHaveAttribute('aria-expanded', 'true');
    const names = within(ask).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['Answer: Gather notes, overdue since Oct 18', 'Already done: Gather notes', 'Keep Gather notes in the plan', 'Drop Gather notes']);
    await userEvent.click(within(ask).getByRole('button', { name: 'Keep Gather notes in the plan' }));
    expect(within(ask).getByRole('form', { name: 'Keep Gather notes in the plan' })).toBeInTheDocument();
  });

  it('Add suggested previews them in a sheet, and Add puts focus on the Undo that reverses it', async () => {
    const t = await openPlanning({ step: 1, layout: 'phone', seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: 'Add suggested 8h' }));
    const sheet = screen.getByRole('dialog', { name: 'Add suggested' });
    expect(sheet).toHaveClass('sheet');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Add 8h' }));
    await waitFor(async () => expect(await minutesOf(t, 't2')).toBe(240));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus());
  });

  it('More holds Change aims and Select', async () => {
    const t = await openPlanning({ step: 1, layout: 'phone', seed: seedWeek });
    const more = await screen.findByRole('button', { name: 'More: change aims, select' });
    await userEvent.click(more);
    await userEvent.click(within(screen.getByRole('dialog', { name: 'More' })).getByRole('button', { name: 'Change aims for this week' }));
    const aims = screen.getByRole('dialog', { name: 'Aims for this week' });
    await userEvent.click(within(aims).getByRole('button', { name: "Skip this week's aim, Learn to bake bread" }));
    await userEvent.click(within(aims).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await getRecord(t.db, 'week_plan', weekPlanId(WEEK)))?.skipped_aims).toEqual(['bread']));
    await userEvent.click(more);
    await userEvent.click(within(screen.getByRole('dialog', { name: 'More' })).getByRole('button', { name: 'Select' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Collect the sources' }));
    const bar = screen.getByRole('region', { name: 'Selected tasks' });
    expect(bar).toHaveTextContent('1 selected · 2h');
    await userEvent.click(within(bar).getByRole('button', { name: 'Add to this week' }));
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBe(120));
  });

  it("a task's title opens its popup, with why it's suggested, which renames it, and its time button still adds it", async () => {
    const t = await openPlanning({ step: 1, layout: 'phone', seed: seedWeek });
    const card = await screen.findByRole('region', { name: 'Write the report' });
    await userEvent.click(within(card).getByRole('button', { name: 'Edit task Collect the sources' }));
    const popup = await popupOf('Collect the sources');
    expect(within(popup).getByText('Suggested: milestone overdue')).toBeInTheDocument();
    await renameIn(popup, 'Collect the sources', 'Collect the papers');
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.title).toBe('Collect the papers'));
    const renamed = await within(card).findByRole('button', { name: 'Edit task Collect the papers' });
    await waitFor(() => expect(renamed).toHaveFocus());
    await userEvent.click(within(card).getByRole('button', { name: 'Add 2h to this week: Collect the papers' }));
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBe(120));
  });
});

describe('Pick tasks: estimates and Mark done', () => {
  // Outline chapter two has no estimate and an hour already on Wednesday's calendar.
  const placed = async (w: Writer) => {
    await seedUnestimated(w);
    await w.create('time_block', { task_id: 't3', start: localToInstant('2026-11-04', 18 * 60, 'America/Chicago'), end: localToInstant('2026-11-04', 19 * 60, 'America/Chicago'), tz: 'America/Chicago' });
  };
  const openReport = () => openCard('Write the report');

  it('a task stays listed when its new estimate is all on the calendar, saying so', async () => {
    const t = await openPlanning({ step: 1, seed: placed });
    await openReport();
    await userEvent.click(screen.getByRole('button', { name: 'Add to this week: Outline chapter two' }));
    const pop = screen.getByRole('dialog', { name: 'Outline chapter two' });
    // With no estimate there's nothing to take a share of, so it says what's on the calendar.
    expect(within(pop).getByText('1h is on your calendar this week.')).toBeInTheDocument();
    expect(within(pop).queryByRole('slider', { name: 'This week' })).toBeNull();
    setEstimate(within(pop).getByRole('slider', { name: 'Estimate' }), 60);
    expect(within(pop).getByText('All 1h is on your calendar this week.')).toBeInTheDocument();
    expect(within(pop).queryByRole('slider', { name: 'This week' })).toBeNull();
    await userEvent.click(within(pop).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't3'))?.estimate_min).toBe(60));
    expect(await within(rowOf('Outline chapter two')).findByText('On the calendar')).toBeInTheDocument();
    expect(await minutesOf(t, 't3')).toBeNull();
    expect(within(rowOf('Outline chapter two')).queryByRole('button', { name: /to this week/ })).toBeNull();
    // Select mode says the same, not that it has no estimate.
    await userEvent.click(screen.getByRole('button', { name: 'Select' }));
    const selected = screen.getByRole('checkbox', { name: 'Select Outline chapter two' }).closest('li');
    expect(selected).toHaveTextContent('On the calendar');
    expect(selected).not.toHaveTextContent('No estimate');
  });

  // Write the abstract is in this week, and its whole 15 minutes are on Wednesday's calendar.
  const allPlaced = (minutes: number) => async (w: Writer) => {
    await seedWeek(w);
    await w.create('task', { kind: 'project', project_id: 'report', milestone_id: 'm2', title: 'Write the abstract', estimate_min: 15 }, 't4');
    await w.create('time_block', { task_id: 't4', start: localToInstant('2026-11-04', 18 * 60, 'America/Chicago'), end: localToInstant('2026-11-04', 18 * 60 + 15, 'America/Chicago'), tz: 'America/Chicago' });
    await setWeekPick(w, WEEK, 't4', minutes);
  };

  it("a task whose time is all on the calendar says so, with no This week slider, and Save leaves its week as it was", async () => {
    const t = await openPlanning({ step: 1, seed: allPlaced(15) });
    await openReport();
    const time = await screen.findByRole('button', { name: '15m of Write the abstract on your calendar this week' });
    expect(time).toHaveTextContent(/^15m on calendar/);
    await userEvent.click(time);
    const pop = screen.getByRole('dialog', { name: 'Write the abstract' });
    expect(within(pop).getByText('All 15m is on your calendar this week.')).toBeInTheDocument();
    expect(within(pop).queryByRole('slider', { name: 'This week' })).toBeNull();
    expect(within(pop).getByRole('slider', { name: 'Estimate' })).toHaveAttribute('aria-valuetext', '15m');
    for (const name of ['Already done', 'Remove from this week', 'Save', 'Cancel']) expect(within(pop).getByRole('button', { name })).toBeInTheDocument();
    await userEvent.click(within(pop).getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('dialog', { name: 'Write the abstract' })).toBeNull();
    expect(await minutesOf(t, 't4')).toBe(15);
  });

  it('a task partly on the calendar says how much is, under its This week slider', async () => {
    await openPlanning({
      step: 1,
      seed: async (w) => {
        await seedWeek(w);
        await w.create('time_block', { task_id: 't1', start: localToInstant('2026-11-04', 18 * 60, 'America/Chicago'), end: localToInstant('2026-11-04', 19 * 60, 'America/Chicago'), tz: 'America/Chicago' });
        await setWeekPick(w, WEEK, 't1', 60);
      },
    });
    await openReport();
    await userEvent.click(await screen.findByRole('button', { name: '1h this week: Collect the sources' }));
    const slider = within(screen.getByRole('dialog', { name: 'Collect the sources' })).getByRole('slider', { name: 'This week' });
    expect(slider).toHaveAttribute('aria-valuetext', '1h of 1h');
    expect(slider).toHaveAccessibleDescription('1h already on your calendar');
    expect(screen.getByText('1h already on your calendar')).toBeVisible();
  });

  it('raising the estimate of a task all on the calendar brings back This week, for the extra time', async () => {
    await openPlanning({ step: 1, seed: allPlaced(15) });
    await openReport();
    await userEvent.click(await screen.findByRole('button', { name: '15m of Write the abstract on your calendar this week' }));
    const pop = screen.getByRole('dialog', { name: 'Write the abstract' });
    setEstimate(within(pop).getByRole('slider', { name: 'Estimate' }), 45);
    expect(within(pop).getByRole('slider', { name: 'This week' })).toHaveAttribute('aria-valuetext', '30m of 30m');
    expect(within(pop).getByText('15m already on your calendar')).toBeInTheDocument();
    expect(within(pop).queryByText(/^All /)).toBeNull();
    setEstimate(within(pop).getByRole('slider', { name: 'Estimate' }), 15);
    expect(within(pop).queryByRole('slider', { name: 'This week' })).toBeNull();
    expect(within(pop).getByText('All 15m is on your calendar this week.')).toBeInTheDocument();
  });

  it('on phone, a task all on the calendar says so in its row, in This week, and in select mode', async () => {
    // A share of 0m, as the owner's was: what's on the calendar is what's shown.
    await openPlanning({ step: 1, layout: 'phone', seed: allPlaced(0) });
    const tray = await screen.findByRole('region', { name: 'Write the report' });
    expect(within(tray).getByRole('button', { name: '15m of Write the abstract on your calendar this week' })).toHaveTextContent(/^15m on calendar/);
    await userEvent.click(screen.getByRole('button', { name: 'More: change aims, select' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'More' })).getByRole('button', { name: 'Select' }));
    expect(screen.getByRole('checkbox', { name: 'Select Write the abstract, in this week' }).closest('li')).toHaveTextContent('In this week · 15m on calendar');
    await userEvent.click(within(screen.getByRole('region', { name: 'Selected tasks' })).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'This week, 2 tasks' }));
    expect(screen.getByRole('button', { name: 'Change time: Write the abstract, 15m on calendar' })).toHaveTextContent('15m on calendar');
  });

  it('the time popover waits for Save, with Undo; Esc keeps a change, and Cancel drops it', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await openReport();
    await userEvent.click(screen.getByRole('button', { name: 'Add 2h to this week: Collect the sources' }));
    const time = await screen.findByRole('button', { name: '2h this week: Collect the sources' });
    await userEvent.click(time);
    let pop = screen.getByRole('dialog', { name: 'Collect the sources' });
    setEstimate(within(pop).getByRole('slider', { name: 'Estimate' }), 60);
    await userEvent.keyboard('{Escape}');
    expect(within(pop).getByRole('alert')).toHaveTextContent("Your changes aren't saved. Save them, or Cancel to drop them.");
    expect(within(pop).getByRole('button', { name: 'Save' })).toHaveFocus();
    await userEvent.click(within(pop).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Collect the sources' })).toBeNull();
    expect((await getRecord(t.db, 'task', 't1'))?.estimate_min).toBe(120);

    await userEvent.click(time);
    pop = screen.getByRole('dialog', { name: 'Collect the sources' });
    // All of it was in the week, so the week's share follows the estimate.
    setEstimate(within(pop).getByRole('slider', { name: 'Estimate' }), 180);
    expect((await getRecord(t.db, 'task', 't1'))?.estimate_min).toBe(120);
    await userEvent.click(within(pop).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Collect the sources, 3h this week, 3h estimate.')).toBeVisible();
    expect((await getRecord(t.db, 'task', 't1'))?.estimate_min).toBe(180);
    expect(await minutesOf(t, 't1')).toBe(180);
    expect(screen.queryByRole('dialog', { name: 'Collect the sources' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: '3h this week: Collect the sources' })).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.estimate_min).toBe(120));
    expect(await minutesOf(t, 't1')).toBe(120);
  });

  it('on phone, the time popover is a sheet that Save writes, and the circle ticks it in place', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek, layout: 'phone' });
    const tray = await screen.findByRole('region', { name: 'Write the report' });
    await userEvent.click(within(tray).getByRole('button', { name: 'Add 2h to this week: Collect the sources' }));
    await userEvent.click(await within(tray).findByRole('button', { name: '2h this week: Collect the sources' }));
    const sheet = screen.getByRole('dialog', { name: 'Collect the sources' });
    setEstimate(within(sheet).getByRole('slider', { name: 'Estimate' }), 60);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.estimate_min).toBe(60));
    await userEvent.click(within(tray).getByRole('checkbox', { name: 'Already done: Collect the sources' }));
    await waitFor(() => expect(within(tray).getByRole('button', { name: 'Edit task Collect the sources, done' }).closest('li')).toHaveClass('done'));
  });
});

describe('Pick tasks: dragging an estimate', () => {
  it('saves a drag once, when it is let go, with the slider following it throughout, and Undo puts the estimate back', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await openCard('Write the report');
    await userEvent.click(screen.getByRole('button', { name: 'Add 2h to this week: Collect the sources' }));
    await userEvent.click(await screen.findByRole('button', { name: '2h this week: Collect the sources' }));
    const slider = within(screen.getByRole('dialog', { name: 'Collect the sources' })).getByRole('slider', { name: 'Estimate' });
    let saves = 0;
    const stop = t.db.subscribe((change) => void (change.source === 'local' && saves++));
    // A drag from 2h up past 3h and back: an input event at each step, then a change event when it's let go.
    for (const [minutes, text] of [
      [150, '2h 30m'],
      [180, '3h'],
      [210, '3h 30m'],
      [180, '3h'],
    ] as const) {
      fireEvent.input(slider, { target: { value: String(EST_STEPS.indexOf(minutes)) } });
      expect(slider).toHaveAttribute('aria-valuetext', text);
    }
    expect(saves).toBe(0);
    // Letting go sets the popover's draft; Save writes it, once.
    fireEvent.change(slider);
    expect(slider).toHaveAttribute('aria-valuetext', '3h');
    expect(saves).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Collect the sources, 3h this week, 3h estimate.')).toBeVisible();
    expect((await getRecord(t.db, 'task', 't1'))?.estimate_min).toBe(180);
    expect(saves).toBe(1);
    stop();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.estimate_min).toBe(120));
  });
});

describe('Pick tasks: quick fixes', () => {
  // A second task under Gather notes, after Collect the sources.
  const twoInGroup = async (w: Writer) => {
    await seedWeek(w);
    await w.create('task', { kind: 'project', project_id: 'report', milestone_id: 'm1', title: 'Read the old reports', estimate_min: 60 }, 't4');
  };
  const big = (from?: string) => async (w: Writer) => {
    await seedWeek(w);
    await w.create('task', { kind: 'one_off', title: 'Paint the house', estimate_min: 6000, schedule: from ? { type: 'once', from } : { type: 'once' } }, 'o9');
  };
  const firstButtons = (group: HTMLElement, attr: 'text' | 'name') =>
    within(group)
      .getAllByRole('listitem')
      .map((li) => within(li).getAllByRole('button')[0]!)
      .map((b) => (attr === 'text' ? b.textContent : b.getAttribute('aria-label')));

  it('names each control by its visible words, and groups a project as headings and a list', async () => {
    await openPlanning({ step: 1, seed: twoInGroup });
    const tasks = await screen.findByRole('region', { name: 'Write the report' });
    expect(within(tasks).getByRole('heading', { name: /^Milestone: Gather notes, overdue since Oct 18/ })).toBeInTheDocument();
    expect(firstButtons(tasks, 'text')).toEqual(['Collect the sources', 'Read the old reports', 'Write chapter one']);
    expect(within(tasks).getByRole('button', { name: 'Add 2h to this week: Collect the sources' })).toHaveTextContent('+ 2h');
  });

  it('keeps a finished row where it was, says what it freed, and names it done', async () => {
    const t = await openPlanning({ step: 1, seed: twoInGroup });
    await userEvent.click(await screen.findByRole('button', { name: 'Add 2h to this week: Collect the sources' }));
    await waitFor(() => expect(said()).toBe('Collect the sources added. 3h 30m of 98h.'));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Already done: Collect the sources' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBeTruthy());
    expect((await screen.findByText('Collect the sources done. 2h freed.')).closest('.toast')).toHaveTextContent('2h freed. 96h 30m free.');
    const tasks = screen.getByRole('region', { name: 'Write the report' });
    expect(firstButtons(tasks, 'name')).toEqual(['Edit task Collect the sources, done', 'Edit task Read the old reports', 'Edit task Write chapter one']);
  });

  it("a short task's This week slider reaches its whole time", async () => {
    const short = async (w: Writer) => {
      await seedWeek(w);
      await w.create('task', { kind: 'one_off', title: 'Return the library books', estimate_min: 20, schedule: { type: 'once', from: '2026-11-05' } }, 'o4');
    };
    const t = await openPlanning({ step: 1, seed: short });
    await userEvent.click(await screen.findByRole('button', { name: '20m this week: Return the library books' }));
    const slider = within(screen.getByRole('dialog', { name: 'Return the library books' })).getByRole('slider', { name: 'This week' });
    expect(slider).toHaveAttribute('aria-valuetext', '20m of 20m');
    expect(slider).toHaveAttribute('max', '1');
    expect(slider).toHaveValue('1');
    fireEvent.change(slider, { target: { value: '0' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect(await minutesOf(t, 'o4')).toBe(15));
  });

  it('on phone, Does it fit says over capacity as a number', async () => {
    await openPlanning({ step: 1, layout: 'phone', seed: big('2026-11-03') });
    expect(await screen.findByRole('button', { name: 'Does it fit? 101h 30m of 98h, 3h 30m over. Show This week' })).toBeInTheDocument();
  });
});

describe('Pick tasks: the row', () => {
  const openReport = () => openCard('Write the report');
  const timeOf = (title: string) => screen.getByRole('button', { name: new RegExp(`(^Add .*to this week|this week): ${title}$`) });

  it('has a done circle, the title and why, and one time button that adds the suggested part', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await openReport();
    const circle = screen.getByRole('checkbox', { name: 'Already done: Collect the sources' });
    expect(circle).not.toBeChecked();
    const row = circle.closest('li')!;
    expect(within(row).getByText(/milestone overdue/)).toBeInTheDocument();
    const add = within(row).getByRole('button', { name: 'Add 2h to this week: Collect the sources' });
    expect(add).toHaveTextContent('+ 2h');
    // Only the part the aim needs is suggested, so that's what it adds.
    expect(screen.getByRole('button', { name: 'Add 2h to this week: Bake a test loaf' })).toHaveTextContent('+ 2h');

    await userEvent.click(add);
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBe(120));
    const time = await screen.findByRole('button', { name: '2h this week: Collect the sources' });
    expect(time).toHaveTextContent('2h ▾');
    expect(time).toHaveAttribute('aria-haspopup', 'dialog');
    expect(time).toHaveAttribute('aria-expanded', 'false');
    expect(time).toHaveFocus();
    expect(row).toHaveClass('on');
    expect(within(row).queryByText(/milestone overdue/)).toBeNull();
    await waitFor(() => expect(said()).toBe('Collect the sources added. 3h 30m of 98h.'));
    await userEvent.click(screen.getByRole('button', { name: 'Add 2h to this week: Bake a test loaf' }));
    expect(await screen.findByRole('button', { name: '2h of 3h this week: Bake a test loaf' })).toHaveTextContent('2h of 3h ▾');
  });

  it('the time button opens This week and the estimate, which Save writes as one change with Undo, and Cancel drops', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await openReport();
    await userEvent.click(timeOf('Collect the sources'));
    await userEvent.click(await screen.findByRole('button', { name: '2h this week: Collect the sources' }));
    const pop = screen.getByRole('dialog', { name: 'Collect the sources' });
    const week = within(pop).getByRole('slider', { name: 'This week' });
    await waitFor(() => expect(week).toHaveFocus());
    expect(week).toHaveAttribute('aria-valuetext', '2h of 2h');
    // Quarter-hour stops: 1h is the fourth.
    fireEvent.change(week, { target: { value: '3' } });
    setEstimate(within(pop).getByRole('slider', { name: 'Estimate' }), 180);
    expect(week).toHaveAttribute('aria-valuetext', '1h of 3h');
    expect(await minutesOf(t, 't1')).toBe(120);
    await userEvent.click(within(pop).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Collect the sources, 1h this week, 3h estimate.')).toBeInTheDocument();
    expect(await minutesOf(t, 't1')).toBe(60);
    expect((await getRecord(t.db, 'task', 't1'))?.estimate_min).toBe(180);
    await waitFor(() => expect(screen.getByRole('button', { name: '1h of 3h this week: Collect the sources' })).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBe(120));
    expect((await getRecord(t.db, 'task', 't1'))?.estimate_min).toBe(120);

    await userEvent.click(await screen.findByRole('button', { name: '2h this week: Collect the sources' }));
    fireEvent.change(within(screen.getByRole('dialog', { name: 'Collect the sources' })).getByRole('slider', { name: 'This week' }), { target: { value: '0' } });
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Collect the sources' })).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Collect the sources' })).toBeNull();
    expect(await minutesOf(t, 't1')).toBe(120);
    expect(screen.getByRole('button', { name: '2h this week: Collect the sources' })).toHaveFocus();
  });

  it("the popover's Already done and Remove from this week act at once, each with Undo", async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await openReport();
    await userEvent.click(timeOf('Collect the sources'));
    await userEvent.click(await screen.findByRole('button', { name: '2h this week: Collect the sources' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Collect the sources' })).getByRole('button', { name: 'Remove from this week' }));
    expect(screen.queryByRole('dialog', { name: 'Collect the sources' })).toBeNull();
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBeNull());
    expect(await screen.findByText('Removed Collect the sources from this week.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBe(120));

    await userEvent.click(await screen.findByRole('button', { name: '2h this week: Collect the sources' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Collect the sources' })).getByRole('button', { name: 'Already done' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBeTruthy());
    expect(await screen.findByText('Collect the sources done. 2h freed.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBeFalsy());
    expect(await minutesOf(t, 't1')).toBe(120);
  });

  it('ticking the circle strikes the row through where it is, with a toast that says what it freed, and unticking undoes it', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await openReport();
    await userEvent.click(timeOf('Collect the sources'));
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBe(120));
    const circle = screen.getByRole('checkbox', { name: 'Already done: Collect the sources' });
    await userEvent.click(circle);
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBeTruthy());
    const toast = await screen.findByText('Collect the sources done. 2h freed.');
    // The toast is the announcement, and it ends with the fit.
    expect(toast.closest('.toast')).toHaveTextContent('Collect the sources done. 2h freed. 96h 30m free.');
    expect(said()).not.toMatch(/done/);
    expect(await minutesOf(t, 't1')).toBeNull();
    const ticked = screen.getByRole('checkbox', { name: 'Already done: Collect the sources' });
    expect(ticked).toBeChecked();
    expect(ticked).toHaveFocus();
    expect(ticked.closest('li')).toHaveClass('done');
    expect(screen.getByRole('button', { name: 'Edit task Collect the sources, done' })).toBeInTheDocument();
    await userEvent.click(ticked);
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBeFalsy());
    expect(await minutesOf(t, 't1')).toBe(120);
  });

  it('a task with no estimate offers + Add, which opens the popover to set its time and adds it', async () => {
    const t = await openPlanning({ step: 1, seed: seedUnestimated });
    await openReport();
    const add = screen.getByRole('button', { name: 'Add to this week: Outline chapter two' });
    expect(add).toHaveTextContent('+ Add');
    expect(add).toHaveAttribute('aria-haspopup', 'dialog');
    await userEvent.click(add);
    const pop = screen.getByRole('dialog', { name: 'Outline chapter two' });
    setEstimate(within(pop).getByRole('slider', { name: 'Estimate' }), 90);
    expect(within(pop).getByRole('slider', { name: 'This week' })).toHaveAttribute('aria-valuetext', '1h 30m of 1h 30m');
    await userEvent.click(within(pop).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect(await minutesOf(t, 't3')).toBe(90));
    expect((await getRecord(t.db, 'task', 't3'))?.estimate_min).toBe(90);
    expect(await screen.findByText('Outline chapter two, 1h 30m this week, 1h 30m estimate.')).toBeInTheDocument();
  });

  it('on phone, the row is the same, with the time button inside a 44pt box and its popover as a sheet', async () => {
    const t = await openPlanning({ step: 1, layout: 'phone', seed: seedWeek });
    const sheet = await screen.findByRole('region', { name: 'Write the report' });
    expect(within(sheet).getByRole('checkbox', { name: 'Already done: Collect the sources' })).toBeInTheDocument();
    const add = within(sheet).getByRole('button', { name: 'Add 2h to this week: Collect the sources' });
    expect(add.closest('.tpw')).not.toBeNull();
    await userEvent.click(add);
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBe(120));
    await userEvent.click(await within(sheet).findByRole('button', { name: '2h this week: Collect the sources' }));
    const pop = screen.getByRole('dialog', { name: 'Collect the sources' });
    expect(pop).toHaveClass('sheet');
    expect(within(pop).getByRole('heading', { name: 'Collect the sources' })).toBeInTheDocument();
  });
});

describe('Pick tasks: adding while you pick', () => {
  const tasksNamed = async (t: { db: Parameters<typeof getRecord>[0] }, title: string) =>
    (await listRecords(t.db, 'task')).filter((x) => x.title === title && !x.deleted_at);

  it('+ Task at a card’s foot adds a task under the last milestone used, in this week, with Undo that deletes it', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    const report = await screen.findByRole('region', { name: 'Write the report' });
    expect(within(report).getByRole('button', { name: 'Add milestone to Write the report' })).toBeInTheDocument();
    await userEvent.click(within(report).getByRole('button', { name: 'Add task to Write the report' }));
    const form = within(report).getByRole('form', { name: 'New task in Write the report' });
    const title = within(form).getByRole('textbox', { name: 'Title' });
    expect(title).toHaveFocus();
    expect(within(form).getByRole('checkbox', { name: 'This week' })).toBeChecked();
    await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'Milestone' }), 'Draft chapters');
    await userEvent.type(title, 'Outline chapter three{Enter}');
    expect(await screen.findByText('Added Outline chapter three to Draft chapters, 1h in this week.')).toBeInTheDocument();
    const [added] = await tasksNamed(t, 'Outline chapter three');
    expect(added).toMatchObject({ project_id: 'report', milestone_id: 'm2', estimate_min: 60 });
    expect(await minutesOf(t, added!.id)).toBe(60);
    // Enter adds and keeps the field open for the next one.
    expect(title).toHaveValue('');
    expect(title).toHaveFocus();
    expect(await within(report).findByRole('button', { name: '1h this week: Outline chapter three' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await tasksNamed(t, 'Outline chapter three')).toEqual([]));
    expect(await minutesOf(t, added!.id)).toBeNull();

    await userEvent.click(within(form).getByRole('checkbox', { name: 'This week' }));
    await userEvent.type(title, 'Make the index{Enter}');
    expect(await screen.findByText('Added Make the index to Draft chapters.')).toBeInTheDocument();
    const [index] = await tasksNamed(t, 'Make the index');
    expect(await minutesOf(t, index!.id)).toBeNull();
    await userEvent.click(within(form).getByRole('button', { name: 'Close' }));
    expect(within(report).queryByRole('form', { name: 'New task in Write the report' })).toBeNull();
    expect(within(report).getByRole('button', { name: 'Add task to Write the report' })).toHaveFocus();

    // The milestone starts on the last one used.
    await userEvent.click(within(report).getByRole('button', { name: 'Add task to Write the report' }));
    expect(within(report).getByRole('combobox', { name: 'Milestone' })).toHaveDisplayValue('Draft chapters');
  });

  it('+ Milestone adds one tagged to this stretch, with an optional date, then opens the task form with it chosen', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    const report = await screen.findByRole('region', { name: 'Write the report' });
    await userEvent.click(within(report).getByRole('button', { name: 'Add milestone to Write the report' }));
    const form = within(report).getByRole('form', { name: 'New milestone in Write the report' });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Milestone name' }), 'Print and bind');
    await userEvent.click(within(form).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Added milestone Print and bind to Write the report.')).toBeInTheDocument();
    const ms = (await listRecords(t.db, 'milestone')).find((m) => m.title === 'Print and bind')!;
    // Walk case 3: with no date it's tagged to this stretch, so it reads "by Dec 31" and never folds.
    expect(ms).toMatchObject({ stretch: '2026-10-01', added_on: '2026-11-02' });
    expect(ms.due ?? null).toBeNull();
    const tasks = within(report).getByRole('form', { name: 'New task in Write the report' });
    expect(within(tasks).getByRole('combobox', { name: 'Milestone' })).toHaveDisplayValue('Print and bind');
    await userEvent.click(within(tasks).getByRole('button', { name: 'Close' }));

    await userEvent.click(within(report).getByRole('button', { name: 'Add milestone to Write the report' }));
    const dated = within(report).getByRole('form', { name: 'New milestone in Write the report' });
    await userEvent.type(within(dated).getByRole('textbox', { name: 'Milestone name' }), 'Send it out');
    fireEvent.change(within(dated).getByLabelText('Date (optional)'), { target: { value: '2026-12-10' } });
    await userEvent.click(within(dated).getByRole('button', { name: 'Add' }));
    await waitFor(async () => expect((await listRecords(t.db, 'milestone')).find((m) => m.title === 'Send it out')).toMatchObject({ due: '2026-12-10', stretch: '2026-10-01' }));
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await listRecords(t.db, 'milestone')).some((m) => m.title === 'Send it out')).toBe(false));
  });

  it('+ Add project, with a goal, adds a project whose card opens on its task form, with Undo', async () => {
    const t = await openPlanning({
      step: 1,
      seed: async (w) => {
        await seedWeek(w);
        await w.create('objective', { title: 'Make a home we love', state: 'active' }, 'g1');
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: '+ Add project' }));
    const form = screen.getByRole('form', { name: 'Add project' });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Name' }), 'Plan the trip');
    await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'Goal' }), 'Make a home we love');
    await userEvent.click(within(form).getByRole('button', { name: 'Add project' }));
    expect(await screen.findByText(/^Added project Plan the trip, Nov 2 to /)).toBeInTheDocument();
    const project = (await listRecords(t.db, 'project')).find((p) => p.title === 'Plan the trip')!;
    expect(project).toMatchObject({ objective_id: 'g1', added_on: '2026-11-02' });
    const card = await screen.findByRole('region', { name: 'Plan the trip' });
    await waitFor(() => expect(within(card).getByRole('textbox', { name: 'Title' })).toHaveFocus());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'project', project.id))?.deleted_at).toBeTruthy());
  });

  it('+ Add ▾ by Save and exit adds a task to the open card, a one off in this week, a milestone or a project', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    const add = await screen.findByRole('button', { name: '+ Add' });
    await userEvent.click(add);
    const menu = screen.getByRole('dialog', { name: 'Add' });
    expect(within(menu).getAllByRole('button').map((b) => b.textContent)).toEqual(['Task in Write the report', 'One off', 'Milestone in Write the report', 'Project', 'Task to Inbox']);
    await userEvent.click(within(menu).getByRole('button', { name: 'One off' }));
    const form = screen.getByRole('form', { name: 'Add a one off' });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Title' }), 'Buy stamps');
    expect(within(form).getByRole('checkbox', { name: 'This week' })).toBeChecked();
    await userEvent.click(within(form).getByRole('button', { name: 'Add one off' }));
    expect(await screen.findByText(/^Added Buy stamps to One offs/)).toBeInTheDocument();
    const [stamps] = await tasksNamed(t, 'Buy stamps');
    expect(stamps).toMatchObject({ kind: 'one_off' });
    expect(await minutesOf(t, stamps!.id)).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await tasksNamed(t, 'Buy stamps')).toEqual([]));

    await userEvent.click(add);
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Add' })).getByRole('button', { name: 'Task in Write the report' }));
    expect(within(screen.getByRole('region', { name: 'Write the report' })).getByRole('form', { name: 'New task in Write the report' })).toBeInTheDocument();
  });

  it('select mode hides the adders', async () => {
    await openPlanning({ step: 1, seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
    expect(screen.queryByRole('button', { name: /^Add task to / })).toBeNull();
  });

  it('on phone, + becomes the Add sheet, naming the project in view, with Task to Inbox', async () => {
    await openPlanning({ step: 1, layout: 'phone', seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: 'Add a task, one off, milestone or project' }));
    const sheet = screen.getByRole('dialog', { name: 'Add' });
    expect(within(sheet).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Task in Write the report',
      'One off',
      'Milestone in Write the report',
      'Project',
      'Task to Inbox',
      'Cancel',
    ]);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Task in Write the report' }));
    expect(screen.getByRole('dialog', { name: 'New task in Write the report' })).toBeInTheDocument();
  });
});
