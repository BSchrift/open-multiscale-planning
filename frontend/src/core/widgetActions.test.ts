import { describe, expect, it } from 'vitest';
import { answerBlock, moveBlock, startBlock } from './blocks';
import { applyPlanChange } from './plan';
import { getRecord, transact } from './records';
import { nodeSqliteDriver } from '../platform/node-sqlite';
import { pst, widgetScenario, ZONE } from './widget-testing';
import type { WidgetScenario } from './widget-testing';
import { applyWidgetAction, parseWidgetAction, recentStarts, recordOutcome } from './widgetActions';
import type { AppliedWidgetAction, WidgetAction, WidgetActionKind, WidgetActionOutcome } from './widgetActions';
import { buildWidgetSnapshot, loadWidgetData } from './widgetSnapshot';

let n = 0;
const fileId = (at: string) => `${Date.parse(at)}-00000000-0000-4000-8000-${String(++n).padStart(12, '0')}.json`;

async function setup(name: WidgetScenario) {
  const t = await widgetScenario(name, nodeSqliteDriver());
  const snapshot = buildWidgetSnapshot(await loadWidgetData(t.db, t.clock), { clock: t.clock });
  const rev = (id: string) => snapshot.blocks.find((b) => b.id === id)!.rev;
  let history: AppliedWidgetAction[] = [];
  const action = (kind: WidgetActionKind, blockId: string, at: string, more: Partial<WidgetAction> = {}): WidgetAction => ({
    v: 1,
    id: fileId(at),
    kind,
    blockId,
    rev: rev(blockId),
    at,
    target: null,
    ...more,
  });
  /** Applies a batch in one transaction, as the app does, keeping the history between batches. */
  const apply = (...actions: WidgetAction[]) =>
    transact(t.db, t.clock, async (w) => {
      const outcomes: WidgetActionOutcome[] = [];
      for (const a of actions) {
        const outcome = await applyWidgetAction(w, a, history, ZONE);
        history = recordOutcome(history, outcome, t.clock.now());
        outcomes.push(outcome);
      }
      return outcomes;
    });
  const read = (id: string) => getRecord(t.db, 'time_block', id);
  return { ...t, snapshot, rev, action, apply, read, history: () => history };
}

const kinds = (outcomes: WidgetActionOutcome[]) => outcomes.map((o) => o.kind);
const messages = (outcomes: WidgetActionOutcome[]) => outcomes.map((o) => (o.kind === 'duplicate' ? '' : o.message));

describe('applying a start from the widget', () => {
  it('starts the block at the tap, however much later the app opens, and Undo takes it back', async () => {
    const t = await setup('start');
    t.clock.set(pst('9:40'));
    const [outcome] = await t.apply(t.action('start', 'spec', pst('9:06')));
    expect(messages([outcome!])).toEqual(['Started Write widget spec at 9:06am from the widget.']);
    expect((await t.read('spec'))!.started_at).toBe(pst('9:06'));
    if (outcome?.kind !== 'applied') throw new Error('not applied');
    await transact(t.db, t.clock, (w) => applyPlanChange(w, outcome.applied.reverse));
    expect((await t.read('spec'))!.started_at).toBeNull();
  });

  it('is applied once, however many times its file is seen', async () => {
    const t = await setup('start');
    const start = t.action('start', 'spec', pst('9:06'));
    expect(kinds(await t.apply(start))).toEqual(['applied']);
    expect(kinds(await t.apply(start))).toEqual(['duplicate']);
    expect(kinds(await t.apply({ ...start }, { ...start }))).toEqual(['duplicate', 'duplicate']);
    expect((await t.read('spec'))!.started_at).toBe(pst('9:06'));
  });

  it('isn’t forced on a block started on another device, and says so', async () => {
    const t = await setup('start');
    await transact(t.db, t.clock, (w) => startBlock(w, 'spec', { now: () => Date.parse(pst('9:05')), zone: () => ZONE }));
    const outcomes = await t.apply(t.action('start', 'spec', pst('9:06')));
    expect(messages(outcomes)).toEqual(["Didn't start Write widget spec from the widget. It had already started."]);
    expect((await t.read('spec'))!.started_at).toBe(pst('9:05'));
  });

  it('isn’t applied to a block moved since the widget drew it, and says where it went', async () => {
    const t = await setup('start');
    await transact(t.db, t.clock, (w) => moveBlock(w, 'spec', { start: pst('13:00'), end: pst('14:30') }));
    const outcomes = await t.apply(t.action('start', 'spec', pst('9:06')));
    expect(messages(outcomes)).toEqual(["Didn't start Write widget spec from the widget. It changed since. It's now 1pm to 2:30pm."]);
    expect((await t.read('spec'))!.started_at).toBeFalsy();
  });

  it('isn’t applied to a block answered since', async () => {
    const t = await setup('start');
    await transact(t.db, t.clock, (w) => answerBlock(w, 'spec', { result: 'not' }, t.clock));
    expect(messages(await t.apply(t.action('start', 'spec', pst('9:06'))))).toEqual(["Didn't start Write widget spec from the widget. It was already answered."]);
  });

  it('isn’t applied to a block deleted since', async () => {
    const t = await setup('start');
    await transact(t.db, t.clock, (w) => w.set('time_block', 'spec', { deleted_at: pst('9:05') }));
    expect(messages(await t.apply(t.action('start', 'spec', pst('9:06'))))).toEqual(["Didn't start the block from the widget. It's no longer on your calendar."]);
  });

  it('isn’t applied when the tap came after the block had ended', async () => {
    const t = await setup('start');
    expect(messages(await t.apply(t.action('start', 'spec', pst('10:31'))))).toEqual(["Didn't start Write widget spec from the widget. It had already ended."]);
  });
});

