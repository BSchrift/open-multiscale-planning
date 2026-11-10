// A task's description: plain text with a small subset of Markdown. **bold**, *italic*, lines starting "- " or "1. ",
// [words](https://…) and bare web addresses. Anything else, such as a heading, an image, a table or HTML, is shown as
// typed. The UI turns what parseNotes gives into its own elements, never into HTML, so nothing in a description can run
// or load anything.

import { protocol } from '@multiscale/config';

/** The longest description, counted in UTF-16 units as the field counts them: never more characters than the server takes. */
export const MAX_NOTES = protocol.records.maxNotesChars;

export type Span =
  | { kind: 'text'; text: string }
  | { kind: 'bold' | 'italic'; children: Span[] }
  | { kind: 'link'; href: string; children: Span[] };

export type Block =
  /** Lines that follow each other, each kept on a line of its own. */
  | { kind: 'paragraph'; lines: Span[][] }
  | { kind: 'list'; ordered: boolean; start: number; items: Span[][] };

/** The address a link may go to: only the web and mail, since anything else could run code or open a local file. */
export function linkHref(url: string): string | null {
  if (!/^(https?:\/\/|mailto:)\S/i.test(url)) return null;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'mailto:' ? parsed.pathname : parsed.host) ? url : null;
  } catch {
    return null;
  }
}

type Mark = 'bold' | 'italic' | 'link';

// The link's words and address are bounded, so a line of unclosed brackets is read in linear time.
const LINK = /\[([^\]\n]{1,500})\]\(([^\s()]{1,2000}(?:\([^\s()]*\)[^\s()]*)?)\)/y;
const BARE = /(?:https?:\/\/|www\.)[^\s<>]+/iy;
const SPACE = /\s/;

/** A bare address without the punctuation that ends the sentence around it, keeping a bracket it opened. */
function trimBare(url: string): string {
  for (;;) {
    const last = url.at(-1)!;
    const unopened = last === ')' && url.split('(').length < url.split(')').length;
    if (!'.,;:!?\'"'.includes(last) && !unopened) return url;
    url = url.slice(0, -1);
  }
}

/**
 * Where each run of stars can close a mark: a run after a non-space. One star closes italic, two close bold, and three
 * close both, bold first from inside out. Worked out once per line, so each opening run looks its closer up.
 */
function closers(line: string) {
  const bold: number[] = [];
  const italic: number[] = [];
  const runs = new Map<number, number>();
  for (let i = 0; i < line.length; ) {
    if (line[i] !== '*') {
      i++;
      continue;
    }
    let end = i;
    while (line[end] === '*') end++;
    runs.set(i, end - i);
    if (i > 0 && !SPACE.test(line[i - 1]!)) {
      if (end - i === 1) italic.push(i);
      else if (end - i === 2) bold.push(i);
      else if (end - i === 3) {
        bold.push(i + 1);
        italic.push(i + 2);
      }
    }
    i = end;
  }
  return { bold, italic, runs };
}

/** The first closer at or after from. */
function closerFrom(list: readonly number[], from: number): number | undefined {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! < from) lo = mid + 1;
    else hi = mid;
  }
  return list[lo];
}

