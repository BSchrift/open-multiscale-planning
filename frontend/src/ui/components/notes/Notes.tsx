// A description, formatted. Each part becomes one of the app's own elements: text stays text, so nothing in a
// description can run or load. A link opens outside the app, in the system browser.

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { parseNotes } from '../../../core/notes';
import type { Span } from '../../../core/notes';
import './notes.css';

function spans(line: readonly Span[]): ReactNode[] {
  return line.map((span, i) => {
    switch (span.kind) {
      case 'text':
        return span.text;
      case 'bold':
        return <strong key={i}>{spans(span.children)}</strong>;
      case 'italic':
        return <em key={i}>{spans(span.children)}</em>;
      case 'link':
        // A target="_blank" link opens in the system browser on the Mac app and the iPhone too.
        return (
          <a key={i} href={span.href} target="_blank" rel="noreferrer">
            {spans(span.children)}
          </a>
        );
    }
  });
}

export function Notes(props: { text: string; className?: string }) {
  const blocks = useMemo(() => parseNotes(props.text), [props.text]);
  return (
    <div className={`notes${props.className ? ` ${props.className}` : ''}`}>
      {blocks.map((block, i) => {
        if (block.kind === 'paragraph') {
          return (
            <p key={i}>
              {block.lines.map((line, j) => (
                <span key={j}>
                  {j > 0 && <br />}
                  {spans(line)}
                </span>
              ))}
            </p>
          );
        }
        const items = block.items.map((item, j) => <li key={j}>{spans(item)}</li>);
        return block.ordered ? (
          <ol key={i} start={block.start}>
            {items}
          </ol>
        ) : (
          <ul key={i}>{items}</ul>
        );
      })}
    </div>
  );
}
