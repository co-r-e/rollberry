import { AbortError, captureVideo } from './capture/capture.js';
import { createCaptureLogger } from './capture/logger.js';
import type { ProgressReporter } from './capture/progress.js';
import type {
  CaptureManifest,
  CaptureOptions,
  CaptureRunResult,
} from './capture/types.js';
import { sanitizeUrl } from './capture/utils.js';
import { serializeError, writeJsonFile } from './serialize.js';

export async function runCaptureCommand(
  options: CaptureOptions,
  progress?: ProgressReporter,
  signal?: AbortSignal,
): Promise<CaptureRunResult> {
  const logger = createCaptureLogger(options.logFilePath);
  const startedAt = new Date();
  let capture: CaptureRunResult['capture'] | undefined;
  const sanitizedUrls = options.urls.map((u) => sanitizeUrl(u));

  await logger.info('capture.start', 'Capture started', {
    urls: sanitizedUrls,
    outPath: options.outPath,
    manifestPath: options.manifestPath,
    logFilePath: options.logFilePath,
  });

  try {
    capture = await captureVideo(options, logger, progress, signal);
    const finishedAt = new Date();
    const warnings = capture.truncated ? ['scroll_height_truncated'] : [];

    const manifest = buildManifest({
      status: 'succeeded',
      options,
      sanitizedUrls,
      startedAt,
      finishedAt,
      warnings,
      videoCreated: true,
      result: capture,
    });

    await writeJsonFile(options.manifestPath, manifest);
    await logger.info('capture.complete', 'Capture finished', {
      outPath: capture.outPath,
      frameCount: capture.frameCount,
      durationSeconds: capture.durationSeconds,
      manifestPath: options.manifestPath,
    });

    return {
      capture,
      manifestPath: options.manifestPath,
      logFilePath: options.logFilePath,
    };
  } catch (error) {
    const finishedAt = new Date();
    const isCancelled = error instanceof AbortError;
    const warnings = capture?.truncated ? ['scroll_height_truncated'] : [];

    const manifest = buildManifest({
      status: isCancelled ? 'cancelled' : 'failed',
      options,
      sanitizedUrls,
      startedAt,
      finishedAt,
      warnings,
      videoCreated: capture !== undefined,
      result: capture,
      error: isCancelled ? undefined : error,
    });

    const logEvent = isCancelled ? 'capture.cancelled' : 'capture.failed';
    const logMessage = isCancelled ? 'Capture cancelled' : 'Capture failed';

    await logger.error(logEvent, logMessage, {
      name: manifest.error?.name,
      message: manifest.error?.message,
      manifestPath: options.manifestPath,
    });
    await writeJsonFile(options.manifestPath, manifest);

    throw error;
  } finally {
    await logger.close();
  }
}

function buildManifest(input: {
  status: CaptureManifest['status'];
  options: CaptureOptions;
  sanitizedUrls: string[];
  startedAt: Date;
  finishedAt: Date;
  warnings: string[];
  videoCreated: boolean;
  result?: CaptureManifest['result'];
  error?: unknown;
}): CaptureManifest {
  return {
    schemaVersion: 2,
    status: input.status,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    options: {
      urls: input.sanitizedUrls,
      viewport: input.options.viewport,
      fps: input.options.fps,
      duration: input.options.duration,
      motion: input.options.motion,
      timeoutMs: input.options.timeoutMs,
      waitFor: input.options.waitFor,
      hideSelectors: input.options.hideSelectors,
      pageGapSeconds: input.options.pageGapSeconds,
    },
    artifacts: {
      videoPath: input.options.outPath,
      manifestPath: input.options.manifestPath,
      logFilePath: input.options.logFilePath,
      debugFramesDir: input.options.debugFramesDir,
      videoCreated: input.videoCreated,
    },
    result: input.result,
    warnings: input.warnings,
    error: input.error ? serializeError(input.error) : undefined,
  };
}
