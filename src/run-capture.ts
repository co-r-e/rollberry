import { writeFile } from 'node:fs/promises';

import { captureVideo } from './capture/capture.js';
import { createCaptureLogger } from './capture/logger.js';
import type {
  CaptureManifest,
  CaptureOptions,
  CaptureRunResult,
} from './capture/types.js';
export async function runCaptureCommand(
  options: CaptureOptions,
): Promise<CaptureRunResult> {
  const logger = createCaptureLogger(options.logFilePath);
  const startedAt = new Date();

  await logger.info('capture.start', 'Capture started', {
    urls: options.urls.map((u) => u.toString()),
    outPath: options.outPath,
    manifestPath: options.manifestPath,
    logFilePath: options.logFilePath,
  });

  try {
    const capture = await captureVideo(options, logger);
    const finishedAt = new Date();
    const warnings = capture.truncated
      ? ['scroll_height_truncated']
      : [];

    const manifest = buildManifest({
      status: 'succeeded',
      options,
      startedAt,
      finishedAt,
      warnings,
      videoCreated: true,
      result: capture,
    });

    await writeManifest(options.manifestPath, manifest);
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
    const manifest = buildManifest({
      status: 'failed',
      options,
      startedAt,
      finishedAt,
      warnings: [],
      videoCreated: false,
      error,
    });

    await logger.error('capture.failed', 'Capture failed', {
      name: manifest.error?.name,
      message: manifest.error?.message,
      manifestPath: options.manifestPath,
    });
    await writeManifest(options.manifestPath, manifest);
    throw error;
  } finally {
    await logger.close();
  }
}

async function writeManifest(
  manifestPath: string,
  manifest: CaptureManifest,
): Promise<void> {
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

function buildManifest(input: {
  status: CaptureManifest['status'];
  options: CaptureOptions;
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
      urls: input.options.urls.map((u) => u.toString()),
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

function serializeError(error: unknown): CaptureManifest['error'] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: 'Error',
    message: typeof error === 'string' ? error : 'Unknown error',
  };
}
