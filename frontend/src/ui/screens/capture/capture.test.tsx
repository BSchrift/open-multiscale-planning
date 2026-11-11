import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listRecords } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { renderApp, renderScreen } from '../../app/testing';
import type { Layout } from '../../app/registry';
import { EST_STEPS } from '../../components/EstimateSlider';

afterEach(cleanup);

const running = { state: 'active' as const, start: '2026-10-01', end: '2027-01-31' };
async function seed(w: Writer) {
  await w.create('project', { title: 'Paint the fence', ...running }, 'p1');
  await w.create('project', { title: 'Write the report', ...running, state: 'finished' }, 'p2');
  await w.create('milestone', { project_id: 'p1', title: 'Primer on', due: '2026-11-20' }, 'm1');
  await w.create('milestone', { project_id: 'p1', title: 'Second coat', due: '2026-11-10' }, 'm2');
  await w.create('milestone', { project_id: 'p1', title: 'Sanded', due: '2026-11-01', met_at: '2026-10-30T12:00:00Z' }, 'm3');
  await w.create('milestone', { project_id: 'p1', title: 'Old plan', dropped_at: '2026-10-20T12:00:00Z' }, 'm4');
  await w.create('milestone', { project_id: 'p2', title: 'First draft', due: '2026-11-15' }, 'm5');
}

const open = (layout: Layout = 'desktop') => {
  const close = vi.fn();
  return renderScreen('capture', { layout, seed, presentation: 'overlay', close }).then(async (t) => {
    await screen.findByRole('textbox', { name: /Capture to/ });
    return { ...t, close };
  });
};
const field = () => screen.getByRole('textbox', { name: /Capture to/ });
const tasks = async (db: Parameters<typeof listRecords>[0]) => listRecords(db, 'task');

describe('Capture on desktop', () => {
  it('opens on one field, with details folded away', async () => {
    await open();
    expect(screen.getByRole('dialog', { name: 'Capture' })).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: 'Capture to Inbox' })).toHaveFocus();
    expect(screen.getByText('Saves to Inbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add details' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('saves to the Inbox on Enter, says so, then closes', async () => {
    const t = await open();
    await userEvent.type(field(), '  Call  the bank {Enter}');
    expect(await screen.findByText('Saved to Inbox, 1 waiting')).toBeInTheDocument();
    expect(await tasks(t.db)).toMatchObject([{ kind: 'inbox', title: 'Call the bank' }]);
    expect((await tasks(t.db))[0]!.estimate_min ?? null).toBeNull();
    await waitFor(() => expect(t.close).toHaveBeenCalled(), { timeout: 2000 });
  });

  it('says what it saved through a live region that was already there, so screen readers announce it', async () => {
    await open();
    const status = within(screen.getByRole('dialog', { name: 'Capture' })).getByRole('status');
    expect(status).toBeEmptyDOMElement();
    await userEvent.type(field(), 'Call the bank{Enter}');
    await waitFor(() => expect(status).toHaveTextContent('Saved to Inbox, 1 waiting'));
    expect(status).toBeInTheDocument();
  });

  it('keeps a pasted title to a length that syncs', async () => {
    const t = await open();
    await userEvent.click(field());
    await userEvent.paste('x'.repeat(5000));
    await userEvent.keyboard('{Enter}');
    await waitFor(async () => expect((await tasks(t.db))[0]?.title).toHaveLength(2000));
  });

  it('saves nothing when empty, and Esc cancels', async () => {
    const t = await open();
    await userEvent.type(field(), '{Enter}');
    expect(await tasks(t.db)).toEqual([]);
    expect(t.close).not.toHaveBeenCalled();
    await userEvent.type(field(), 'Half a thought');
    await userEvent.keyboard('{Escape}');
    expect(t.close).toHaveBeenCalled();
    expect(await tasks(t.db)).toEqual([]);
  });

  it('keeps a time estimate in the Inbox, and a chosen place skips it', async () => {
    const t = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    const where = screen.getByRole('combobox', { name: 'Send to' });
    expect(within(where).getAllByRole('option').map((o) => o.textContent)).toEqual(['Inbox', 'One offs', 'Paint the fence']);
    fireEvent.change(screen.getByRole('slider', { name: 'Time' }), { target: { value: String(EST_STEPS.indexOf(120)) } });
    await userEvent.type(field(), 'Fix the gate{Enter}');
    await screen.findByText(/Saved to Inbox/);
    expect(await tasks(t.db)).toMatchObject([{ kind: 'inbox', title: 'Fix the gate', estimate_min: 120 }]);
  });

  it('sends straight to a project', async () => {
    const t = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'Paint the fence');
    expect(screen.getByText('Saves to Paint the fence')).toBeInTheDocument();
    await userEvent.type(field(), 'Buy brushes{Enter}');
    expect(await screen.findByText('Saved to Paint the fence')).toBeInTheDocument();
    expect(await tasks(t.db)).toMatchObject([{ kind: 'project', project_id: 'p1', title: 'Buy brushes', milestone_id: null }]);
  });

  it("offers the chosen project's open milestones, soonest first, and saves to the one picked", async () => {
    const t = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    expect(screen.queryByRole('combobox', { name: 'Milestone' })).toBeNull();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'Paint the fence');
    const milestone = await screen.findByRole('combobox', { name: 'Milestone' });
    expect(within(milestone).getAllByRole('option').map((o) => o.textContent)).toEqual(['No milestone', 'Second coat', 'Primer on']);
    await userEvent.selectOptions(milestone, 'Primer on');
    expect(screen.getByText('Saves to Paint the fence, Primer on')).toBeInTheDocument();
    await userEvent.type(field(), 'Buy brushes{Enter}');
    expect(await screen.findByText('Saved to Paint the fence, Primer on')).toBeInTheDocument();
    expect(await tasks(t.db)).toMatchObject([{ kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Buy brushes' }]);
  });

  it('forgets the milestone when the place changes', async () => {
    const t = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'Paint the fence');
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Milestone' }), 'Second coat');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'One offs');
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Milestone' })).toBeNull());
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'Paint the fence');
    expect(await screen.findByRole('combobox', { name: 'Milestone' })).toHaveValue('');
    await userEvent.type(field(), 'Buy brushes{Enter}');
    await screen.findByText('Saved to Paint the fence');
    expect(await tasks(t.db)).toMatchObject([{ project_id: 'p1', milestone_id: null }]);
  });

  it('sends straight to One offs', async () => {
    const t = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'One offs');
    await userEvent.type(field(), 'Return the books{Enter}');
    expect(await screen.findByText('Saved to One offs')).toBeInTheDocument();
    expect(await tasks(t.db)).toMatchObject([{ kind: 'one_off', title: 'Return the books', schedule: { type: 'once' } }]);
  });
});

