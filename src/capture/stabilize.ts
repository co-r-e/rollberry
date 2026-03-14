import type { Page } from 'playwright';

import { STABILIZE_DELAY_MS } from './constants.js';
import type { WaitForCondition } from './types.js';
import { delay, waitForAnimationFrames } from './utils.js';

export async function stabilizePage(options: {
  page: Page;
  waitFor: WaitForCondition;
  hideSelectors: string[];
}): Promise<void> {
  await options.page.addStyleTag({
    content: buildStabilizingCss(options.hideSelectors),
  });

  await waitForRequestedCondition(options.page, options.waitFor);
  await waitForFonts(options.page);
  await delay(STABILIZE_DELAY_MS);
  await options.page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  });
  await waitForAnimationFrames(options.page);
}

function buildStabilizingCss(hideSelectors: string[]): string {
  const hiddenSelectorBlock =
    hideSelectors.length > 0
      ? `${hideSelectors.join(', ')} { display: none !important; visibility: hidden !important; }\n`
      : '';

  return `
    html {
      scroll-behavior: auto !important;
      caret-color: transparent !important;
      scroll-snap-type: none !important;
    }

    *, *::before, *::after {
      animation: none !important;
      transition: none !important;
      scroll-behavior: auto !important;
      caret-color: transparent !important;
    }

    ${hiddenSelectorBlock}
  `;
}

async function waitForRequestedCondition(
  page: Page,
  waitFor: WaitForCondition,
): Promise<void> {
  if (waitFor.kind === 'load') {
    await page.waitForLoadState('load');
    return;
  }

  if (waitFor.kind === 'selector') {
    await page.waitForSelector(waitFor.selector, {
      state: 'attached',
    });
    return;
  }

  await delay(waitFor.ms);
}

async function waitForFonts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (!('fonts' in document)) {
      return;
    }

    await document.fonts.ready;
  });
}
