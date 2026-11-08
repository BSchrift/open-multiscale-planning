// What the app reports about how it runs, as OpenTelemetry events: the OTel SDK batches them and its OTLP/HTTP
// exporter sends them, so the receiver can be ours or any OTel collector. Names follow OTel's semantic conventions.
// Only how the app runs is sent: memory, the screen, and errors by type and place without their messages, never what a
// person wrote. The server drops anything else too. The app loads this file after it starts, so the SDK never slows
// startup or capture.

import { protocol } from '@multiscale/config';
import type { AnyValueMap } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import type { LogRecordExporter } from '@opentelemetry/sdk-logs';
import type { Updater } from './updates';

export type Attributes = Record<string, string | number>;

/** The native side's numbers, where there is one. Bytes and seconds. */
export interface DiagnosticsSnapshot {
  footprint: number;
  peak: number;
  warnings: number;
  /** Page loads in this run of the app: more than one means the web view was reloaded. */
  pageLoads: number;
  model?: string;
  osVersion?: string;
  /** How the previous run ended, reported once. */
  previous?: { peak: number; last: number; warnings: number; state: string; uptime: number };
}

export interface Diagnostics {
  snapshot(): Promise<DiagnosticsSnapshot>;
  /** Returns an unsubscribe function. */
  onMemoryWarning(listener: () => void): () => void;
}

const FLUSH_MS = 60_000;
/** The most the server keeps from one send, from config/protocol.yaml. */
const MAX_QUEUED = protocol.telemetry.maxBatchEvents;

/** Where an error was thrown, as a path in the app's files, never its message. */
function errorPlace(event: ErrorEvent): Attributes {
  const place: Attributes = { 'exception.type': (event.error as Error | undefined)?.name ?? 'Error' };
  try {
    if (event.filename) place['code.file.path'] = new URL(event.filename).pathname.replace(/^\//, '');
  } catch {
    // Not a URL: leave the place out.
  }
  if (event.lineno) place['code.line.number'] = event.lineno;
  if (event.colno) place['code.column.number'] = event.colno;
  return place;
}

/**
 * Reports app.start and the last run's end at once, an app.heartbeat each minute, memory warnings and uncaught errors,
 * each update check's result and an update rolled back. The SDK sends a batch each minute and when the page is hidden; a
 * batch that fails to send is dropped.
 */
export async function startTelemetry(deps: {
  /** The OTLP endpoint, and the headers for each send, such as a fresh sign-in token. */
  url: string;
  headers(): Promise<Record<string, string>>;
  /** Replaces the OTLP exporter, for tests. */
  exporter?: LogRecordExporter;
  now(): number;
  resource: Attributes;
  diagnostics?: Diagnostics;
  /** Over-the-air updates, in apps that take them. */
  updates?: Pick<Updater, 'status' | 'subscribe' | 'rolledBack'>;
  /** The screen on show, such as week. */
  screen(): string | undefined;
  /** Where errors and visibility changes arrive: the window. */
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> & { document?: Pick<Document, 'visibilityState' | 'getElementsByTagName'> };
}) {
  const { now, diagnostics, screen, target } = deps;
  const started = now();
  const snap = await diagnostics?.snapshot().catch(() => undefined);
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      ...deps.resource,
      ...(snap?.model ? { 'device.model.identifier': snap.model } : {}),
      ...(snap?.osVersion ? { 'os.version': snap.osVersion } : {}),
    }),
    processors: [
      new BatchLogRecordProcessor({
        exporter: deps.exporter ?? new OTLPLogExporter({ url: deps.url, headers: deps.headers }),
        scheduledDelayMillis: FLUSH_MS,
        maxQueueSize: MAX_QUEUED,
      }),
    ],
  });
  const logger = provider.getLogger('multiscale');

  const record = (name: string, attributes: Attributes = {}) => {
    const on = screen();
    logger.emit({ eventName: name, timestamp: now(), attributes: (on ? { 'app.screen.name': on, ...attributes } : attributes) as AnyValueMap });
  };

  const memory = async (): Promise<Attributes> => {
    const current = await diagnostics?.snapshot().catch(() => undefined);
    const nodes = target.document?.getElementsByTagName('*').length;
    return {
      'app.uptime': Math.round((now() - started) / 1000),
      ...(nodes ? { 'browser.dom.nodes': nodes } : {}),
      ...(current ? { 'process.memory.usage': current.footprint, 'process.memory.peak': current.peak, 'app.memory_warnings': current.warnings } : {}),
    };
  };

  record('app.start', snap ? { 'app.page_loads': snap.pageLoads, 'process.memory.usage': snap.footprint } : {});
  const last = snap?.previous;
  if (last) {
    record('app.last_session', {
      'app.last_session.state': last.state,
      'process.memory.peak': last.peak,
      'process.memory.usage': last.last,
      'app.memory_warnings': last.warnings,
      'app.uptime': last.uptime,
    });
  }

  // A bundle that never reported ready can't report itself, so the one loaded after it does.
  const { updates } = deps;
  const rolledBack = await updates?.rolledBack().catch(() => null);
  if (rolledBack) record('app.update.rollback', { 'app.update.build': rolledBack });
  const updateChecked = () => {
    const status = updates!.status();
    if (status.state === 'idle' || status.state === 'checking') return;
    record('app.update.check', {
      'app.update.outcome': status.state,
      ...(status.state === 'failed' ? { 'app.update.failure': status.failure } : {}),
      ...('build' in status && status.build ? { 'app.update.build': status.build } : {}),
    });
  };
  // A check that finished before this started is reported too.
  if (updates) updateChecked();
  const stopUpdates = updates?.subscribe(updateChecked);

  const onError = (event: Event) => record('exception', errorPlace(event as ErrorEvent));
  const onRejection = (event: Event) => {
    const reason = (event as PromiseRejectionEvent).reason as { name?: unknown } | undefined;
    record('exception', { 'exception.type': typeof reason?.name === 'string' ? reason.name : 'UnhandledRejection' });
  };
  const onVisibility = () => {
    if (target.document?.visibilityState === 'hidden') void memory().then((m) => record('app.hidden', m));
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  target.addEventListener('visibilitychange', onVisibility);
  const stopWarnings = diagnostics?.onMemoryWarning(() => void memory().then((m) => record('device.memory_warning', m)));
  const timer = setInterval(() => void memory().then((m) => record('app.heartbeat', m)), FLUSH_MS);

  return {
    flush: () => provider.forceFlush(),
    stop(): void {
      clearInterval(timer);
      stopWarnings?.();
      stopUpdates?.();
      target.removeEventListener('error', onError);
      target.removeEventListener('unhandledrejection', onRejection);
      target.removeEventListener('visibilitychange', onVisibility);
      void provider.shutdown();
    },
  };
}
