import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { getRecord } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderApp, renderScreen } from '../../app/testing';

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
