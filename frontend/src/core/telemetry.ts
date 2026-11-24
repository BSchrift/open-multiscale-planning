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
import { dailyAttributes, exceptionAttributes } from './metrickit';
import type { MetricReports } from './metrickit';
import type { Updater } from './updates';

export type Attributes = Record<string, string | number | boolean>;

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

/** The battery's state, as context for the energy numbers. */
export interface Power {
  /** On a charger: plugged in on the iPhone, on AC power on the Mac. */
  charging?: boolean;
  /** Low Power Mode, on the iPhone. */
  lowPower?: boolean;
  /** nominal, fair, serious or critical, or unknown. */
  thermal?: string;
}

/** One kind of process's CPU percent and idle wakeups a second, over the minute since the last sample. */
export interface ProcessEnergy {
  process: 'main' | 'renderer' | 'gpu';
  cpuPercent: number;
  idleWakeupsPerSecond: number;
}

/** What the device says about its battery and the energy the app uses (docs/performance.md, Battery). */
export interface Energy {
  /** Taken with each heartbeat. The Mac also gives each kind of process's CPU, and whether its window shows. */
  sample(): Promise<{ power: Power; processes?: ProcessEnergy[]; windowVisible?: boolean }>;
  /** On the iPhone: MetricKit's reports since the last call, each handed over once. */
  reports?(): Promise<MetricReports>;
}

const FLUSH_MS = 60_000;
const round = (value: number) => Math.round(value * 100) / 100;
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
 * Reports app.start and the last run's end at once, an app.heartbeat with the battery's state, app.sync.count and the Mac's
 * app.energy.sample each minute, the iPhone's MetricKit reports as they come, memory warnings and uncaught errors,
 * each update check's result, an update rolled back, and a Mac app that just replaced itself. The SDK sends a batch each minute and when the page is hidden; a
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
  updates?: Pick<Updater, 'status' | 'subscribe' | 'rolledBack' | 'app'>;
  energy?: Energy;
  /** The sync requests answered since the last call, and the bytes they carried, which drain the battery. */
  syncs?(): { count: number; bytes: number };
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
  // On the first launch of a Mac app that replaced itself, with the app builds before and after.
  const installed = await updates?.app?.updated().catch(() => null);
  if (installed) record('app.update.installed', { 'app.update.from': installed.from, 'app.update.build': installed.to });
  let downloading: number | undefined;
  const updateChecked = () => {
    const status = updates!.status();
    if (status.state === 'idle' || status.state === 'checking') return;
    // A download reports its percent as it goes: one event when it starts is enough.
    if (status.state === 'app-downloading' && downloading === status.build) return;
    downloading = status.state === 'app-downloading' ? status.build : undefined;
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
  const heartbeat = async () => {
    const [m, energy] = await Promise.all([memory(), deps.energy?.sample().catch(() => undefined)]);
    const { charging, lowPower, thermal } = energy?.power ?? {};
    record('app.heartbeat', {
      ...m,
      ...(charging !== undefined ? { 'device.battery.charging': charging } : {}),
      ...(lowPower !== undefined ? { 'device.low_power': lowPower } : {}),
      ...(thermal ? { 'device.thermal_state': thermal } : {}),
    });
    for (const p of energy?.processes ?? []) {
      record('app.energy.sample', {
        'energy.process': p.process,
        'energy.cpu_percent': round(p.cpuPercent),
        'energy.idle_wakeups_per_s': round(p.idleWakeupsPerSecond),
        ...(energy!.windowVisible !== undefined ? { 'energy.window_visible': energy!.windowVisible } : {}),
      });
    }
  };
  // MetricKit delivers a day about once a day, often at launch, so it's looked for then and with each heartbeat.
  const metricReports = async () => {
    const reports = await deps.energy?.reports?.().catch(() => undefined);
    for (const day of reports?.daily ?? []) record('app.energy.daily', dailyAttributes(day));
    for (const exception of reports?.exceptions ?? []) record('app.energy.exception', exceptionAttributes(exception));
  };
  await metricReports();
  const timer = setInterval(() => {
    void heartbeat();
    void metricReports();
    // Idle minutes too, so a sync loop shows against the time the app was open.
    const synced = deps.syncs?.();
    if (synced) record('app.sync.count', { 'sync.count': synced.count, 'sync.bytes': synced.bytes });
  }, FLUSH_MS);

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
