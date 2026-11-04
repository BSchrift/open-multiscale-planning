import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { fixedClock } from '../../core/clock';
import { createTestPlatform } from '../../platform/testing';
import { AppProvider } from '../app/store';
import type { Layout } from '../app/registry';
import { EST_STEPS, estIndex, EstimateSlider } from './EstimateSlider';
import { MilestoneDiamond } from './MilestoneDiamond';
import { Pill } from './Pill';
import { Popover } from './Popover';
import { Sheet } from './Sheet';
import { axisMonths, axisPercent, TimelineAxisHead, TimelineBar } from './TimelineBar';
import { CheckCircle, TaskRow } from './TaskRow';
import { ToastProvider, useToast } from './Toast';

afterEach(cleanup);

async function inApp(ui: ReactNode, layout: Layout = 'desktop') {
  const platform = await createTestPlatform();
  return render(
    <AppProvider platform={platform} clock={fixedClock(0)} layout={layout}>
      <ToastProvider>
        <div data-layout={layout}>{ui}</div>
      </ToastProvider>
    </AppProvider>,
  );
}

describe('EstimateSlider', () => {
  it('has 15-minute steps to 2h, coarser to 16h, and starts from none', () => {
    expect(EST_STEPS[0]).toBe(0);
    expect(EST_STEPS.slice(1, 9).every((s, i) => s === (i + 1) * 15)).toBe(true);
    expect(EST_STEPS[EST_STEPS.length - 1]).toBe(960);
    expect(estIndex(0)).toBe(0);
    expect(estIndex(50)).toBe(EST_STEPS.indexOf(45));
    expect(estIndex(5000)).toBe(EST_STEPS.length - 1);
  });

  it('reads as a value, and reports minutes', async () => {
    function Host() {
      const [v, setV] = useState<number | null>(null);
      return <EstimateSlider label="Time" value={v} onChange={setV} />;
    }
    await inApp(<Host />);
    const slider = screen.getByRole('slider', { name: 'Time' });
    expect(slider).toHaveAttribute('aria-valuetext', 'No estimate');
    expect(screen.getByText('No estimate')).toBeInTheDocument();
    fireEvent.change(slider, { target: { value: String(EST_STEPS.indexOf(90)) } });
    expect(slider).toHaveAttribute('aria-valuetext', '1h 30m');
    expect(screen.getByText('1h 30m')).toBeInTheDocument();
    fireEvent.change(slider, { target: { value: '0' } });
    expect(slider).toHaveAttribute('aria-valuetext', 'No estimate');
  });
});

