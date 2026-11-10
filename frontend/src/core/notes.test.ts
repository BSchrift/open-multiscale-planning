import { describe, expect, it } from 'vitest';
import { linkHref, MAX_NOTES, notesLines, parseNotes, toggleList, wrapLink, wrapMark } from './notes';
import type { Span } from './notes';

const text = (t: string): Span => ({ kind: 'text', text: t });
const bold = (...children: Span[]): Span => ({ kind: 'bold', children });
const italic = (...children: Span[]): Span => ({ kind: 'italic', children });
const link = (href: string, ...children: Span[]): Span => ({ kind: 'link', href, children });
/** The spans of a one-line paragraph. */
const line = (notes: string) => {
  const blocks = parseNotes(notes);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]!.kind).toBe('paragraph');
  return blocks[0]!.kind === 'paragraph' ? blocks[0]!.lines[0]! : [];
};

describe('parseNotes', () => {
  it('reads each mark', () => {
    expect(line('Use the **Q3 numbers** first.')).toEqual([text('Use the '), bold(text('Q3 numbers')), text(' first.')]);
    expect(line('by *Friday*')).toEqual([text('by '), italic(text('Friday'))]);
    expect(line('[the brief](https://example.com/brief)')).toEqual([link('https://example.com/brief', text('the brief'))]);
    expect(line('[write](mailto:sam@example.com)')).toEqual([link('mailto:sam@example.com', text('write'))]);
  });

  it('nests marks inside each other', () => {
    expect(line('**all *of* it**')).toEqual([bold(text('all '), italic(text('of')), text(' it'))]);
    expect(line('*all **of** it*')).toEqual([italic(text('all '), bold(text('of')), text(' it'))]);
    expect(line('***both***')).toEqual([bold(italic(text('both')))]);
    expect(line('**[bold link](https://example.com)**')).toEqual([bold(link('https://example.com', text('bold link')))]);
    expect(line('[a **bold** word](https://example.com)')).toEqual([link('https://example.com', text('a '), bold(text('bold')), text(' word'))]);
  });

  it('turns a bare web address into a link, leaving the punctuation after it', () => {
    expect(line('See https://example.com/a?b=1.')).toEqual([text('See '), link('https://example.com/a?b=1', text('https://example.com/a?b=1')), text('.')]);
    expect(line('(http://example.com/x_(y))')).toEqual([text('('), link('http://example.com/x_(y)', text('http://example.com/x_(y)')), text(')')]);
    expect(line('www.example.com, then')).toEqual([link('https://www.example.com', text('www.example.com')), text(', then')]);
    // Only at the start of a word.
    expect(line('xhttps://example.com')).toEqual([text('xhttps://example.com')]);
  });

  it('shows anything else exactly as typed', () => {
    for (const notes of [
      '# Not a heading',
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '![a picture](https://example.com/a.png)',
      '| a | table |',
      '** not bold **',
      '* not a list or italic',
      'a lone * star',
      '`code`',
    ]) {
      const spans = line(notes);
      const shown = spans.map((s) => (s.kind === 'text' ? s.text : s.kind === 'link' ? `[link ${s.href}]` : `[${s.kind}]`)).join('');
      // The picture's address may become a link of its own, but never a picture: no span is anything but these.
      expect(shown.replace(/\[link (https:\/\/example.com\/a.png)\]/, '$1')).toBe(notes);
    }
  });

  it('never links to anything but the web or mail', () => {
    for (const href of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'vbscript:x', '//example.com', 'ftp://example.com']) {
      expect(line(`[click](${href})`)).toEqual([text(`[click](${href})`)]);
    }
    expect(linkHref('javascript:alert(1)')).toBeNull();
    expect(linkHref(' https://example.com')).toBeNull();
    expect(linkHref('https://')).toBeNull();
    expect(linkHref('mailto:')).toBeNull();
    expect(linkHref('HTTPS://example.com/')).toBe('HTTPS://example.com/');
  });

  it('reads lists and paragraphs, keeping line breaks', () => {
    expect(parseNotes('First line\nsecond line\n\nNext paragraph')).toEqual([
      { kind: 'paragraph', lines: [[text('First line')], [text('second line')]] },
      { kind: 'paragraph', lines: [[text('Next paragraph')]] },
    ]);
    expect(parseNotes('Before\n- one\n- **two**\nAfter')).toEqual([
      { kind: 'paragraph', lines: [[text('Before')]] },
      { kind: 'list', ordered: false, start: 1, items: [[text('one')], [bold(text('two'))]] },
      { kind: 'paragraph', lines: [[text('After')]] },
    ]);
    expect(parseNotes('3. three\n4. four')).toEqual([{ kind: 'list', ordered: true, start: 3, items: [[text('three')], [text('four')]] }]);
    // A change of kind starts a new list.
    expect(parseNotes('- a\n1. b').map((b) => b.kind === 'list' && b.ordered)).toEqual([false, true]);
    expect(parseNotes('')).toEqual([]);
    expect(parseNotes('\n\n')).toEqual([]);
  });

  it('reads a full description quickly, even one made of unclosed marks', () => {
    const started = performance.now();
    parseNotes('**['.repeat(MAX_NOTES / 3));
    parseNotes('*a '.repeat(MAX_NOTES / 3));
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('notesLines', () => {
  it('gives the first lines without their marks', () => {
    expect(notesLines('Use the **Q3 numbers** first.\n\n- Check the [totals](https://example.com)\n- Send it', 2)).toEqual([
      'Use the Q3 numbers first.',
      'Check the totals',
    ]);
    expect(notesLines('', 2)).toEqual([]);
  });
});

describe('the bar', () => {
  it('wraps the selection in a mark, and takes it off again', () => {
    expect(wrapMark('Use the Q3 numbers', 8, 18, '**')).toEqual({ text: 'Use the **Q3 numbers**', start: 10, end: 20 });
    expect(wrapMark('Use the **Q3 numbers**', 10, 20, '**')).toEqual({ text: 'Use the Q3 numbers', start: 8, end: 18 });
    expect(wrapMark('by Friday', 3, 9, '*')).toEqual({ text: 'by *Friday*', start: 4, end: 10 });
    // Italic inside bold, and out again: the stars of one mark aren't read as the other's.
    expect(wrapMark('**plan**', 2, 6, '*')).toEqual({ text: '***plan***', start: 3, end: 7 });
    expect(wrapMark('***plan***', 3, 7, '*')).toEqual({ text: '**plan**', start: 2, end: 6 });
    expect(wrapMark('***plan***', 3, 7, '**')).toEqual({ text: '*plan*', start: 1, end: 5 });
    expect(wrapMark('*plan*', 1, 5, '**')).toEqual({ text: '***plan***', start: 3, end: 7 });
    // With nothing selected, the cursor lands between the marks.
    expect(wrapMark('ab', 1, 1, '*')).toEqual({ text: 'a**b', start: 2, end: 2 });
  });

  it('makes the selected lines a list, and back', () => {
    expect(toggleList('one\ntwo\nthree', 0, 7)).toEqual({ text: '- one\n- two\nthree', start: 0, end: 11 });
    expect(toggleList('- one\n- two\nthree', 0, 11)).toEqual({ text: 'one\ntwo\nthree', start: 0, end: 7 });
    expect(toggleList('', 0, 0)).toEqual({ text: '- ', start: 2, end: 2 });
  });

  it('makes the selection a link, with its address selected to type over', () => {
    expect(wrapLink('see the brief', 8, 13)).toEqual({ text: 'see the [brief](https://)', start: 16, end: 24 });
  });

  it('changes nothing that would pass the limit', () => {
    const full = 'x'.repeat(MAX_NOTES - 3);
    expect(wrapMark(full, 0, 1, '**')).toBeNull();
    expect(toggleList(full, 0, 0)).not.toBeNull();
    expect(wrapLink(full, 0, 1)).toBeNull();
  });
});
