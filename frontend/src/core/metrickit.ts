// MetricKit's reports on the iPhone, as the native plugin hands them over (ios/App/App/EnergyPlugin.swift), turned into telemetry's
// app.energy.daily and app.energy.exception attributes. The plugin reads MetricKit's typed measurements, so every
// number arrives in seconds or bytes whatever the phone's region; this side names them and finds the frame to blame.

import type { Attributes } from './telemetry';

/** One day of the app's use as MetricKit totals it: seconds and bytes. */
export interface MetricDay {
  /** The day it covers, as yyyy-mm-dd. */
  day: string;
  cpuSeconds?: number;
  gpuSeconds?: number;
  cellularBytes?: number;
  wifiBytes?: number;
  foregroundSeconds?: number;
  backgroundSeconds?: number;
  hangSeconds?: number;
}

/** A frame of MetricKit's call stack tree (MXCallStackTree's JSON). */
interface Frame {
  binaryName?: string;
  offsetIntoBinaryTextSegment?: number;
  sampleCount?: number;
  subFrames?: Frame[];
}

/** iOS stopping the app for using too much CPU in the background, or writing too much to disk. */
export interface MetricException {
  kind: 'cpu' | 'disk';
  cpuSeconds?: number;
  diskBytes?: number;
  callStackTree?: { callStacks?: { threadAttributed?: boolean; callStackRootFrames?: Frame[] }[] };
}

export interface MetricReports {
  daily: MetricDay[];
  exceptions: MetricException[];
}

const round = (value: number) => Math.round(value * 100) / 100;

export function dailyAttributes(day: MetricDay): Attributes {
  const numbers: [string, number | undefined][] = [
    ['energy.cpu_seconds', day.cpuSeconds],
    ['energy.gpu_seconds', day.gpuSeconds],
    ['energy.cellular_bytes', day.cellularBytes],
    ['energy.wifi_bytes', day.wifiBytes],
    ['energy.foreground_seconds', day.foregroundSeconds],
    ['energy.background_seconds', day.backgroundSeconds],
    ['energy.hang_seconds', day.hangSeconds],
  ];
  return { 'energy.day': day.day, ...Object.fromEntries(numbers.filter((entry): entry is [string, number] => Number.isFinite(entry[1])).map(([key, value]) => [key, round(value)])) };
}

/**
 * The frame the samples landed in most, as its binary and offset, such as App+0x28a3c, which the build's symbols turn
 * into a function. MetricKit roots each stack at its newest frame. Never the rest of the stack, or any names in it.
 */
export function topFrame(tree: MetricException['callStackTree']): string | undefined {
  const stacks = tree?.callStacks ?? [];
  const frames = (stacks.find((stack) => stack.threadAttributed) ?? stacks[0])?.callStackRootFrames ?? [];
  const top = frames.reduce<Frame | undefined>((best, frame) => ((frame.sampleCount ?? 0) > (best?.sampleCount ?? -1) ? frame : best), undefined);
  if (!top?.binaryName || top.offsetIntoBinaryTextSegment === undefined) return undefined;
  return `${top.binaryName}+0x${top.offsetIntoBinaryTextSegment.toString(16)}`;
}

export function exceptionAttributes(exception: MetricException): Attributes {
  const frame = topFrame(exception.callStackTree);
  return {
    'energy.exception.kind': exception.kind,
    ...(exception.cpuSeconds !== undefined ? { 'energy.exception.cpu_seconds': round(exception.cpuSeconds) } : {}),
    ...(exception.diskBytes !== undefined ? { 'energy.exception.disk_bytes': Math.round(exception.diskBytes) } : {}),
    ...(frame ? { 'code.function': frame } : {}),
  };
}
