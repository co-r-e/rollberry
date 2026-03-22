import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AbortError, captureSceneVideo } from './capture/capture.js';
import {
  type ComposedVideoClip,
  composeVideoClips,
  probeVideoFile,
  type VideoProbeOutcome,
} from './capture/ffmpeg.js';
import { createCaptureLogger } from './capture/logger.js';
import type { ProgressReporter } from './capture/progress.js';
import type {
  CaptureAction,
  CaptureResult,
  CaptureScene,
  CaptureTimelineScrollTarget,
  CaptureTimelineSegment,
  MotionCurve,
  Viewport,
  WaitForCondition,
} from './capture/types.js';
import { ensureParentDirectory, sanitizeUrl } from './capture/utils.js';
import type { RenderCliOptions } from './options.js';
import type { ResolvedRenderOutput } from './project.js';
import { loadRenderProject } from './project.js';
import {
  buildArtifactMetrics,
  buildCaptureMetrics,
  buildComposedCaptureResult,
  buildProbeWarningEvent,
  buildSceneCaptureArtifact,
  buildSceneClipProbeFailureMessage,
  collectProbeWarnings,
  createRenderPlan,
  type RenderArtifactMetrics,
  type RenderCaptureMetrics,
  type SceneCaptureArtifact,
  shouldFailOnSceneClipProbe,
} from './render-plan.js';

export interface RenderOutputResult {
  name: string;
  fps: number;
  format: 'mp4' | 'webm';
  capture: CaptureResult;
  manifestPath: string;
  logFilePath: string;
}

export interface RenderCommandResult {
  projectPath: string;
  summaryManifestPath: string;
  outputs: RenderOutputResult[];
}

