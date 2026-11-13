import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { localToInstant } from '../../../../core/dates';
import { getRecord, weekPickId, weekPlanId } from '../../../../core/records';
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

describe('Pick tasks on desktop', () => {
  it('lists projects soonest first on one timeline, collapsed, with status and aim, and paused ones apart', async () => {
    await openPlanning({ step: 1, seed: seedWeek });
    const projects = await screen.findByRole('region', { name: 'Your projects' });
    const rows = await within(projects).findAllByRole('button', { expanded: false, name: / planned$/ });
    expect(rows.map((b) => b.textContent)).toEqual(['▸Write the report', '▸Learn to bake bread']);
    expect(within(projects).getByRole('button', { name: 'Overdue: move the date or drop the milestone' })).toBeInTheDocument();
    expect(within(projects).getByRole('img', { name: 'Weekly aim 4h, 0m planned, 4h short' })).toBeInTheDocument();
    expect(within(projects).getByText('Plan the garden')).toBeInTheDocument();
    expect(within(projects).getByText("Can't be planned while paused")).toBeInTheDocument();
    expect(within(projects).getByRole('img', { name: /^Write the report runs Oct 1 to Dec 15\. Milestone Gather notes, overdue since Oct 18, in the plan\. Milestone Draft chapters, due Nov 9, in the plan\./ })).toBeInTheDocument();
  });

  it('opens a project to its tasks under their milestones, and Add puts one in the Planned list', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: /^Write the report,/ }));
    expect(document.querySelector('.pmshead')).toHaveTextContent('Milestone: Gather notes, overdue since Oct 18');
    expect(screen.getByText('Suggested: milestone overdue')).toBeInTheDocument();
    expect(screen.getByText('Suggested: due Nov 9')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add Collect the sources to the plan' }));
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBe(120));
    const planned = screen.getByRole('complementary', { name: 'Time this week' });
    expect(await within(planned).findByText('Collect the sources')).toBeInTheDocument();
    expect(within(planned).getByText('Paint the fence')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'Weekly aim 4h, 2h planned, 2h short' })).toBeInTheDocument();
    expect(screen.getByText(/Gather notes, overdue since Oct 18: 2h planned/)).toBeInTheDocument();
    expect(document.querySelector('.pickside .donut')).not.toBeNull();

    const slider = within(planned).getByRole('slider', { name: 'Time this week for Collect the sources' });
    expect(slider).toHaveAttribute('aria-valuetext', '2h of 2h');
    // Its quarter-hour stops: 90m is the sixth.
    fireEvent.change(slider, { target: { value: '5' } });
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBe(90));
    await userEvent.click(within(planned).getByRole('button', { name: 'Remove Collect the sources from the plan' }));
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBeNull());
    expect(await screen.findByRole('button', { name: 'Add Collect the sources to the plan' })).toBeInTheDocument();
  });

  it("puts a project's tasks with no milestone under its Done, as Goals does", async () => {
    await openPlanning({
      step: 1,
      seed: async (w) => {
        await seedWeek(w);
        await w.create('task', { kind: 'project', project_id: 'report', title: 'Print a copy', estimate_min: 30 }, 't9');
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: /^Write the report,/ }));
    const heads = [...document.querySelectorAll('.pmshead')].map((h) => h.textContent);
    expect(heads.at(-1)).toBe('Done');
    expect(heads).not.toContain('Tasks with no milestone');
  });

  it('adds every suggestion in one go, only the part an aim needs', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: 'Add suggested (8h)' }));
    await waitFor(async () => expect(await minutesOf(t, 'b1')).toBe(120));
    expect(await minutesOf(t, 't1')).toBe(120);
    expect(await minutesOf(t, 't2')).toBe(240);
    expect(await minutesOf(t, 'o2')).toBeNull();
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Add suggested/ })).toBeNull());
  });

  it('keeps keyboard focus in the Planned list after Add suggested and Remove', async () => {
    await openPlanning({ step: 1, seed: seedWeek });
    const planned = await screen.findByRole('complementary', { name: 'Time this week' });
    const head = within(planned).getByRole('heading', { name: /^Planned for/ });
    within(planned).getByRole('button', { name: /^Add suggested/ }).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(within(planned).queryByRole('button', { name: /^Add suggested/ })).toBeNull());
    await waitFor(() => expect(head).toHaveFocus());

    const removes = () => within(planned).getAllByRole('button', { name: /^Remove .* from the plan$/ });
    const [first, second] = removes();
    first!.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(first).not.toBeInTheDocument());
    await waitFor(() => expect(second).toHaveFocus());

    // The last one left goes back to the heading.
    while (removes().length > 1) {
      const n = removes().length;
      removes()[0]!.focus();
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(removes()).toHaveLength(n - 1));
    }
    removes()[0]!.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(within(planned).queryAllByRole('button', { name: /^Remove .* from the plan$/ })).toHaveLength(0));
    await waitFor(() => expect(head).toHaveFocus());
  });

  it('shows the week’s open time and what is left, and changes an aim for this week only', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    const planned = await screen.findByRole('complementary', { name: 'Time this week' });
    // Monday at 2pm: the 98h left of the week's 105h.
    expect(await within(planned).findByText('98h')).toBeInTheDocument();
    expect(within(planned).getByText('96h 30m')).toBeInTheDocument();
    await userEvent.click(within(planned).getByRole('button', { name: 'Change aims for this week' }));
    fireEvent.change(within(planned).getByLabelText('Aim for Write the report this week'), { target: { value: '4' } });
    await waitFor(async () => expect((await getRecord(t.db, 'week_plan', weekPlanId(WEEK)))?.aims).toEqual({ report: 60 }));
    expect((await getRecord(t.db, 'project', 'report'))?.weekly_aim).toBe(240);
    await userEvent.click(await within(planned).findByRole('button', { name: 'Back to my usual aims' }));
    await waitFor(async () => expect((await getRecord(t.db, 'week_plan', weekPlanId(WEEK)))?.aims).toEqual({}));
  });

  it('skips an aim for this week from the open project', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: /^Learn to bake bread,/ }));
    await userEvent.click(screen.getByRole('button', { name: "Skip this week's aim" }));
    await waitFor(async () => expect((await getRecord(t.db, 'week_plan', weekPlanId(WEEK)))?.skipped_aims).toEqual(['bread']));
    expect(await screen.findByRole('img', { name: 'Weekly aim skipped this week' })).toBeInTheDocument();
  });

  it('the Overdue pill offers to mark the milestone done, which opens the row with Undo', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: 'Overdue: move the date or drop the milestone' }));
    const fix = screen.getByRole('dialog', { name: 'Gather notes was due Oct 18' });
    expect(within(fix).getByText('0 of 1 task done, 2h left.')).toBeInTheDocument();
    await userEvent.click(within(fix).getByRole('button', { name: 'Mark 1 task done' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBe('2026-11-02T20:00:00Z'));
    expect(await screen.findByText(/Marked Gather notes done, and ticked 1 task\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBeNull());
  });

  it('the Overdue pill moves the date, previewing the status', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: 'Overdue: move the date or drop the milestone' }));
    await userEvent.click(screen.getByRole('button', { name: 'Move date' }));
    fireEvent.change(screen.getByLabelText('New due date'), { target: { value: '2026-11-06' } });
    expect(screen.getByText('Project goes from Overdue to Behind.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Move to Nov 6' }));
    await waitFor(async () => expect((await getRecord(t.db, 'milestone', 'm1'))?.due).toBe('2026-11-06'));
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

  it("a task's title opens its popup, which renames it and gives focus back, and Add still picks it", async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: /^Write the report,/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Edit task Collect the sources' }));
    const popup = await popupOf('Collect the sources');
    await renameIn(popup, 'Collect the sources', 'Collect the papers');
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.title).toBe('Collect the papers'));
    expect(screen.queryByRole('dialog', { name: /Collect the/ })).toBeNull();
    const renamed = await screen.findByRole('button', { name: 'Edit task Collect the papers' });
    await waitFor(() => expect(renamed).toHaveFocus());

    await userEvent.click(screen.getByRole('button', { name: 'Add Collect the papers to the plan' }));
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBe(120));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(screen.getByRole('complementary', { name: 'Time this week' })).getByText('Collect the papers')).toBeInTheDocument();
  });

  it('sets an estimate on a task with none, which Pick then shows and Add puts in the plan', async () => {
    const t = await openPlanning({ step: 1, seed: seedUnestimated });
    await userEvent.click(await screen.findByRole('button', { name: /^Write the report,/ }));
    const open = screen.getByRole('button', { name: 'Edit task Outline chapter two' });
    const row = open.closest<HTMLElement>('.pickrow')!;
    expect(within(row).getByText('No estimate')).toBeInTheDocument();
    await userEvent.click(open);
    const popup = await popupOf('Outline chapter two');
    expect(within(popup).getByRole('slider', { name: 'Time estimate' })).toHaveAttribute('aria-valuetext', 'No estimate');
    setEstimate(within(popup).getByRole('slider', { name: 'Time estimate' }), 90);
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't3'))?.estimate_min).toBe(90));
    expect(await within(row).findByText('1h 30m')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Add Outline chapter two to the plan' }));
    await waitFor(async () => expect(await minutesOf(t, 't3')).toBe(90));
  });

  it("a one off's title opens its popup, which renames it and sets its time", async () => {
    const t = await openPlanning({ step: 1, seed: seedUnestimated });
    const oneOffs = await screen.findByRole('region', { name: 'One offs' });
    // It starts open only if the dated one off was picked before it drew.
    const band = await within(oneOffs).findByRole('button', { name: 'One offs, 1h 30m planned' });
    if (band.getAttribute('aria-expanded') === 'false') await userEvent.click(band);
    await userEvent.click(within(oneOffs).getByRole('button', { name: 'Edit task Call the plumber' }));
    const popup = await popupOf('Call the plumber');
    await renameIn(popup, 'Call the plumber', 'Call the electrician');
    setEstimate(within(popup).getByRole('slider', { name: 'Time estimate' }), 30);
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect(await getRecord(t.db, 'task', 'o3')).toMatchObject({ title: 'Call the electrician', estimate_min: 30 }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await within(oneOffs).findByText('30m')).toBeInTheDocument();
    await waitFor(() => expect(within(oneOffs).getByRole('button', { name: 'Edit task Call the electrician' })).toHaveFocus());
  });
});

