import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { getRecord } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderApp, renderScreen } from '../../app/testing';
import type { Harness } from '../../app/testing';

afterEach(cleanup);

async function seed(w: Writer) {
  await w.create('task', { kind: 'inbox', title: 'Call the bank' }, 'i1');
  await w.create('task', { kind: 'inbox', title: 'Fix the gate', estimate_min: 120 }, 'i2');
  await w.create('task', { kind: 'one_off', title: 'Return the books', schedule: { type: 'once' } }, 'o1');
}

const rows = () => Array.from(document.querySelectorAll('.inboxrow')).map((r) => r.textContent);

describe('Inbox on desktop', () => {
  it('lists what was captured in added order, live, with Process first', async () => {
    const t = await renderScreen('inbox', { seed });
    expect(await screen.findByRole('heading', { name: 'Inbox', level: 1 })).toBeInTheDocument();
    await screen.findByText('Call the bank');
    expect(rows()).toEqual(['Call the bankAssign', 'Fix the gate2h estimateAssign']);
    await act(() => t.write((w) => w.create('task', { kind: 'inbox', title: 'Buy stamps' }, 'i3')));
    expect(await screen.findByRole('button', { name: 'Process 3 items' })).toHaveClass('pxstart');
    expect(rows()[2]).toBe('Buy stampsAssign');
  });

  it('opens Process over the page, from the top or on one item', async () => {
    const t = await renderScreen('inbox', { seed });
    await userEvent.click(await screen.findByRole('button', { name: 'Process 2 items' }));
    expect(t.nav().overlay).toEqual({ area: 'process', params: {} });
    await userEvent.click(screen.getByRole('button', { name: 'Assign Fix the gate' }));
    expect(t.nav().overlay).toEqual({ area: 'process', params: { item: 'i2' } });
  });

  it('says when it is empty', async () => {
    await renderScreen('inbox');
    expect(await screen.findByText('Inbox is empty.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Process/ })).toBeNull();
    // No empty card under it.
    expect(document.querySelector('.inboxlist')).toBeNull();
  });
});

describe('Inbox on phone', () => {
  it('lists rows whose › opens Process on that item, and docks the Process button', async () => {
    const t = await renderScreen('inbox', { seed, layout: 'phone' });
    await screen.findByText('Call the bank');
    expect(rows()).toEqual(['Call the bank›', 'Fix the gate2h estimate›']);
    await userEvent.click(screen.getByRole('button', { name: 'Process Fix the gate' }));
    expect(t.nav().overlay).toEqual({ area: 'process', params: { item: 'i2' } });
    expect(screen.getByRole('button', { name: 'Process 2 items' })).toHaveClass('tray', 'go');
  });

  // The owner's request: an Inbox item opens to be changed, its description included, before it has a home.
  for (const layout of ['desktop', 'phone'] as const) {
    it(`an item's name opens its popup, to rename it and write its description (${layout})`, async () => {
      const t = await renderScreen('inbox', { seed, layout });
      await userEvent.click(await screen.findByRole('button', { name: 'Fix the gate' }));
      const popup = await screen.findByRole('dialog', { name: 'Fix the gate' });
      await userEvent.click(within(popup).getByRole('button', { name: 'Rename Fix the gate' }));
      await userEvent.clear(within(popup).getByRole('textbox', { name: 'Name' }));
      await userEvent.type(within(popup).getByRole('textbox', { name: 'Name' }), 'Fix the side gate');
      await userEvent.type(within(popup).getByRole('textbox', { name: 'Description' }), 'Hinges from the **shed**');
      await userEvent.click(within(popup).getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('Saved Fix the side gate.')).toBeVisible();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(await getRecord(t.db, 'task', 'i2')).toMatchObject({ kind: 'inbox', title: 'Fix the side gate', notes: 'Hinges from the **shed**' });
      // Still in the Inbox, now with the mark for a task with details.
      const name = await screen.findByRole('button', { name: /^Fix the side gate/ });
      expect(within(name).getByRole('img', { name: 'Has details' })).toBeInTheDocument();
      expect(name).toHaveFocus();
    });
  }

  it('says where captures land when it is empty', async () => {
    await renderScreen('inbox', { layout: 'phone' });
    expect(await screen.findByText('Inbox is empty. Anything you capture lands here.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Process/ })).toBeNull();
  });

  it('runs Process from the Inbox tab and comes back to a clear Inbox', async () => {
    await renderApp({ layout: 'phone', seed: (w) => w.create('task', { kind: 'inbox', title: 'Call the bank' }, 'i1') });
    await userEvent.click(await screen.findByRole('button', { name: 'Inbox, 1 to sort' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Process 1 item' }));
    await userEvent.click(await screen.findByRole('button', { name: 'One offs' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Inbox is empty. Anything you capture lands here.')).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// The owner's request: no batches of 25. Select mode sorts a long Inbox in a few actions, each with one Undo.
describe('Inbox select mode', () => {
  async function many(w: Writer) {
    await w.create('project', { title: 'Japan trip', state: 'active' }, 'p1');
    await w.create('project', { title: 'Paint the house', state: 'paused' }, 'p2');
    await w.create('project', { title: 'Old garden', state: 'finished' }, 'p3');
    await w.create('task', { kind: 'inbox', title: 'Book the flights' }, 'i1');
    await w.create('task', { kind: 'inbox', title: 'Renew the passport' }, 'i2');
    await w.create('task', { kind: 'inbox', title: 'Call the bank' }, 'i3');
    await w.create('task', { kind: 'inbox', title: 'Buy stamps' }, 'i4');
  }
  const box = (name: string) => screen.getByRole('checkbox', { name });
  const count = (text: string) => expect(screen.getByText(text)).toHaveAttribute('role', 'status');
  /** Where each item is now: still in the Inbox, sent somewhere, or deleted. */
  const where = (t: Harness) =>
    Promise.all(
      ['i1', 'i2', 'i3', 'i4'].map(async (id) => {
        const task = await getRecord(t.db, 'task', id);
        return task?.deleted_at ? 'deleted' : task?.kind;
      }),
    );

  for (const layout of ['desktop', 'phone'] as const) {
    it(`Select gives each item a checkbox, Select all and a count; leaving clears it, and nothing is written (${layout})`, async () => {
      const t = await renderScreen('inbox', { seed: many, layout });
      await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
      expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['Book the flights', 'Renew the passport', 'Call the bank', 'Buy stamps']);
      // While selecting, a row ticks its box rather than opening Process or the popup.
      expect(screen.queryByRole('button', { name: /Call the bank/ })).toBeNull();
      count('0 selected');
      for (const name of ['Send', 'Make one offs', 'Delete/done']) expect(screen.getByRole('button', { name })).toBeDisabled();

      await userEvent.click(box('Renew the passport'));
      count('1 selected');
      // The whole row is the checkbox's label.
      await userEvent.click(screen.getByText('Buy stamps'));
      count('2 selected');
      expect(box('Buy stamps')).toBeChecked();
      await userEvent.click(screen.getByRole('button', { name: 'Select all' }));
      count('4 selected');
      expect(screen.getAllByRole('checkbox').every((c) => (c as HTMLInputElement).checked)).toBe(true);

      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('checkbox')).toBeNull();
      expect(screen.getByRole('button', { name: 'Select' })).toHaveFocus();
      await userEvent.click(screen.getByRole('button', { name: 'Select' }));
      count('0 selected');
      expect(await where(t)).toEqual(['inbox', 'inbox', 'inbox', 'inbox']);
    });
  }

  it('sends the selected items to a project in one change, with one Undo, and focus goes to the next item', async () => {
    const t = await renderScreen('inbox', { seed: many });
    await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
    await userEvent.click(box('Book the flights'));
    await userEvent.click(box('Renew the passport'));
    const picker = screen.getByRole('combobox', { name: 'Send to project' });
    // Active and paused projects, as Process offers.
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a project', 'Japan trip', 'Paint the house (Paused)']);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await userEvent.selectOptions(picker, 'Japan trip');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Sent 2 items to Japan trip.')).toBeVisible();
    expect(await where(t)).toEqual(['project', 'project', 'inbox', 'inbox']);
    expect(await getRecord(t.db, 'task', 'i1')).toMatchObject({ project_id: 'p1' });
    await waitFor(() => expect(rows()).toEqual(['Call the bankAssign', 'Buy stampsAssign']));
    // Select mode ends with the action, and focus lands on the item after the first one sent.
    expect(screen.queryByRole('checkbox')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Call the bank' })).toHaveFocus());

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(await where(t)).toEqual(['inbox', 'inbox', 'inbox', 'inbox']);
  });

  it('makes the selected items one offs, and with nothing after them focus goes to Select', async () => {
    const t = await renderScreen('inbox', { seed: many, layout: 'phone' });
    await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
    await userEvent.click(box('Buy stamps'));
    await userEvent.click(screen.getByRole('button', { name: 'Make one offs' }));
    expect(await screen.findByText('Made 1 one off.')).toBeVisible();
    expect(await where(t)).toEqual(['inbox', 'inbox', 'inbox', 'one_off']);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select' })).toHaveFocus());

    await userEvent.click(screen.getByRole('button', { name: 'Select' }));
    await userEvent.click(box('Book the flights'));
    await userEvent.click(box('Call the bank'));
    await userEvent.click(screen.getByRole('button', { name: 'Make one offs' }));
    expect(await screen.findByText('Made 2 one offs.')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Renew the passport' })).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect(await where(t)).toEqual(['inbox', 'inbox', 'inbox', 'one_off']));
  });

  it('asks before deleting, as Process does, then deletes them all with one Undo', async () => {
    const t = await renderScreen('inbox', { seed: many });
    await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
    await userEvent.click(screen.getByRole('button', { name: 'Select all' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete/done' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Delete 4 items?');
    await userEvent.click(screen.getByRole('button', { name: 'Keep them' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete/done' })).toHaveFocus();
    expect(await where(t)).toEqual(['inbox', 'inbox', 'inbox', 'inbox']);

    await userEvent.click(screen.getByRole('button', { name: 'Delete/done' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(await screen.findByText('Deleted 4 items.')).toBeVisible();
    expect(await where(t)).toEqual(['deleted', 'deleted', 'deleted', 'deleted']);
    expect(await screen.findByText('Inbox is empty.')).toBeVisible();
    // Nothing is left to focus, so Undo takes it.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(await where(t)).toEqual(['inbox', 'inbox', 'inbox', 'inbox']);
  });

  it('drops an item from the selection when it leaves the Inbox some other way', async () => {
    const t = await renderScreen('inbox', { seed: many });
    await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
    await userEvent.click(box('Call the bank'));
    await userEvent.click(box('Buy stamps'));
    count('2 selected');
    await act(() => t.write((w) => w.set('task', 'i3', { kind: 'one_off' })));
    await waitFor(() => count('1 selected'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete/done' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Delete 1 item?');
  });
});
