import { writeFile } from 'node:fs/promises';

import type {
  CaptureAction,
  CaptureTimelineScrollTarget,
  CaptureTimelineSegment,
} from './capture/types.js';

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export function serializeAction(
  action: CaptureAction,
): Record<string, unknown> {
  switch (action.kind) {
    case 'wait':
      return { kind: action.kind, ms: action.ms };
    case 'press':
      return { kind: action.kind, key: action.key };
    case 'click':
    case 'hover':
      return { kind: action.kind, selector: action.selector };
    case 'type':
      return {
        kind: action.kind,
        selector: action.selector,
        textLength: action.text.length,
        clear: action.clear,
      };
    case 'scroll-to':
      return {
        kind: action.kind,
        selector: action.selector,
        block: action.block,
      };
  }
}

export function serializeTimelineSegment(
  segment: CaptureTimelineSegment,
): Record<string, unknown> {
  switch (segment.kind) {
    case 'pause':
      return {
        kind: segment.kind,
        durationSeconds: segment.durationSeconds,
      };
    case 'scroll':
      return {
        kind: segment.kind,
        duration: segment.duration,
        motion: segment.motion,
        target: serializeTimelineTarget(segment.target),
      };
    case 'action':
      return {
        kind: segment.kind,
        holdAfterSeconds: segment.holdAfterSeconds,
        action: serializeAction(segment.action),
      };
  }
}

export function serializeTimelineTarget(
  target: CaptureTimelineScrollTarget,
): Record<string, unknown> {
  switch (target.kind) {
    case 'bottom':
      return { kind: target.kind };
    case 'absolute':
      return { kind: target.kind, top: target.top };
    case 'relative':
      return { kind: target.kind, delta: target.delta };
    case 'selector':
      return {
        kind: target.kind,
        selector: target.selector,
        block: target.block,
      };
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: 'Error',
    message: typeof error === 'string' ? error : 'Unknown error',
  };
}

export async function writeJsonFile(
  path: string,
  data: unknown,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