describe('Pick tasks on phone', () => {
  it('opens on the first project, with a star for suggestions, and + adds the suggested part', async () => {
    const t = await openPlanning({ step: 1, layout: 'phone', seed: seedWeek });
    const sheet = await screen.findByRole('region', { name: 'Tasks in Write the report' });
    expect(screen.getByRole('button', { name: /^Write the report, Overdue/ })).toHaveTextContent('★2');
    expect(within(sheet).getByText('★ 2h')).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Add Collect the sources to the plan' }));
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBe(120));
    expect(await within(sheet).findByRole('button', { name: 'Add Collect the sources to the plan', pressed: true })).toBeInTheDocument();
    expect(document.querySelector('.donut .dlabel')).toHaveTextContent('+2h');
    expect(screen.getByText('Collect the sources added. 3h 30m of 98h.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Next project: Learn to bake bread' }));
    const bread = await screen.findByRole('region', { name: 'Tasks in Learn to bake bread' });
    expect(within(bread).getByText('★ 2h of 3h')).toBeInTheDocument();
    await userEvent.click(within(bread).getByRole('button', { name: 'Add Bake a test loaf to the plan' }));
    await waitFor(async () => expect(await minutesOf(t, 'b1')).toBe(120));
    expect(document.querySelector('.donut .dlabel')).toHaveTextContent('+4h');

    await userEvent.click(screen.getByRole('button', { name: /^One offs/ }));
    expect(await screen.findByRole('region', { name: 'Tasks in One offs' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close tasks' }));
    expect(screen.queryByRole('region', { name: /^Tasks in/ })).toBeNull();
  });

  it('Suggest lists the reasons and adds them all, with Undo', async () => {
    const t = await openPlanning({ step: 1, layout: 'phone', seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: 'Suggest 8h' }));
    const sheet = screen.getByRole('dialog', { name: 'Suggested' });
    expect(within(sheet).getByText(/Milestone overdue/)).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Add all 8h' }));
    await waitFor(async () => expect(await minutesOf(t, 't2')).toBe(240));
    expect(screen.queryByRole('dialog', { name: 'Suggested' })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await minutesOf(t, 't2')).toBeNull());
    expect(await minutesOf(t, 'o1')).toBe(90);
  });

  it('the dock opens the Planned list, where a slider lowers the time for this week', async () => {
    const t = await openPlanning({ step: 1, layout: 'phone', seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: 'Planned for Nov 2 to 8, 1 task, 1h 30m, 96h 30m left free. Open the list' }));
    const sheet = screen.getByRole('dialog', { name: 'Planned for Nov 2 to 8' });
    // Its quarter-hour stops: 60m is the fourth.
    fireEvent.change(within(sheet).getByLabelText('Time this week for Paint the fence'), { target: { value: '3' } });
    await waitFor(async () => expect(await minutesOf(t, 'o1')).toBe(60));
  });

  it('More holds Change aims, where an aim can be skipped, and the Timeline key', async () => {
    const t = await openPlanning({ step: 1, layout: 'phone', seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: 'More: change aims, timeline key' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'More' })).getByRole('button', { name: 'Change aims for this week' }));
    const aims = screen.getByRole('dialog', { name: 'Change aims for this week' });
    await userEvent.click(within(aims).getByRole('button', { name: "Skip this week's aim, Learn to bake bread" }));
    await waitFor(async () => expect((await getRecord(t.db, 'week_plan', weekPlanId(WEEK)))?.skipped_aims).toEqual(['bread']));
    await userEvent.click(within(aims).getByRole('button', { name: 'Done' }));
    await userEvent.click(screen.getByRole('button', { name: 'More: change aims, timeline key' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'More' })).getByRole('button', { name: 'Timeline key' }));
    expect(within(screen.getByRole('dialog', { name: 'Timeline key' })).getByText('In the plan')).toBeInTheDocument();
  });

  it('the Overdue pill opens a sheet without opening the row', async () => {
    await openPlanning({ step: 1, layout: 'phone', seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: 'Close tasks' }));
    await userEvent.click(screen.getByRole('button', { name: 'Overdue: move the date, drop the milestone or mark it done' }));
    expect(screen.getByRole('dialog', { name: 'Gather notes was due Oct 18' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /^Tasks in/ })).toBeNull();
  });

  it("a task's title opens its popup, with why it's suggested, which renames it, and + still adds it", async () => {
    const t = await openPlanning({ step: 1, layout: 'phone', seed: seedWeek });
    const tray = await screen.findByRole('region', { name: 'Tasks in Write the report' });
    await userEvent.click(within(tray).getByRole('button', { name: 'Edit task Collect the sources' }));
    const popup = await popupOf('Collect the sources');
    expect(within(popup).getByText('Suggested: milestone overdue')).toBeInTheDocument();
    await renameIn(popup, 'Collect the sources', 'Collect the papers');
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.title).toBe('Collect the papers'));
    expect(screen.queryByRole('dialog', { name: /Collect the/ })).toBeNull();
    const renamed = await within(tray).findByRole('button', { name: 'Edit task Collect the papers' });
    expect(within(tray).getByRole('button', { name: 'Estimate for Collect the papers: Suggested 2h' })).toBeInTheDocument();
    await waitFor(() => expect(renamed).toHaveFocus());

    await userEvent.click(within(tray).getByRole('button', { name: 'Add Collect the papers to the plan' }));
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBe(120));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sets an estimate on a task with none, which the sheet then shows and + adds', async () => {
    const t = await openPlanning({ step: 1, layout: 'phone', seed: seedUnestimated });
    const tray = await screen.findByRole('region', { name: 'Tasks in Write the report' });
    await userEvent.click(within(tray).getByRole('button', { name: 'Edit task Outline chapter two' }));
    const popup = await popupOf('Outline chapter two');
    setEstimate(within(popup).getByRole('slider', { name: 'Time estimate' }), 90);
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't3'))?.estimate_min).toBe(90));
    expect(await within(tray).findByRole('button', { name: /^Estimate for Outline chapter two: .*1h 30m$/ })).toBeInTheDocument();
    await userEvent.click(within(tray).getByRole('button', { name: 'Add Outline chapter two to the plan' }));
    await waitFor(async () => expect(await minutesOf(t, 't3')).toBe(90));
  });

  it("a one off's title opens its popup, which sets its time", async () => {
    const t = await openPlanning({ step: 1, layout: 'phone', seed: seedUnestimated });
    await userEvent.click(await screen.findByRole('button', { name: /^One offs/ }));
    const tray = await screen.findByRole('region', { name: 'Tasks in One offs' });
    await userEvent.click(within(tray).getByRole('button', { name: 'Edit task Call the plumber' }));
    const popup = await popupOf('Call the plumber');
    setEstimate(within(popup).getByRole('slider', { name: 'Time estimate' }), 30);
    await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 'o3'))?.estimate_min).toBe(30));
    expect(screen.queryByRole('dialog', { name: 'Call the plumber' })).toBeNull();
    expect(await within(tray).findByRole('button', { name: 'Estimate for Call the plumber: 30m' })).toBeInTheDocument();
  });
});

