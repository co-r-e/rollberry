import { writeFile } from 'node:fs/promises';

import type { Page } from 'playwright';

import { navigateWithRetry, openBrowserSession } from './browser.js';
import { createVideoEncoder, type VideoEncoder } from './ffmpeg.js';
import type { CaptureLogger } from './logger.js';
import { preflightMeasurePage } from './preflight.js';
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
  waitForAnimationFrames,
} from './utils.js';

export async function captureVideo(
  options: CaptureOptions,
  logger: CaptureLogger,
): Promise<CaptureResult> {
  if (options.urls.length === 0) {
    throw new Error('少なくとも1つのURLを指定してください。');
  }

  await Promise.all([
    ensureParentDirectory(options.outPath),
    ensureParentDirectory(options.logFilePath),
    ensureParentDirectory(options.manifestPath),
    options.debugFramesDir
      ? ensureDirectory(options.debugFramesDir)
      : undefined,
  ]);

  const { browser, page } = await openBrowserSession(options, logger);

  try {
    const encoder = await createVideoEncoder({
      fps: options.fps,
      outPath: options.outPath,
    });

    const pages: PageCaptureResult[] = [];
    let totalFrameCount = 0;
    let totalDurationSeconds = 0;
    let frameOffset = 0;
    let anyTruncated = false;

    for (const [urlIndex, url] of options.urls.entries()) {
      const { pageResult, lastFrame } = await capturePageFrames({
        page,
        url,
        encoder,
        options,
        logger,
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
  } finally {
    await browser.close();
  }
}

async function capturePageFrames(input: {
  page: Page;
  url: URL;
  encoder: VideoEncoder;
  options: CaptureOptions;
  logger: CaptureLogger;
  frameOffset: number;
  urlIndex: number;
}): Promise<{
  pageResult: PageCaptureResult;
  lastFrame: Buffer;
}> {
  const { page, url, encoder, options, logger, urlIndex } = input;
  const { frameOffset } = input;

  await logger.info('browser.open', `Opening page ${urlIndex + 1}`, {
    url: url.toString(),
    viewport: options.viewport,
  });

  await navigateWithRetry(page, url, options.timeoutMs);
  await stabilizePage({
    page,
    waitFor: options.waitFor,
    hideSelectors: options.hideSelectors,
  });

  const preflight = await preflightMeasurePage(page);
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
  const durationSeconds = frames.length / options.fps;

  await logger.info('render.start', `Rendering frames for page ${urlIndex + 1}`, {
    frameCount: frames.length,
    fps: options.fps,
    durationSeconds,
    maxScroll: preflight.maxScroll,
    url: url.toString(),
  });

  if (preflight.truncated) {
    await logger.warn(
      'preflight.truncated',
      'Scroll height exceeded capture limit and was truncated',
      {
        scrollHeight: preflight.scrollHeight,
        url: url.toString(),
      },
    );
  }

  let lastFrame: Buffer | undefined;

  for (const [index, scrollTop] of frames.entries()) {
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

    if ((index + 1) % Math.max(1, Math.floor(frames.length / 10)) === 0) {
      await logger.info('render.progress', 'Rendered frame batch', {
        renderedFrames: index + 1,
        totalFrames: frames.length,
        scrollTop,
        url: url.toString(),
      });
    }
  }

  if (!lastFrame) {
    throw new Error(`ページのフレーム取得に失敗しました: ${url.toString()}`);
  }

  return {
    pageResult: {
      url: url.toString(),
      frameCount: frames.length,
      durationSeconds,
      scrollHeight: preflight.scrollHeight,
      truncated: preflight.truncated,
    },
    lastFrame,
  };
}

async function writeGapFrames(input: {
  encoder: VideoEncoder;
  frame: Buffer;
  fps: number;
  gapSeconds: number;
  debugFramesDir?: string;
  frameOffset: number;
}): Promise<number> {
  const { encoder, frame, fps, gapSeconds, debugFramesDir, frameOffset } = input;
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
