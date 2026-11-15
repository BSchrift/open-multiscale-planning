import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { Icon, ICON_NAMES } from './Icon';

afterEach(cleanup);

describe('Icon', () => {
  it('draws on the 24 grid, hidden from screen readers, at one of three sizes', () => {
    const { container } = render(<Icon name="chevron-right" size={16} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.classList.contains('ico')).toBe(true);
    expect(svg.classList.contains('s16')).toBe(true);
    // Tests and the reference page find an icon by its name.
    expect(svg.dataset.icon).toBe('chevron-right');
  });

  it('has the brief’s set, including the answers, chevrons, pen, add and close', () => {
    for (const name of ['done', 'partly', 'not-done', 'no-answer', 'chevron-left', 'chevron-right', 'chevron-down', 'pen', 'plus', 'close'] as const) {
      expect(ICON_NAMES).toContain(name);
    }
    for (const name of ICON_NAMES) {
      const { container } = render(<Icon name={name} />);
      expect(container.querySelector('svg')!.children.length, name).toBeGreaterThan(0);
      cleanup();
    }
  });

  it('strokes at the one stroke width, from the tokens', () => {
    const css = readFileSync(join(import.meta.dirname, 'ds.css'), 'utf8');
    expect(css).toMatch(/\.ico \{[^}]*stroke-width: var\(--icon-stroke\)/);
    expect(css).toMatch(/\.ico \{[^}]*stroke: currentColor/);
  });
});

describe('Button', () => {
  it('is a button with its classes by variant and size, keeping native behaviour', async () => {
    const onClick = vi.fn();
    render(
      <>
        <Button variant="primary" type="submit" onClick={onClick}>Save</Button>
        <Button>Cancel</Button>
        <Button variant="quiet">Not now</Button>
        <Button variant="destructive">Delete</Button>
        <Button variant="destructive" filled>Yes, delete</Button>
        <Button size="compact" className="extra" disabled>Small</Button>
        <Button variant="link" size="compact">Show all</Button>
      </>,
    );
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.className).toBe('btn pri');
    expect(save.getAttribute('type')).toBe('submit');
    await userEvent.click(save);
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toBe('btn');
    // No type unless given, as with a plain <button>, so one in a form still submits it.
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('type')).toBe(false);
    expect(screen.getByRole('button', { name: 'Not now' }).className).toBe('btn plain');
    expect(screen.getByRole('button', { name: 'Delete' }).className).toBe('btn danger');
    expect(screen.getByRole('button', { name: 'Yes, delete' }).className).toBe('btn pri danger');
    const small = screen.getByRole('button', { name: 'Small' });
    expect(small.className).toBe('btn sm extra');
    expect((small as HTMLButtonElement).disabled).toBe(true);
    // A link is text in a line, never a btn: compact means nothing to it.
    expect(screen.getByRole('button', { name: 'Show all' }).className).toBe('link');
  });

  it('puts an icon before or after its label, and names an icon-only button in full', () => {
    render(
      <>
        <Button icon="plus">Capture</Button>
        <Button iconEnd="chevron-right">Done today</Button>
        <Button variant="icon" icon="close" label="Close" />
      </>,
    );
    const capture = screen.getByRole('button', { name: 'Capture' });
    expect(capture.firstElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(screen.getByRole('button', { name: 'Done today' }).lastElementChild?.tagName.toLowerCase()).toBe('svg');
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.className).toBe('btn btn-icon');
    expect(close.getAttribute('aria-label')).toBe('Close');
  });

  it('is 44px tall, 36px compact on desktop only, with one radius on both layouts', () => {
    const css = readFileSync(join(import.meta.dirname, 'ds.css'), 'utf8');
    expect(css).toMatch(/\.btn \{[^}]*min-height: var\(--tap\)/);
    expect(css).toMatch(/\.btn \{[^}]*border-radius: var\(--radius-control\)/);
    expect(css).toMatch(/\[data-layout='desktop'\] \.btn\.sm \{[^}]*min-height: var\(--tap-compact\)/);
    expect(css).not.toMatch(/\[data-layout='phone'\] \.btn\.sm/);
    // The primary's label is as strong as every other emphasis.
    expect(css).toMatch(/\.btn\.pri \{[^}]*font-weight: var\(--fw-strong\)/);
  });
});