describe('Capture on phone', () => {
  it('is a sheet with one field and Save, saving to the Inbox and closing at once', async () => {
    const t = await open('phone');
    expect(screen.getByRole('dialog', { name: 'Capture' })).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: 'Capture to Inbox' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'Paint the fence');
    expect(screen.getByRole('textbox', { name: 'Capture to Paint the fence' })).toBeInTheDocument();
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Milestone' }), 'Second coat');
    expect(screen.getByRole('textbox', { name: 'Capture to Paint the fence, Second coat' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'Inbox');
    await userEvent.type(field(), 'Call the bank');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(t.close).toHaveBeenCalled();
    expect(await tasks(t.db)).toMatchObject([{ kind: 'inbox', title: 'Call the bank' }]);
  });
});

describe("Capture's details", () => {
  /** The details' controls in order, by their names. */
  const order = (dialog: HTMLElement) =>
    Array.from(dialog.querySelectorAll('input, select, textarea, [role="toolbar"]'))
      .map((e) => (e as HTMLElement).getAttribute('aria-label') ?? (e as HTMLInputElement).labels?.[0]?.textContent ?? e.tagName)
      .filter((name) => !name.startsWith('Capture to'));

  for (const layout of ['desktop', 'phone'] as const) {
    it(`open with Time first, then Send to, Milestone and Description (${layout})`, async () => {
      const t = await open(layout);
      await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Send to' }), 'Paint the fence');
      await screen.findByRole('combobox', { name: 'Milestone' });
      expect(order(screen.getByRole('dialog', { name: 'Capture' }))).toEqual(['Time', 'Send to', 'Milestone', 'Formatting', 'Description']);
      await userEvent.type(field(), 'Buy brushes');
      await userEvent.type(screen.getByRole('textbox', { name: 'Description' }), 'Two **wide** ones{Enter}and a narrow one');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(async () => expect(await tasks(t.db)).toMatchObject([{ title: 'Buy brushes', project_id: 'p1', notes: 'Two **wide** ones\nand a narrow one' }]));
    });
  }

  it('one Tab from the name reaches Time on desktop', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    field().focus();
    await userEvent.tab();
    expect(screen.getByRole('slider', { name: 'Time' })).toHaveFocus();
  });

  it('saves from the description with ⌘Enter, where Enter makes a new line', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const t = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    await userEvent.type(field(), 'Call the bank');
    const description = screen.getByRole('textbox', { name: 'Description' });
    await userEvent.type(description, 'Ask about{Enter}the fee');
    expect(await tasks(t.db)).toEqual([]);
    fireEvent.keyDown(description, { key: 'Enter', metaKey: true });
    await screen.findByText(/Saved to Inbox/);
    expect(await tasks(t.db)).toMatchObject([{ kind: 'inbox', title: 'Call the bank', notes: 'Ask about\nthe fee' }]);
  });

  it('leaves out an empty description', async () => {
    const t = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Add details' }));
    await userEvent.type(field(), 'Call the bank{Enter}');
    await screen.findByText(/Saved to Inbox/);
    expect((await tasks(t.db))[0]).not.toHaveProperty('notes');
  });
});

describe('Capture in the app', () => {
  it('opens from the phone + button and lands in the Inbox count', async () => {
    await renderApp({ layout: 'phone' });
    await userEvent.click(await screen.findByRole('button', { name: 'Capture a task' }));
    await userEvent.type(await screen.findByRole('textbox', { name: 'Capture to Inbox' }), 'Call the bank');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('button', { name: 'Inbox, 1 to sort' })).toBeInTheDocument();
    expect(await screen.findByText('Saved to Inbox')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Capture' })).toBeNull();
  });

  it('opens from Shift+Cmd+Space on desktop', async () => {
    await renderApp();
    await screen.findByRole('navigation', { name: 'Main' });
    act(() => void fireEvent.keyDown(window, { code: 'Space', key: ' ', shiftKey: true, metaKey: true }));
    await userEvent.type(await screen.findByRole('textbox', { name: 'Capture to Inbox' }), 'Call the bank{Enter}');
    expect(await screen.findByText('Saved to Inbox, 1 waiting')).toBeInTheDocument();
  });
});