describe('Toast', () => {
  function Host(props: { undo?: () => void }) {
    const toast = useToast();
    return <button onClick={() => toast.show('Moved', props.undo ? { undo: props.undo } : {})}>go</button>;
  }

  it('announces, and runs Undo once', async () => {
    const undo = vi.fn();
    await inApp(<Host undo={undo} />);
    await userEvent.click(screen.getByText('go'));
    expect(screen.getByRole('status')).toHaveTextContent('Moved');
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByText('Moved')).toBeNull();
  });

  it('goes away on its own', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await inApp(<Host />);
      fireEvent.click(screen.getByText('go'));
      expect(screen.getByText('Moved')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
      vi.advanceTimersByTime(4000);
      await waitFor(() => expect(screen.queryByText('Moved')).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits while Undo has focus or the pointer is on it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await inApp(<Host undo={vi.fn()} />);
      fireEvent.click(screen.getByText('go'));
      const undo = screen.getByRole('button', { name: 'Undo' });
      act(() => undo.focus());
      act(() => vi.advanceTimersByTime(20_000));
      expect(screen.getByText('Moved')).toBeInTheDocument();
      act(() => undo.blur());
      fireEvent.mouseEnter(undo);
      act(() => vi.advanceTimersByTime(20_000));
      expect(screen.getByText('Moved')).toBeInTheDocument();
      fireEvent.mouseLeave(undo);
      act(() => vi.advanceTimersByTime(9000));
      await waitFor(() => expect(screen.queryByText('Moved')).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Sheet', () => {
  function Host(props: { layout: Layout }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>open</button>
        {open && (
          <Sheet label="Edit" onClose={() => setOpen(false)}>
            <button>first</button>
            <button>last</button>
          </Sheet>
        )}
        <span>{props.layout}</span>
      </>
    );
  }

  it.each(['desktop', 'phone'] as const)('is a labelled modal that traps focus and closes on Esc, on %s', async (layout) => {
    await inApp(<Host layout={layout} />, layout);
    const opener = screen.getByText('open');
    opener.focus();
    await userEvent.click(opener);
    expect(screen.getByRole('dialog', { name: 'Edit' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('dialog')).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByText('first')).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByText('last')).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByText('first')).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByText('last')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('returns focus to the opener when a field inside took focus with autoFocus', async () => {
    function Auto() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>open</button>
          {open && (
            <Sheet label="Edit" onClose={() => setOpen(false)}>
              <input aria-label="Name" autoFocus />
            </Sheet>
          )}
        </>
      );
    }
    await inApp(<Auto />, 'phone');
    await userEvent.click(screen.getByText('open'));
    expect(screen.getByLabelText('Name')).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByText('open')).toHaveFocus();
  });

  it('returns focus to the button pressed to open it, even where a press does not focus it (WebKit)', async () => {
    await inApp(<Host layout="phone" />, 'phone');
    const opener = screen.getByText('open');
    // WebKit leaves focus where it was when a button is tapped.
    fireEvent.pointerDown(opener);
    fireEvent.click(opener);
    expect(opener).not.toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('closes from the backdrop but not from inside', async () => {
    const onClose = vi.fn();
    const view = await inApp(
      <Sheet label="Edit" onClose={onClose}>
        <button>inside</button>
      </Sheet>,
    );
    await userEvent.click(screen.getByText('inside'));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(view.container.querySelector('.overlay')!);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('Popover', () => {
  it('hangs in place on desktop and closes on an outside press', async () => {
    const onClose = vi.fn();
    await inApp(
      <>
        <button>outside</button>
        <Popover label="Edit milestone" onClose={onClose}>
          <button>inside</button>
        </Popover>
      </>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Edit milestone' });
    expect(dialog).toHaveClass('qpop');
    await userEvent.click(screen.getByText('inside'));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('outside'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('becomes a sheet on phone', async () => {
    await inApp(
      <Popover label="Edit milestone" onClose={() => undefined}>
        x
      </Popover>,
      'phone',
    );
    expect(screen.getByRole('dialog', { name: 'Edit milestone' })).toHaveClass('sheet');
  });
});

describe('Pill', () => {
  it('is plain text, or a button when it asks something', async () => {
    const onClick = vi.fn();
    await inApp(
      <>
        <Pill tone="green">On track</Pill>
        <Pill tone="red" onClick={onClick} aria-label="Overdue: move the date" aria-expanded={false}>
          Overdue
        </Pill>
      </>,
    );
    expect(screen.getByText('On track')).toHaveClass('pill', 'p-g');
    expect(screen.queryByRole('button', { name: 'On track' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Overdue: move the date' }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByText('Overdue')).toHaveClass('p-r');
  });
});

describe('MilestoneDiamond', () => {
  it('is solid in the plan, hollow out of it, and red when late', async () => {
    const { container } = await inApp(
      <>
        <MilestoneDiamond state={{ on: true }} />
        <MilestoneDiamond />
        <MilestoneDiamond state={{ late: true }} />
      </>,
    );
    const dias = container.querySelectorAll('.msdia');
    expect(dias[0]).toHaveClass('on');
    expect(dias[1]).not.toHaveClass('on');
    expect(dias[2]).toHaveClass('late');
  });
});

describe('TimelineBar', () => {
  const axis = { start: '2026-10-01', end: '2026-12-31' };

  it('places dates along the axis, kept inside it', () => {
    expect(axisPercent(axis, '2026-10-01')).toBe(0);
    expect(axisPercent(axis, '2026-11-15')).toBeCloseTo((45 / 92) * 100);
    expect(axisPercent(axis, '2026-01-01')).toBe(0);
    expect(axisPercent(axis, '2027-06-01')).toBe(100);
    expect(axisMonths(axis)).toEqual(['2026-10-01', '2026-11-01', '2026-12-01']);
    expect(axisMonths({ start: '2026-10-15', end: '2026-11-15' })).toEqual(['2026-11-01']);
  });

  it('names no month that starts too near the end to fit its label', async () => {
    await inApp(<TimelineAxisHead axis={{ start: '2026-10-01', end: '2026-12-03' }} />);
    expect(screen.getByText('Nov')).toBeInTheDocument();
    expect(screen.queryByText('Dec')).toBeNull();
  });

  it('draws bar, bands, ticks and diamonds, described for screen readers', async () => {
    const { container } = await inApp(
      <>
        <TimelineAxisHead axis={axis} week={{ start: '2026-11-02', end: '2026-11-08' }} weekLabel="Nov 2 to 8" />
        <TimelineBar
          axis={axis}
          bar={{ start: '2026-10-01', end: '2026-11-30' }}
          stretch={{ start: '2026-10-01', end: '2026-12-31' }}
          week={{ start: '2026-11-02', end: '2026-11-08' }}
          diamonds={[
            { id: 'a', date: '2026-11-10', state: { on: true } },
            { id: 'b', date: '2026-11-30', state: { done: true } },
          ]}
          alt="Write the report, on track"
        />
      </>,
    );
    expect(screen.getByRole('img', { name: 'Write the report, on track' })).toBeInTheDocument();
    expect(container.querySelector('.pband')).toHaveStyle({ left: '0%', width: '100%' });
    expect(container.querySelector('.pweekband')).toBeInTheDocument();
    expect(container.querySelector('.pspan')).toBeInTheDocument();
    expect(container.querySelectorAll('.ptick')).toHaveLength(3);
    expect(container.querySelectorAll('.gdia')).toHaveLength(2);
    expect(container.querySelector('.gdia.on')).toBeInTheDocument();
    expect(screen.getByText('Nov 2 to 8')).toBeInTheDocument();
  });
});

describe('TaskRow', () => {
  it('ticks, strikes through and unticks', async () => {
    function Host() {
      const [on, setOn] = useState(false);
      return <TaskRow title="Paint the fence" checked={on} onToggle={setOn} line="Nov 2" />;
    }
    await inApp(<Host />);
    const box = screen.getByRole('checkbox', { name: 'Paint the fence done' });
    expect(screen.getByText('Paint the fence')).not.toHaveClass('done');
    await userEvent.click(box);
    expect(box).toBeChecked();
    expect(screen.getByText('Paint the fence')).toHaveClass('done');
    await userEvent.click(box);
    expect(box).not.toBeChecked();
    expect(screen.getByText('Nov 2')).toBeInTheDocument();
  });

  it('reports the new value, and the circle, from the circle alone', async () => {
    const onChange = vi.fn();
    await inApp(<CheckCircle checked={false} label="Done" onChange={onChange} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Done' }));
    expect(onChange).toHaveBeenCalledWith(true, screen.getByRole('checkbox', { name: 'Done' }));
  });
});
