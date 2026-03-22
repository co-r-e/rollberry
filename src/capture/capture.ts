import { unlink, writeFile } from 'node:fs/promises';

import type { Page } from 'playwright';

import {
  executeCaptureAction,
  executeSceneActions,
  resetScrollPosition,
} from './actions.js';
import { navigateWithRetry, openBrowserSession } from './browser.js';
import { MAX_TOTAL_FRAMES, PREFLIGHT_MAX_SCROLL_HEIGHT } from './constants.js';
import {
  checkFfmpegAvailable,
  createVideoEncoder,
  type VideoEncoder,
} from './ffmpeg.js';
import type { CaptureLogger } from './logger.js';
import { preflightMeasurePage } from './preflight.js';
import type { ProgressReporter } from './progress.js';
import {
  buildScrollFrames,
  resolveDurationSeconds,
  resolveTimelineDurationSeconds,
} from './scroll-plan.js';
import { stabilizePage } from './stabilize.js';
import type {
  CaptureJob,
  CaptureOptions,
  CaptureResult,
  CaptureScene,
  CaptureTimelineScrollTarget,
  CaptureTimelineSegment,
  PageCaptureResult,
} from './types.js';
import {
  clamp,
  ensureDirectory,
  ensureParentDirectory,
  fileExists,
  measurePage,
  sanitizeUrl,
  waitForAnimationFrames,
} from './utils.js';

export async function captureVideo(
  options: CaptureOptions,
  logger: CaptureLogger,
  progress?: ProgressReporter,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  return captureSceneVideo(buildCaptureJob(options), logger, progress, signal);
}

