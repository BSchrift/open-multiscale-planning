import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fixedClock } from '../../core/clock';
import { listRecords, transact } from '../../core/records';
import { createTestPlatform } from '../../platform/testing';
import { ToastProvider } from '../components/Toast';
import { AppProvider, useMutation, useQuery, useStickyState } from './store';

afterEach(cleanup);

const clock = fixedClock('2026-11-02T20:00:00Z', 'America/Chicago');

async function setup(ui: React.ReactElement) {
  const platform = await createTestPlatform();
  render(
    <AppProvider platform={platform} clock={clock} layout="desktop">
      <ToastProvider>{ui}</ToastProvider>
    </AppProvider>,
  );
  return platform;
}

function Titles(props: { kind: string }) {
  const { data, loading } = useQuery(
    async (sql) => (await listRecords(sql, 'task')).filter((t) => t.kind === props.kind).map((t) => t.title),
    [props.kind],
  );
  return <div data-testid="titles" data-loading={loading}>{data?.join(',') ?? 'none yet'}</div>;
}

describe('useQuery', () => {
  it('loads, then re-runs on any change to the database', async () => {
    const platform = await setup(<Titles kind="inbox" />);
    await waitFor(() => expect(screen.getByTestId('titles').dataset.loading).toBe('false'));
    expect(screen.getByTestId('titles').textContent).toBe('');
    await act(() => transact(platform.db, clock, (w) => w.create('task', { kind: 'inbox', title: 'Paint the fence' })));
    await waitFor(() => expect(screen.getByTestId('titles').textContent).toBe('Paint the fence'));
  });

  it('re-runs when deps change, keeping the old rows until the new ones arrive', async () => {
    const platform = await createTestPlatform();
    await transact(platform.db, clock, async (w) => {
      await w.create('task', { kind: 'inbox', title: 'A' });
      await w.create('task', { kind: 'one_off', title: 'B' });
    });
    function Both() {
      const [kind, setKind] = useState('inbox');
      return (
        <>
          <button onClick={() => setKind('one_off')}>switch</button>
          <Titles kind={kind} />
        </>
      );
    }
    render(
      <AppProvider platform={platform} clock={clock} layout="desktop">
        <ToastProvider>
          <Both />
        </ToastProvider>
      </AppProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('titles').textContent).toBe('A'));
    await userEvent.click(screen.getByText('switch'));
    await waitFor(() => expect(screen.getByTestId('titles').textContent).toBe('B'));
  });

  it('reports a failed query instead of throwing, and stops listening when unmounted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let calls = 0;
    function Bad() {
      const { error } = useQuery(async (sql) => {
        calls++;
        return sql.all('SELECT * FROM no_such_table');
      }, []);
      return <div>{error ? 'failed' : 'ok'}</div>;
    }
    const platform = await createTestPlatform();
    const view = render(
      <AppProvider platform={platform} clock={clock} layout="desktop">
        <ToastProvider>
          <Bad />
        </ToastProvider>
      </AppProvider>,
    );
    await screen.findByText('failed');
    view.unmount();
    const before = calls;
    await transact(platform.db, clock, (w) => w.create('task', { kind: 'inbox', title: 'x' }));
    expect(calls).toBe(before);
    spy.mockRestore();
  });
});

describe('useMutation', () => {
  it('runs in one transaction and returns the result', async () => {
    function Add() {
      const add = useMutation((w, title: string) => w.create('task', { kind: 'inbox', title }));
      return <button onClick={() => void add.run('Paint the fence')}>add</button>;
    }
    const platform = await setup(<><Add /><Titles kind="inbox" /></>);
    await userEvent.click(screen.getByText('add'));
    await waitFor(() => expect(screen.getByTestId('titles').textContent).toBe('Paint the fence'));
    expect(await platform.db.all('SELECT field FROM outbox')).toHaveLength(2);
  });

  it('rolls back on failure and tells the user', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Bad() {
      const bad = useMutation(async (w) => {
        await w.create('task', { kind: 'inbox', title: 'half done' });
        throw new Error('boom');
      });
      return <button onClick={() => void bad.run()}>go</button>;
    }
    const platform = await setup(<Bad />);
    await userEvent.click(screen.getByText('go'));
    await screen.findByText("Couldn't save that. Try again.");
    expect(await platform.db.all('SELECT * FROM records')).toEqual([]);
    spy.mockRestore();
  });
});

describe('useStickyState', () => {
  it('survives a remount', async () => {
    function Step() {
      const [step, setStep] = useStickyState('test.step', 1);
      return <button onClick={() => setStep(step + 1)}>step {step}</button>;
    }
    const first = render(<Step />);
    await userEvent.click(screen.getByText('step 1'));
    first.unmount();
    render(<Step />);
    expect(screen.getByText('step 2')).toBeInTheDocument();
  });
});
