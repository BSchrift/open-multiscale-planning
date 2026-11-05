import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTelemetry } from './telemetry';
import type { Diagnostics, DiagnosticsSnapshot } from './telemetry';

const T0 = Date.parse('2026-11-05T06:00:00Z');
const MB = 1024 * 1024;

beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'], now: T0 }));
afterEach(() => vi.useRealTimers());

async function setup(snapshot?: Partial<DiagnosticsSnapshot>) {
  const exporter = new InMemoryLogRecordExporter();
  let warn: (() => void) | undefined;
  const diagnostics: Diagnostics | undefined = snapshot && {
    snapshot: async () => ({ footprint: 200 * MB, peak: 250 * MB, warnings: 0, pageLoads: 1, ...snapshot }),
    onMemoryWarning: (listener) => {
      warn = listener;
      return () => (warn = undefined);
    },
  };
  const target = new EventTarget() as EventTarget & { document: { visibilityState: string; getElementsByTagName(name: string): { length: number } } };
  target.document = { visibilityState: 'visible', getElementsByTagName: () => ({ length: 1500 }) };
  const telemetry = await startTelemetry({
    url: 'https://api.example.test/v1/logs',
    headers: async () => ({}),
    exporter,
    now: () => Date.now(),
    resource: { 'os.name': 'ios', 'session.id': 's-1' },
    ...(diagnostics ? { diagnostics } : {}),
    screen: () => 'week',
    target: target as never,
  });
  const events = async () => {
    await telemetry.flush();
    return exporter.getFinishedLogRecords();
  };
  return { telemetry, events, target, warn: () => warn?.() };
}

describe('startTelemetry', () => {
  it('reports the start and how the last run ended, with the device it ran on', async () => {
    const t = await setup({ pageLoads: 2, model: 'iPhone14,2', osVersion: '26.6.2', previous: { peak: 1900 * MB, last: 1800 * MB, warnings: 3, state: 'active', uptime: 1077 } });
    const [start, last] = await t.events();
    expect([start?.eventName, last?.eventName]).toEqual(['app.start', 'app.last_session']);
    expect(start!.resource.attributes).toMatchObject({ 'os.name': 'ios', 'session.id': 's-1', 'device.model.identifier': 'iPhone14,2', 'os.version': '26.6.2' });
    expect(start!.attributes).toMatchObject({ 'app.screen.name': 'week', 'app.page_loads': 2 });
    expect(last!.attributes).toMatchObject({ 'app.last_session.state': 'active', 'process.memory.peak': 1900 * MB, 'app.memory_warnings': 3 });
    t.telemetry.stop();
  });

  it('sends a heartbeat with memory, the page size and the screen each minute', async () => {
    const t = await setup({});
    await vi.advanceTimersByTimeAsync(60_000);
    const beat = (await t.events()).at(-1)!;
    expect(beat.eventName).toBe('app.heartbeat');
    expect(beat.attributes).toMatchObject({ 'app.screen.name': 'week', 'process.memory.usage': 200 * MB, 'browser.dom.nodes': 1500, 'app.uptime': 60 });
    t.telemetry.stop();
  });

  it('reports an uncaught error by type and place, never its message', async () => {
    const t = await setup();
    t.target.dispatchEvent(Object.assign(new Event('error'), { error: new TypeError('Paint the fence is undefined'), filename: 'capacitor://localhost/assets/index-Cc.js', lineno: 1, colno: 4321 }));
    t.target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new RangeError('Bake bread') }));
    const [thrown, rejected] = (await t.events()).filter((e) => e.eventName === 'exception');
    expect(thrown!.attributes).toEqual({ 'app.screen.name': 'week', 'exception.type': 'TypeError', 'code.file.path': 'assets/index-Cc.js', 'code.line.number': 1, 'code.column.number': 4321 });
    expect(rejected!.attributes).toEqual({ 'app.screen.name': 'week', 'exception.type': 'RangeError' });
    expect(JSON.stringify((await t.events()).map((e) => e.attributes))).not.toMatch(/Paint the fence|Bake bread/);
    t.telemetry.stop();
  });

  it('reports memory warnings, and the page being hidden', async () => {
    const t = await setup({ warnings: 1 });
    t.warn();
    t.target.document.visibilityState = 'hidden';
    t.target.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect((await t.events()).map((e) => e.eventName)).toEqual(['app.start', 'device.memory_warning', 'app.hidden']);
    t.telemetry.stop();
  });
});