export async function captureSceneVideo(
  job: CaptureJob,
  logger: CaptureLogger,
  progress?: ProgressReporter,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  if (job.scenes.length === 0) {
    throw new Error('At least one scene is required.');
  }

  if (signal?.aborted) {
    throw new AbortError();
  }

  if (!job.force && (await fileExists(job.outPath))) {
    throw new Error(
      `Output file already exists: ${job.outPath}\nUse --force to overwrite, or specify a different --out path.`,
    );
  }

  await checkFfmpegAvailable();

  await Promise.all([
    ensureParentDirectory(job.outPath),
    job.debugFramesDir ? ensureDirectory(job.debugFramesDir) : undefined,
  ]);

  const { browser, page } = await openBrowserSession(
    {
      viewport: job.viewport,
      timeoutMs: job.timeoutMs,
      urls: job.scenes.map((scene) => scene.url),
    },
    logger,
  );

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
      fps: job.fps,
      outPath: job.outPath,
      format: job.format,
      audio: job.audio,
      subtitles: job.subtitles,
      transition: job.transition,
      videoEncoding: job.videoEncoding,
    });

    if (signal?.aborted) {
      throw new AbortError();
    }

    const pages: PageCaptureResult[] = [];
    let totalFrameCount = 0;
    let totalDurationSeconds = 0;
    let frameOffset = 0;
    let anyTruncated = false;

    for (const [sceneIndex, scene] of job.scenes.entries()) {
      if (signal?.aborted) {
        throw new AbortError();
      }

      const { pageResult, lastFrame } = await capturePageFrames({
        page,
        scene,
        sceneIndex,
        totalScenes: job.scenes.length,
        encoder,
        job,
        logger,
        progress,
        signal,
        frameOffset,
      });

      pages.push(pageResult);
      totalFrameCount += pageResult.frameCount;
      totalDurationSeconds += pageResult.durationSeconds;
      frameOffset += pageResult.frameCount;
      anyTruncated = anyTruncated || pageResult.truncated;

      const isLastScene = sceneIndex === job.scenes.length - 1;
      if (
        scene.holdAfterSeconds > 0 &&
        shouldWriteHoldAfterScene(job, isLastScene)
      ) {
        const gapFrameCount = await writeGapFrames({
          encoder,
          frame: lastFrame,
          fps: job.fps,
          gapSeconds: scene.holdAfterSeconds,
          debugFramesDir: job.debugFramesDir,
          frameOffset,
        });

        totalFrameCount += gapFrameCount;
        totalDurationSeconds += gapFrameCount / job.fps;
        frameOffset += gapFrameCount;
      }
    }

    await encoder.finish();
    encodingFinished = true;
    progress?.onEncodeComplete();
    await logger.info('encode.complete', 'Video encoding finished', {
      outPath: job.outPath,
    });

    return {
      outPath: job.outPath,
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
      await cleanupPartialOutput(job.outPath);
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

function buildCaptureJob(options: CaptureOptions): CaptureJob {
  if (options.urls.length === 0) {
    throw new Error('At least one URL is required.');
  }

  const scenes = options.urls.map((url, index) => ({
    url,
    duration: options.duration,
    motion: options.motion,
    waitFor: options.waitFor,
    hideSelectors: options.hideSelectors,
    holdAfterSeconds:
      index === options.urls.length - 1 ? 0 : options.pageGapSeconds,
    actions: [],
    timeline: [],
  }));
  const [firstScene, ...remainingScenes] = scenes;

  return {
    scenes: [firstScene, ...remainingScenes],
    outPath: options.outPath,
    format: 'mp4',
    viewport: options.viewport,
    fps: options.fps,
    timeoutMs: options.timeoutMs,
    debugFramesDir: options.debugFramesDir,
    includeHoldAfterFinalScene: false,
    force: options.force,
  };
}

async function capturePageFrames(input: {
  page: Page;
  scene: CaptureScene;
  sceneIndex: number;
  totalScenes: number;
  encoder: VideoEncoder;
  job: CaptureJob;
  logger: CaptureLogger;
  progress?: ProgressReporter;
  signal?: AbortSignal;
  frameOffset: number;
}): Promise<{
  pageResult: PageCaptureResult;
  lastFrame: Buffer;
}> {
  const {
    page,
    scene,
    sceneIndex,
    totalScenes,
    encoder,
    job,
    logger,
    progress,
    signal,
    frameOffset,
  } = input;
  const safeUrl = sanitizeUrl(scene.url);
  const progressTarget = scene.name ? `${scene.name} (${safeUrl})` : safeUrl;

  progress?.onPageStart(sceneIndex, totalScenes, progressTarget);

  await logger.info('browser.open', `Opening scene ${sceneIndex + 1}`, {
    name: scene.name,
    url: safeUrl,
    viewport: job.viewport,
  });

  await navigateWithRetry(page, scene.url, job.timeoutMs);
  await stabilizePage({
    page,
    waitFor: scene.waitFor,
    hideSelectors: scene.hideSelectors,
  });

  if (scene.actions.length > 0) {
    await executeSceneActions({
      page,
      actions: scene.actions,
      timeoutMs: job.timeoutMs,
      onActionStart(action, index) {
        return logger.info('scene.action.start', 'Executing scene action', {
          action: serializeAction(action),
          actionIndex: index,
          name: scene.name,
          url: safeUrl,
        });
      },
      onActionComplete(action, index) {
        return logger.info('scene.action.complete', 'Scene action completed', {
          action: serializeAction(action),
          actionIndex: index,
          name: scene.name,
          url: safeUrl,
        });
      },
    });
    await resetScrollPosition(page);
  }

  if (scene.timeline.length > 0) {
    const timelineResult = await captureTimelineFrames({
      page,
      scene,
      sceneIndex,
      totalScenes,
      encoder,
      job,
      logger,
      progress,
      signal,
      frameOffset,
      safeUrl,
    });

    progress?.onPageComplete(sceneIndex);

    return {
      pageResult: {
        name: scene.name,
        url: safeUrl,
        frameCount: timelineResult.frameCount,
        durationSeconds: timelineResult.frameCount / job.fps,
        scrollHeight: timelineResult.scrollHeight,
        truncated: timelineResult.truncated,
      },
      lastFrame: timelineResult.lastFrame,
    };
  }

  const legacyResult = await captureLegacyScrollFrames({
    page,
    scene,
    sceneIndex,
    totalScenes,
    encoder,
    job,
    logger,
    progress,
    signal,
    frameOffset,
    safeUrl,
  });

  progress?.onPageComplete(sceneIndex);

  return legacyResult;
}

async function captureLegacyScrollFrames(input: {
  page: Page;
  scene: CaptureScene;
  sceneIndex: number;
  totalScenes: number;
  encoder: VideoEncoder;
  job: CaptureJob;
  logger: CaptureLogger;
  progress?: ProgressReporter;
  signal?: AbortSignal;
  frameOffset: number;
  safeUrl: string;
}): Promise<{
  pageResult: PageCaptureResult;
  lastFrame: Buffer;
}> {
  const {
    page,
    scene,
    sceneIndex,
    totalScenes,
    encoder,
    job,
    logger,
    progress,
    signal,
    frameOffset,
    safeUrl,
  } = input;

  const preflight = await preflightMeasurePage(page, logger);
  const plannedDurationSeconds = resolveDurationSeconds(
    scene.duration,
    preflight.maxScroll,
  );
  const frames = buildScrollFrames({
    fps: job.fps,
    durationSeconds: plannedDurationSeconds,
    maxScroll: preflight.maxScroll,
    motion: scene.motion,
  });
  assertWithinFrameLimit(
    frameOffset +
      frames.length +
      getReservedGapFrames({
        fps: job.fps,
        gapSeconds: scene.holdAfterSeconds,
        shouldWriteGap: shouldWriteHoldAfterScene(
          job,
          sceneIndex === totalScenes - 1,
        ),
      }),
  );
  const durationSeconds = frames.length / job.fps;

  await logger.info(
    'render.start',
    `Rendering frames for scene ${sceneIndex + 1}`,
    {
      name: scene.name,
      frameCount: frames.length,
      fps: job.fps,
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
        name: scene.name,
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

    await writeFrameToOutput({
      encoder,
      frame,
      debugFramesDir: job.debugFramesDir,
      frameNumber: frameOffset + index,
    });
    progress?.onFrameRendered(index, frames.length);

    if ((index + 1) % Math.max(1, Math.floor(frames.length / 10)) === 0) {
      await logger.info('render.progress', 'Rendered frame batch', {
        name: scene.name,
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

  return {
    pageResult: {
      name: scene.name,
      url: safeUrl,
      frameCount: frames.length,
      durationSeconds,
      scrollHeight: preflight.scrollHeight,
      truncated: preflight.truncated,
    },
    lastFrame,
  };
}

async function captureTimelineFrames(input: {
  page: Page;
  scene: CaptureScene;
  sceneIndex: number;
  totalScenes: number;
  encoder: VideoEncoder;
  job: CaptureJob;
  logger: CaptureLogger;
  progress?: ProgressReporter;
  signal?: AbortSignal;
  frameOffset: number;
  safeUrl: string;
}): Promise<{
  frameCount: number;
  lastFrame: Buffer;
  scrollHeight: number;
  truncated: boolean;
}> {
  const {
    page,
    scene,
    sceneIndex,
    totalScenes,
    encoder,
    job,
    logger,
    progress,
    signal,
    frameOffset,
    safeUrl,
  } = input;

  let sceneFrameCount = 0;
  let lastFrame: Buffer | undefined;
  let maxObservedScrollHeight = 0;
  let anyTruncated = false;

  const initialMetrics = await measureTimelineMetrics(page);
  maxObservedScrollHeight = initialMetrics.scrollHeight;
  anyTruncated = initialMetrics.truncated;

  await logger.info(
    'timeline.start',
    `Running timeline for scene ${sceneIndex + 1}`,
    {
      name: scene.name,
      segmentCount: scene.timeline.length,
      url: safeUrl,
    },
  );

  for (const [segmentIndex, segment] of scene.timeline.entries()) {
    if (signal?.aborted) {
      throw new AbortError();
    }

    await logger.info('timeline.segment.start', 'Executing timeline segment', {
      name: scene.name,
      sceneIndex,
      segmentIndex,
      segment: serializeTimelineSegment(segment),
      url: safeUrl,
    });

    switch (segment.kind) {
      case 'scroll': {
        const metrics = await measureTimelineMetrics(page);
        maxObservedScrollHeight = Math.max(
          maxObservedScrollHeight,
          metrics.scrollHeight,
        );
        anyTruncated = anyTruncated || metrics.truncated;

        const startScrollTop = metrics.scrollTop;
        const targetScrollTop = await resolveTimelineTargetScrollTop(
          page,
          metrics.viewportHeight,
          metrics.maxScroll,
          startScrollTop,
          segment.target,
        );
        const scrollDistance = targetScrollTop - startScrollTop;
        const durationSeconds =
          segment.duration === 'auto'
            ? resolveTimelineDurationSeconds(Math.abs(scrollDistance))
            : segment.duration;
        const relativeFrames = buildScrollFrames({
          fps: job.fps,
          durationSeconds,
          maxScroll: Math.abs(scrollDistance),
          motion: segment.motion,
        });

        assertWithinFrameLimit(
          frameOffset +
            sceneFrameCount +
            relativeFrames.length +
            getReservedGapFrames({
              fps: job.fps,
              gapSeconds: scene.holdAfterSeconds,
              shouldWriteGap: shouldWriteHoldAfterScene(
                job,
                sceneIndex === totalScenes - 1,
              ),
            }),
        );

        for (const [index, relativeScrollTop] of relativeFrames.entries()) {
          if (signal?.aborted) {
            throw new AbortError();
          }

          const nextScrollTop =
            scrollDistance >= 0
              ? startScrollTop + relativeScrollTop
              : startScrollTop - relativeScrollTop;

          await page.evaluate((scrollTop) => {
            window.scrollTo({ top: scrollTop, behavior: 'auto' });
          }, nextScrollTop);
          await waitForAnimationFrames(page);

          const frame = await captureFrame(page);
          lastFrame = frame;
          await writeFrameToOutput({
            encoder,
            frame,
            debugFramesDir: job.debugFramesDir,
            frameNumber: frameOffset + sceneFrameCount,
          });
          sceneFrameCount += 1;
          progress?.onFrameRendered(index, relativeFrames.length);
        }

        const postScrollMetrics = await measureTimelineMetrics(page);
        maxObservedScrollHeight = Math.max(
          maxObservedScrollHeight,
          postScrollMetrics.scrollHeight,
        );
        anyTruncated = anyTruncated || postScrollMetrics.truncated;
        break;
      }

      case 'pause': {
        const pauseFrame = lastFrame ?? (await captureFrame(page));
        lastFrame = pauseFrame;
        const pauseFrameCount = Math.max(
          1,
          Math.round(segment.durationSeconds * job.fps),
        );

        assertWithinFrameLimit(
          frameOffset +
            sceneFrameCount +
            pauseFrameCount +
            getReservedGapFrames({
              fps: job.fps,
              gapSeconds: scene.holdAfterSeconds,
              shouldWriteGap: shouldWriteHoldAfterScene(
                job,
                sceneIndex === totalScenes - 1,
              ),
            }),
        );

        await writeRepeatedFrames({
          encoder,
          frame: pauseFrame,
          frameCount: pauseFrameCount,
          debugFramesDir: job.debugFramesDir,
          frameOffset: frameOffset + sceneFrameCount,
          progress,
        });
        sceneFrameCount += pauseFrameCount;
        break;
      }

      case 'action': {
        await executeCaptureAction(page, segment.action, job.timeoutMs);
        const actionFrame = await captureFrame(page);
        lastFrame = actionFrame;

        const holdFrameCount = Math.round(segment.holdAfterSeconds * job.fps);
        const totalActionFrames = 1 + holdFrameCount;

        assertWithinFrameLimit(
          frameOffset +
            sceneFrameCount +
            totalActionFrames +
            getReservedGapFrames({
              fps: job.fps,
              gapSeconds: scene.holdAfterSeconds,
              shouldWriteGap: shouldWriteHoldAfterScene(
                job,
                sceneIndex === totalScenes - 1,
              ),
            }),
        );

        await writeFrameToOutput({
          encoder,
          frame: actionFrame,
          debugFramesDir: job.debugFramesDir,
          frameNumber: frameOffset + sceneFrameCount,
        });
        sceneFrameCount += 1;
        progress?.onFrameRendered(0, totalActionFrames);

        if (holdFrameCount > 0) {
          await writeRepeatedFrames({
            encoder,
            frame: actionFrame,
            frameCount: holdFrameCount,
            debugFramesDir: job.debugFramesDir,
            frameOffset: frameOffset + sceneFrameCount,
            progress,
            progressStartIndex: 1,
            progressTotal: totalActionFrames,
          });
          sceneFrameCount += holdFrameCount;
        }

        const postActionMetrics = await measureTimelineMetrics(page);
        maxObservedScrollHeight = Math.max(
          maxObservedScrollHeight,
          postActionMetrics.scrollHeight,
        );
        anyTruncated = anyTruncated || postActionMetrics.truncated;
        break;
      }
    }

    await logger.info(
      'timeline.segment.complete',
      'Timeline segment completed',
      {
        name: scene.name,
        sceneIndex,
        segmentIndex,
        sceneFrameCount,
        segment: serializeTimelineSegment(segment),
        url: safeUrl,
      },
    );
  }

  await logger.info(
    'timeline.complete',
    `Timeline finished for scene ${sceneIndex + 1}`,
    {
      name: scene.name,
      frameCount: sceneFrameCount,
      durationSeconds: sceneFrameCount / job.fps,
      url: safeUrl,
    },
  );

  if (!lastFrame) {
    throw new Error(`Failed to capture timeline frames from page: ${safeUrl}`);
  }

  return {
    frameCount: sceneFrameCount,
    lastFrame,
    scrollHeight: maxObservedScrollHeight,
    truncated: anyTruncated,
  };
}

async function captureFrame(page: Page): Promise<Buffer> {
  return page.screenshot({
    type: 'png',
    scale: 'css',
    animations: 'disabled',
    caret: 'hide',
  });
}

async function writeFrameToOutput(input: {
  encoder: VideoEncoder;
  frame: Buffer;
  debugFramesDir?: string;
  frameNumber: number;
}): Promise<void> {
  const { encoder, frame, debugFramesDir, frameNumber } = input;

  if (debugFramesDir) {
    const fileName = `${String(frameNumber).padStart(5, '0')}.png`;
    await writeFile(`${debugFramesDir}/${fileName}`, frame);
  }

  await encoder.writeFrame(frame);
}

async function writeRepeatedFrames(input: {
  encoder: VideoEncoder;
  frame: Buffer;
  frameCount: number;
  debugFramesDir?: string;
  frameOffset: number;
  progress?: ProgressReporter;
  progressStartIndex?: number;
  progressTotal?: number;
}): Promise<void> {
  const {
    encoder,
    frame,
    frameCount,
    debugFramesDir,
    frameOffset,
    progress,
    progressStartIndex = 0,
    progressTotal = frameCount,
  } = input;

  for (let index = 0; index < frameCount; index += 1) {
    await writeFrameToOutput({
      encoder,
      frame,
      debugFramesDir,
      frameNumber: frameOffset + index,
    });
    progress?.onFrameRendered(progressStartIndex + index, progressTotal);
  }
}

async function measureTimelineMetrics(page: Page): Promise<{
  scrollHeight: number;
  viewportHeight: number;
  maxScroll: number;
  scrollTop: number;
  truncated: boolean;
}> {
  const metrics = await measurePage(page);
  const scrollTop = await page.evaluate(
    () => window.scrollY || window.pageYOffset || 0,
  );
  const truncated = metrics.scrollHeight > PREFLIGHT_MAX_SCROLL_HEIGHT;
  const scrollHeight = Math.min(
    metrics.scrollHeight,
    PREFLIGHT_MAX_SCROLL_HEIGHT,
  );

  return {
    scrollHeight,
    viewportHeight: metrics.viewportHeight,
    maxScroll: Math.max(0, scrollHeight - metrics.viewportHeight),
    scrollTop: clamp(
      scrollTop,
      0,
      Math.max(0, scrollHeight - metrics.viewportHeight),
    ),
    truncated,
  };
}

async function resolveTimelineTargetScrollTop(
  page: Page,
  viewportHeight: number,
  maxScroll: number,
  currentScrollTop: number,
  target: CaptureTimelineScrollTarget,
): Promise<number> {
  switch (target.kind) {
    case 'bottom':
      return maxScroll;
    case 'absolute':
      return clamp(target.top, 0, maxScroll);
    case 'relative':
      return clamp(currentScrollTop + target.delta, 0, maxScroll);
    case 'selector': {
      const targetScrollTop = await page.evaluate(
        ({ selector, block, viewportHeight: height }) => {
          const element = document.querySelector(selector);
          if (!element) {
            throw new Error(
              `Selector not found for timeline scroll target: ${selector}`,
            );
          }

          const rect = element.getBoundingClientRect();
          const absoluteTop = rect.top + window.scrollY;

          switch (block) {
            case 'start':
              return absoluteTop;
            case 'center':
              return absoluteTop - (height - rect.height) / 2;
            case 'end':
              return absoluteTop - (height - rect.height);
          }
        },
        {
          selector: target.selector,
          block: target.block,
          viewportHeight,
        },
      );

      return clamp(targetScrollTop, 0, maxScroll);
    }
  }
}

function serializeTimelineSegment(
  segment: CaptureTimelineSegment,
): Record<string, unknown> {
  switch (segment.kind) {
    case 'pause':
      return {
        kind: segment.kind,
        durationSeconds: segment.durationSeconds,
      };
    case 'scroll':
      return {
        kind: segment.kind,
        duration: segment.duration,
        motion: segment.motion,
        target: serializeTimelineTarget(segment.target),
      };
    case 'action':
      return {
        kind: segment.kind,
        holdAfterSeconds: segment.holdAfterSeconds,
        action: serializeAction(segment.action),
      };
  }
}

function serializeTimelineTarget(
  target: CaptureTimelineScrollTarget,
): Record<string, unknown> {
  switch (target.kind) {
    case 'bottom':
      return { kind: target.kind };
    case 'absolute':
      return { kind: target.kind, top: target.top };
    case 'relative':
      return { kind: target.kind, delta: target.delta };
    case 'selector':
      return {
        kind: target.kind,
        selector: target.selector,
        block: target.block,
      };
  }
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
      `Total frame count ${frameCount} exceeds maximum ${MAX_TOTAL_FRAMES}. Reduce --fps, --duration, --page-gap, or the number of scenes.`,
    );
  }
}

function getReservedGapFrames(options: {
  fps: number;
  gapSeconds: number;
  shouldWriteGap: boolean;
}): number {
  if (!options.shouldWriteGap) {
    return 0;
  }

  return Math.round(options.fps * options.gapSeconds);
}

function shouldWriteHoldAfterScene(
  job: CaptureJob,
  isLastScene: boolean,
): boolean {
  if (!isLastScene) {
    return true;
  }

  return job.includeHoldAfterFinalScene === true;
}

function serializeAction(
  action: CaptureScene['actions'][number],
): Record<string, unknown> {
  switch (action.kind) {
    case 'wait':
      return { kind: action.kind, ms: action.ms };
    case 'press':
      return { kind: action.kind, key: action.key };
    case 'click':
    case 'hover':
      return { kind: action.kind, selector: action.selector };
    case 'type':
      return {
        kind: action.kind,
        selector: action.selector,
        textLength: action.text.length,
        clear: action.clear,
      };
    case 'scroll-to':
      return {
        kind: action.kind,
        selector: action.selector,
        block: action.block,
      };
  }
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
