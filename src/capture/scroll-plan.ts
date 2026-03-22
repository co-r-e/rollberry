import {
  AUTO_DURATION_MAX_SECONDS,
  AUTO_DURATION_MIN_SECONDS,
  AUTO_DURATION_PIXELS_PER_SECOND,
  MAX_TOTAL_FRAMES,
  TIMELINE_AUTO_DURATION_MAX_SECONDS,
  TIMELINE_AUTO_DURATION_MIN_SECONDS,
  TIMELINE_AUTO_DURATION_PIXELS_PER_SECOND,
} from './constants.js';
import type { MotionCurve } from './types.js';
import { clamp } from './utils.js';

export function resolveDurationSeconds(
  requestedDuration: number | 'auto',
  maxScroll: number,
): number {
  if (requestedDuration !== 'auto') {
    return requestedDuration;
  }

  return clamp(
    maxScroll / AUTO_DURATION_PIXELS_PER_SECOND,
    AUTO_DURATION_MIN_SECONDS,
    AUTO_DURATION_MAX_SECONDS,
  );
}

export function buildScrollFrames(options: {
  fps: number;
  durationSeconds: number;
  maxScroll: number;
  motion: MotionCurve;
}): number[] {
  const frameCount = Math.max(
    1,
    Math.ceil(options.durationSeconds * options.fps),
  );

  if (frameCount > MAX_TOTAL_FRAMES) {
    throw new Error(
      `Frame count ${frameCount} exceeds maximum ${MAX_TOTAL_FRAMES}. Reduce --fps or --duration.`,
    );
  }

  if (frameCount === 1) {
    return [0];
  }

  return Array.from({ length: frameCount }, (_, index) => {
    const progress = index / (frameCount - 1);
    const easedProgress =
      options.motion === 'linear' ? progress : easeInOutSine(progress);

    return Number((options.maxScroll * easedProgress).toFixed(3));
  });
}

export function resolveTimelineDurationSeconds(distance: number): number {
  return clamp(
    distance / TIMELINE_AUTO_DURATION_PIXELS_PER_SECOND,
    TIMELINE_AUTO_DURATION_MIN_SECONDS,
    TIMELINE_AUTO_DURATION_MAX_SECONDS,
  );
}

function easeInOutSine(value: number): number {
  return -(Math.cos(Math.PI * value) - 1) / 2;
}
