import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { Writer } from '../../../core/records';
import { renderApp, renderScreen } from '../../app/testing';

afterEach(cleanup);

async function seed(w: Writer) {
  await w.create('task', { kind: 'inbox', title: 'Call the bank' }, 'i1');
  await w.create('task', { kind: 'inbox', title: 'Fix the gate', estimate_min: 120 }, 'i2');
  await w.create('task', { kind: 'one_off', title: 'Return the books', schedule: { type: 'once' } }, 'o1');
}

const rows = () => Array.from(document.querySelectorAll('.inboxrow, .morerow')).map((r) => r.textContent);

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
  it('lists rows that open Process on that item, and docks the Process button', async () => {
    const t = await renderScreen('inbox', { seed, layout: 'phone' });
    await screen.findByText('Call the bank');
    expect(rows()).toEqual(['Call the bank›', 'Fix the gate2h estimate›']);
    await userEvent.click(screen.getByRole('button', { name: /Fix the gate/ }));
    expect(t.nav().overlay).toEqual({ area: 'process', params: { item: 'i2' } });
    expect(screen.getByRole('button', { name: 'Process 2 items' })).toHaveClass('tray', 'go');
  });

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
