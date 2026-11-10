import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { localToInstant } from '../../../core/dates';
import { getRecord, outcomeId, weekPlanId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import type { Layout } from '../../app/registry';
import { renderScreen } from '../../app/testing';

afterEach(cleanup);

// Monday, Nov 2 in Chicago. The harness clock reads 2pm there.
const ZONE = 'America/Chicago';
const DAY = '2026-11-02';
const at = (h: number, m = 0) => localToInstant(DAY, h * 60 + m, ZONE);

// Five blocks went by unanswered this morning: two of the chapter, the email, piano practice and the water bill.
const morning = async (w: Writer) => {
  await w.create('week_plan', { week_start: DAY, finished_at: at(8) }, weekPlanId(DAY));
  await w.create('task', { kind: 'project', project_id: 'p', title: 'Draft chapter five', estimate_min: 180 }, 't1');
  await w.create('task', { kind: 'project', project_id: 'p', title: 'Email the editor', estimate_min: 60 }, 't2');
  await w.create('task', { kind: 'one_off', title: 'Pay the water bill' }, 't3');
  await w.create('practice', { title: 'Piano', target_min: 30, per: 'day', state: 'active' }, 'pr');
  const block = (id: string, fields: Record<string, unknown>, from: number, to: number) =>
    w.create('time_block', { ...fields, start: at(Math.floor(from), (from % 1) * 60), end: at(Math.floor(to), (to % 1) * 60), tz: ZONE }, id);
  await block('b1', { task_id: 't1' }, 9, 10);
  await block('b2', { task_id: 't2' }, 10.5, 11);
  await block('pb', { practice_id: 'pr' }, 11, 11.5);
  await block('b3', { task_id: 't1' }, 12, 13);
  await block('b4', { task_id: 't3' }, 13, 13.5);
};

const open = (layout: Layout = 'desktop') => renderScreen('today', { now: at(14), zone: ZONE, layout, seed: morning });
const sheet = (count = 5) => screen.findByRole('dialog', { name: `${count} missed blocks` });
const rows = (dialog: HTMLElement) => within(dialog).getAllByRole('group').map((g) => g.getAttribute('aria-label'));
const outcome = (t: Awaited<ReturnType<typeof open>>, id: string) => getRecord(t.db, 'block_outcome', outcomeId(id));

describe('the missed blocks sheet', () => {
  it('opens by itself, oldest first with the practice among them, and nothing answered', async () => {
    await open();
    const dialog = await sheet();
    expect(rows(dialog)).toEqual(['Draft chapter five', 'Email the editor', 'Piano', 'Draft chapter five', 'Pay the water bill']);
    const first = within(dialog).getAllByRole('group')[0]!;
    expect(within(first).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Finished: Draft chapter five',
      'Partly: Draft chapter five',
      'Not done: Draft chapter five',
    ]);
    expect(within(dialog).getByRole('button', { name: 'Did it: Piano' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Some: Piano' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Skipped: Piano' })).toBeVisible();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /None of them/ })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('says the time spent and the pauses on a row that was started', async () => {
    await renderScreen('today', {
      now: at(14),
      zone: ZONE,
      seed: async (w) => {
        await morning(w);
        await w.set('time_block', 'b3', { started_at: at(12), end: at(13, 9), paused_min: 9 });
      },
    });
    const row = within(await sheet()).getAllByRole('group')[3]!;
    expect(within(row).getByText('1h spent, 9 min paused.')).toBeVisible();
  });

  it('a practice paused and resumed logs its time less the pause', async () => {
    const t = await renderScreen('today', {
      now: at(14),
      zone: ZONE,
      seed: async (w) => {
        await morning(w);
        await w.set('time_block', 'pb', { started_at: at(11), end: at(11, 39), paused_min: 9 });
      },
    });
    await userEvent.click(within(await sheet()).getByRole('button', { name: 'Did it: Piano' }));
    await waitFor(async () => expect((await outcome(t, 'pb'))?.logged_min).toBe(30));
  });

  it('Finished saves at once with Undo, and the task takes its later missed block with it', async () => {
    const t = await open();
    await userEvent.click(within(await sheet()).getAllByRole('button', { name: 'Finished: Draft chapter five' })[0]!);
    expect(await screen.findByText('Draft chapter five: finished, and 1 later block.')).toBeVisible();
    const dialog = await sheet(3);
    expect(rows(dialog)).toEqual(['Email the editor', 'Piano', 'Pay the water bill']);
    expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBe(at(10));
    // Focus moves on to the row that took its place.
    await waitFor(() => expect(document.activeElement?.closest('[role="group"]')).toHaveAccessibleName('Email the editor'));

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(rows(await sheet())).toHaveLength(5);
    expect((await getRecord(t.db, 'task', 't1'))?.done_at).toBeNull();
    expect(await outcome(t, 'b1')).toMatchObject({ deleted_at: expect.any(String) });
  });

  it('Not done and Skipped save at once, each with its own words', async () => {
    const t = await open();
    await userEvent.click(within(await sheet()).getByRole('button', { name: 'Not done: Email the editor' }));
    expect(await screen.findByText("Email the editor: not done. It's in Needs a new time.")).toBeVisible();
    await userEvent.click(within(await sheet(4)).getByRole('button', { name: 'Skipped: Piano' }));
    expect(await screen.findByText('Piano: skipped.')).toBeVisible();
    expect(await outcome(t, 'b2')).toMatchObject({ result: 'not' });
    expect(await outcome(t, 'pb')).toMatchObject({ result: 'not', logged_min: 0 });
    await userEvent.click(within(await sheet(3)).getByRole('button', { name: 'Finished: Pay the water bill' }));
    expect(await screen.findByText('Pay the water bill: finished.')).toBeVisible();
  });

  it('Partly asks for the time left inside the sheet, from what was left, and Back saves nothing', async () => {
    const t = await open();
    let dialog = await sheet();
    await userEvent.click(within(dialog).getAllByRole('button', { name: 'Partly: Draft chapter five' })[0]!);
    expect(within(dialog).getByRole('heading', { name: 'How much is left?' })).toHaveFocus();
    expect(within(dialog).getByText('2h left')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(rows(dialog)).toHaveLength(5);
    expect(within(dialog).getAllByRole('button', { name: 'Partly: Draft chapter five' })[0]!).toHaveFocus();
    expect(await outcome(t, 'b1')).toBeUndefined();

    await userEvent.click(within(dialog).getAllByRole('button', { name: 'Partly: Draft chapter five' })[0]!);
    await userEvent.click(within(dialog).getByRole('button', { name: 'More time left: Draft chapter five' }));
    expect(within(dialog).getByText('2h 30m left')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Draft chapter five: partly, 2h 30m left.')).toBeVisible();
    expect(await outcome(t, 'b1')).toMatchObject({ result: 'partly', remaining_min: 150 });
    // The task is still open, so its later block stays to be answered.
    dialog = await sheet(4);
    expect(rows(dialog)[2]).toBe('Draft chapter five');
  });

  it("a practice's Some logs the minutes done", async () => {
    const t = await open();
    const dialog = await sheet();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Some: Piano' }));
    expect(within(dialog).getByRole('heading', { name: 'How much did you do?' })).toBeVisible();
    expect(within(dialog).getByText('15m done')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'More time done: Piano' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Piano: logged 20m.')).toBeVisible();
    expect(await outcome(t, 'pb')).toMatchObject({ result: 'done', logged_min: 20 });
  });

  it('Select mode answers every ticked row at once, with one Undo, and Finished is Did it for a practice', async () => {
    const t = await open();
    const dialog = await sheet();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Select' }));
    const boxes = within(dialog).getAllByRole('checkbox');
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([false, false, false, false, false]);
    expect(within(dialog).getByRole('status')).toHaveTextContent('0 selected');
    for (const name of ['Finished', 'Partly', 'Not done']) expect(within(dialog).getByRole('button', { name })).toBeDisabled();

    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Email the editor' }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Piano' }));
    expect(within(dialog).getByRole('status')).toHaveTextContent('2 selected');
    expect(within(dialog).getByText('For a practice, Finished counts as Did it.')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Finished' }));
    expect(await screen.findByText('Answered 2 blocks.')).toBeVisible();
    expect(await outcome(t, 'b2')).toMatchObject({ result: 'done' });
    expect(await outcome(t, 'pb')).toMatchObject({ result: 'done', logged_min: 30 });
    // Back to answering row by row.
    expect(rows(await sheet(3))).toEqual(['Draft chapter five', 'Draft chapter five', 'Pay the water bill']);
    expect(within(await sheet(3)).queryByRole('checkbox')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(rows(await sheet())).toHaveLength(5);
    expect(await outcome(t, 'b2')).toMatchObject({ deleted_at: expect.any(String) });
    expect(await outcome(t, 'pb')).toMatchObject({ deleted_at: expect.any(String) });
  });

  it('Partly for a selection gives each row its own stepper from its own value, saved together', async () => {
    const t = await open();
    const dialog = await sheet();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Select' }));
    await userEvent.click(within(dialog).getAllByRole('checkbox', { name: 'Draft chapter five' })[0]!);
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Email the editor' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Partly' }));
    expect(within(dialog).getByText('2h left')).toBeVisible();
    expect(within(dialog).getByText('30m left')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Less time left: Email the editor' }));
    expect(within(dialog).getByText('15m left')).toBeVisible();

    // Back keeps the selection.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(within(dialog).getByRole('status')).toHaveTextContent('2 selected');
    expect(within(dialog).getByRole('button', { name: 'Partly' })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Partly' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save 2 answers' }));
    expect(await screen.findByText('Answered 2 blocks.')).toBeVisible();
    expect(await outcome(t, 'b1')).toMatchObject({ result: 'partly', remaining_min: 120 });
    expect(await outcome(t, 'b2')).toMatchObject({ result: 'partly', remaining_min: 30 });
  });

  it('Cancel leaves Select mode with nothing changed', async () => {
    const t = await open();
    const dialog = await sheet();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Select' }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Piano' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Select' })).toHaveFocus();
    expect(await outcome(t, 'pb')).toBeUndefined();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Select' }));
    expect(within(dialog).getByRole('status')).toHaveTextContent('0 selected');
  });

  it('Select all then Not done answers every one, and the sheet goes', async () => {
    const t = await open();
    const dialog = await sheet();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Select' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Select all' }));
    expect(within(dialog).getByRole('status')).toHaveTextContent('5 selected');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Not done' }));
    expect(await screen.findByText('Answered 5 blocks.')).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    for (const id of ['b1', 'b2', 'b3', 'b4']) expect(await outcome(t, id)).toMatchObject({ result: 'not' });
    expect(await outcome(t, 'pb')).toMatchObject({ result: 'not', logged_min: 0 });
  });

  it('the key says what the icons mean, for a practice too', async () => {
    await open();
    const dialog = await sheet();
    const info = within(dialog).getByRole('button', { name: 'What the icons mean' });
    expect(info).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(info);
    expect(info).toHaveAttribute('aria-expanded', 'true');
    const key = within(dialog).getByRole('group', { name: 'Key' });
    expect(key).toHaveTextContent('Finished');
    expect(key).toHaveTextContent('Partly, some is left');
    expect(key).toHaveTextContent('Not done');
    expect(key).toHaveTextContent('For a practice: Did it, Some and Skipped.');
    // Esc puts the key away first, and leaves the sheet up.
    await userEvent.keyboard('{Escape}');
    expect(info).toHaveAttribute('aria-expanded', 'false');
    expect(dialog).toBeInTheDocument();
  });

  it('works from the keyboard', async () => {
    const t = await open();
    const dialog = await sheet();
    const focusedRow = () => document.activeElement?.closest('[role="group"]')?.getAttribute('aria-label');
    await waitFor(() => expect(focusedRow()).toBe('Draft chapter five'));
    await userEvent.keyboard('{ArrowDown}');
    expect(focusedRow()).toBe('Email the editor');
    await userEvent.keyboard('3');
    expect(await screen.findByText("Email the editor: not done. It's in Needs a new time.")).toBeVisible();
    await waitFor(() => expect(focusedRow()).toBe('Piano'));

    await userEvent.keyboard('i');
    expect(within(dialog).getByRole('group', { name: 'Key' })).toBeVisible();
    await userEvent.keyboard('i');
    expect(within(dialog).queryByRole('group', { name: 'Key' })).toBeNull();

    await userEvent.keyboard('s');
    expect(within(dialog).getByRole('status')).toHaveTextContent('0 selected');
    await userEvent.keyboard(' ');
    expect(within(dialog).getByRole('checkbox', { name: 'Piano' })).toBeChecked();
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(focusedRow()).toBe('Draft chapter five');
    await userEvent.keyboard('a');
    expect(within(dialog).getByRole('status')).toHaveTextContent('4 selected');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await outcome(t, 'pb')).toBeUndefined();

    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    await sheet(4);
    await waitFor(() => expect(focusedRow()).toBe('Draft chapter five'));
    await userEvent.keyboard('s');
    await userEvent.keyboard('a');
    await userEvent.keyboard('1');
    expect(await screen.findByText('Answered 4 blocks.')).toBeVisible();
    expect(await outcome(t, 'b4')).toMatchObject({ result: 'done' });
  });

  it('Later puts it away for the session, and Review brings it back', async () => {
    await open();
    await userEvent.click(within(await sheet()).getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await sheet()).toBeVisible();
  });

  it('on phone is a modal sheet with a way to put it away', async () => {
    await open('phone');
    const dialog = await sheet();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('button', { name: 'Later' })).toBeVisible();
  });

  it('stays up for the last row, rather than switching to another prompt', async () => {
    await open();
    await userEvent.click(within(await sheet()).getByRole('button', { name: 'Select' }));
    const dialog = await sheet();
    for (const box of within(dialog).getAllByRole('checkbox').slice(0, 4)) await userEvent.click(box);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Not done' }));
    expect(rows(await screen.findByRole('dialog', { name: '1 missed block' }))).toEqual(['Pay the water bill']);
  });
});
