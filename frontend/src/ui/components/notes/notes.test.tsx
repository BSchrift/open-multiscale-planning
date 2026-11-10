import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localToInstant } from '../../../core/dates';
import { MAX_NOTES } from '../../../core/notes';
import { getRecord, weekPlanId } from '../../../core/records';
import type { Writer } from '../../../core/records';
import { fixedClock } from '../../../core/clock';
import { createTestPlatform } from '../../../platform/testing';
import type { Layout } from '../../app/registry';
import { AppProvider } from '../../app/store';
import { renderScreen } from '../../app/testing';
import { Notes } from './Notes';
import { NotesField } from './NotesField';

afterEach(cleanup);

async function inApp(ui: React.ReactNode, layout: Layout = 'desktop') {
  const platform = await createTestPlatform();
  return render(
    <AppProvider platform={platform} clock={fixedClock(0)} layout={layout}>
      <div data-layout={layout}>{ui}</div>
    </AppProvider>,
  );
}

function Field(props: { initial?: string; onValue?(v: string): void }) {
  const [value, setValue] = useState(props.initial ?? '');
  return (
    <NotesField
      value={value}
      onChange={(v) => {
        setValue(v);
        props.onValue?.(v);
      }}
    />
  );
}

describe('Notes', () => {
  it('shows each mark as the app’s own elements', async () => {
    const { container } = await inApp(<Notes text={'Use the **Q3 numbers** first.\n- Check the totals\n- Send it by *Friday*\n\n1. [The brief](https://example.com/brief)'} />);
    expect(container.querySelector('strong')).toHaveTextContent('Q3 numbers');
    expect(container.querySelector('em')).toHaveTextContent('Friday');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Check the totals', 'Send it by Friday', 'The brief']);
    const link = screen.getByRole('link', { name: 'The brief' });
    expect(link).toHaveAttribute('href', 'https://example.com/brief');
    // Out of the app, to the system browser.
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('never runs or loads anything a description holds', async () => {
    const hostile = [
      '<script>window.ran = true</script>',
      '<img src="https://example.com/x.png" onerror="window.ran = true">',
      '![picture](https://example.com/x.png)',
      '[click](javascript:window.ran=true)',
      '<b>html</b>',
    ].join('\n');
    const { container } = await inApp(<Notes text={hostile} />);
    expect(container.querySelectorAll('script, img, b, iframe, style')).toHaveLength(0);
    for (const line of hostile.split('\n')) expect(container).toHaveTextContent(line, { normalizeWhitespace: false });
    expect(screen.queryByRole('link', { name: 'click' })).toBeNull();
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['https://example.com/x.png']);
    expect((window as unknown as { ran?: boolean }).ran).toBeUndefined();
  });
});

describe('NotesField', () => {
  it('puts the bar’s marks around the selection', async () => {
    let value = '';
    await inApp(<Field onValue={(v) => (value = v)} />);
    const field = screen.getByLabelText('Description');
    await userEvent.type(field, 'Use the numbers');
    (field as HTMLTextAreaElement).setSelectionRange(8, 15);
    await userEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(value).toBe('Use the **numbers**');
    // The words stay selected, so a second press takes the mark off.
    await userEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(value).toBe('Use the numbers');
    (field as HTMLTextAreaElement).setSelectionRange(0, 3);
    await userEvent.click(screen.getByRole('button', { name: 'Italic' }));
    expect(value).toBe('*Use* the numbers');
    await userEvent.click(screen.getByRole('button', { name: 'Bulleted list' }));
    expect(value).toBe('- *Use* the numbers');
    (field as HTMLTextAreaElement).setSelectionRange(12, 19);
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(value).toBe('- *Use* the [numbers](https://)');
    // Its address is selected, to type over.
    expect(field).toHaveFocus();
    expect((field as HTMLTextAreaElement).selectionStart).toBe(22);
    expect((field as HTMLTextAreaElement).selectionEnd).toBe(30);
  });

  it('takes ⌘B and ⌘I as Bold and Italic on a Mac, and Ctrl elsewhere', async () => {
    let value = '';
    await inApp(<Field initial="" onValue={(v) => (value = v)} />);
    const field = screen.getByLabelText('Description') as HTMLTextAreaElement;
    await userEvent.type(field, 'plan');
    field.setSelectionRange(0, 4);
    fireEvent.keyDown(field, { key: 'b', ctrlKey: true });
    expect(value).toBe('**plan**');
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    fireEvent.keyDown(field, { key: 'i', ctrlKey: true });
    expect(value).toBe('**plan**');
    fireEvent.keyDown(field, { key: 'i', metaKey: true });
    expect(value).toBe('***plan***');
    platform.mockRestore();
  });

  it('stops at the limit, and counts from 90% of it', async () => {
    await inApp(<Field initial={'x'.repeat(MAX_NOTES * 0.9 - 1)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit description' }));
    const field = screen.getByLabelText('Description');
    expect(field).toHaveAttribute('maxlength', String(MAX_NOTES));
    expect(screen.queryByText(/of 20,000/)).toBeNull();
    await userEvent.type(field, 'x');
    expect(screen.getByText('18,000 of 20,000')).toBeVisible();
    expect(field).toHaveAccessibleDescription('18,000 of 20,000');
  });

  it('shows a description formatted until it’s tapped, but a link still opens', async () => {
    await inApp(<Field initial="See [the brief](https://example.com) **first**" />);
    expect(screen.queryByRole('textbox')).toBeNull();
    const shown = screen.getByRole('group', { name: 'Description' });
    expect(within(shown).getByText('first').tagName).toBe('STRONG');
    await userEvent.click(within(shown).getByRole('link', { name: 'the brief' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    await userEvent.click(within(shown).getByText('first'));
    const field = await screen.findByLabelText('Description');
    expect(field).toHaveFocus();
    expect(field).toHaveValue('See [the brief](https://example.com) **first**');
  });

  it('names every tool on the bar', async () => {
    await inApp(<Field />, 'phone');
    for (const button of within(screen.getByRole('toolbar', { name: 'Formatting' })).getAllByRole('button')) {
      expect(button).toHaveClass('notestool');
      expect(button).toHaveAccessibleName();
    }
  });
});

describe('descriptions in the editors', () => {
  async function bread(w: Writer) {
    await w.create('project', { title: 'Bake a loaf', state: 'active', start: '2026-10-01', end: '2026-12-15' }, 'p1');
    await w.create('milestone', { project_id: 'p1', title: 'First loaf', due: '2026-11-20' }, 'm1');
    await w.create('task', { kind: 'project', project_id: 'p1', milestone_id: 'm1', title: 'Feed the starter', estimate_min: 120 }, 't1');
  }

  for (const layout of ['desktop', 'phone'] as const) {
    it(`a project task saves its description, and clears it (${layout})`, async () => {
      const t = await renderScreen('goals', { layout, seed: bread, params: { project: 'p1' } });
      await userEvent.click(await screen.findByRole('button', { name: 'Edit task Feed the starter, 2h' }));
      let editor = await screen.findByRole('dialog', { name: 'Feed the starter' });
      await userEvent.type(within(editor).getByLabelText('Description'), 'Use **rye**');
      await userEvent.click(within(editor).getByRole('button', { name: 'Save' }));
      await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.notes).toBe('Use **rye**'));

      // Its row now carries the mark for a task with details.
      const row = await screen.findByRole('button', { name: 'Edit task Feed the starter, 2h, has details' });
      expect(within(row).getByRole('img', { name: 'Has details' })).toBeInTheDocument();
      await userEvent.click(row);
      editor = await screen.findByRole('dialog', { name: 'Feed the starter' });
      expect(within(editor).getByText('rye').tagName).toBe('STRONG');
      await userEvent.click(within(editor).getByRole('button', { name: 'Edit description' }));
      await userEvent.clear(within(editor).getByLabelText('Description'));
      await userEvent.type(within(editor).getByLabelText('Description'), '  ');
      await userEvent.click(within(editor).getByRole('button', { name: 'Save' }));
      await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.notes).toBeNull());
    });
  }

  it('a new project task takes a description, and the next one starts without it', async () => {
    const t = await renderScreen('goals', { seed: bread, params: { project: 'p1' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Add task to First loaf' }));
    const editor = screen.getByRole('dialog', { name: 'Add task' });
    await userEvent.type(within(editor).getByLabelText('Title'), 'Shape the dough');
    await userEvent.type(within(editor).getByLabelText('Description'), 'Tight *ball*');
    await userEvent.click(within(editor).getByRole('button', { name: 'Add' }));
    expect(await within(editor).findByText('Added Shape the dough.')).toBeVisible();
    expect(within(editor).getByLabelText('Description')).toHaveValue('');
    await userEvent.type(within(editor).getByLabelText('Title'), 'Bake it');
    await userEvent.click(within(editor).getByRole('button', { name: 'Add' }));
    await within(editor).findByText('Added Bake it.');
    const rows = await t.db.all<{ title: string; notes: string | null }>("SELECT title, notes FROM task WHERE id != 't1' ORDER BY id");
    expect(rows).toEqual([
      { title: 'Shape the dough', notes: 'Tight *ball*' },
      { title: 'Bake it', notes: null },
    ]);
  });

  it('a one off saves its description, and keeps it through a change of repeat', async () => {
    const t = await renderScreen('oneoffs', {
      seed: (w) => w.create('task', { kind: 'one_off', title: 'Tidy the shed', schedule: { type: 'once' }, notes: 'Start with the **tools**' }, 't1'),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Change repeat for Tidy the shed' }));
    const form = screen.getByRole('form', { name: 'Change Tidy the shed' });
    expect(within(form).getByText('tools').tagName).toBe('STRONG');
    await userEvent.selectOptions(within(form).getByLabelText('Repeats'), 'In certain months');
    await userEvent.click(within(form).getByRole('button', { name: 'March' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await getRecord(t.db, 'task', 't1'))?.schedule?.type).toBe('seasonal'));
    expect(screen.getByRole('img', { name: 'Has details' })).toBeInTheDocument();
    expect((await getRecord(t.db, 'task', 't1'))?.notes).toBe('Start with the **tools**');
  });
});

describe('the Now card', () => {
  it('shows the first two lines of the block’s description, without marks', async () => {
    const zone = 'America/Chicago';
    const at = (minutes: number) => localToInstant('2026-11-02', minutes, zone);
    await renderScreen('today', {
      now: at(14 * 60),
      zone,
      seed: async (w) => {
        await w.create('week_plan', { week_start: '2026-11-02', finished_at: at(8 * 60) }, weekPlanId('2026-11-02'));
        await w.create('task', { kind: 'one_off', title: 'Write the report', notes: 'Use the **Q3 numbers** first.\n- Check the totals\n- Send it' }, 't1');
        await w.create('time_block', { task_id: 't1', start: at(13 * 60), end: at(15 * 60), tz: zone }, 'b1');
      },
    });
    const now = await screen.findByRole('region', { name: 'Current block' });
    const glance = await within(now).findByText(/Use the Q3 numbers first\./);
    expect(glance.textContent).toBe('Use the Q3 numbers first.\nCheck the totals');
  });
});
