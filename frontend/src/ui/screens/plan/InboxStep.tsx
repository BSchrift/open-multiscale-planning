// The Inbox step: every item waiting, with Process to give each a home, or Skip the Inbox this time to leave them for
// weekly planning. Process opens over the flow; once it closes, a line says what was sorted and takes focus.

import type { Ref } from 'react';
import type { InboxRow } from '../../../core/queries';
import { InboxList } from '../../components/inbox/InboxList';
import { StepHead } from './StepHead';
import type { Head } from './StepHead';
import { Button } from '../../components/ds/Button';

export const itemCount = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

export function InboxStep(props: {
  rows: readonly InboxRow[];
  phone: boolean;
  head: Head;
  /** What Process sorted, once it has run since this step opened. */
  summary: string | null;
  summaryRef: Ref<HTMLParagraphElement>;
  /** The phone's main button already says Process, so the step doesn't say it twice. */
  mainProcesses: boolean;
  onProcess(item?: string): void;
  onSkip(): void;
  onNext(): void;
}) {
  const { rows, phone, summary } = props;
  const n = rows.length;
  return (
    <div className={phone ? 'stack' : 'wrap stack'}>
      <div className="stack8">
        <StepHead head={props.head}>Give each item a home</StepHead>
        <p className={phone ? 'small quiet' : 'quiet'}>
          {n ? `${itemCount(n)}. If one needs a new project, practice or goal, make it from its card.` : 'Your Inbox is empty. Anything you capture lands here.'}
        </p>
        {summary && (
          <p ref={props.summaryRef} className={phone ? 'small' : undefined} tabIndex={-1}>
            {summary}
          </p>
        )}
      </div>
      {n > 0 && !props.mainProcesses && (
        <div>
          <Button variant="primary" className="pxstart" type="button" onClick={() => props.onProcess()}>
            Process {itemCount(n)}
          </Button>
        </div>
      )}
      <InboxList rows={rows} phone={phone} onOpen={props.onProcess} />
      {n > 0 && !summary && (
        <div>
          <Button variant={phone ? 'secondary' : 'link'} className={phone ? undefined : 'small'} type="button" onClick={props.onSkip}>
            Skip the Inbox this time
          </Button>
        </div>
      )}
      {!phone && (
        <div>
          <Button variant={summary || !n ? 'primary' : 'secondary'} type="button" onClick={props.onNext}>
            Continue to Finish
          </Button>
        </div>
      )}
    </div>
  );
}