describe('applying Start early from the widget', () => {
  it('moves the next block to the tap’s minute, keeping its length, and starts it', async () => {
    const t = await setup('next');
    const [outcome] = await t.apply(t.action('startEarly', 'dentist', '2026-11-18T18:48:30Z'));
    expect(messages([outcome!])).toEqual(['Started Call the dentist early, at 10:48am, from the widget.']);
    expect(await t.read('dentist')).toMatchObject({ start: pst('10:48'), end: pst('11:03'), started_at: '2026-11-18T18:48:30Z' });
    expect(outcome?.kind === 'applied' && outcome.applied.before).toEqual({ start: pst('11:00'), end: pst('11:15') });
    expect(recentStarts(t.history(), Date.parse(pst('10:50')))).toEqual([
      { id: outcome!.action.id, kind: 'startEarly', blockId: 'dentist', at: '2026-11-18T18:48:30Z', before: { start: pst('11:00'), end: pst('11:15') } },
    ]);
  });
});

describe('applying Pause and Resume from the widget', () => {
  it('pauses at the tap', async () => {
    const t = await setup('now');
    expect(messages(await t.apply(t.action('pause', 'spec', pst('9:52'))))).toEqual(['Paused Write widget spec at 9:52am from the widget.']);
    expect((await t.read('spec'))!.paused_at).toBe(pst('9:52'));
  });

  it('resumes at the tap, moving the end on by the pause', async () => {
    const t = await setup('paused');
    expect(messages(await t.apply(t.action('resume', 'spec', pst('10:04'))))).toEqual(['Resumed Write widget spec from the widget. It now ends at 10:42am.']);
    expect(await t.read('spec')).toMatchObject({ paused_at: null, paused_min: 12, end: pst('10:42') });
  });

  it('applies a start, then a pause and a resume queued after it from the same drawing, in order', async () => {
    const t = await setup('start');
    const outcomes = await t.apply(t.action('start', 'spec', pst('9:06')), t.action('pause', 'spec', pst('9:30')), t.action('resume', 'spec', pst('9:40')));
    expect(kinds(outcomes)).toEqual(['applied', 'applied', 'applied']);
    expect(await t.read('spec')).toMatchObject({ started_at: pst('9:06'), paused_at: null, paused_min: 10, end: pst('10:40') });
  });

  it('still follows its own earlier actions in a later batch, when the snapshot wasn’t rewritten between', async () => {
    const t = await setup('now');
    expect(kinds(await t.apply(t.action('pause', 'spec', pst('9:52'))))).toEqual(['applied']);
    expect(kinds(await t.apply(t.action('resume', 'spec', pst('10:04'))))).toEqual(['applied']);
  });

  it('isn’t applied to a block that had ended, or that another device already paused', async () => {
    const t = await setup('now');
    expect(messages(await t.apply(t.action('pause', 'spec', pst('10:31'))))).toEqual(["Didn't pause Write widget spec from the widget. It had already ended."]);
    await transact(t.db, t.clock, (w) => w.set('time_block', 'spec', { paused_at: pst('10:00') }));
    expect(messages(await t.apply(t.action('pause', 'spec', pst('10:01'))))).toEqual(["Didn't pause Write widget spec from the widget. It changed since. It's now 9am to 10:30am."]);
  });

  it('isn’t applied to a block ended early on another device', async () => {
    const t = await setup('paused');
    await transact(t.db, t.clock, (w) => w.set('time_block', 'spec', { ended_at: pst('10:00') }));
    expect(messages(await t.apply(t.action('resume', 'spec', pst('10:04'))))).toEqual(["Didn't resume Write widget spec from the widget. It had already ended."]);
  });
});