describe('Pick tasks: estimates and Mark done', () => {
  // Outline chapter two has no estimate and an hour already on Wednesday's calendar.
  const placed = async (w: Writer) => {
    await seedUnestimated(w);
    await w.create('time_block', { task_id: 't3', start: localToInstant('2026-11-04', 18 * 60, 'America/Chicago'), end: localToInstant('2026-11-04', 19 * 60, 'America/Chicago'), tz: 'America/Chicago' });
  };
  const openReport = async () => userEvent.click(await screen.findByRole('button', { name: /^Write the report,/ }));

  it('a task stays listed when its new estimate is all on the calendar, saying so', async () => {
    const t = await openPlanning({ step: 1, seed: placed });
    await openReport();
    await userEvent.click(screen.getByRole('button', { name: 'Estimate for Outline chapter two: No estimate' }));
    const pop = screen.getByRole('dialog', { name: 'Estimate for Outline chapter two' });
    setEstimate(within(pop).getByRole('slider'), 60);
    await userEvent.click(within(pop).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't3'))?.estimate_min).toBe(60));
    expect(await screen.findByRole('button', { name: 'Estimate for Outline chapter two: On the calendar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Outline chapter two to the plan' })).toBeNull();
  });

  it('the estimate opens a slider that waits for Save, with Undo; Esc keeps a change, and Cancel drops it', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await openReport();
    const est = screen.getByRole('button', { name: 'Estimate for Collect the sources: 2h' });
    await userEvent.click(est);
    let pop = screen.getByRole('dialog', { name: 'Estimate for Collect the sources' });
    setEstimate(within(pop).getByRole('slider', { name: 'Estimate' }), 60);
    await userEvent.keyboard('{Escape}');
    expect(within(pop).getByRole('alert')).toHaveTextContent("Your changes aren't saved. Save them, or Cancel to drop them.");
    expect(within(pop).getByRole('button', { name: 'Save' })).toHaveFocus();
    await userEvent.click(within(pop).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Estimate for Collect the sources' })).toBeNull();
    expect((await getRecord(t.db, 'task', 't1'))?.estimate_min).toBe(120);

    await userEvent.click(est);
    pop = screen.getByRole('dialog', { name: 'Estimate for Collect the sources' });
    setEstimate(within(pop).getByRole('slider', { name: 'Estimate' }), 180);
    expect((await getRecord(t.db, 'task', 't1'))?.estimate_min).toBe(120);
    await userEvent.click(within(pop).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Collect the sources, 3h estimate.')).toBeVisible();
    expect((await getRecord(t.db, 'task', 't1'))?.estimate_min).toBe(180);
    expect(screen.queryByRole('dialog', { name: 'Estimate for Collect the sources' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Estimate for Collect the sources: 3h' })).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.estimate_min).toBe(120));
  });

  it('Mark done finishes a task in place, struck through, and Undo opens it again with its pick back', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await openReport();
    await userEvent.click(screen.getByRole('button', { name: 'Add Collect the sources to the plan' }));
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBe(120));
    await userEvent.click(screen.getByRole('button', { name: 'Mark done: Collect the sources' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBeTruthy());
    const undo = await screen.findByRole('button', { name: 'Undo finishing Collect the sources' });
    expect(undo.closest('.pickrow')).toHaveClass('isdone');
    expect(await minutesOf(t, 't1')).toBeNull();
    await userEvent.click(undo);
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBeFalsy());
    expect(await minutesOf(t, 't1')).toBe(120);
    expect(await screen.findByRole('button', { name: 'Mark done: Collect the sources' })).toBeInTheDocument();
  });

  it('on phone, the estimate opens a slider sheet that Save writes, and Mark done toggles to Undo', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek, layout: 'phone' });
    const tray = await screen.findByRole('region', { name: /Write the report/ });
    await userEvent.click(within(tray).getByRole('button', { name: /^Estimate for Collect the sources:/ }));
    const sheet = screen.getByRole('dialog', { name: 'Estimate for Collect the sources' });
    setEstimate(within(sheet).getByRole('slider', { name: 'Estimate' }), 60);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.estimate_min).toBe(60));
    await userEvent.click(within(tray).getByRole('button', { name: 'Mark done: Collect the sources' }));
    expect(await within(tray).findByRole('button', { name: 'Undo finishing Collect the sources' })).toBeInTheDocument();
    expect(within(tray).getByRole('button', { name: 'Edit task Collect the sources, done' }).closest('.trow')).toHaveClass('isdone');
  });
});

