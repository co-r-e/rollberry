import type { Page } from 'playwright';

import {
  PREFLIGHT_MAX_SCROLL_HEIGHT,
  PREFLIGHT_STABLE_ROUNDS,
  PREFLIGHT_STEP_DELAY_MS,
} from './constants.js';
import type { PreflightResult } from './types.js';
import { delay, measurePage, waitForAnimationFrames } from './utils.js';

export async function preflightMeasurePage(
  page: Page,
): Promise<PreflightResult> {
  let metrics = await measurePage(page);
  let truncated = metrics.scrollHeight > PREFLIGHT_MAX_SCROLL_HEIGHT;
  let stableRounds = metrics.maxScroll === 0 ? PREFLIGHT_STABLE_ROUNDS : 0;

  while (!truncated && stableRounds < PREFLIGHT_STABLE_ROUNDS) {
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

    if (nextMetrics.scrollHeight > metrics.scrollHeight) {
      metrics = nextMetrics;
      stableRounds = nextMetrics.maxScroll === 0 ? PREFLIGHT_STABLE_ROUNDS : 0;
    } else {
      metrics = nextMetrics;
      stableRounds += 1;
    }
  }

  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  });
  await waitForAnimationFrames(page);

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
