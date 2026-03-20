import { unlink, writeFile } from 'node:fs/promises';

import type { Page } from 'playwright';

import { navigateWithRetry, openBrowserSession } from './browser.js';
import { MAX_TOTAL_FRAMES } from './constants.js';
import {
  checkFfmpegAvailable,
  createVideoEncoder,
  type VideoEncoder,
} from './ffmpeg.js';
import type { CaptureLogger } from './logger.js';
import { preflightMeasurePage } from './preflight.js';
import type { ProgressReporter } from './progress.js';
import { buildScrollFrames, resolveDurationSeconds } from './scroll-plan.js';
import { stabilizePage } from './stabilize.js';
import type {
  CaptureOptions,
  CaptureResult,
  PageCaptureResult,
} from './types.js';
import {
  ensureDirectory,
  ensureParentDirectory,
  fileExists,
  sanitizeUrl,
  waitForAnimationFrames,
} from './utils.js';

export async function captureVideo(
  options: CaptureOptions,
  logger: CaptureLogger,
  progress?: ProgressReporter,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  if (options.urls.length === 0) {
    throw new Error('At least one URL is required.');
  }

  if (signal?.aborted) {
    throw new AbortError();
  }

  if (!options.force && (await fileExists(options.outPath))) {
    throw new Error(
      `Output file already exists: ${options.outPath}\nUse --force to overwrite, or specify a different --out path.`,
    );
  }

  await checkFfmpegAvailable();

  await Promise.all([
    ensureParentDirectory(options.outPath),
    ensureParentDirectory(options.logFilePath),
    ensureParentDirectory(options.manifestPath),
    options.debugFramesDir
      ? ensureDirectory(options.debugFramesDir)
      : undefined,
  ]);

  const { browser, page } = await openBrowserSession(options, logger);
  let encoder: VideoEncoder | undefined;
  let encodingFinished = false;
  let browserClosed = false;

  const closeBrowser = async (): Promise<void> => {
    if (browserClosed) {
      return;
    }

    browserClosed = true;

    try {
      await browser.close();
    } catch {
      // Browser may already be closed during cancellation
    }
  };

  const abortHandler = () => {
    void encoder?.abort();
    void closeBrowser();
  };

  signal?.addEventListener('abort', abortHandler);

  try {
    if (signal?.aborted) {
      throw new AbortError();
    }

    encoder = await createVideoEncoder({
      fps: options.fps,
      outPath: options.outPath,
    });

    if (signal?.aborted) {
      throw new AbortError();
    }

    const pages: PageCaptureResult[] = [];
    let totalFrameCount = 0;
    let totalDurationSeconds = 0;
    let frameOffset = 0;
    let anyTruncated = false;

    for (const [urlIndex, url] of options.urls.entries()) {
      if (signal?.aborted) {
        throw new AbortError();
      }

      const { pageResult, lastFrame } = await capturePageFrames({
        page,
        url,
        encoder,
        options,
        logger,
        progress,
        signal,
        frameOffset,
        urlIndex,
      });

      pages.push(pageResult);
      totalFrameCount += pageResult.frameCount;
      totalDurationSeconds += pageResult.durationSeconds;
      frameOffset += pageResult.frameCount;
      anyTruncated = anyTruncated || pageResult.truncated;

      const isLastPage = urlIndex === options.urls.length - 1;
      if (options.pageGapSeconds > 0 && !isLastPage) {
        const gapFrameCount = await writeGapFrames({
          encoder,
          frame: lastFrame,
          fps: options.fps,
          gapSeconds: options.pageGapSeconds,
          debugFramesDir: options.debugFramesDir,
          frameOffset,
        });

        totalFrameCount += gapFrameCount;
        totalDurationSeconds += gapFrameCount / options.fps;
        frameOffset += gapFrameCount;
      }
    }

    await encoder.finish();
    encodingFinished = true;
    progress?.onEncodeComplete();
    await logger.info('encode.complete', 'Video encoding finished', {
      outPath: options.outPath,
    });

    return {
      outPath: options.outPath,
      frameCount: totalFrameCount,
      durationSeconds: totalDurationSeconds,
      pages,
      truncated: anyTruncated,
    };
  } catch (error) {
    const failure =
      signal?.aborted && !(error instanceof AbortError)
        ? new AbortError()
        : error;

    if (encoder && !encodingFinished) {
      await encoder.abort();
      await cleanupPartialOutput(options.outPath);
    }

    throw failure;
  } finally {
    signal?.removeEventListener('abort', abortHandler);
    await closeBrowser();
  }
}

export class AbortError extends Error {
  constructor() {
    super('Capture was cancelled.');
    this.name = 'AbortError';
  }
}

