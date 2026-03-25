import type { Page } from 'playwright';

import { resetScrollPosition } from './actions.js';
import {
  MAX_PREFLIGHT_ITERATIONS,
  PREFLIGHT_MAX_SCROLL_HEIGHT,
  PREFLIGHT_STABLE_ROUNDS,
  PREFLIGHT_STEP_DELAY_MS,
} from './constants.js';
import type { CaptureLogger } from './logger.js';
import type { PreflightResult } from './types.js';
import { delay, measurePage, waitForAnimationFrames } from './utils.js';

export async function preflightMeasurePage(
  page: Page,
  logger?: CaptureLogger,
): Promise<PreflightResult> {
  let metrics = await measurePage(page);
  let truncated = metrics.scrollHeight > PREFLIGHT_MAX_SCROLL_HEIGHT;
  let stableRounds = metrics.maxScroll === 0 ? PREFLIGHT_STABLE_ROUNDS : 0;
  let iterations = 0;

  while (!truncated && stableRounds < PREFLIGHT_STABLE_ROUNDS) {
    iterations += 1;
    if (iterations > MAX_PREFLIGHT_ITERATIONS) {
      await logger?.warn(
        'preflight.max_iterations',
        `Preflight measurement stopped after ${MAX_PREFLIGHT_ITERATIONS} iterations (page content may still be loading)`,
      );
      break;
    }

    let position = 0;

    while (position < metrics.maxScroll) {
      position = Math.min(position + metrics.viewportHeight, metrics.maxScroll);
      await page.evaluate((scrollTop) => {
        window.scrollTo({ top: scrollTop, behavior: 'auto' });
      }, position);
      await waitForAnimationFrames(page);
      await delay(PREFLIGHT_STEP_DELAY_MS);
    }

    await delay(PREFLIGHT_STEP_DELAY_MS);
    const nextMetrics = await measurePage(page);
    truncated = nextMetrics.scrollHeight > PREFLIGHT_MAX_SCROLL_HEIGHT;

    const grew = nextMetrics.scrollHeight > metrics.scrollHeight;
    metrics = nextMetrics;
    if (grew) {
      stableRounds = nextMetrics.maxScroll === 0 ? PREFLIGHT_STABLE_ROUNDS : 0;
    } else {
      stableRounds += 1;
    }
  }

  await resetScrollPosition(page);

  const clampedScrollHeight = Math.min(
    metrics.scrollHeight,
    PREFLIGHT_MAX_SCROLL_HEIGHT,
  );

  return {
    scrollHeight: clampedScrollHeight,
    viewportHeight: metrics.viewportHeight,
    maxScroll: Math.max(0, clampedScrollHeight - metrics.viewportHeight),
    truncated,
  };
}
