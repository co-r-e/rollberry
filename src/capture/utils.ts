import { access, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Page } from 'playwright';

import type { PageMetrics } from './types.js';

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isLocalUrl(url: URL): boolean {
  return LOCALHOST_HOSTS.has(url.hostname);
}

export function parseCaptureUrl(rawUrl: string): URL {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(
      `Invalid URL: ${rawUrl}\n  Expected format: http://example.com or https://localhost:3000`,
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `Unsupported URL: ${rawUrl} (only http:// and https:// are supported)`,
    );
  }

  return url;
}

export function sanitizeUrl(url: URL): string {
  const sanitized = new URL(url.toString());
  sanitized.username = '';
  sanitized.password = '';
  return sanitized.toString();
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function validateHideSelector(selector: string): void {
  if (selector.includes('{') || selector.includes('}')) {
    throw new Error(
      `Invalid CSS selector for --hide-selector: "${selector}". Selectors must not contain { or } characters.`,
    );
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitForAnimationFrames(
  page: Page,
  frameCount = 2,
): Promise<void> {
  await page.evaluate(async (count) => {
    for (let index = 0; index < count; index += 1) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }
  }, frameCount);
}

export async function measurePage(page: Page): Promise<PageMetrics> {
  return page.evaluate(() => {
    const body = document.body;
    const root = document.documentElement;
    const scrollHeight = Math.max(
      body?.scrollHeight ?? 0,
      body?.offsetHeight ?? 0,
      root.scrollHeight,
      root.offsetHeight,
      root.clientHeight,
    );
    const viewportHeight = window.innerHeight || root.clientHeight;

    return {
      scrollHeight,
      viewportHeight,
      maxScroll: Math.max(0, scrollHeight - viewportHeight),
    };
  });
}