describe('undoing a start from the widget after the app applied it', () => {
  it('puts the block back as it was, Start early’s times included', async () => {
    const t = await setup('next');
    const [early] = await t.apply(t.action('startEarly', 'dentist', pst('10:48')));
    const undo = t.action('undo', 'dentist', pst('10:50'), { target: early!.action.id });
    expect(messages(await t.apply(undo))).toEqual(['Took back the start of Call the dentist from the widget.']);
    expect(await t.read('dentist')).toMatchObject({ start: pst('11:00'), end: pst('11:15'), started_at: null });
    expect(recentStarts(t.history(), Date.parse(pst('10:51')))).toEqual([]);
  });

  it('is dropped once the block has changed since, or with no start to take back', async () => {
    const t = await setup('start');
    const [start] = await t.apply(t.action('start', 'spec', pst('9:06')));
    await transact(t.db, t.clock, (w) => w.set('time_block', 'spec', { end: pst('11:00') }));
    expect(messages(await t.apply(t.action('undo', 'spec', pst('9:08'), { target: start!.action.id })))).toEqual([
      "Didn't undo the start of Write widget spec from the widget. It changed since.",
    ]);
    expect(messages(await t.apply(t.action('undo', 'spec', pst('9:09'), { target: fileId(pst('9:00')) })))).toEqual([
      "Didn't undo the start of Write widget spec from the widget. Its start is no longer there to take back.",
    ]);
  });
});

describe('the history of applied actions', () => {
  it('keeps a day, then forgets', async () => {
    const t = await setup('start');
    await t.apply(t.action('start', 'spec', pst('9:06')));
    expect(recordOutcome(t.history(), { kind: 'duplicate', action: t.action('pause', 'spec', pst('9:07')) }, Date.parse(pst('9:07', 19)))).toEqual([]);
  });
});

describe('reading a queued action', () => {
  const at = pst('9:06');
  const id = fileId(at);
  const good = { v: 1, id, kind: 'start', blockId: 'spec', rev: '0a1b2c3d', at, target: null };
  const parse = (value: unknown, name = id) => parseWidgetAction(name, JSON.stringify(value));

  it('reads exactly what an intent writes', () => {
    expect(parse(good)).toEqual(good);
    expect(parse({ ...good, kind: 'undo', target: fileId(at) })).toMatchObject({ kind: 'undo' });
  });

  it('refuses anything else', () => {
    for (const bad of [
      { ...good, v: 2 },
      { ...good, id: 'other.json' },
      { ...good, kind: 'done' },
      { ...good, blockId: '' },
      { ...good, at: '9:06' },
      { ...good, at: '2026-11-18T17:06:00.000Z' },
      { ...good, rev: 'x'.repeat(40) },
      { ...good, target: 'x' },
      { ...good, kind: 'undo', target: null },
      { ...good, kind: 'undo', target: '../x.json' },
      [good],
      null,
    ]) {
      expect(parse(bad)).toBeNull();
    }
    expect(parse(good, '../escape.json')).toBeNull();
    expect(parseWidgetAction(id, '{not json')).toBeNull();
    expect(parseWidgetAction(id, JSON.stringify({ ...good, pad: 'x'.repeat(5000) }))).toBeNull();
  });
});
