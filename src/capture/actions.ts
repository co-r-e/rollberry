import type { Page } from 'playwright';

import type { CaptureAction } from './types.js';
import { delay, waitForAnimationFrames } from './utils.js';

const ACTION_SETTLE_DELAY_MS = 75;

export async function executeSceneActions(options: {
  page: Page;
  actions: CaptureAction[];
  timeoutMs: number;
  onActionStart?: (
    action: CaptureAction,
    index: number,
  ) => Promise<void> | void;
  onActionComplete?: (
    action: CaptureAction,
    index: number,
  ) => Promise<void> | void;
}): Promise<void> {
  const { page, actions, timeoutMs, onActionStart, onActionComplete } = options;

  for (const [index, action] of actions.entries()) {
    await onActionStart?.(action, index);
    await executeCaptureAction(page, action, timeoutMs);

    await onActionComplete?.(action, index);
  }
}

export async function executeCaptureAction(
  page: Page,
  action: CaptureAction,
  timeoutMs: number,
): Promise<void> {
  switch (action.kind) {
    case 'wait':
      await delay(action.ms);
      break;

    case 'click':
      await page.waitForSelector(action.selector, {
        state: 'visible',
        timeout: timeoutMs,
      });
      await page.locator(action.selector).click();
      await settlePage(page);
      break;

    case 'hover':
      await page.waitForSelector(action.selector, {
        state: 'visible',
        timeout: timeoutMs,
      });
      await page.locator(action.selector).hover();
      await settlePage(page);
      break;

    case 'press':
      await page.keyboard.press(action.key);
      await settlePage(page);
      break;

    case 'type':
      await page.waitForSelector(action.selector, {
        state: 'visible',
        timeout: timeoutMs,
      });
      if (action.clear) {
        await page.locator(action.selector).fill(action.text);
      } else {
        await page.locator(action.selector).type(action.text);
      }
      await settlePage(page);
      break;

    case 'scroll-to':
      await page.waitForSelector(action.selector, {
        state: 'attached',
        timeout: timeoutMs,
      });
      await page.evaluate(
        ({ selector, block }) => {
          const element = document.querySelector(selector);
          if (!element) {
            throw new Error(
              `Selector not found for scroll action: ${selector}`,
            );
          }

          element.scrollIntoView({
            block,
            behavior: 'auto',
            inline: 'nearest',
          });
        },
        {
          selector: action.selector,
          block: action.block,
        },
      );
      await settlePage(page);
      break;
  }
}

export async function resetScrollPosition(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  });
  await waitForAnimationFrames(page);
}

async function settlePage(page: Page): Promise<void> {
  await waitForAnimationFrames(page);
  await delay(ACTION_SETTLE_DELAY_MS);
}
