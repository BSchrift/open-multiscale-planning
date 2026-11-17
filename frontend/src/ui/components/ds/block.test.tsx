import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnswerBadge } from './AnswerBadge';
import { blockClass, BlockMarks, blockState } from './Block';

afterEach(cleanup);
const css = readFileSync(join(import.meta.dirname, 'block.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector: string) => new RegExp(`(^|[},])\\s*${selector.replace(/[.()[\]]/g, '\\$&')}\\s*\\{[^}]*`, 'm').exec(css)?.[0] ?? '';

describe('blockState', () => {
  it('reads a block’s state from its answer, whether it has ended, and whether it’s under way', () => {
    expect(blockState({ result: 'done', ended: true })).toBe('done');
    expect(blockState({ result: 'partly', ended: true })).toBe('partly');
    expect(blockState({ result: 'not', ended: true })).toBe('notdone');
    expect(blockState({ result: null, ended: true })).toBe('goneby');
    expect(blockState({ result: null, ended: false, now: true })).toBe('now');
    expect(blockState({ result: null, ended: false })).toBe('planned');
    // Done early, while it was still on: the answer wins.
    expect(blockState({ result: 'done', ended: false, now: true })).toBe('done');
  });
});

describe('blockClass', () => {
  it('names the kind and the state, the same on every calendar', () => {
    expect(blockClass('project', 'done')).toBe('blk k-project s-done');
    expect(blockClass('oneoff', 'planned', { short: true })).toBe('blk k-oneoff s-planned short');
  });
});

describe('BlockMarks', () => {
  it('gives a block gone by its round answer badge, in ink', () => {
    const icons = (['done', 'partly', 'notdone', 'goneby'] as const).map((state) => {
      const { container } = render(<BlockMarks state={state} />);
      const badge = container.querySelector('.ansbadge')!;
      const icon = badge.querySelector('svg')!.dataset.icon;
      cleanup();
      return icon;
    });
    expect(icons).toEqual(['done', 'partly', 'not-done', 'no-answer']);
  });

  it('marks the block under way with a live dot and the word Now, and a planned block not at all', () => {
    const { container } = render(<BlockMarks state="now" />);
    expect(container.querySelector('.live')).not.toBeNull();
    expect(container).toHaveTextContent('Now');
    cleanup();
    expect(render(<BlockMarks state="planned" />).container.innerHTML).toBe('');
  });

  it('marks an Inbox item’s block with the inbox icon, before what its state draws', () => {
    const { container } = render(<BlockMarks look="inbox" state="now" />);
    expect((container.firstElementChild as SVGElement).dataset.icon).toBe('inbox');
    expect(container.querySelector('.live')).not.toBeNull();
    cleanup();
    expect(render(<BlockMarks look="project" state="planned" />).container.innerHTML).toBe('');
  });

  it('draws a 12px badge on a 15-minute block, and 16px otherwise', () => {
    expect(render(<AnswerBadge answer="done" />).container.querySelector('.ansbadge')!.className).toBe('ansbadge b-done');
    cleanup();
    expect(render(<AnswerBadge answer="done" small />).container.querySelector('.ansbadge')!.className).toBe('ansbadge b-done small');
    expect(rule('.ansbadge')).toMatch(/width: var\(--icon-sm\)/);
    expect(rule('.ansbadge.small')).toMatch(/width: 12px/);
  });
});

describe('the block’s look', () => {
  it('fills Partly halfway with its kind’s tint, so it shows how much got done', () => {
    expect(rule('.blk.s-partly')).toMatch(/linear-gradient\(90deg, var\(--kt\) 50%, var\(--card\) 50%\)/);
  });

  it('frames the block under way in ink, never in the project blue', () => {
    expect(rule('.blk.s-now')).toMatch(/inset 0 0 0 var\(--border-emphasis\) var\(--ink\)/);
    expect(rule('.blk.s-now')).not.toMatch(/--accent|--project/);
  });

  it('never draws Not done in amber, nor strikes it', () => {
    const notDone = css.split('}').filter((r) => /\.s-notdone|\.b-notdone/.test(r.split('{')[0]!));
    expect(notDone.join('}')).not.toMatch(/--warn|line-through/);
  });

  it('dashes the outline of a block gone by with no answer yet', () => {
    expect(rule('.blk.s-goneby')).toMatch(/dashed var\(--ink-3\)/);
  });

  it('keeps each kind’s edge on the leading side: solid, double, dotted', () => {
    expect(rule('.blk')).toMatch(/border-left: var\(--edge\) solid var\(--kc\)/);
    expect(rule('.blk.k-practice')).toMatch(/border-left-style: double/);
    expect(rule('.blk.k-oneoff')).toMatch(/border-left-style: dotted/);
  });

  it('gives an Inbox item’s block no kind’s colour: Planning’s neutral wash, told apart by a dashed edge', () => {
    expect(blockClass('inbox', 'planned')).toBe('blk k-inbox s-planned');
    const colours = (selector: string) => rule(selector).replace(/^[^{]*\{/, '').trim();
    expect(colours('.k-inbox')).toBe(colours('.k-planning'));
    expect(rule('.blk.k-inbox')).toMatch(/border-left-style: dashed/);
  });
});
