import { chromium, type Page } from 'playwright';

import { ensureChromiumInstalled } from './browser-install.js';
import { LOCALHOST_RETRY_INTERVAL_MS } from './constants.js';
import type { CaptureLogger } from './logger.js';
import type { CaptureOptions } from './types.js';
import { delay, isLocalUrl } from './utils.js';

export interface BrowserSession {
  browser: Awaited<ReturnType<typeof chromium.launch>>;
  page: Page;
}

export async function openBrowserSession(
  options: CaptureOptions,
  logger: CaptureLogger,
): Promise<BrowserSession> {
  await ensureChromiumInstalled(logger);

  const browser = await chromium.launch({
    headless: true,
  });

  try {
    const context = await browser.newContext({
      viewport: options.viewport,
      ignoreHTTPSErrors: options.urls.some(isLocalUrl),
    });
    const page = await context.newPage();

    page.setDefaultTimeout(options.timeoutMs);

    await page.addInitScript(() => {
      history.scrollRestoration = 'manual';
    });

    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

export async function navigateWithRetry(
  page: Page,
  url: URL,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const canRetry = isLocalUrl(url);

  while (true) {
    const remainingMs = Math.max(1, deadline - Date.now());

    try {
      await page.goto(url.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: remainingMs,
      });
      return;
    } catch (error) {
      if (
        !canRetry ||
        Date.now() + LOCALHOST_RETRY_INTERVAL_MS >= deadline ||
        !isRetryableNavigationError(error)
      ) {
        throw error;
      }

      await delay(LOCALHOST_RETRY_INTERVAL_MS);
    }
  }
}

function isRetryableNavigationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return [
    'ERR_CONNECTION_REFUSED',
    'ERR_EMPTY_RESPONSE',
    'ERR_CONNECTION_RESET',
    'ECONNREFUSED',
    'ECONNRESET',
  ].some((token) => error.message.includes(token));
}
