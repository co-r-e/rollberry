import { describe, expect, it } from 'vitest';

import {
  buildScrollFrames,
  resolveDurationSeconds,
} from '../../src/capture/scroll-plan.js';

describe('resolveDurationSeconds', () => {
  it('uses auto duration with clamp', () => {
    expect(resolveDurationSeconds('auto', 0)).toBe(4);
    expect(resolveDurationSeconds('auto', 1_800)).toBe(4);
    expect(resolveDurationSeconds('auto', 90_000)).toBe(40);
  });

  it('uses explicit duration as-is', () => {
    expect(resolveDurationSeconds(7, 40_000)).toBe(7);
  });
});

describe('buildScrollFrames', () => {
  it('builds a monotonic frame plan ending at maxScroll', () => {
    const frames = buildScrollFrames({
      fps: 4,
      durationSeconds: 1,
      maxScroll: 900,
      motion: 'ease-in-out-sine',
    });

    expect(frames).toHaveLength(4);
    expect(frames[0]).toBe(0);
    expect(frames.at(-1)).toBe(900);
    expect([...frames].sort((a, b) => a - b)).toEqual(frames);
  });

  it('returns a static frame list for zero scroll', () => {
    expect(
      buildScrollFrames({
        fps: 3,
        durationSeconds: 1,
        maxScroll: 0,
        motion: 'linear',
      }),
    ).toEqual([0, 0, 0]);
  });
});
