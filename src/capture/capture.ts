import { writeFile } from 'node:fs/promises';

import { navigateWithRetry, openBrowserSession } from './browser.js';
import { createVideoEncoder } from './ffmpeg.js';
import type { CaptureLogger } from './logger.js';
import { preflightMeasurePage } from './preflight.js';
import { buildScrollFrames, resolveDurationSeconds } from './scroll-plan.js';
import { stabilizePage } from './stabilize.js';
import type { CaptureOptions, CaptureResult } from './types.js';
import {
  ensureDirectory,
  ensureParentDirectory,
  waitForAnimationFrames,
} from './utils.js';

export async function captureVideo(
  options: CaptureOptions,
  logger: CaptureLogger,
): Promise<CaptureResult> {
  await ensureParentDirectory(options.outPath);
  await ensureParentDirectory(options.logFilePath);
  await ensureParentDirectory(options.manifestPath);
  if (options.debugFramesDir) {
    await ensureDirectory(options.debugFramesDir);
  }

  const { browser, page } = await openBrowserSession(options, logger);

  try {
    await logger.info('browser.open', 'Opening page', {
      url: options.url.toString(),
      viewport: options.viewport,
    });
    await navigateWithRetry(page, options);
    await stabilizePage({
      page,
      waitFor: options.waitFor,
      hideSelectors: options.hideSelectors,
    });

    const preflight = await preflightMeasurePage(page);
    const durationSeconds = resolveDurationSeconds(
      options.duration,
      preflight.maxScroll,
    );
    const frames = buildScrollFrames({
      fps: options.fps,
      durationSeconds,
      maxScroll: preflight.maxScroll,
      motion: options.motion,
    });
    const encoder = await createVideoEncoder({
      fps: options.fps,
      outPath: options.outPath,
    });

    await logger.info('render.start', 'Rendering frames', {
      frameCount: frames.length,
      fps: options.fps,
      durationSeconds,
      maxScroll: preflight.maxScroll,
    });
    if (preflight.truncated) {
      await logger.warn(
        'preflight.truncated',
        'Scroll height exceeded capture limit and was truncated',
        {
          scrollHeight: preflight.scrollHeight,
        },
      );
    }

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

      if (options.debugFramesDir) {
        const fileName = `${String(index).padStart(5, '0')}.png`;
        await writeFile(`${options.debugFramesDir}/${fileName}`, frame);
      }

      await encoder.writeFrame(frame);

      if ((index + 1) % Math.max(1, Math.floor(frames.length / 10)) === 0) {
        await logger.info('render.progress', 'Rendered frame batch', {
          renderedFrames: index + 1,
          totalFrames: frames.length,
          scrollTop,
        });
      }
    }

    await encoder.finish();
    await logger.info('encode.complete', 'Video encoding finished', {
      outPath: options.outPath,
    });

    return {
      outPath: options.outPath,
      frameCount: frames.length,
      durationSeconds,
      finalScrollHeight: preflight.scrollHeight,
      truncated: preflight.truncated,
    };
  } finally {
    await browser.close();
  }
}