interface RenderManifest {
  schemaVersion: 2;
  kind: 'render';
  status: 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  environment: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  project: {
    path: string;
    name: string;
    timeoutMs: number;
  };
  output: {
    name: string;
    format: 'mp4' | 'webm';
    viewport: Viewport;
    fps: number;
    videoPath: string;
    manifestPath: string;
    logFilePath: string;
    debugFramesDir?: string;
    audio?: {
      sourcePath: string;
      volume: number;
      loop: boolean;
    };
    subtitles?: {
      sourcePath: string;
      format: 'srt' | 'webvtt';
      mode: 'soft' | 'burn-in';
    };
    transition?: {
      kind: 'fade-in' | 'crossfade';
      durationSeconds: number;
    };
    intermediateArtifact: {
      format: 'mp4';
      extension: '.mp4';
      videoEncoding: {
        preset:
          | 'ultrafast'
          | 'superfast'
          | 'veryfast'
          | 'faster'
          | 'fast'
          | 'medium'
          | 'slow'
          | 'slower'
          | 'veryslow'
          | 'placebo';
        crf: number;
      };
    };
    finalVideo:
      | {
          format: 'mp4';
          preset:
            | 'ultrafast'
            | 'superfast'
            | 'veryfast'
            | 'faster'
            | 'fast'
            | 'medium'
            | 'slow'
            | 'slower'
            | 'veryslow'
            | 'placebo';
          crf: number;
        }
      | {
          format: 'webm';
          deadline: 'best' | 'good' | 'realtime';
          crf: number;
        };
    videoCreated: boolean;
  };
  scenes: Array<{
    name?: string;
    url: string;
    duration: number | 'auto';
    motion: MotionCurve;
    waitFor: WaitForCondition;
    hideSelectors: string[];
    holdAfterSeconds: number;
    actions: Array<Record<string, unknown>>;
    timeline: Array<Record<string, unknown>>;
  }>;
  captureMetrics?: RenderCaptureMetrics;
  artifactMetrics?: RenderArtifactMetrics;
  warnings: string[];
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

interface RenderSummaryManifest {
  schemaVersion: 1;
  kind: 'render-summary';
  status: 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  project: {
    path: string;
    name: string;
    summaryManifestPath: string;
  };
  outputs: Array<{
    name: string;
    format: 'mp4' | 'webm';
    status: 'succeeded' | 'failed' | 'cancelled';
    videoPath: string;
    manifestPath: string;
    logFilePath: string;
    frameCount?: number;
    durationSeconds?: number;
    warnings: string[];
    error?: {
      name: string;
      message: string;
    };
  }>;
}

export async function runRenderCommand(
  options: RenderCliOptions,
  progress?: ProgressReporter,
  signal?: AbortSignal,
): Promise<RenderCommandResult> {
  const project = await loadRenderProject(options);
  await ensureParentDirectory(project.summaryManifestPath);

  const outputs: RenderOutputResult[] = [];
  const summaryOutputs: RenderSummaryManifest['outputs'] = [];
  const startedAt = new Date();
  let overallStatus: RenderSummaryManifest['status'] = 'succeeded';

  for (const output of project.outputs) {
    await Promise.all([
      ensureParentDirectory(output.outPath),
      ensureParentDirectory(output.manifestPath),
      ensureParentDirectory(output.logFilePath),
    ]);

    const logger = createCaptureLogger(output.logFilePath);
    const tempDir = await mkdtemp(join(tmpdir(), 'rollberry-render-'));
    const renderPlan = createRenderPlan({
      output,
      scenes: project.scenes,
      timeoutMs: project.timeoutMs,
      tempDir,
    });
    const startedAt = new Date();
    let capture: CaptureResult | undefined;
    let captureMetrics: RenderCaptureMetrics | undefined;
    let artifactMetrics: RenderArtifactMetrics | undefined;
    let finalProbe: VideoProbeOutcome | undefined;
    const warningCodes = new Set<string>();

    await logger.info('render.start', 'Project render started', {
      projectPath: project.projectPath,
      projectName: project.projectName,
      outputName: output.name,
      outPath: output.outPath,
    });

    try {
      const sceneClips: ComposedVideoClip[] = [];
      const sceneArtifacts: SceneCaptureArtifact[] = [];

      for (const scenePlan of renderPlan.sceneCaptures) {
        await logger.info(
          'scene.capture.start',
          `Capturing scene clip ${scenePlan.sceneIndex + 1}`,
          {
            outputName: output.name,
            sceneIndex: scenePlan.sceneIndex,
            sceneName: scenePlan.scene.name,
            sceneUrl: sanitizeUrl(scenePlan.scene.url),
            clipPath: scenePlan.clipPath,
          },
        );

        const rawSceneCapture = await captureSceneVideo(
          scenePlan.job,
          logger,
          progress,
          signal,
        );
        const sceneProbe = await probeVideoFile(scenePlan.clipPath);
        const sceneProbeWarning = buildProbeWarningEvent({
          target: 'scene-clip',
          index: scenePlan.sceneIndex,
          probe: sceneProbe,
        });
        if (sceneProbeWarning) {
          warningCodes.add(`scene_clip_probe_${sceneProbe.status}`);
          await logger.warn(
            sceneProbeWarning.event,
            sceneProbeWarning.message,
            sceneProbeWarning.metadata,
          );
        }
        if (
          shouldFailOnSceneClipProbe({
            probe: sceneProbe,
            capabilities: renderPlan.capabilities,
          })
        ) {
          throw new Error(
            buildSceneClipProbeFailureMessage({
              sceneIndex: scenePlan.sceneIndex,
              probe: sceneProbe,
              capabilities: renderPlan.capabilities,
            }),
          );
        }

        const sceneArtifact = buildSceneCaptureArtifact({
          rawCapture: rawSceneCapture,
          clipPath: scenePlan.clipPath,
          probe: sceneProbe,
        });

        sceneArtifacts.push(sceneArtifact);
        sceneClips.push({
          path: sceneArtifact.clip.path,
          durationSeconds: sceneArtifact.clip.durationSeconds,
        });

        await logger.info(
          'scene.capture.complete',
          'Scene clip capture finished',
          {
            outputName: output.name,
            sceneIndex: scenePlan.sceneIndex,
            clipPath: scenePlan.clipPath,
            frameCount: sceneArtifact.captureMetrics.frameCount,
            durationSeconds: sceneArtifact.captureMetrics.durationSeconds,
          },
        );
      }

      await logger.info('compose.start', 'Composing final output', {
        outputName: output.name,
        outPath: output.outPath,
        sceneCount: sceneClips.length,
        transition: output.transition,
        subtitles: output.subtitles,
      });

      await composeVideoClips({
        clips: sceneClips as [ComposedVideoClip, ...ComposedVideoClip[]],
        ...renderPlan.composition,
      });

      finalProbe = await probeVideoFile(renderPlan.composition.outPath);
      const outputProbeWarning = buildProbeWarningEvent({
        target: 'output',
        probe: finalProbe,
      });
      if (outputProbeWarning) {
        warningCodes.add(`output_probe_${finalProbe.status}`);
        await logger.warn(
          outputProbeWarning.event,
          outputProbeWarning.message,
          outputProbeWarning.metadata,
        );
      }

      capture = buildComposedCaptureResult({
        outPath: renderPlan.composition.outPath,
        fps: renderPlan.composition.fps,
        sceneArtifacts,
        transition: renderPlan.composition.transition,
        probe: finalProbe,
      });
      captureMetrics = buildCaptureMetrics(sceneArtifacts);
      artifactMetrics = buildArtifactMetrics({
        captureResult: capture,
        probe: finalProbe,
      });
      for (const warning of collectProbeWarnings(sceneArtifacts, finalProbe)) {
        warningCodes.add(warning);
      }

      await logger.info('compose.complete', 'Final output composed', {
        outputName: output.name,
        outPath: output.outPath,
        frameCount: capture.frameCount,
        durationSeconds: capture.durationSeconds,
      });

      const finishedAt = new Date();
      const warnings = finalizeWarnings(warningCodes, capture, captureMetrics);
      const manifest = buildRenderManifest({
        status: 'succeeded',
        projectPath: project.projectPath,
        projectName: project.projectName,
        timeoutMs: project.timeoutMs,
        scenes: project.scenes,
        output,
        startedAt,
        finishedAt,
        warnings,
        videoCreated: true,
        captureMetrics,
        artifactMetrics,
      });

      await writeManifest(output.manifestPath, manifest);
      await logger.info('render.complete', 'Project render finished', {
        outputName: output.name,
        outPath: output.outPath,
        frameCount: capture.frameCount,
        durationSeconds: capture.durationSeconds,
      });

      outputs.push({
        name: output.name,
        fps: output.fps,
        format: output.format,
        capture,
        manifestPath: output.manifestPath,
        logFilePath: output.logFilePath,
      });
      summaryOutputs.push({
        name: output.name,
        format: output.format,
        status: 'succeeded',
        videoPath: output.outPath,
        manifestPath: output.manifestPath,
        logFilePath: output.logFilePath,
        frameCount: capture.frameCount,
        durationSeconds: capture.durationSeconds,
        warnings,
      });
    } catch (error) {
      const finishedAt = new Date();
      const isCancelled = error instanceof AbortError;
      const warnings = finalizeWarnings(warningCodes, capture, captureMetrics);
      const manifest = buildRenderManifest({
        status: isCancelled ? 'cancelled' : 'failed',
        projectPath: project.projectPath,
        projectName: project.projectName,
        timeoutMs: project.timeoutMs,
        scenes: project.scenes,
        output,
        startedAt,
        finishedAt,
        warnings,
        videoCreated: capture !== undefined,
        captureMetrics,
        artifactMetrics:
          artifactMetrics ??
          (capture && finalProbe
            ? buildArtifactMetrics({
                captureResult: capture,
                probe: finalProbe,
              })
            : undefined),
        error: isCancelled ? undefined : error,
      });

      await logger.error(
        isCancelled ? 'render.cancelled' : 'render.failed',
        isCancelled ? 'Project render cancelled' : 'Project render failed',
        {
          outputName: output.name,
          manifestPath: output.manifestPath,
          name: manifest.error?.name,
          message: manifest.error?.message,
        },
      );
      await writeManifest(output.manifestPath, manifest);

      if (isCancelled) {
        summaryOutputs.push({
          name: output.name,
          format: output.format,
          status: 'cancelled',
          videoPath: output.outPath,
          manifestPath: output.manifestPath,
          logFilePath: output.logFilePath,
          frameCount: capture?.frameCount,
          durationSeconds: capture?.durationSeconds,
          warnings,
        });
        overallStatus = 'cancelled';
        await writeSummaryManifest(
          project.summaryManifestPath,
          buildRenderSummaryManifest({
            status: overallStatus,
            projectPath: project.projectPath,
            projectName: project.projectName,
            summaryManifestPath: project.summaryManifestPath,
            startedAt,
            finishedAt,
            outputs: summaryOutputs,
          }),
        );
        await logger.close();
        throw error;
      }

      overallStatus = 'failed';
      summaryOutputs.push({
        name: output.name,
        format: output.format,
        status: 'failed',
        videoPath: output.outPath,
        manifestPath: output.manifestPath,
        logFilePath: output.logFilePath,
        frameCount: capture?.frameCount,
        durationSeconds: capture?.durationSeconds,
        warnings,
        error: manifest.error
          ? {
              name: manifest.error.name,
              message: manifest.error.message,
            }
          : undefined,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await logger.close();
    }
  }

  const finishedAt = new Date();
  await writeSummaryManifest(
    project.summaryManifestPath,
    buildRenderSummaryManifest({
      status: overallStatus,
      projectPath: project.projectPath,
      projectName: project.projectName,
      summaryManifestPath: project.summaryManifestPath,
      startedAt,
      finishedAt,
      outputs: summaryOutputs,
    }),
  );

  if (overallStatus === 'failed') {
    throw new Error(
      `Render failed for outputs: ${summaryOutputs
        .filter((output) => output.status === 'failed')
        .map((output) => output.name)
        .join(', ')}`,
    );
  }

  return {
    projectPath: project.projectPath,
    summaryManifestPath: project.summaryManifestPath,
    outputs,
  };
}

async function writeManifest(
  manifestPath: string,
  manifest: RenderManifest,
): Promise<void> {
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

async function writeSummaryManifest(
  manifestPath: string,
  manifest: RenderSummaryManifest,
): Promise<void> {
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

function buildRenderManifest(input: {
  status: RenderManifest['status'];
  projectPath: string;
  projectName: string;
  timeoutMs: number;
  scenes: CaptureScene[];
  output: ResolvedRenderOutput;
  startedAt: Date;
  finishedAt: Date;
  warnings: string[];
  videoCreated: boolean;
  captureMetrics?: RenderCaptureMetrics;
  artifactMetrics?: RenderArtifactMetrics;
  error?: unknown;
}): RenderManifest {
  return {
    schemaVersion: 2,
    kind: 'render',
    status: input.status,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    project: {
      path: input.projectPath,
      name: input.projectName,
      timeoutMs: input.timeoutMs,
    },
    output: {
      name: input.output.name,
      format: input.output.format,
      viewport: input.output.viewport,
      fps: input.output.fps,
      videoPath: input.output.outPath,
      manifestPath: input.output.manifestPath,
      logFilePath: input.output.logFilePath,
      debugFramesDir: input.output.debugFramesDir,
      audio: input.output.audio,
      subtitles: input.output.subtitles,
      transition: input.output.transition,
      intermediateArtifact: input.output.intermediateArtifact,
      finalVideo: input.output.finalVideo,
      videoCreated: input.videoCreated,
    },
    scenes: input.scenes.map((scene) => ({
      name: scene.name,
      url: sanitizeUrl(scene.url),
      duration: scene.duration,
      motion: scene.motion,
      waitFor: scene.waitFor,
      hideSelectors: scene.hideSelectors,
      holdAfterSeconds: scene.holdAfterSeconds,
      actions: scene.actions.map(serializeAction),
      timeline: scene.timeline.map(serializeTimelineSegment),
    })),
    captureMetrics: input.captureMetrics,
    artifactMetrics: input.artifactMetrics,
    warnings: input.warnings,
    error: input.error ? serializeError(input.error) : undefined,
  };
}

function finalizeWarnings(
  warningCodes: Set<string>,
  capture: CaptureResult | undefined,
  captureMetrics: RenderCaptureMetrics | undefined,
): string[] {
  const warnings = new Set(warningCodes);

  if (capture?.truncated || captureMetrics?.truncated) {
    warnings.add('scroll_height_truncated');
  }

  return [...warnings];
}

function buildRenderSummaryManifest(input: {
  status: RenderSummaryManifest['status'];
  projectPath: string;
  projectName: string;
  summaryManifestPath: string;
  startedAt: Date;
  finishedAt: Date;
  outputs: RenderSummaryManifest['outputs'];
}): RenderSummaryManifest {
  return {
    schemaVersion: 1,
    kind: 'render-summary',
    status: input.status,
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    project: {
      path: input.projectPath,
      name: input.projectName,
      summaryManifestPath: input.summaryManifestPath,
    },
    outputs: input.outputs,
  };
}

function serializeAction(action: CaptureAction): Record<string, unknown> {
  switch (action.kind) {
    case 'wait':
      return { kind: action.kind, ms: action.ms };
    case 'click':
    case 'hover':
      return { kind: action.kind, selector: action.selector };
    case 'press':
      return { kind: action.kind, key: action.key };
    case 'type':
      return {
        kind: action.kind,
        selector: action.selector,
        clear: action.clear,
        textLength: action.text.length,
      };
    case 'scroll-to':
      return {
        kind: action.kind,
        selector: action.selector,
        block: action.block,
      };
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

function serializeError(error: unknown): RenderManifest['error'] {
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