async function capturePageFrames(input: {
  page: Page;
  url: URL;
  encoder: VideoEncoder;
  options: CaptureOptions;
  logger: CaptureLogger;
  progress?: ProgressReporter;
  signal?: AbortSignal;
  frameOffset: number;
  urlIndex: number;
}): Promise<{
  pageResult: PageCaptureResult;
  lastFrame: Buffer;
}> {
  const { page, url, encoder, options, logger, progress, signal, urlIndex } =
    input;
  const { frameOffset } = input;
  const safeUrl = sanitizeUrl(url);

  progress?.onPageStart(urlIndex, options.urls.length, safeUrl);

  await logger.info('browser.open', `Opening page ${urlIndex + 1}`, {
    url: safeUrl,
    viewport: options.viewport,
  });

  await navigateWithRetry(page, url, options.timeoutMs);
  await stabilizePage({
    page,
    waitFor: options.waitFor,
    hideSelectors: options.hideSelectors,
  });

  const preflight = await preflightMeasurePage(page, logger);
  const plannedDurationSeconds = resolveDurationSeconds(
    options.duration,
    preflight.maxScroll,
  );
  const frames = buildScrollFrames({
    fps: options.fps,
    durationSeconds: plannedDurationSeconds,
    maxScroll: preflight.maxScroll,
    motion: options.motion,
  });
  assertWithinFrameLimit(
    frameOffset +
      frames.length +
      getReservedGapFrames({
        fps: options.fps,
        pageGapSeconds: options.pageGapSeconds,
        isLastPage: urlIndex === options.urls.length - 1,
      }),
  );
  const durationSeconds = frames.length / options.fps;

  await logger.info(
    'render.start',
    `Rendering frames for page ${urlIndex + 1}`,
    {
      frameCount: frames.length,
      fps: options.fps,
      durationSeconds,
      maxScroll: preflight.maxScroll,
      url: safeUrl,
    },
  );

  if (preflight.truncated) {
    await logger.warn(
      'preflight.truncated',
      'Scroll height exceeded capture limit and was truncated',
      {
        scrollHeight: preflight.scrollHeight,
        url: safeUrl,
      },
    );
  }

  let lastFrame: Buffer | undefined;

  for (const [index, scrollTop] of frames.entries()) {
    if (signal?.aborted) {
      throw new AbortError();
    }

    await page.evaluate((nextScrollTop) => {
      window.scrollTo({ top: nextScrollTop, behavior: 'auto' });
    }, scrollTop);
    await waitForAnimationFrames(page);

    const frame = await page.screenshot({
      type: 'png',
      scale: 'css',
      animations: 'disabled',
      caret: 'hide',
    });
    lastFrame = frame;

    if (options.debugFramesDir) {
      const fileName = `${String(frameOffset + index).padStart(5, '0')}.png`;
      await writeFile(`${options.debugFramesDir}/${fileName}`, frame);
    }

    await encoder.writeFrame(frame);
    progress?.onFrameRendered(index, frames.length);

    if ((index + 1) % Math.max(1, Math.floor(frames.length / 10)) === 0) {
      await logger.info('render.progress', 'Rendered frame batch', {
        renderedFrames: index + 1,
        totalFrames: frames.length,
        scrollTop,
        url: safeUrl,
      });
    }
  }

  if (!lastFrame) {
    throw new Error(`Failed to capture frames from page: ${safeUrl}`);
  }

  progress?.onPageComplete(urlIndex);

  return {
    pageResult: {
      url: safeUrl,
      frameCount: frames.length,
      durationSeconds,
      scrollHeight: preflight.scrollHeight,
      truncated: preflight.truncated,
    },
    lastFrame,
  };
}

async function cleanupPartialOutput(outPath: string): Promise<void> {
  try {
    await unlink(outPath);
  } catch {
    // Partial output may not exist
  }
}

function assertWithinFrameLimit(frameCount: number): void {
  if (frameCount > MAX_TOTAL_FRAMES) {
    throw new Error(
      `Total frame count ${frameCount} exceeds maximum ${MAX_TOTAL_FRAMES}. Reduce --fps, --duration, --page-gap, or the number of pages.`,
    );
  }
}

function getReservedGapFrames(options: {
  fps: number;
  pageGapSeconds: number;
  isLastPage: boolean;
}): number {
  if (options.isLastPage) {
    return 0;
  }

  return Math.round(options.fps * options.pageGapSeconds);
}

async function writeGapFrames(input: {
  encoder: VideoEncoder;
  frame: Buffer;
  fps: number;
  gapSeconds: number;
  debugFramesDir?: string;
  frameOffset: number;
}): Promise<number> {
  const { encoder, frame, fps, gapSeconds, debugFramesDir, frameOffset } =
    input;
  const gapFrameCount = Math.round(fps * gapSeconds);

  if (gapFrameCount <= 0) {
    return 0;
  }

  for (let i = 0; i < gapFrameCount; i++) {
    if (debugFramesDir) {
      const fileName = `${String(frameOffset + i).padStart(5, '0')}.png`;
      await writeFile(`${debugFramesDir}/${fileName}`, frame);
    }

    await encoder.writeFrame(frame);
  }

  return gapFrameCount;
}