describe('Pick tasks: dragging an estimate', () => {
  it('saves a drag once, when it is let go, with the slider following it throughout, and Undo puts the estimate back', async () => {
    const t = await openPlanning({ step: 1, seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: /^Write the report,/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Estimate for Collect the sources: 2h' }));
    const slider = within(screen.getByRole('dialog', { name: 'Estimate for Collect the sources' })).getByRole('slider', { name: 'Estimate' });
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
    expect(await screen.findByText('Collect the sources, 3h estimate.')).toBeVisible();
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
  const said = () => document.querySelector('.pickside .sr[role=status], .pkdock .sr[role=status]')?.textContent;
  const firstButtons = (group: HTMLElement, attr: 'text' | 'name') =>
    within(group)
      .getAllByRole('listitem')
      .map((li) => within(li).getAllByRole('button')[0]!)
      .map((b) => (attr === 'text' ? b.textContent : b.getAttribute('aria-label')));

  it('names each control by its visible words, and groups an open project as headings and a list', async () => {
    await openPlanning({ step: 1, seed: twoInGroup });
    expect(await screen.findByRole('button', { name: 'Overdue: move the date or drop the milestone' })).toHaveAttribute('aria-haspopup', 'dialog');
    await userEvent.click(screen.getByRole('button', { name: /^Write the report,/ }));
    const tasks = screen.getByRole('group', { name: 'Write the report tasks' });
    expect(within(tasks).getByRole('heading', { name: /^Milestone: Gather notes, overdue since Oct 18/ })).toBeInTheDocument();
    expect(firstButtons(tasks, 'text')).toEqual(['Collect the sources', 'Read the old reports', 'Write chapter one']);
    const est = within(tasks).getByRole('button', { name: 'Estimate for Collect the sources: 2h' });
    expect(est).toHaveTextContent(/^2h$/);
    expect(est).toHaveAttribute('aria-haspopup', 'dialog');
    expect(within(tasks).getByRole('button', { name: 'Mark done: Collect the sources' })).toHaveTextContent('Mark done');
  });

  it('keeps a finished row where it was, says what it freed, and names it done', async () => {
    const t = await openPlanning({ step: 1, seed: twoInGroup });
    await userEvent.click(await screen.findByRole('button', { name: /^Write the report,/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Add Collect the sources to the plan' }));
    await waitFor(() => expect(said()).toBe('Collect the sources added. 3h 30m of 98h.'));
    await userEvent.click(screen.getByRole('button', { name: 'Mark done: Collect the sources' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBeTruthy());
    await waitFor(() => expect(said()).toBe('Collect the sources done. 2h freed, 96h 30m free.'));
    const tasks = screen.getByRole('group', { name: 'Write the report tasks' });
    expect(firstButtons(tasks, 'name')).toEqual(['Edit task Collect the sources, done', 'Edit task Read the old reports', 'Edit task Write chapter one']);
  });

  it('says over capacity as a number, in the totals and when adding', async () => {
    await openPlanning({ step: 1, seed: big() });
    const oneOffs = await screen.findByRole('region', { name: 'One offs' });
    const band = await within(oneOffs).findByRole('button', { name: /^One offs, / });
    if (band.getAttribute('aria-expanded') === 'false') await userEvent.click(band);
    await userEvent.click(within(oneOffs).getByRole('button', { name: 'Add Paint the house to the plan' }));
    const planned = screen.getByRole('complementary', { name: 'Time this week' });
    expect(await within(planned).findByText('Over by')).toBeInTheDocument();
    expect(within(planned).getByText('3h 30m')).toBeInTheDocument();
    expect(within(planned).queryByText('Left free')).toBeNull();
    expect(within(planned).getByText("What doesn't fit stays on its project or in One offs.")).toBeInTheDocument();
    await waitFor(() => expect(said()).toBe('Paint the house added. 101h 30m of 98h, 3h 30m over.'));
  });

  it("a short task's slider reaches its whole time, and moving it says nothing", async () => {
    const short = async (w: Writer) => {
      await seedWeek(w);
      await w.create('task', { kind: 'one_off', title: 'Return the library books', estimate_min: 20, schedule: { type: 'once', from: '2026-11-05' } }, 'o4');
    };
    const t = await openPlanning({ step: 1, seed: short });
    const planned = await screen.findByRole('complementary', { name: 'Time this week' });
    const slider = await within(planned).findByRole('slider', { name: 'Time this week for Return the library books' });
    expect(slider).toHaveAttribute('aria-valuetext', '20m of 20m');
    expect(slider).toHaveAttribute('max', '1');
    expect(slider).toHaveValue('1');
    fireEvent.change(slider, { target: { value: '0' } });
    await waitFor(async () => expect(await minutesOf(t, 'o4')).toBe(15));
    expect(said() ?? '').not.toMatch(/removed/);
    fireEvent.change(slider, { target: { value: '1' } });
    await waitFor(async () => expect(await minutesOf(t, 'o4')).toBe(20));
  });

  it('on phone, + keeps one name and says it with pressed, and the arrows name where they go', async () => {
    const t = await openPlanning({ step: 1, layout: 'phone', seed: seedWeek });
    const sheet = await screen.findByRole('region', { name: 'Tasks in Write the report' });
    const add = within(sheet).getByRole('button', { name: 'Add Collect the sources to the plan' });
    expect(add).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(add);
    await waitFor(async () => expect(await minutesOf(t, 't1')).toBe(120));
    expect(await within(sheet).findByRole('button', { name: 'Add Collect the sources to the plan', pressed: true })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Mark done: Collect the sources' })).toBeInTheDocument();

    const back = within(sheet).getByRole('button', { name: 'Previous project' });
    expect(back).toHaveAttribute('aria-disabled', 'true');
    expect(back).not.toBeDisabled();
    await userEvent.click(back);
    expect(screen.getByRole('region', { name: 'Tasks in Write the report' })).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Next project: Learn to bake bread' }));
    const bread = await screen.findByRole('region', { name: 'Tasks in Learn to bake bread' });
    expect(within(bread).getByRole('button', { name: 'Previous project: Write the report' })).toBeInTheDocument();
  });

  it('on phone, Add all puts focus on the Undo that reverses it', async () => {
    await openPlanning({ step: 1, layout: 'phone', seed: seedWeek });
    await userEvent.click(await screen.findByRole('button', { name: 'Suggest 8h' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Suggested' })).getByRole('button', { name: 'Add all 8h' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus());
  });

  it('on phone, the dock says over capacity as a number', async () => {
    await openPlanning({ step: 1, layout: 'phone', seed: big('2026-11-03') });
    expect(await screen.findByRole('button', { name: 'Planned for Nov 2 to 8, 2 tasks, 101h 30m, over by 3h 30m. Open the list' })).toBeInTheDocument();
  });
});
