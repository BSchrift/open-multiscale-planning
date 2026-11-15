import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Card, Chip, Icon, ListRow, Segmented, Switch, TextField } from '.';

afterEach(cleanup);
const css = readFileSync(join(import.meta.dirname, 'ds.css'), 'utf8');

describe('Chip', () => {
  it('is a toggle that says whether it’s on', async () => {
    const onClick = vi.fn();
    render(<Chip pressed={false} onClick={onClick}>Mon</Chip>);
    const chip = screen.getByRole('button', { name: 'Mon' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(chip).toHaveClass('chip');
    await userEvent.click(chip);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('Card', () => {
  it('is a section named by its heading, with its actions beside it', () => {
    render(
      <Card title="To schedule" actions={<button type="button">Schedule one at a time</button>}>
        <p>Nothing waiting.</p>
      </Card>,
    );
    const card = screen.getByRole('region', { name: 'To schedule' });
    expect(card).toHaveClass('card');
    expect(card.querySelector('.cardhead button')).toHaveTextContent('Schedule one at a time');
  });
});

describe('ListRow', () => {
  it('puts its title and meta first and its trailing icons in one column', () => {
    render(<ListRow title="Call the bank" meta="15m estimate" trailing={<Icon name="chevron-right" />} />);
    const row = screen.getByText('Call the bank').closest('.lrow')!;
    expect(row.querySelector('.lrowmeta')).toHaveTextContent('15m estimate');
    expect(row.querySelector('.lrowtrail svg')).not.toBeNull();
    // A fixed column, so a pencil and a chevron line up from row to row.
    expect(css).toMatch(/\.lrow \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/);
  });
});

describe('TextField', () => {
  it('labels its field and ties its help and error to it', () => {
    render(<TextField label="Title" value="" onChange={() => {}} help="Short and specific" error="Give it a title" />);
    const field = screen.getByRole('textbox', { name: 'Title' });
    expect(field).toHaveAccessibleDescription('Short and specific Give it a title');
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('Switch', () => {
  it('is a switch that turns on and off, named by its label', async () => {
    function On() {
      const [on, setOn] = useState(false);
      return <Switch checked={on} onChange={setOn} label="Add to this week" />;
    }
    render(<On />);
    const sw = screen.getByRole('switch', { name: 'Add to this week' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Segmented', () => {
  it('is a group of buttons, the chosen one pressed', async () => {
    const onChange = vi.fn();
    render(<Segmented label="Timeline view" options={[['calendar', 'Calendar'], ['list', 'List']]} value="calendar" onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'Timeline view' });
    expect(group).toHaveClass('seg');
    expect(screen.getByRole('button', { name: 'Calendar' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(onChange).toHaveBeenCalledWith('list');
  });
});
