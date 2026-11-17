// The design system's reference page (docs/design.md): every component and every block state, on one layout in one
// theme, as the URL chooses. Never shipped: the build's only page is index.html. e2e/reference.spec.ts screenshots it
// at both sizes in both themes, so any change to how a component looks shows up in review.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { AnswerBadge, blockClass, BlockMarks, Button, Card, Chip, Icon, ICON_NAMES, ListRow, Pill, Segmented, Switch, TextField } from '../ui/components/ds';
import type { BlockLook, BlockState } from '../ui/components/ds';
import { OutcomeTag } from '../ui/components/blocks/Outcome';

const ROLES = ['ground', 'card', 'raised', 'ink', 'ink-2', 'ink-3', 'line', 'accent', 'on-accent', 'accent-text', 'accent-tint', 'focus',
  'project', 'project-tint', 'project-ink', 'practice', 'practice-tint', 'practice-ink', 'oneoff', 'oneoff-tint', 'oneoff-ink', 'on-kind', 'placing',
  'danger', 'warn', 'ok', 'ink-action', 'hairline', 'wash', 'pressed', 'danger-tint', 'warn-tint', 'ok-tint', 'placing-tint'];
const STYLES = ['display', 'title', 'heading', 'body', 'label', 'meta', 'caption'];
const KINDS: BlockLook[] = ['project', 'practice', 'oneoff', 'planning', 'inbox', 'event', 'info'];
const STATES: BlockState[] = ['planned', 'now', 'done', 'partly', 'notdone', 'goneby', 'placing', 'drop', 'suggested'];
const RESULT = { done: 'done', partly: 'partly', notdone: 'not' } as const;

function Part(props: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2>{props.title}</h2>
      <div className="stack8">{props.children}</div>
    </section>
  );
}

function Block(props: { kind: BlockLook; state: BlockState; short?: boolean }) {
  const { kind, state, short } = props;
  const result = RESULT[state as keyof typeof RESULT] ?? null;
  return (
    <div className={blockClass(kind, state, { short })}>
      <BlockMarks state={state} short={short} look={kind} />
      {!short && <OutcomeTag result={result} />}
      <span className="blktitle">
        {kind} {state}
      </span>
    </div>
  );
}

export function Reference(props: { layout: 'desktop' | 'phone' }) {
  const [on, setOn] = useState(true);
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  return (
    <div className="refpage" data-layout={props.layout}>
      <h1>Design system</h1>

      <Part title="Colour roles">
        <div className="refgrid">
          {ROLES.map((role) => (
            <span key={role} className="refswatch">
              <i style={{ background: `var(--${role})` }} />
              {role}
            </span>
          ))}
        </div>
      </Part>

      <Part title="Text styles">
        {STYLES.map((s) => (
          <div key={s} style={{ fontSize: `var(--fs-${s})`, lineHeight: `var(--lh-${s})` }}>
            {s}: Revise chapter three
          </div>
        ))}
      </Part>

      <Part title="Buttons">
        <div className="refgrid">
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="quiet">Quiet</Button>
          <Button variant="destructive">Delete</Button>
          <Button variant="destructive" filled>
            Yes, delete
          </Button>
          <Button variant="icon" icon="close" label="Close" />
          <Button icon="plus">Capture</Button>
          <Button iconEnd="chevron-right">Done today</Button>
          <Button variant="link">See this week's analytics</Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="refgrid">
          <Button variant="primary" size="compact">
            Compact primary
          </Button>
          <Button size="compact">Compact</Button>
          <Button variant="icon" size="compact" icon="pen" label="Rename" />
        </div>
      </Part>

      <Part title="Icons">
        {([16, 20, 24] as const).map((size) => (
          <div key={size} className="refgrid">
            {ICON_NAMES.map((name) => (
              <Icon key={name} name={name} size={size} />
            ))}
          </div>
        ))}
      </Part>

      <Part title="Answers">
        <div className="refgrid">
          {(['done', 'partly', 'notdone', 'none'] as const).map((a) => (
            <AnswerBadge key={a} answer={a} />
          ))}
          {(['done', 'partly', 'notdone', 'none'] as const).map((a) => (
            <AnswerBadge key={`s${a}`} answer={a} small />
          ))}
        </div>
      </Part>

      <Part title="Controls">
        <div className="refgrid">
          <Chip pressed>Mon</Chip>
          <Chip pressed={false}>Tue</Chip>
          <Segmented<'calendar' | 'list'> label="Timeline view" options={[['calendar', 'Calendar'], ['list', 'List']]} value={view} onChange={setView} />
          <Switch checked={on} onChange={setOn} label="Add to this week" />
          <Switch checked={false} onChange={() => {}} label="Remind me" />
        </div>
        <TextField label="Title" value="Call the bank" onChange={() => {}} help="Short and specific" />
        <TextField label="Estimate" value="" onChange={() => {}} error="Give it an estimate" />
        <div className="refgrid">
          <Pill tone="red">Overdue</Pill>
          <Pill tone="amber">Behind</Pill>
          <Pill tone="green">On track</Pill>
          <Pill tone="grey">Paused</Pill>
        </div>
      </Part>

      <Part title="Card and list rows">
        <Card title="Inbox" actions={<Button size="compact">Select</Button>}>
          <ListRow title="Call the bank" trailing={<><Icon name="pen" /><Icon name="chevron-right" /></>} />
          <ListRow title="Fix the gate" meta="2h estimate" trailing={<><Icon name="pen" /><Icon name="chevron-right" /></>} />
        </Card>
      </Part>

      <Part title="Calendar blocks">
        {KINDS.map((kind) => (
          <div key={kind} className="refblocks">
            {(kind === 'event' || kind === 'info' ? (['planned'] as BlockState[]) : STATES).map((state) => (
              <Block key={state} kind={kind} state={state} />
            ))}
          </div>
        ))}
        <div className="refblocks">
          {STATES.map((state) => (
            <Block key={state} kind="project" state={state} short />
          ))}
        </div>
      </Part>

      <Part title="Toast and sheet">
        <div className="toast withaction" style={{ position: 'static' }}>
          <span>Marked done after 19m.</span>
          <button className="toastact" type="button">
            Undo
          </button>
        </div>
        <div className="sheet stack8" role="dialog" aria-label="Block ended" style={{ position: 'static', transform: 'none' }}>
          <h3>Block ended</h3>
          <p>Revise chapter three</p>
          <div className="refgrid">
            <Button variant="primary" icon="done">
              Done
            </Button>
            <Button icon="partly">Partly</Button>
            <Button icon="not-done">Not done</Button>
          </div>
        </div>
      </Part>
    </div>
  );
}