function spans(line: string, inside: readonly Mark[] = []): Span[] {
  const out: Span[] = [];
  let plain = '';
  const push = (span: Span) => {
    if (plain) out.push({ kind: 'text', text: plain });
    plain = '';
    out.push(span);
  };
  const stars = closers(line);
  for (let i = 0; i < line.length; ) {
    const ch = line[i]!;
    const run = stars.runs.get(i);
    if (run) {
      const after = line[i + Math.min(run, 2)];
      const opens = after !== undefined && !SPACE.test(after);
      const mark: 'bold' | 'italic' | null = opens && run >= 2 && run <= 3 ? 'bold' : opens && run === 1 ? 'italic' : null;
      const width = mark === 'bold' ? 2 : 1;
      const close = mark && !inside.includes(mark) ? closerFrom(stars[mark], i + width + 1) : undefined;
      if (mark && close !== undefined) {
        push({ kind: mark, children: spans(line.slice(i + width, close), [...inside, mark]) });
        i = close + width;
      } else {
        plain += line.slice(i, i + run);
        i += run;
      }
      continue;
    }
    if (!inside.includes('link')) {
      if (ch === '[' && line[i - 1] !== '!') {
        LINK.lastIndex = i;
        const m = LINK.exec(line);
        const href = m && linkHref(m[2]!);
        if (m && href) {
          push({ kind: 'link', href, children: spans(m[1]!, [...inside, 'link']) });
          i += m[0].length;
          continue;
        }
      }
      if ((ch === 'h' || ch === 'H' || ch === 'w' || ch === 'W') && (i === 0 || /[\s(]/.test(line[i - 1]!))) {
        BARE.lastIndex = i;
        const m = BARE.exec(line);
        const url = m && trimBare(m[0]);
        const www = url && /^www\./i.test(url);
        const href = url && (www ? (url.length > 4 ? linkHref(`https://${url}`) : null) : linkHref(url));
        if (url && href) {
          push({ kind: 'link', href, children: [{ kind: 'text', text: url }] });
          i += url.length;
          continue;
        }
      }
    }
    plain += ch;
    i++;
  }
  if (plain) out.push({ kind: 'text', text: plain });
  return out;
}

const ITEM = /^(?:(- )|(\d{1,9})\. )(.*)$/;

export function parseNotes(text: string): Block[] {
  const blocks: Block[] = [];
  let open: Block | null = null;
  for (const line of text.split(/\r?\n/)) {
    const item = ITEM.exec(line);
    if (item) {
      const ordered = !item[1];
      if (open?.kind !== 'list' || open.ordered !== ordered) {
        open = { kind: 'list', ordered, start: ordered ? Number(item[2]) : 1, items: [] };
        blocks.push(open);
      }
      open.items.push(spans(item[3]!));
    } else if (!line.trim()) {
      open = null;
    } else {
      if (open?.kind !== 'paragraph') {
        open = { kind: 'paragraph', lines: [] };
        blocks.push(open);
      }
      open.lines.push(spans(line));
    }
  }
  return blocks;
}

function plainText(line: readonly Span[]): string {
  return line.map((s) => (s.kind === 'text' ? s.text : plainText(s.children))).join('');
}

/** The first lines of a description as plain text, without their marks, for a glance at it. */
export function notesLines(text: string, count: number): string[] {
  const lines = parseNotes(text).flatMap((b) => (b.kind === 'paragraph' ? b.lines : b.items));
  return lines.slice(0, count).map(plainText);
}

/** The text after a change from the bar, with what to select. */
export interface NotesEdit {
  text: string;
  start: number;
  end: number;
}

const fits = (edit: NotesEdit) => (edit.text.length <= MAX_NOTES ? edit : null);

/** Puts a mark either side of the selection, or takes it off if it's already there. Null if it would pass the limit. */
export function wrapMark(text: string, start: number, end: number, mark: '**' | '*'): NotesEdit | null {
  const n = mark.length;
  // The stars right before and after the selection: an odd run holds an italic mark, and two or more a bold one.
  let before = 0;
  while (text[start - before - 1] === '*') before++;
  let after = 0;
  while (text[end + after] === '*') after++;
  const marked = (run: number) => (n === 1 ? run % 2 === 1 : run >= 2);
  if (marked(before) && marked(after)) {
    return { text: text.slice(0, start - n) + text.slice(start, end) + text.slice(end + n), start: start - n, end: end - n };
  }
  return fits({ text: text.slice(0, start) + mark + text.slice(start, end) + mark + text.slice(end), start: start + n, end: end + n });
}

/** Makes the selected lines a bulleted list, or plain lines again if they all are one already. */
export function toggleList(text: string, start: number, end: number): NotesEdit | null {
  const from = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
  // A selection that ends at the start of a line leaves that line alone.
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const nl = text.indexOf('\n', last);
  const to = nl < 0 ? text.length : nl;
  const lines = text.slice(from, to).split('\n');
  const listed = lines.every((l) => l.startsWith('- '));
  const changed = lines.map((l) => (listed ? l.slice(2) : l.startsWith('- ') || (!l.trim() && lines.length > 1) ? l : `- ${l}`)).join('\n');
  const result = text.slice(0, from) + changed + text.slice(to);
  if (start === end) {
    const moved = Math.max(from, start + (listed ? -2 : changed.length - (to - from) > 0 ? 2 : 0));
    return fits({ text: result, start: moved, end: moved });
  }
  return fits({ text: result, start: from, end: from + changed.length });
}

/** Makes the selection a link's words, and selects its address to type over. */
export function wrapLink(text: string, start: number, end: number): NotesEdit | null {
  const before = `${text.slice(0, start)}[${text.slice(start, end)}](`;
  return fits({ text: `${before}https://)${text.slice(end)}`, start: before.length, end: before.length + 'https://'.length });
}
