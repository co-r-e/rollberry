import type { Page } from 'playwright';

import { resetScrollPosition } from './actions.js';
import { FONT_LOADING_TIMEOUT_MS, STABILIZE_DELAY_MS } from './constants.js';
import type { WaitForCondition } from './types.js';
import { delay, validateHideSelector } from './utils.js';

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
  await resetScrollPosition(options.page);
}

function buildStabilizingCss(hideSelectors: string[]): string {
  for (const selector of hideSelectors) {
    validateHideSelector(selector);
  }

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
  await page.evaluate(async (timeoutMs: number) => {
    if (!('fonts' in document)) {
      return;
    }

    await Promise.race([
      document.fonts.ready,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }, FONT_LOADING_TIMEOUT_MS);
}
